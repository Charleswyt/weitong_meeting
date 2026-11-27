package meeting

import (
	"context"
	"strings"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
	"github.com/gogf/gf/v2/os/glog"

	v1 "cloud-conference-backend/api/v1"
	"cloud-conference-backend/internal/response"
	"cloud-conference-backend/internal/service"
	"cloud-conference-backend/internal/service/thirdparty"
	"cloud-conference-backend/internal/session"
	"cloud-conference-backend/internal/websocket"
)

// requireHostControl 校验当前用户是否有权执行会控（仅主持人）。
func (c *Controller) requireHostControl(r *ghttp.Request, meetingId int64) (Caller, bool) {
	cu := c.callerOf(r)
	if session.IsManaged(meetingId) {
		m, err := c.meetingSvc.GetDetail(r.Context(), meetingId)
		if err != nil {
			response.Fail(r, "会议不存在")
			return cu, false
		}
		if !service.CanManage(m, cu.UserId, cu.Account) {
			response.Fail(r, "只有会议主持人可以执行此操作")
			return cu, false
		}
		return cu, true
	}
	// 外部会议的主持人身份由会议服务确认。
	member, joined := c.registry.Session(meetingId, cu.UserId)
	number, known := c.registry.ExternalNoFor(meetingId)
	if !joined || !known {
		response.Fail(r, "你尚未加入这场会议")
		return cu, false
	}
	state, err := c.adapter.GetMeetingState(r.Context(), member.ParticipantToken, number)
	if err != nil || !canControlExternalRoom(state, member.ParticipantId) {
		response.Fail(r, "只有会议主持人可以执行此操作")
		return cu, false
	}
	return cu, true
}

func canControlExternalRoom(state *thirdparty.MeetingResponse, participantId string) bool {
	if state == nil || participantId == "" {
		return false
	}
	if state.Meeting.HostParticipantId != "" {
		return state.Meeting.HostParticipantId == participantId
	}
	for _, member := range state.Participants {
		if member.ParticipantId == participantId {
			return member.IsHost
		}
	}
	return false
}

// MuteAll 主持人一键全员静音：向房间内所有其他参会人广播 mute_all 事件。
func (c *Controller) MuteAll(r *ghttp.Request) {
	var req v1.MeetingMuteAllReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	cu, ok := c.requireHostControl(r, req.Id)
	if !ok {
		return
	}
	websocket.DefaultHub.BroadcastControl(req.Id, cu.UserId, websocket.WsEvent{
		Type: "mute_all",
		Data: g.Map{"byUserId": cu.UserId},
	})
	glog.Infof(r.Context(), "host_control mute_all meetingId=%d byUserId=%d", req.Id, cu.UserId)
	response.OkWithMessage(r, "已向全体参会人发送静音指令")
}

// Kick 主持人移出指定参会人：通知被移出端、停掉其推流并从三方与本地会话移除。
func (c *Controller) Kick(r *ghttp.Request) {
	var req v1.MeetingKickReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	cu, ok := c.requireHostControl(r, req.Id)
	if !ok {
		return
	}
	target, found := c.registry.FindSessionByParticipant(req.Id, req.ParticipantId)
	if !found {
		response.Fail(r, "该成员已不在本系统会议会话中")
		return
	}
	if target.UserId == cu.UserId {
		response.Fail(r, "不能移出自己")
		return
	}
	// 先通过 WS 告知目标端已被移出，便于前端给出明确提示并清理本地音视频。
	websocket.DefaultHub.SendToUser(req.Id, target.UserId, websocket.WsEvent{
		Type: "kicked",
		Data: g.Map{"meetingId": req.Id, "reason": "你已被主持人移出会议"},
	})
	c.stopParticipantPublications(r, req.Id, target)
	if err := c.adapter.LeaveMeeting(r.Context(), target.ParticipantToken); err != nil && !isAlreadyGoneUpstream(err) {
		glog.Warningf(r.Context(), "kick 移出三方会议失败 meetingId=%d targetUserId=%d: %v", req.Id, target.UserId, err)
	}
	c.registry.Leave(req.Id, target.UserId)
	glog.Infof(r.Context(), "host_control kick meetingId=%d byUserId=%d targetUserId=%d participantId=%s",
		req.Id, cu.UserId, target.UserId, req.ParticipantId)
	response.OkWithMessage(r, "已将该成员移出会议")
}

// isHostCaller 判断当前请求者是否为该场会议的主持人（不写错误响应）。
func (c *Controller) isHostCaller(r *ghttp.Request, meetingId int64, cu Caller) bool {
	if session.IsManaged(meetingId) {
		m, err := c.meetingSvc.GetDetail(r.Context(), meetingId)
		return err == nil && service.CanManage(m, cu.UserId, cu.Account)
	}
	member, joined := c.registry.Session(meetingId, cu.UserId)
	number, known := c.registry.ExternalNoFor(meetingId)
	if !joined || !known {
		return false
	}
	state, err := c.adapter.GetMeetingState(r.Context(), member.ParticipantToken, number)
	return err == nil && canControlExternalRoom(state, member.ParticipantId)
}

// resolveHostUserId 查找房间内主持人的本系统 userId，用于推送改名审批请求。
func (c *Controller) resolveHostUserId(ctx context.Context, meetingId int64) int64 {
	if session.IsManaged(meetingId) {
		if m, err := c.meetingSvc.GetDetail(ctx, meetingId); err == nil && m != nil {
			if uid, ok := c.hostUserId(ctx, m); ok && uid > 0 {
				return uid
			}
		}
	}
	room, ok := c.registry.Room(meetingId)
	if !ok {
		return 0
	}
	if state := room.LastState(); state != nil {
		hostPid := state.Meeting.HostParticipantId
		if hostPid == "" {
			for _, p := range state.Participants {
				if p.IsHost {
					hostPid = p.ParticipantId
					break
				}
			}
		}
		if hostPid != "" {
			if sess, found := c.registry.FindSessionByParticipant(meetingId, hostPid); found {
				return sess.UserId
			}
		}
	}
	return 0
}

// applyMeetingTitle 落库（如为本系统会议）+ 写入房间缓存 + 全员广播。
func (c *Controller) applyMeetingTitle(ctx context.Context, meetingId int64, title, byName string) {
	if session.IsManaged(meetingId) {
		if err := c.meetingSvc.UpdateTitle(ctx, meetingId, title); err != nil {
			glog.Warningf(ctx, "会中更新会议名称落库失败 meetingId=%d: %v", meetingId, err)
		}
	}
	if room, ok := c.registry.Room(meetingId); ok {
		room.SetCustomTitle(title)
	}
	websocket.DefaultHub.BroadcastControl(meetingId, 0, websocket.WsEvent{
		Type: "title_changed",
		Data: g.Map{"meetingId": meetingId, "title": title, "byName": byName},
	})
}

// RenameTitle 会中修改会议名称：主持人直接生效，其他参会人发给主持人审批。
func (c *Controller) RenameTitle(r *ghttp.Request) {
	var req v1.MeetingRenameReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	newTitle := strings.TrimSpace(req.Title)
	if newTitle == "" {
		response.Fail(r, "会议名称不能为空")
		return
	}
	cu := c.callerOf(r)
	if _, joined := c.registry.Session(req.Id, cu.UserId); !joined && !c.isHostCaller(r, req.Id, cu) {
		response.Fail(r, "你尚未加入这场会议")
		return
	}
	requesterName := "参会成员"
	if room, ok := c.registry.Room(req.Id); ok {
		if ov := room.GetDisplayNameOverride(cu.UserId); ov != "" {
			requesterName = ov
		}
	}
	if requesterName == "参会成员" {
		if u, err := c.authSvc.GetMe(r.Context(), cu.UserId); err == nil && u != nil && u.DisplayName != "" {
			requesterName = u.DisplayName
		}
	}

	if c.isHostCaller(r, req.Id, cu) {
		c.applyMeetingTitle(r.Context(), req.Id, newTitle, requesterName)
		response.Ok(r, g.Map{"applied": true, "pending": false, "title": newTitle})
		return
	}

	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.Fail(r, "会议会话不存在")
		return
	}
	hostUid := c.resolveHostUserId(r.Context(), req.Id)
	if hostUid == 0 {
		response.Fail(r, "主持人当前不在会中，暂无法提交改名申请")
		return
	}
	if _, hostInRoom := c.registry.Session(req.Id, hostUid); !hostInRoom {
		response.Fail(r, "主持人当前不在会中，暂无法提交改名申请")
		return
	}
	treq := room.AddTitleRequest(cu.UserId, requesterName, newTitle)
	websocket.DefaultHub.SendToUser(req.Id, hostUid, websocket.WsEvent{
		Type: "title_change_request",
		Data: g.Map{
			"meetingId":     req.Id,
			"requestId":     treq.RequestId,
			"requesterName": treq.RequesterName,
			"newTitle":      treq.NewTitle,
		},
	})
	response.Ok(r, g.Map{"applied": false, "pending": true, "requestId": treq.RequestId, "title": newTitle})
}

// DecideRenameTitle 主持人审批非主持人的会中改名申请。
func (c *Controller) DecideRenameTitle(r *ghttp.Request) {
	var req v1.MeetingRenameDecisionReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	cu, ok := c.requireHostControl(r, req.Id)
	if !ok {
		return
	}
	room, exists := c.registry.Room(req.Id)
	if !exists {
		response.Fail(r, "会议会话不存在")
		return
	}
	treq, found := room.TakeTitleRequest(req.RequestId)
	if !found {
		response.Fail(r, "该改名申请已处理或已失效")
		return
	}
	if req.Approve {
		c.applyMeetingTitle(r.Context(), req.Id, treq.NewTitle, treq.RequesterName)
		websocket.DefaultHub.SendToUser(req.Id, treq.RequesterUserId, websocket.WsEvent{
			Type: "title_change_result",
			Data: g.Map{"meetingId": req.Id, "approved": true, "title": treq.NewTitle},
		})
		glog.Infof(r.Context(), "host_control approve_title meetingId=%d byUserId=%d newTitle=%q", req.Id, cu.UserId, treq.NewTitle)
		response.OkWithMessage(r, "已同意修改会议名称")
		return
	}
	websocket.DefaultHub.SendToUser(req.Id, treq.RequesterUserId, websocket.WsEvent{
		Type: "title_change_result",
		Data: g.Map{"meetingId": req.Id, "approved": false, "title": treq.NewTitle},
	})
	glog.Infof(r.Context(), "host_control reject_title meetingId=%d byUserId=%d newTitle=%q", req.Id, cu.UserId, treq.NewTitle)
	response.OkWithMessage(r, "已拒绝修改会议名称")
}

// RenameSelf 会中修改自己的名称：每人只能改自己。
// scope=session 仅本场会议临时修改（退出重进保持）；scope=permanent 同步修改外部账号显示名。
func (c *Controller) RenameSelf(r *ghttp.Request) {
	var req v1.MeetingRenameSelfReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	name := strings.TrimSpace(req.DisplayName)
	if name == "" {
		response.Fail(r, "显示名称不能为空")
		return
	}
	cu := c.callerOf(r)
	sess, joined := c.registry.Session(req.Id, cu.UserId)
	if !joined {
		response.Fail(r, "你尚未加入这场会议")
		return
	}
	if room, ok := c.registry.Room(req.Id); ok {
		room.SetDisplayNameOverride(cu.UserId, name)
	}
	if req.Scope == "permanent" && c.userSvc != nil {
		updated, err := c.userSvc.UpdateDisplayName(r.Context(), cu.UserId, name)
		if err != nil {
			response.Fail(r, err.Error())
			return
		}
		name = updated
	}
	websocket.DefaultHub.BroadcastControl(req.Id, 0, websocket.WsEvent{
		Type: "member_renamed",
		Data: g.Map{
			"meetingId":     req.Id,
			"participantId": sess.ParticipantId,
			"displayName":   name,
			"scope":         req.Scope,
		},
	})
	response.Ok(r, g.Map{"displayName": name, "scope": req.Scope})
}
