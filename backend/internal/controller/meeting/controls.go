package meeting

import (
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
	"github.com/gogf/gf/v2/os/glog"

	v1 "cloud-conference-backend/api/v1"
	"cloud-conference-backend/internal/response"
	"cloud-conference-backend/internal/service"
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
	// 外部会议：必须在会中
	if _, ok := c.registry.Session(meetingId, cu.UserId); !ok {
		response.Fail(r, "你尚未加入这场会议")
		return cu, false
	}
	return cu, true
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
