package meeting

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gogf/gf/v2/net/ghttp"
	"github.com/gogf/gf/v2/os/glog"
	"github.com/gogf/gf/v2/os/gtime"

	v1 "cloud-conference-backend/api/v1"
	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/errs"
	"cloud-conference-backend/internal/model"
	"cloud-conference-backend/internal/model/entity"
	"cloud-conference-backend/internal/response"
	"cloud-conference-backend/internal/service"
	"cloud-conference-backend/internal/service/thirdparty"
	"cloud-conference-backend/internal/session"
)

// RoomPump 由 WS Hub 实现：入会即拉起该会议的心跳轮询，不依赖前端再来连 WebSocket。
type RoomPump interface {
	EnsureRoom(meetingId int64)
}

// roiHintSuccess 是本进程成功上报到三方的累计次数，只用于日志采样计数。
var roiHintSuccess uint64

type Controller struct {
	meetingSvc *service.MeetingService
	authSvc    *service.AuthService
	dictSvc    *service.DictService
	adapter    *thirdparty.Adapter
	registry   *session.Registry
	pump       RoomPump
}

func New(meetingSvc *service.MeetingService, authSvc *service.AuthService, dictSvc *service.DictService, adapter *thirdparty.Adapter, registry *session.Registry, pump RoomPump) *Controller {
	return &Controller{meetingSvc: meetingSvc, authSvc: authSvc, dictSvc: dictSvc, adapter: adapter, registry: registry, pump: pump}
}

// Caller 是"这次请求是谁"的两件套：本库 userId + 他映射的三方账号。
// 主持人判定必须同时握这两个（第 6 项）：三方按账号认主持人，本库按 userId 认创建人。
type Caller struct {
	UserId  int64
	Account string
}

func (c *Controller) callerOf(r *ghttp.Request) Caller {
	userId := service.GetUserIdFromCtx(r.Context())
	cu := Caller{UserId: userId}
	if user, err := c.authSvc.GetMe(r.Context(), userId); err != nil {
		// 取不到三方账号只让 isHost 退成 false（少给两个按钮），不把整个请求拖失败。
		glog.Warningf(r.Context(), "取当前用户三方账号失败 user=%d: %v", userId, err)
		return cu
	} else {
		cu.Account = user.ThirdPartyAccount
	}
	return cu
}

// scheduleItems 取当前账号的日程全集（自己创建的 + 受邀的 + 加入过的）。三方按主持人账号过滤，
// 所以这里要带上登录用户映射的三方账号，不能只按 userId 查库。
func (c *Controller) scheduleItems(r *ghttp.Request) ([]service.ScheduleItem, Caller, error) {
	cu := c.callerOf(r)
	board, err := c.meetingSvc.ScheduleBoard(r.Context(), cu.UserId, cu.Account)
	return board, cu, err
}

func (c *Controller) List(r *ghttp.Request) {
	var req v1.MeetingListReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}

	board, cu, err := c.scheduleItems(r)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	list, total := service.FilterSchedule(board, req.Status, req.Keyword, req.OrderByColumn, req.IsAsc, req.PageNum, req.PageSize)

	brief := c.scheduleCreatorBrief(r.Context(), list)
	att := c.attendanceCountsFor(r.Context(), list)
	rows := make([]v1.MeetingVo, 0, len(list))
	for _, it := range list {
		rows = append(rows, c.scheduleToVo(r.Context(), it, brief, cu, att))
	}
	response.OkWithRows(r, rows, total)
}

func (c *Controller) Today(r *ghttp.Request) {
	board, cu, err := c.scheduleItems(r)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	list := service.TodaySchedule(board, gtime.Now())
	brief := c.scheduleCreatorBrief(r.Context(), list)
	att := c.attendanceCountsFor(r.Context(), list)
	result := make([]v1.MeetingVo, 0, len(list))
	for _, it := range list {
		result = append(result, c.scheduleToVo(r.Context(), it, brief, cu, att))
	}
	response.Ok(r, result)
}

func (c *Controller) Stats(r *ghttp.Request) {
	userId := service.GetUserIdFromCtx(r.Context())
	board, _, err := c.scheduleItems(r)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	stats := service.ScheduleStats(board, userId)
	response.Ok(r, v1.MeetingStatsRes{
		WeekCount:    stats.WeekCount,
		PendingCount: stats.PendingCount,
		MyCount:      stats.MyCount,
		TotalMinutes: stats.TotalMinutes,
	})
}

func (c *Controller) Detail(r *ghttp.Request) {
	var req v1.MeetingDetailReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	if !session.IsManaged(req.Id) {
		c.detailFromUpstream(r, req.Id)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	ok, verr := c.meetingSvc.VisibleToUser(r.Context(), req.Id, userId)
	if verr != nil {
		response.FailSystem(r, "请求处理失败", verr)
		return
	}
	if !ok {
		// 与「不存在」同文案：不向无关账号泄露这场会是否在库里。
		response.Fail(r, "会议不存在")
		return
	}
	m, err := c.meetingSvc.GetDetail(r.Context(), req.Id)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	brief := c.creatorBriefMap(r.Context(), []entity.MeetingAppointment{*m})
	response.Ok(r, c.meetingToVo(r.Context(), m, brief, c.callerOf(r)))
}

// detailFromUpstream 外部会议（只在三方建的会）库里没有预约单，详情只能实时问三方。
// 返回的仍是我方 MeetingVo：前端不必知道这场会是谁建的，也不因为多一个来源就多一套字段。
// 三方没给的字段（本系统同步态、入会默认静音、发起人档案、创建时间）留空，不用别的值凑数。
func (c *Controller) detailFromUpstream(r *ghttp.Request, roomKey int64) {
	ctx := r.Context()
	userId := service.GetUserIdFromCtx(ctx)
	cu := c.callerOf(r)
	number, ok := c.registry.ExternalNoFor(roomKey)
	if !ok {
		response.Fail(r, "会议不存在或已过期，请从日程重新进入")
		return
	}
	info, err := c.externalMeetingInfo(ctx, roomKey, userId, number)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	vo := v1.MeetingVo{
		Id:              roomKey,
		Title:           info.Title,
		MeetingNo:       firstNonEmpty(info.MeetingNumber, number),
		DurationMinutes: info.DurationMinutes,
		CloudRecord:     info.CloudRecord,
		HostName:        info.HostUsername,
		Status:          info.Status,
		IsHost:          cu.Account != "" && info.HostUsername == cu.Account,
	}
	if ms := info.StartedAtMs(); ms > 0 {
		started := gtime.NewFromTimeStamp(ms / 1000)
		vo.StartTime = formatTime(started)
		vo.StartedAt = formatTime(started)
	}
	response.Ok(r, vo)
}

// externalMeetingInfo 取外部会议的三方事实：已在会中用 /state（顺带刷新房间快照，成员与流都在里面），
// 没入会时用三方 join 前的按号查询 —— 日程里点开一场没参加的会不该要求先入会。
func (c *Controller) externalMeetingInfo(ctx context.Context, roomKey, userId int64, number string) (*thirdparty.MeetingInfo, error) {
	if room, okRoom := c.registry.Room(roomKey); okRoom {
		if sess, okSess := c.registry.Session(roomKey, userId); okSess {
			resp, err := c.adapter.GetMeetingState(ctx, sess.ParticipantToken, number)
			if err != nil {
				return nil, err
			}
			room.StoreState(resp, userId)
			return &resp.Meeting, nil
		}
	}
	bearer, err := c.authSvc.GetThirdPartyToken(ctx, userId)
	if err != nil {
		return nil, err
	}
	return c.adapter.GetMeetingByNumber(ctx, bearer, number)
}

func (c *Controller) Schedule(r *ghttp.Request) {
	var req v1.MeetingScheduleReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	user, err := c.authSvc.GetMe(r.Context(), userId)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	m, syncReason, err := c.meetingSvc.Schedule(r.Context(), userId, &service.ScheduleInput{
		Title: req.Title, StartTime: req.StartTime, DurationMinutes: req.DurationMinutes,
		CloudRecord: req.CloudRecord, HostAccount: user.ThirdPartyAccount,
		MuteOnJoin: req.MuteOnJoin == nil || *req.MuteOnJoin, CameraOffOnJoin: req.CameraOff != nil && *req.CameraOff,
		AllowWaiting:   req.AllowWaiting != nil && *req.AllowWaiting,
		ParticipantIds: req.ParticipantIds,
		LaunchKind:     "scheduled",
	})
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	brief := c.creatorBriefMap(r.Context(), []entity.MeetingAppointment{*m})
	vo := c.meetingToVo(r.Context(), m, brief, c.callerOf(r))
	if syncReason != "" {
		// 同快速会议：没同步成功就等于没约上，本地行已撤销，回失败而不是假装"已记录"。
		glog.Warningf(r.Context(), "预约没能同步到会议服务: %s", syncReason)
		response.Fail(r, syncReason)
		return
	}
	response.Ok(r, vo)
}

func (c *Controller) QuickStart(r *ghttp.Request) {
	var req v1.MeetingQuickStartReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	user, err := c.authSvc.GetMe(r.Context(), userId)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	duration := req.DurationMinutes
	if duration <= 0 {
		duration = 30
	}
	launchKind := service.NormalizeLaunchKind(req.LaunchKind, false)
	m, syncReason, err := c.meetingSvc.QuickStart(r.Context(), userId, &service.ScheduleInput{
		Title: req.Title, DurationMinutes: duration,
		CloudRecord: req.CloudRecord, HostAccount: user.ThirdPartyAccount,
		LaunchKind: launchKind,
		// 共享/语音都不采摄像头：共享靠屏幕轨，语音只走麦。
		CameraOffOnJoin: launchKind == "voice" || launchKind == "share",
	})
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	brief := c.creatorBriefMap(r.Context(), []entity.MeetingAppointment{*m})
	vo := c.meetingToVo(r.Context(), m, brief, c.callerOf(r))
	if syncReason != "" {
		// 三方没建成 = 这场会不存在（本地行已被撤销），必须如实回失败：
		// 从前这里回 200 +「已创建，但尚未同步」，用户以为建好了，实际得到一条清不掉的幽灵行。
		glog.Warningf(r.Context(), "快速会议没能同步到会议服务: %s", syncReason)
		response.Fail(r, syncReason)
		return
	}
	response.Ok(r, vo)
}

func (c *Controller) Start(r *ghttp.Request) {
	var req v1.MeetingStartReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	cu := c.callerOf(r)
	reason, err := c.meetingSvc.Start(r.Context(), req.Id, userId, cu.Account)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	if reason != "" {
		response.OkWithMessage(r, "会议未开始："+reason)
		return
	}
	response.OkWithMessage(r, "会议已开始")
}

func (c *Controller) Stop(r *ghttp.Request) {
	var req v1.MeetingStopReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	reason, err := c.meetingSvc.Stop(r.Context(), req.Id, userId)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	if reason != "" {
		// 不写"会议仍在运行："这种断言：reason 说"平台上已经不存在"时两句话自相矛盾。
		// 这里只陈述"没做成"，具体原因由 reason 自己说（实测非主持人停会会走到这句）。
		response.OkWithMessage(r, "没能结束这场会议："+reason)
		return
	}
	response.OkWithMessage(r, "会议已结束")
}

// Precheck 入会前预检（第 27 项）：前端在跳预检页之前先调一次，确认三方还能加入。
// 不实际入会、不占名额，只问三方"这场会还在不在"。
// 发现终态时顺手回写本地，让会议列表下次刷新就能拿到正确状态。
func (c *Controller) Precheck(r *ghttp.Request) {
	var req v1.MeetingPrecheckReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	ctx := r.Context()
	externalNo, local, err := c.meetingSvc.ResolveExternal(ctx, req.MeetingNo)
	if err != nil || externalNo == "" {
		message := "会议不存在或不由本系统管理"
		if msg := errs.BizMessage(err); msg != "" {
			message = msg
		}
		response.Ok(r, v1.MeetingPrecheckRes{Joinable: false, Message: message})
		return
	}
	userId := service.GetUserIdFromCtx(ctx)
	bearer, err := c.authSvc.GetThirdPartyToken(ctx, userId)
	if err != nil {
		response.FailSystem(r, "获取三方令牌失败", err)
		return
	}
	info, err := c.adapter.GetMeetingByNumber(ctx, bearer, externalNo)
	if err != nil {
		msg := err.Error()
		// 三方确认不存在或已结束 → 顺手回写本地，修掉列表"进行中"的过期显示。
		if local != nil {
			switch {
			case strings.Contains(msg, "meeting_ended"),
				strings.Contains(msg, "meeting_not_found"):
				_ = c.meetingSvc.SyncUpstreamStatus(ctx, local.Id, "ended")
			case strings.Contains(msg, "cancelled"):
				_ = c.meetingSvc.SyncUpstreamStatus(ctx, local.Id, "cancelled")
			}
		}
		response.Ok(r, v1.MeetingPrecheckRes{Joinable: false, Message: joinUserMessage(ctx, err)})
		return
	}
	// 三方说这场会已经不在运行中了 —— 虽然查到了，但状态是终态，不能入会。
	switch info.Status {
	case "ended", "finished", "closed", "cancelled", "failed":
		if local != nil {
			_ = c.meetingSvc.SyncUpstreamStatus(ctx, local.Id, info.Status)
		}
		response.Ok(r, v1.MeetingPrecheckRes{Joinable: false, Message: "会议已结束"})
		return
	}
	response.Ok(r, v1.MeetingPrecheckRes{Joinable: true})
}

// Join 完成三方入会并把参会令牌留在服务端（契约 §5.2）。
func (c *Controller) Join(r *ghttp.Request) {
	var req v1.MeetingJoinReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	user, err := c.authSvc.GetMe(r.Context(), userId)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	externalNo, local, err := c.meetingSvc.ResolveExternal(r.Context(), req.MeetingNo)
	if err != nil {
		// 业务拒绝（如"还没同步到会议服务"）原样上桌；其余收敛成系统异常。
		if msg := errs.BizMessage(err); msg != "" {
			response.Fail(r, msg)
			return
		}
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	if externalNo == "" {
		response.Fail(r, "会议不存在或不由本系统管理，请输入本系统预约的会议号")
		return
	}

	displayName := req.DisplayName
	if displayName == "" {
		displayName = user.DisplayName
	}
	// 第 10 项：这场会开了「允许成员在主持人入会前等待」而主持人还没到 —— 不把这个端放进三方。
	// 三方没有等候室能力（新版接口文档 20260928 的 scheduleMeeting 没有相关字段），
	// 但"要不要真的加入"这个决定权在我方后端手里，所以门禁做在这一侧：不进三方 = 不占参会名额、
	// 不收流、也不让主持人以为已经有人坐在会里。前端拿到 waiting=true 就停在"等待主持人"页
	// 定时重试入会 —— 主持人到场后同一次请求自然通过，不需要额外的放行信令。
	// 主持人自己入会不能拦：否则预约人永远进不去自己建的会（hostInMeeting 查的是"主持人到了没"，
	// 而主持人就是当前用户时这个问题无意义——他到了才算到）。
	if local != nil && local.AllowWaiting == 1 && !service.CanManage(local, userId, user.ThirdPartyAccount) {
		roomKey := c.registry.RoomKey(local.Id, externalNo)
		if !c.hostInMeeting(r.Context(), local, roomKey) {
			response.Ok(r, v1.MeetingJoinRes{
				MeetingId:    roomKey,
				MeetingNo:    externalNo,
				Title:        local.Title,
				Status:       local.Status,
				InitialMedia: v1.InitialMediaVo{MicOff: local.MuteOnJoin == 1, CameraOff: local.CameraOffOnJoin == 1},
				Kind:         service.NormalizeLaunchKind(local.LaunchKind, local.Status == consts.MeetingStatusScheduled),
				Waiting:      true,
			})
			return
		}
	}
	endpointType, deviceID := service.JoinEndpoint(r.Context())
	var result *thirdparty.JoinResult
	err = c.authSvc.WithTokenRetry(r.Context(), userId, func(token string) error {
		res, callErr := c.adapter.JoinMeeting(r.Context(), token, &thirdparty.JoinReq{
			MeetingNumber:    externalNo,
			DisplayName:      displayName,
			AccountName:      user.ThirdPartyAccount,
			EndpointType:     endpointType,
			DeviceId:         deviceID,
			ClientId:         webClientId(userId),
			RecordingConsent: req.RecordingConsent,
		})
		if callErr == nil {
			result = res
		}
		return callErr
	})
	if err != nil {
		// 三方已自行结束会议时，顺手把本地状态改过来，别让首页一直挂"进行中"。
		if local != nil && strings.Contains(err.Error(), "meeting_ended") {
			if syncErr := c.meetingSvc.SyncUpstreamStatus(r.Context(), local.Id, "ended"); syncErr != nil {
				glog.Warningf(r.Context(), "入会被拒后回写会议 %d 终态失败: %v", local.Id, syncErr)
			}
		}
		response.Fail(r, joinUserMessage(r.Context(), err))
		return
	}

	var localId int64
	var thirdPartyId string
	title := ""
	kind := "quick"
	initial := v1.InitialMediaVo{}
	status := result.State.Status
	if local != nil {
		localId = local.Id
		thirdPartyId = local.ThirdPartyMeetingId
		title = local.Title
		kind = service.NormalizeLaunchKind(local.LaunchKind, local.Status == consts.MeetingStatusScheduled)
		initial = v1.InitialMediaVo{MicOff: local.MuteOnJoin == 1, CameraOff: local.CameraOffOnJoin == 1}
		if local.StartedAt == nil && result.Meeting.StartedAtMs() > 0 {
			c.meetingSvc.BackfillStartedAt(r.Context(), local.Id, gtime.NewFromTimeStamp(result.Meeting.StartedAtMs()/1000))
		}
	}
	// 外部会议（本库无预约单）的日程事实只能实时取自三方：主题与三方会议 id 都从入会响应拿，
	// 不留空——否则录制/板卡这类按三方会议 id 操作的功能对它就直接不可用。
	if thirdPartyId == "" {
		thirdPartyId = result.Meeting.MeetingId
	}
	if title == "" {
		title = result.Meeting.Title
	}
	// 前端后续所有 /meetings/{id}/... 与 WS 握手都拿这个键回传，因此它必须唯一标识这场会。
	roomKey := c.registry.RoomKey(localId, externalNo)
	c.registry.Join(roomKey, externalNo, thirdPartyId, &session.Session{
		UserId:           userId,
		ParticipantId:    result.ParticipantId,
		ParticipantToken: result.ParticipantToken,
		JoinedAt:         gtime.Now().Time,
	})
	// 三方心跳兼令牌续期，必须从入会这一刻就有人负责，而不是等前端连上 WebSocket 才开始。
	if c.pump != nil {
		c.pump.EnsureRoom(roomKey)
	}
	// 第 5 项：进过这场会是一次事实，落库后"加入过的会议"才能在列表里出现。
	c.meetingSvc.RecordAttendance(r.Context(), thirdPartyId, externalNo, localId, userId)

	response.Ok(r, v1.MeetingJoinRes{
		MeetingId:     roomKey,
		MeetingNo:     externalNo,
		ParticipantId: result.ParticipantId,
		Title:         title,
		Status:        status,
		InitialMedia:  initial,
		Kind:          kind,
	})
}

func (c *Controller) Leave(r *ghttp.Request) {
	var req v1.MeetingLeaveReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	sess, ok := c.registry.Session(req.MeetingId, userId)
	if !ok {
		// 服务端已经没有这个端的会话（会话被闲置回收、后端重启、上游判死后被剔除）：
		// 用户要的"离开"此刻已经成立，再回一句报错就是把成功说成故障（第 40 项）。
		glog.Warningf(r.Context(), "离会时本地已无会话 meeting=%d user=%d，按已完成处理", req.MeetingId, userId)
		c.registry.Leave(req.MeetingId, userId)
		response.OkWithMessage(r, "已离开会议")
		return
	}
	// 离会前先拆掉这个端的全部发布：三方不会替我们收尸——留着 screen 发布会把共享位
	// 永久占住（别人报 screen_share_in_use），现场还挂着一串 not-ready 僵尸流。
	c.stopParticipantPublications(r, req.MeetingId, sess)
	// 本端订阅过的远端流同样要拆：人走了 WHEP 会话还挂在三方，接收通道不会自己释放。
	if room, ok := c.registry.Room(req.MeetingId); ok {
		c.releaseWhepSessions(r, room.TakeWhepForUser(userId))
	}
	if err := c.adapter.LeaveMeeting(r.Context(), sess.ParticipantToken); err != nil {
		if !isAlreadyGoneUpstream(err) {
			response.FailSystem(r, "离开会议失败", err)
			return
		}
		// 上游已经把这个端判死（同账号被顶号、心跳超时）或会已散：离开这个动作没有还能失败的对象。
		glog.Warningf(r.Context(), "离会时上游已无此端 meeting=%d user=%d: %v", req.MeetingId, userId, err)
	}
	c.registry.Leave(req.MeetingId, userId)
	response.OkWithMessage(r, "已离开会议")
}

// isAlreadyGoneUpstream 认出"这个端在上游已经不在会中了 / 这场会已经没了"。
// 这两类对离会、关注这类收尾动作来说是幂等成功，不是故障。
func isAlreadyGoneUpstream(err error) bool {
	return err != nil && (strings.Contains(err.Error(), "participant_not_joined") || isMeetingGone(err))
}

// stopParticipantPublications 停掉某参会者当前仍活跃的全部发布并解绑 WHIP 会话。
func (c *Controller) stopParticipantPublications(r *ghttp.Request, meetingId int64, sess *session.Session) {
	room, ok := c.registry.Room(meetingId)
	if !ok {
		return
	}
	state := room.State()
	if state == nil {
		return
	}
	for _, pub := range state.Publications {
		if pub.ParticipantId != sess.ParticipantId || pub.Status == "stopped" || pub.Status == "failed" {
			continue
		}
		if _, err := c.adapter.StopPublication(r.Context(), sess.ParticipantToken, pub.PublicationId); err != nil {
			glog.Warningf(r.Context(), "离会清理发布 %s 失败: %v", pub.PublicationId, err)
		}
		room.UnbindWhip(pub.PublicationId)
	}
}

func (c *Controller) End(r *ghttp.Request) {
	var req v1.MeetingEndReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	sess, ok := c.registry.Session(req.MeetingId, userId)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	if err := c.adapter.EndMeetingAsHost(r.Context(), sess.ParticipantToken); err != nil {
		response.FailSystem(r, "结束会议失败", err)
		return
	}
	// 上游已经把会结束，本地必须同时落终态：否则列表里这场会永远挂着"进行中"，
	// 只有还有人留在会中拉状态时才会被顺带回写（第 13 项）。
	if err := c.meetingSvc.SyncUpstreamStatus(r.Context(), req.MeetingId, "ended"); err != nil {
		glog.Warningf(r.Context(), "结束会议后回写 %d 终态失败: %v", req.MeetingId, err)
	}
	response.OkWithMessage(r, "会议已结束")
}

// State 返回入会首屏所需的全量状态。
func (c *Controller) State(r *ghttp.Request) {
	var req v1.MeetingStateReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	vo, err := c.buildState(r, req.Id)
	if err != nil {
		response.FailSystem(r, "查询会议状态失败", err)
		return
	}
	response.Ok(r, vo)
}

func (c *Controller) Focus(r *ghttp.Request) {
	var req v1.MeetingFocusReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	alias, ok := room.ResolveStream(req.StreamId)
	if !ok {
		response.Fail(r, "该流已结束")
		return
	}
	sess, ok := c.registry.Session(req.Id, userId)
	if !ok {
		// 不能吞掉 ok：下面直接取 sess.ParticipantToken，非成员进来就是 nil 解引用（panic）。
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	if err := c.adapter.FocusPublication(r.Context(), sess.ParticipantToken, alias.PublicationId); err != nil {
		// 发布已终止是参会端要据此清瓦片的业务事实，其余失败原因只进日志。
		if strings.Contains(err.Error(), "publication_not_active") {
			response.Fail(r, "该流已结束")
			return
		}
		if strings.Contains(err.Error(), "participant_not_joined") {
			// 本端在上游已经不在会中（同账号被另一台设备顶号、心跳被判死）。这是"该离开会中页"
			// 的业务事实，不是我方坏了：回 not_in_meeting，别弹「系统异常」（第 6/34 项）。
			response.FailSystem(r, "关注该流失败", errs.BizReason(errs.Bizf("本端会议会话已失效，请重新入会"), "not_in_meeting"))
			return
		}
		response.FailSystem(r, "关注该流失败", err)
		return
	}
	response.OkWithMessage(r, "已关注")
}

// Recording 会中录制开关（本域语义，后端决定用哪个上游能力实现）。
func (c *Controller) Recording(r *ghttp.Request) {
	var req v1.MeetingRecordingReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	sess, ok := c.registry.Session(req.Id, userId)
	if !ok {
		// 同上：下面要取 sess.ParticipantToken，非成员进来不能让它成 nil。
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	if room.ThirdPartyId == "" {
		response.Fail(r, "该会议尚未同步到录制服务，无法在会中开关录制")
		return
	}
	bearer, err := c.authSvc.GetThirdPartyToken(r.Context(), userId)
	if err != nil {
		response.FailSystem(r, "获取录制服务令牌失败", err)
		return
	}
	if req.Action == "start" {
		err = c.adapter.StartBoardRecording(r.Context(), bearer, sess.ParticipantToken, room.ThirdPartyId)
	} else {
		err = c.adapter.StopBoardRecording(r.Context(), bearer, sess.ParticipantToken, room.ThirdPartyId)
	}
	if err != nil {
		response.Fail(r, recordingUserMessage(r.Context(), err))
		return
	}
	resp, err := c.adapter.GetMeetingState(r.Context(), sess.ParticipantToken, room.ExternalNo)
	if err != nil {
		response.FailSystem(r, "录制指令已发出，但状态拉取失败", err)
		return
	}
	room.StoreState(resp, userId)
	c.registry.Room(req.Id)
	vo := service.BuildMeetingStateVo(req.Id, resp, room, c.roster(r.Context(), req.Id))
	response.Ok(r, v1.MeetingRecordingRes{Recording: vo.Recording})
}

// Media 代理上游媒体流：前端只认我方路径与 JWT，上游令牌在此注入。
func (c *Controller) Media(r *ghttp.Request) {
	meetingId := r.GetRouter("id").Int64()
	streamId := r.GetRouter("streamId").String()
	kind := r.GetRouter("kind").String()
	userId := service.GetUserIdFromCtx(r.Context())

	room, ok := c.registry.Room(meetingId)
	if !ok {
		response.FailStream(r, http.StatusUnauthorized, "请先加入会议")
		return
	}
	alias, ok := room.ResolveStream(streamId)
	if !ok {
		response.FailStream(r, http.StatusNotFound, "该流已结束")
		return
	}
	sess, ok := c.registry.Session(meetingId, userId)
	if !ok {
		response.FailStream(r, http.StatusUnauthorized, "请先加入会议")
		return
	}
	// 来取流这件事本身就是"我要收这路"的意图，先把它报给上游再解析地址：
	// 实测没人关注的流会被饿着（下行 ~70kbps、首字节 700ms+，关注后 ~176kbps、1ms），
	// 而前端那次 fire-and-forget 的关注上报和这里的取流是并发的，等它落地再来取就晚了。
	c.focusPublication(r.Context(), room, sess, alias.PublicationId)
	state, source, gone := c.stateWithPublication(r.Context(), room, sess, alias.PublicationId)
	if gone {
		// 终态：回 410。前端把 404/410 判成"这路已经没了"（不重试、不挂红字），等下一轮 state 摘掉死流；
		// 回 503「还在准备中」等于让它每 1.5 秒再取一次一个已经不存在的会议，表现就是"起播失败"。
		response.FailStream(r, http.StatusGone, "这场会议已经结束，媒体不再可用")
		return
	}
	if state == nil {
		response.FailStream(r, http.StatusServiceUnavailable, "会议状态尚未就绪，请稍后重试")
		return
	}
	pub, target, accept, whyNot := pickStreamURL(state, alias.PublicationId, kind)
	if pub.PublicationId != "" && pub.PublicationId != alias.PublicationId {
		// 实际要打开的是兄弟别名（订到的那条还没 ready）：关注必须跟着改报，
		// 否则上游按"没人关注"把真正在播的那条饿掉。
		c.focusPublication(r.Context(), room, sess, pub.PublicationId)
		glog.Infof(r.Context(), "改用就绪别名取流 meeting=%d stream=%s kind=%s 订正=%s→%s",
			meetingId, streamId, kind, alias.PublicationId, pub.PublicationId)
	}
	// 定责用：直连腿的 Accept 完全由编码判定决定，判错就换来一个永不就绪的 425。
	if kind == "video" && target != "" {
		glog.Debugf(r.Context(), "直连取流 pub=%s sourceType=%s directVideoCodec=%q directVideoFormat=%q 判定=%s accept=%s",
			pub.PublicationId, pub.SourceType, pub.DirectVideoCodec, pub.DirectVideoFormat, pub.VideoCodec(), accept)
	}
	if target == "" {
		// whyNot 只进日志：它是"上游怎么没给这条发布"的诊断线索，不是给用户看的话。
		glog.Warningf(r.Context(), "解析流失败 meeting=%d stream=%s kind=%s publication=%s 来源=%s 可见发布=%s 原因=%s",
			meetingId, streamId, kind, alias.PublicationId, source, publicationSummary(state), whyNot)
		response.FailStream(r, http.StatusServiceUnavailable, "这路媒体还在准备中，请稍后重试")
		return
	}
	body, header, err := c.adapter.OpenStream(r.Context(), sess.ParticipantToken, target, accept)
	if err != nil {
		glog.Warningf(r.Context(), "打开流失败 meeting=%d stream=%s kind=%s publication=%s 投放=%s 来源=%s 可见发布=%s: %v",
			meetingId, streamId, kind, alias.PublicationId, accept, source, publicationSummary(state), err)
		if isStreamWarmingUp(err) {
			// 上游回 425「还没准备好」不是故障：稍后再取就有结果。用 503 说清，
			// 前端才不会把它当终态挂进长冷却，用户看到的是"还在准备"而不是"起播失败"。
			response.FailStream(r, http.StatusServiceUnavailable, "这路媒体还在准备中，请稍后重试")
			return
		}
		response.FailStream(r, http.StatusBadGateway, "这路媒体暂时无法接通，请稍后重试")
		return
	}
	defer body.Close()

	r.Response.Header().Set("Content-Type", accept)
	r.Response.Header().Set("Cache-Control", "no-store")
	// 三方播放器会校验这个头来确认"这路确实经过云端转码"，漏传会导致起播被拒
	// （实测报 direct_video_transcode_guard_failed）。
	if tc := header.Get("X-ZWT-Cloud-Transcode"); tc != "" {
		r.Response.Header().Set("X-ZWT-Cloud-Transcode", tc)
	}
	if cl := header.Get("Content-Length"); cl != "" {
		r.Response.Header().Set("Content-Length", cl)
	}
	r.Response.Status = http.StatusOK
	io.Copy(r.Response.Writer, body) //nolint:errcheck
}

// focusPublication 把"这一端要收这路发布"报给上游。失败只进日志：关注影响的是码率与
// 这路在我方状态里的可见性，取流本身仍值得继续试，不能因为一次上报失败就把人挡在会中页外。
func (c *Controller) focusPublication(ctx context.Context, room *session.MeetingRoom, sess *session.Session, pubId string) {
	if err := c.adapter.FocusPublication(ctx, sess.ParticipantToken, pubId); err != nil {
		glog.Warningf(ctx, "上报关注失败 meeting=%d publication=%s: %v", room.MeetingId, pubId, err)
	}
}

// isStreamWarmingUp 认出上游的"这路还没好"（425 / not_ready 一类）：那是会自己变好的中间态，
// 不是故障，也不该带着三方术语抛给前端。
func isStreamWarmingUp(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, " 425") || strings.Contains(msg, "not_ready")
}

// stateWithPublication 保证"要订阅的发布"在可见状态里：流别名由泵先签发、房间缓存随后才更新，
// 前端拿到新流立刻订阅时缓存里往往还没有这条发布（实测报"上游未回报该发布"）。
// 命中不了就实时回源三方拉一次——只用于本次解析，不覆盖泵缓存，避免拿旧快照踩掉新状态。
// 第二个返回值标明状态出处，失败时能一眼看出是"缓存陈旧"还是"上游真没给"。
// 第三个返回值是"上游已经没有这场会了"（实测 404 meeting_not_found）：这是终态，
// 不能继续回 503「还在准备中」——那会让前端按可重试的中间态一直取，用户看到的就是"起播失败"。
func (c *Controller) stateWithPublication(ctx context.Context, room *session.MeetingRoom, sess *session.Session, pubId string) (*thirdparty.MeetingResponse, string, bool) {
	// 只认**本人为这个用户拉的那一份**缓存：状态里的订阅地址嵌着绑定参会者的票据，
	// 复用别人的等于拿 A 的凭证去订 B 的订阅，三方回 401。
	st := room.StateFor(sess.UserId)
	if st != nil {
		for _, p := range st.Publications {
			if p.PublicationId == pubId {
				return st, "房间缓存", false
			}
		}
	}
	// ThirdPartyIds 的返回顺序是 (会议号, 会议ID)。/state 的路径参数只认**会议号**，
	// 传成会议ID 上游一律回 404 meeting_not_found（实测 2026-09-28：缓存未命中时
	// 每次回源都 404，于是"刚入会那位的发布"永远解析不出来 → 别人看不到他）。
	externalNo := room.ExternalMeetingNo()
	fresh, err := c.adapter.GetMeetingState(ctx, sess.ParticipantToken, externalNo)
	if err != nil {
		glog.Warningf(ctx, "订阅流时实时拉取会议状态失败 meeting=%d 号=%s: %v", room.MeetingId, externalNo, err)
		return st, "房间缓存(回源失败)", isMeetingGone(err)
	}
	for _, p := range fresh.Publications {
		if p.PublicationId == pubId {
			return fresh, "回源状态", false
		}
	}
	return fresh, "回源状态(不含该发布)", false
}

// isMeetingGone 认上游的"这场会不在了"（404 / meeting_not_found）。
// 与会自己刚结束、泵缓存还留着旧流别名的场景配对出现，是订阅路径上的常态而不是异常。
func isMeetingGone(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "meeting_not_found") || strings.Contains(msg, " 404")
}

// publicationSummary 把状态里的发布列成一行，供解析失败时定位"上游到底回报了哪些发布"。
// 每条带：媒体种类 / 状态 / 直连腿有无 / RK 腿的形状（投递模式、接收槽号、路径、来源类型）。
// RK 那几样是判"这条远端发布到底有没有接收槽"的唯一现场证据 —— 路径本身不是凭据，
// 但地址一律不打印（ticket 在三方 URL 的 query 里，见 thirdparty.LoggableTarget）。
func publicationSummary(state *thirdparty.MeetingResponse) string {
	if state == nil {
		return "(无状态)"
	}
	ids := make([]string, 0, len(state.Publications))
	for _, p := range state.Publications {
		urls := ""
		if p.DirectVideoUrl != "" {
			urls += "视频"
		}
		if p.DirectAudioUrl != "" {
			urls += "+音频"
		}
		if urls == "" {
			urls = "无直连"
		}
		rk := ""
		if p.RkDeliveryMode != "" || p.RkReceiverLaneId > 0 || p.RkReceiverPath != "" || p.RkReceiverWhepUrl != "" {
			whep := "无"
			if p.RkReceiverWhepUrl != "" {
				whep = "有"
			}
			rk = fmt.Sprintf(" rk{mode=%s lane=%d path=%s whep=%s}", p.RkDeliveryMode, p.RkReceiverLaneId, p.RkReceiverPath, whep)
		}
		src := ""
		if p.SourceType != "" {
			src = " src=" + p.SourceType
		}
		ids = append(ids, fmt.Sprintf("%s(%s/%s/%s%s%s)", p.PublicationId, p.MediaKind, p.Status, urls, src, rk))
	}
	return strings.Join(ids, " ")
}

// findPublication 按上游 publicationId 取回那条发布。
func findPublication(state *thirdparty.MeetingResponse, publicationId string) (thirdparty.Publication, bool) {
	for _, p := range state.Publications {
		if p.PublicationId == publicationId {
			return p, true
		}
	}
	return thirdparty.Publication{}, false
}

// subscribableAliases 把"同一位成员、同一种媒体"的上游别名按此刻能不能打开排序：ready 的排最前。
//
// 上游在同一路媒体重推时会同时留着新旧两个 publicationId：旧的还 ready、新的刚 publishing。
// 只按订到的那条取地址，实测（2026-09-28 会议 90）每轮都是 425 direct_video_not_ready ——
// 前端就一直挂着"这路媒体还在准备中"，而能播的兄弟别名就在同一份快照里。
func subscribableAliases(state *thirdparty.MeetingResponse, publicationId string) []thirdparty.Publication {
	self, ok := findPublication(state, publicationId)
	if !ok {
		return nil
	}
	ready := make([]thirdparty.Publication, 0, 2)
	unready := make([]thirdparty.Publication, 0, 2)
	requested := make([]thirdparty.Publication, 0, 1)
	for _, p := range state.Publications {
		if p.ParticipantId != self.ParticipantId || p.MediaKind != self.MediaKind {
			continue
		}
		if p.Status == "stopped" || p.Status == "failed" {
			continue
		}
		switch {
		case p.Status == "ready":
			ready = append(ready, p)
		case p.PublicationId == publicationId:
			requested = append(requested, p)
		default:
			unready = append(unready, p)
		}
	}
	return append(append(ready, requested...), unready...)
}

// pickStreamURL 选出可播地址，并带回这条地址所属的发布（调用方要按它上报关注）。
// 返回的 whyNot 用于把"为什么没有可播格式"说清楚 ——
// 只回一句"暂不可接收"会让人对着上游猜（音频只有 WHEP 兜底、没有直连地址时尤其容易误判）。
func pickStreamURL(state *thirdparty.MeetingResponse, publicationId, kind string) (thirdparty.Publication, string, string, string) {
	cands := subscribableAliases(state, publicationId)
	if len(cands) == 0 {
		return thirdparty.Publication{}, "", "", "上游未回报该发布"
	}
	for _, p := range cands {
		if kind == "audio" {
			if p.DirectAudioUrl != "" {
				return p, p.DirectAudioUrl, thirdparty.AcceptZaa1Aac, ""
			}
			continue
		}
		if p.DirectVideoUrl != "" {
			// 协商头跟着这一路的实际编码走，不是一律 h264：经边端 RKMPP 处理的那一路
			// 只有 HEVC 这条腿，按 h264 取会拿到一个永远不会就绪的 425。
			return p, p.DirectVideoUrl, thirdparty.AcceptForVideoCodec(p.VideoCodec()), ""
		}
	}
	// 这条通路只有 GET 拉流一种形态，因此只认直连压缩流；WHEP 那条腿要 POST + SDP，
	// 由 /streams/:id/whep 单独走，两件事不许混在一个端点里。
	req, _ := findPublication(state, publicationId)
	if kind == "audio" {
		return req, "", "", audioChannelsHint(req)
	}
	return req, "", "", videoChannelsHint(req)
}

// audioChannelsHint 说清上游给了哪些音频通道、本端为什么用不了 —— 只回一句"暂不可接收"
// 会让人对着上游猜（音频只有板卡通道、没有云端 WHEP 时尤其容易误判）。
func audioChannelsHint(p thirdparty.Publication) string {
	switch {
	case p.DirectAudioUrl != "":
		return "上游有直连音频地址，请走音频直连代理"
	case p.AudioWhepUrl != "":
		return "上游有云端 WHEP 音频通道，请走 WHEP 订阅接口"
	case p.RkReceiverAudioWhepUrl != "":
		return "上游只给了船端同局域网的音频通道，岸端页面连不通它"
	}
	return "上游未给该音频发布任何通道"
}

// videoChannelsHint 说清上游给了哪些视频通道、这条 GET 通路为什么用不了（只进日志）。
// 与音频那条同一用途：只回一句"无可用直连流"会让人对着上游猜，而"上游只给了船端局域网 WHEP"
// 在边端实例上是**能用的**，该走 /streams/:id/whep（2026-10-10 实测：船端形态下网关一条直连地址都不给）。
func videoChannelsHint(p thirdparty.Publication) string {
	switch {
	case p.DirectVideoUrl != "":
		return "上游有直连视频地址，请走视频直连代理"
	case p.RkReceiverWhepUrl != "" || p.RkReceiverPath != "":
		return "上游只给了船端局域网的 WHEP 视频通道，请走 WHEP 订阅接口"
	}
	return "上游未给该视频发布任何通道"
}

// WsTicket 给 WebSocket 握手用的一次性短时票。
func (c *Controller) WsTicket(r *ghttp.Request) {
	var req v1.WsTicketReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	if _, ok := c.registry.Session(req.MeetingId, userId); !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	ticket, ttl, err := c.registry.IssueWsTicket(r.Context(), userId, req.MeetingId)
	if err != nil {
		response.FailSystem(r, "签发连接票失败", err)
		return
	}
	response.Ok(r, v1.WsTicketRes{Ticket: ticket, ExpiresInSeconds: int(ttl.Seconds())})
}

// roster 取本域补充信息（受邀名单 + 账号头像）。名单读失败只降级为空，
// 不能因为通讯录出问题就把整个会中状态接口打挂——画面和成员比"谁还没来"更要紧。
func (c *Controller) roster(ctx context.Context, meetingId int64) *service.Roster {
	invitees, err := service.LoadInvitees(ctx, meetingId)
	if err != nil {
		invitees = nil
	}
	return &service.Roster{Invitees: invitees, Avatars: service.LoadAvatarByAccount(ctx)}
}

func (c *Controller) buildState(r *ghttp.Request, meetingId int64) (*model.MeetingStateVo, error) {
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(meetingId)
	if !ok {
		return nil, c.noMeetingError(r.Context(), meetingId, nil)
	}
	sess, ok := c.registry.Session(meetingId, userId)
	if !ok {
		return nil, c.noMeetingError(r.Context(), meetingId, room)
	}
	c.registry.Touch(meetingId, userId)
	resp, err := c.adapter.GetMeetingState(r.Context(), sess.ParticipantToken, room.ExternalNo)
	if err != nil {
		// 上游说"这端不在会中/会已终"时，前端要的是离开会中页，不是一句系统异常。
		if isUpstreamGone(err) {
			if st, terminal := c.meetingTerminalStatus(r.Context(), meetingId, room); terminal {
				return nil, errs.BizReason(terminalMeetingError(st), "not_in_meeting")
			}
			return nil, errs.BizReason(errs.Bizf("请先加入会议"), "not_in_meeting")
		}
		return nil, err
	}
	room.StoreState(resp, userId)
	c.registry.BindPublicationIds(meetingId, resp.Publications)
	// 三方可能已自行结束会议（时长耗尽），这里顺手把终态回写本地。
	if err := c.meetingSvc.SyncUpstreamStatus(r.Context(), meetingId, resp.Meeting.Status); err != nil {
		glog.Warningf(r.Context(), "回写会议 %d 终态失败: %v", meetingId, err)
	}
	vo := service.BuildMeetingStateVo(meetingId, resp, room, c.roster(r.Context(), meetingId))
	return vo, nil
}

// isUpstreamGone 判断上游的失败是不是"这端已经不在这场会里 / 会已经开完"。
// 这类失败对前端是一个动作（离开会中页），不是故障，不能报系统异常。
func isUpstreamGone(err error) bool {
	msg := err.Error()
	for _, m := range []string{"participant_not_joined", "meeting_ended", "meeting_not_running", "meeting_not_found", "session_not_found"} {
		if strings.Contains(msg, m) {
			return true
		}
	}
	return false
}

// meetingTerminalStatus 找出这场会已知的终态：先看房间缓存，再看预约单。
// 两个来源都拿不到终态时返回 false —— 那时"取不到状态"就真是故障，不能编一句"会议已结束"。
func (c *Controller) meetingTerminalStatus(ctx context.Context, meetingId int64, room *session.MeetingRoom) (string, bool) {
	if room != nil {
		if st := room.State(); st != nil && service.IsTerminalStatus(st.Meeting.Status) {
			return st.Meeting.Status, true
		}
	}
	if session.IsManaged(meetingId) {
		if m, err := c.meetingSvc.GetDetail(ctx, meetingId); err == nil && service.IsTerminalStatus(m.Status) {
			return m.Status, true
		}
	}
	return "", false
}

// noMeetingError 把"取不到这场会的状态"说成前端能区分的话：终态就说终态，本端没在会中就说
// 请先加入会议，两边都拿不到事实（外部会议的键、库里没有预约单）才说"不存在或已结束"。
// room 为 nil 表示服务端已经没有这场会的房间（无人入会或后端重启过）。
// 这几类都带 reason=not_in_meeting：它们对前端是同一个动作 —— 离开会中页，而不是弹一句报错。
func (c *Controller) noMeetingError(ctx context.Context, meetingId int64, room *session.MeetingRoom) error {
	if st, terminal := c.meetingTerminalStatus(ctx, meetingId, room); terminal {
		return errs.BizReason(terminalMeetingError(st), "not_in_meeting")
	}
	if room != nil || session.IsManaged(meetingId) {
		return errs.BizReason(errs.Bizf("请先加入会议"), "not_in_meeting")
	}
	return errs.BizReason(errs.Bizf("会议不存在或已结束"), "not_in_meeting")
}

// terminalMeetingError 用三方的终态词选一句本域中文：ended/cancelled/failed 是同一件事的三种
// 结束方式，前端要能分清"会开完了"和"会被撤了"。
func terminalMeetingError(status string) error {
	switch status {
	case consts.MeetingStatusCancelled:
		return errs.Bizf("会议已取消")
	case consts.MeetingStatusFailed:
		return errs.Bizf("会议已异常结束")
	}
	return errs.Bizf("会议已结束")
}

// subscribeUserMessage 把订阅侧失败翻成一句本域中文。原始错误只进日志：那里头有上游地址、
// 协议名和运行时错误，用户看不懂也做不了任何事（第 10/34 项）。
//
// legKind 是这条腿的机器值（video/audio），用户文案里的感官词由它派生 —— 不拿显示词做判据，
// 那样一改措辞分支就静默失灵。音频腿共用"画面"那句是错的（实测两侧同屏）。
// everHadMedia 只回答一件事 —— **这位用户在这条腿上真的收到过媒体吗**。它改变的是
// "槽里没流"那一句的说法，因为那一个上游回答对应两件不同的事实。
func subscribeUserMessage(err error, legKind string, everHadMedia bool) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "participant_not_joined"):
		return "请先加入会议"
	case strings.Contains(msg, "meeting_ended"), strings.Contains(msg, "meeting_not_found"):
		return "会议已结束，这路媒体不再可用"
	case strings.Contains(msg, "deadline"), strings.Contains(msg, "timeout"), strings.Contains(msg, "connection refused"):
		return "媒体服务没有回应，正在重试"
	case slotHasNoStream(err):
		// 网关**认得**这条槽却回答"里面没流"：船端 RK 的接收进程没在把云端流灌进 `rkReceiverPath`。
		// 实测 2026-10-12 从本机免凭据直 POST 那条槽，回的是同一句 —— 与我方 SDP/令牌/取址无关。
		word := "画面"
		if legKind == consts.WhepKindAudio {
			word = "声音"
		}
		if !everHadMedia {
			// 这一路**从来没起来过**：实测两场会里三条这样的发布，在各自四套实例逐次回源的
			// 快照中 ready 均为 0 次（会 90 的 `pub…343` 是 0/1833，会 91 的 `…353/360/370` 是 0/135）。
			// 对这样的路说"已中断"是断言了一次根本没发生过的中断，还要人去"退出重进"——
			// 而那个动作能不能恢复，代码自己标着未重测（见 docs/adr/0094-be-rk-receiver-slot.md）。
			return "这路" + word + "一直没准备好"
		}
		// 确实从有画面掉下来的：说中断，但不承诺那个没验过的动作。
		// 重连是前端在做的实事（冷却后重挂），所以这句不撒谎。
		return "这一路" + word + "中断了，正在自动重连"
	}
	return "这路媒体没能订阅成功，正在重试"
}

// slotHasNoStream 判"槽认得、里面没流"这一类上游回答。
// 这个字面量在本域只此一处：`subscribeUserMessage` 的文案和订阅前的重试都按它判，
// 两边各写一遍必然分叉（一边改了重试就静默失效）。
func slotHasNoStream(err error) bool {
	return err != nil && strings.Contains(err.Error(), "no stream is available on path")
}

// thirdPartyUserMessage 把三方的机器码翻成用户能行动的一句话。
// 三方 reason 不外泄给前端（契约 §1：弹窗只透出我方 msg），原始错误只进日志。
// knownStatus 是我方已知的会议状态：三方只说"not running"，"还没开始"和"已经散会"对用户是
// 两句不同的话 —— 拿状态判，不要把预约会议说成"已结束"（第 38 项实测）。
func thirdPartyUserMessage(err error, fallback, knownStatus string) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "publication_has_no_media"):
		return "这条发布没有可推的媒体轨，请确认摄像头或麦克风已开启"
	case strings.Contains(msg, "bad_publication_video_spec"):
		return "会议服务不接受该视频规格，请在设置里调低分辨率或帧率后重试"
	case strings.Contains(msg, "participant_not_joined"):
		return "请先加入会议"
	case strings.Contains(msg, "meeting_ended"):
		return "会议已结束，无法推流"
	case strings.Contains(msg, "meeting_not_running"):
		return notRunningUserMessage(knownStatus)
	case strings.Contains(msg, "sdp"), strings.Contains(msg, "offer"):
		return "媒体协商被拒，请重试；仍失败时更换浏览器或检查到媒体服务的连通性"
	}
	return fallback
}

// notRunningUserMessage 用我方已知的状态把"这不在进行中"说准：未开始说未开始，
// 已终态说已结束，两边都不确定时只说"当前不在进行中"，不猜。
func notRunningUserMessage(status string) string {
	switch status {
	case consts.MeetingStatusScheduled:
		return "会议尚未开始，暂时无法推流"
	case consts.MeetingStatusStarting:
		return "会议正在启动，请稍候再试"
	case consts.MeetingStatusEnded, consts.MeetingStatusCancelled, consts.MeetingStatusFailed:
		return "会议已结束，无法推流"
	}
	return "这场会议当前不在进行中（可能还没开始或已经结束），暂时无法推流"
}

// knownMeetingStatus 取我方对这场会当前状态的了解：先看房间缓存（最后一次成功心跳/回源），
// 缓存还没建立时（刚重启、刚入会就点开关）回落预约单。两边都不知道才返回空串，
// 那时宁可说"当前不在进行中"，也不要猜一个方向给用户。
func (c *Controller) knownMeetingStatus(ctx context.Context, meetingId int64, room *session.MeetingRoom) string {
	if room != nil {
		if st := room.State(); st != nil && st.Meeting.Status != "" {
			return st.Meeting.Status
		}
	}
	if session.IsManaged(meetingId) {
		if m, err := c.meetingSvc.GetDetail(ctx, meetingId); err == nil {
			return m.Status
		}
	}
	return ""
}

// CreatePublication 替本端向上游登记一次发布，并把三方签发的 whipUrl 留在服务端，
// 只回给我方 publicationId 与代理路径 —— 三方地址与参会令牌都不外泄。
func (c *Controller) CreatePublication(r *ghttp.Request) {
	var req v1.PublicationCreateReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	sess, ok := c.registry.Session(req.Id, userId)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)

	endpointType, deviceID := service.JoinEndpoint(r.Context())
	sourceType, sourceDeviceID := publicationSourceType(req.MediaKind, endpointType, deviceID)
	payload := map[string]interface{}{
		"mediaKind":     req.MediaKind,
		"sourceType":    sourceType,
		"hasVideo":      req.HasVideo,
		"hasAudio":      req.HasAudio,
		"width":         req.Width,
		"height":        req.Height,
		"fps":           req.Fps,
		"sourceFpsHint": req.Fps,
		"mediaLabel":    req.MediaLabel,
	}
	if sourceDeviceID != "" {
		payload["sourceDeviceId"] = sourceDeviceID
	}
	if req.TargetBitrateKbps > 0 {
		payload["targetBitrateKbps"] = req.TargetBitrateKbps
	}
	if req.EncodingStrategy != "" {
		payload["encodingStrategy"] = req.EncodingStrategy
	}
	// 页面刷新会丢掉前端的 RTCPeerConnection，旧发布在三方还挂着；
	// 不清掉的话新建同类发布会被卡住，且现场留下永远 not-ready 的僵尸流。
	if state := room.State(); state != nil {
		for _, old := range state.Publications {
			if old.ParticipantId != sess.ParticipantId || old.MediaKind != req.MediaKind {
				continue
			}
			if _, err := c.adapter.StopPublication(r.Context(), sess.ParticipantToken, old.PublicationId); err != nil {
				glog.Warningf(r.Context(), "清理旧发布 %s 失败: %v", old.PublicationId, err)
			}
			room.UnbindWhip(old.PublicationId)
		}
	}
	raw, err := c.adapter.CreatePublication(r.Context(), sess.ParticipantToken, payload)
	if err != nil {
		glog.Errorf(r.Context(), "创建发布失败: %v", err)
		response.Fail(r, thirdPartyUserMessage(err, "发布创建失败，请稍后重试", c.knownMeetingStatus(r.Context(), req.Id, room)))
		return
	}
	pubId, whipURL := parsePublication(raw)
	if pubId == "" || whipURL == "" {
		glog.Errorf(r.Context(), "三方创建发布的响应解析不出 publicationId/whipUrl，原文: %s", string(raw))
		response.Fail(r, "暂时无法开始推流，请稍后重试")
		return
	}
	room.BindWhip(pubId, session.WhipTarget{
		OfferURL:   whipURL,
		UserId:     userId,
		AuthBearer: sess.ParticipantToken, // 公网会议 WHIP 要 Bearer；Ocean 预授权 URL 忽略此字段
	})
	// 船端浏览器这一路要过船内的 RK 接收槽。三方自己的次序是"先把槽武装起来，再接上实时轨道"
	// （其注释原文：the RK reader cannot miss the only startup IDR），所以赶在把地址交给浏览器之前调。
	// 等不到也照样返回发布：武装失败不该挡掉推流（与消费侧同一条口径，见 armRkReceiver）。
	if sourceType == consts.SourceTypeRkBrowserRoi {
		c.armRkReceiver(r.Context(), sess.ParticipantToken, pubId, rkArmBudgetPublish)
	}
	response.OkWithData(r, v1.PublicationCreateRes{
		PublicationId: pubId,
		WhipPath:      "/api/v1/meetings/" + strconv.FormatInt(req.Id, 10) + "/publications/" + pubId + "/whip",
		SourceType:    sourceType,
	}, "操作成功")
}

// publicationSourceType 决定这次发布向三方申报哪种来源，以及要不要带设备号。
// 三方按"这条视频是不是船端浏览器发的"分：船端摄像头/屏幕是 rk_browser_roi，要过船内 RK 接收槽；
// 其余一律 browser_whip —— **音频在船端也仍是 browser_whip**（三方原实现就是这么写的，
// 顺手一起改会让音频也走 RK 路径）。端别判据复用入会那一处（service.JoinEndpoint），不另立。
// 缺设备号时回落 browser_whip，与入会回落岸端一致，并已由 JoinEndpoint 记过一条点名配置项的日志。
func publicationSourceType(mediaKind, endpointType, deviceID string) (sourceType, sourceDeviceID string) {
	if mediaKind == "audio" || endpointType != "ship" || deviceID == "" {
		return consts.SourceTypeBrowserWhip, ""
	}
	return consts.SourceTypeRkBrowserRoi, deviceID
}

// 船内 TCP-only 媒体网关的发布地址（三方 `localTcpWhipOffer` 用的同一条判据）。
var (
	localTcpWhipPathRe = regexp.MustCompile(`^/__ship_local_media/[0-9A-Za-z_-]+/whip$`)
	twccFeedbackRe     = regexp.MustCompile(`^a=rtcp-fb:\S+ transport-cc(\s|$)`)
	// TWCC 的两个 extmap URI（draft 版与正式版各一）。
	twccExtmapURIs = map[string]bool{
		"http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01": true,
		"urn:ietf:params:rtp-hdrext:transport-wide-cc-02":                           true,
	}
)

// stripTransportCCForLocalTcp 去掉船内 TCP 网关那一路 offer 里的 TWCC 反馈与扩展。
//
// 照三方 `localTcpWhipOffer`：这个端点是 TCP-only 的，TCP 队头阻塞之后 Chrome 自带的 TWCC
// 估算器会塌到 ~30 kbps，把 delta 帧饿在周期性关键帧后面。保留 TCP 自己的拥塞控制、RTCP 报告与
// NACK/PLI，不改媒体 PTS。
//
// 判据只说"这个端点是不是那个 TCP-only 网关"（看路径），不叠加来源申报：端点是不是 TCP-only
// 由端点自己决定，跟这条发布声明成哪种来源无关；而申报的一半只可能是"是"—— 那个地址本来只给
// 船内发布用。云端地址不匹配这条路径，所以这里对云端是空转。
func stripTransportCCForLocalTcp(offer, whipURL string) string {
	if offer == "" || !strings.Contains(offer, "m=video ") {
		return offer
	}
	u, err := url.Parse(whipURL)
	if err != nil || !localTcpWhipPathRe.MatchString(u.Path) {
		return offer
	}
	newline := "\n"
	if strings.Contains(offer, "\r\n") {
		newline = "\r\n"
	}
	lines := strings.Split(offer, newline)
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if twccFeedbackRe.MatchString(line) {
			continue
		}
		if strings.HasPrefix(line, "a=extmap:") {
			if f := strings.Fields(line); len(f) >= 2 && twccExtmapURIs[f[1]] {
				continue
			}
		}
		kept = append(kept, line)
	}
	if len(kept) == len(lines) {
		return offer
	}
	return strings.Join(kept, newline)
}

// Whip 把浏览器的 SDP offer 转发到三方预授权地址，并把 answer 原文回给浏览器。
// 响应不是统一信封：这一跳是媒体信令，浏览器要的是 application/sdp。
func (c *Controller) Whip(r *ghttp.Request) {
	var req v1.PublicationWhipReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	if _, ok := c.registry.Session(req.Id, userId); !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)
	target, ok := room.WhipForUser(req.PubId, userId)
	if !ok {
		response.Fail(r, "发布不存在或已结束")
		return
	}
	offer := stripTransportCCForLocalTcp(r.GetBodyString(), target.OfferURL)
	if offer == "" {
		response.Fail(r, "发布请求没带上媒体协商内容，请重新开启摄像头或麦克风")
		return
	}
	answer, location, err := c.adapter.PostSdpAuth(r.Context(), target.OfferURL, offer, target.AuthBearer)
	if err != nil {
		glog.Errorf(r.Context(), "WHIP 转发失败: %v", err)
		r.Response.ClearBuffer()
		r.Response.WriteStatus(http.StatusBadGateway, thirdPartyUserMessage(err, "媒体发布失败", c.knownMeetingStatus(r.Context(), req.Id, room)))
		return
	}
	if location != "" {
		room.SetWhipSession(req.PubId, location)
	}
	// 消费侧要哪条投放腿（zha1+h264 / zha1+hevc）取决于**这条连接实际编成了什么**，
	// 而三方 publications 里的 directVideoCodec 是它的标称值，两者可以不一致 ——
	// 不一致时上游不会说"编码不对"，只会一直回 425 direct_video_not_ready（见 adapter.go 的投放头注释）。
	// 所以把 answer 里选定的编码记下来，出问题时这是唯一的一手证据。
	glog.Debugf(r.Context(), "WHIP 协商完成 pub=%s answer选定视频编码=%s", req.PubId, answerVideoCodec(answer))
	// 这个函数（转发 offer）本身不调 prepare：browser_whip 那条发布实测回 404 rtsp_describe_404。
	// 船端浏览器那一路是 rk_browser_roi，它在 CreatePublication 里**已经**武装过接收槽了 ——
	// 时序要求是"先武装、再接轨道"，放到这里就晚了。
	// 消费侧那条局域网槽反过来必须叫 prepare{role:"consumer"}，否则槽里永远没有流，见 armRkReceiver。
	// 三处同名动作各自的边界别合并。
	r.Response.Header().Set("Content-Type", "application/sdp")
	r.Response.Header().Set("Cache-Control", "no-store")
	r.Response.Write(answer)
}

// answerVideoCodec 从 WHIP answer 的 SDP 里取出**实际选定**的视频编码（H.264 带上 profile 参数）。
// 只看第一条 m=video：我方一次 WHIP 只发一路媒体（音频另走一条 WHIP）。
func answerVideoCodec(sdp string) string {
	var payload string
	names := map[string]string{}
	fmtp := map[string]string{}
	for _, raw := range strings.Split(sdp, "\n") {
		line := strings.TrimSpace(raw)
		switch {
		case strings.HasPrefix(line, "m=video"):
			// m=video <port> <proto> <fmt> [payload...] —— 取第一个 payload，即应答方选中的那条。
			if f := strings.Fields(line); len(f) > 4 && payload == "" {
				payload = f[4]
			}
		case strings.HasPrefix(line, "a=rtpmap:"):
			if pt, name, ok := strings.Cut(strings.TrimPrefix(line, "a=rtpmap:"), " "); ok {
				names[pt] = strings.TrimSpace(name)
			}
		case strings.HasPrefix(line, "a=fmtp:"):
			if pt, params, ok := strings.Cut(strings.TrimPrefix(line, "a=fmtp:"), " "); ok {
				fmtp[pt] = strings.TrimSpace(params)
			}
		}
	}
	if payload == "" {
		return "无 m=video"
	}
	codec := names[payload]
	if codec == "" {
		codec = "pt" + payload + "(缺 rtpmap)"
	}
	if p := fmtp[payload]; p != "" {
		return codec + " " + p
	}
	return codec
}

// WhipDelete 对 WHIP 会话 URI 发 DELETE，真正拆掉这条实时连接。
func (c *Controller) WhipDelete(r *ghttp.Request) {
	var req v1.PublicationWhipDeleteReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)
	target, ok := room.WhipForUser(req.PubId, userId)
	if !ok {
		response.OkWithMessage(r, "发布已结束")
		return
	}
	if target.SessionURL != "" {
		if err := c.adapter.DeleteSessionAuth(r.Context(), target.SessionURL, target.AuthBearer); err != nil {
			glog.Warningf(r.Context(), "whip delete %s failed: %v", req.PubId, err)
		}
	}
	room.UnbindWhip(req.PubId)
	response.OkWithMessage(r, "已停止发布")
}

// StopPublication 通知三方结束该发布并解除本地绑定。
func (c *Controller) StopPublication(r *ghttp.Request) {
	var req v1.PublicationStopReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	sess, ok := c.registry.Session(req.Id, userId)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)
	if _, err := c.adapter.StopPublication(r.Context(), sess.ParticipantToken, req.PubId); err != nil {
		glog.Warningf(r.Context(), "stop publication %s failed: %v", req.PubId, err)
	}
	room.UnbindWhip(req.PubId)
	response.OkWithMessage(r, "已停止发布")
}

// RoiHint 上报人脸框，供三方编码器把码率花在人脸（外部契约 §10.3）。
// 只对 camera 发布有效；边端没有 ROI 增强通道，按部署侧直接拒绝。
func (c *Controller) RoiHint(r *ghttp.Request) {
	var req v1.RoiHintReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	sess, ok := c.registry.Session(req.Id, userId)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)
	if !service.FaceEnhancementSupported() {
		response.FailStatus(r, http.StatusConflict, service.FaceEnhancementUnsupportedMessage(), "face_enhancement_unsupported")
		return
	}
	if _, ok := room.WhipForUser(req.PubId, userId); !ok {
		response.Fail(r, "发布不存在或已结束")
		return
	}
	if err := validateRoiHint(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	// 前端已按 250ms 节流；这里兜一层，免得异常客户端把上游打成高频。
	if !room.AllowRoiHint(userId, 250*time.Millisecond) {
		response.OkWithMessage(r, "已跳过")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	_, err := c.adapter.PostRoiHint(ctx, sess.ParticipantToken, req.PubId, map[string]interface{}{
		"detector":          req.Detector,
		"sequence":          req.Sequence,
		"sourceTimestampMs": req.SourceTimestampMs,
		"inferenceMs":       req.InferenceMs,
		"regions":           req.Regions,
	})
	if err != nil {
		// 失败不重试、不弹窗：这条只影响编码器偏置，不该让用户以为画面坏了。
		glog.Warningf(r.Context(), "roi-hint %s 上报失败: %v", req.PubId, err)
		response.FailStatus(r, http.StatusBadGateway, "人脸增强没有生效", "roi_hint_failed")
		return
	}
	// 成功侧要能自证链路通：每 20 次留一条，开 debug 时逐条可见。
	// 现场问"这个开关到底有没有发出去"时，只看 UI 是答不出的。
	if n := atomic.AddUint64(&roiHintSuccess, 1); n == 1 || n%20 == 0 {
		glog.Infof(r.Context(), "roi-hint 已送达三方 pub=%s seq=%d 人脸框=%d 次=%d", req.PubId, req.Sequence, len(req.Regions), n)
	} else {
		glog.Debugf(r.Context(), "roi-hint 已送达三方 pub=%s seq=%d 人脸框=%d", req.PubId, req.Sequence, len(req.Regions))
	}
	response.Ok(r, v1.RoiHintRes{})
}

func validateRoiHint(req *v1.RoiHintReq) error {
	if req.Sequence < 0 || req.SourceTimestampMs < 0 {
		return fmt.Errorf("人脸增强上报的时间戳不合法")
	}
	if req.InferenceMs < 0 || req.InferenceMs > 60000 {
		return fmt.Errorf("人脸增强上报的耗时超出范围")
	}
	if len(req.Regions) > 8 {
		return fmt.Errorf("最多上报 8 个人脸框")
	}
	for i, rg := range req.Regions {
		for _, v := range []float64{rg.X, rg.Y, rg.Width, rg.Height, rg.Score} {
			// v != v 拦 NaN；±Inf 会被下一条的范围判断拦住。
			if v != v || v < 0 || v > 1 {
				return fmt.Errorf("第 %d 个人脸框的坐标超出范围", i+1)
			}
		}
		if rg.X+rg.Width > 1+1e-6 || rg.Y+rg.Height > 1+1e-6 {
			return fmt.Errorf("第 %d 个人脸框超出画面", i+1)
		}
	}
	return nil
}

// MediaState 是媒体意图的 REST 快速通道：更新会话意图位并立刻向三方提交一次带状态的
// 心跳（三方按意图位过滤发布可见性——位为 false 时手机端连画面都不渲染）。
// WS 的 media 消息保留作实时冗余，但正确性以本通道为准。
func (c *Controller) MediaState(r *ghttp.Request) {
	var req v1.MeetingMediaStateReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	if _, ok := c.registry.Room(req.Id); !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	sess, ok := c.registry.Session(req.Id, userId)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)
	media, ok := c.registry.UpdateMedia(req.Id, userId, req.CameraOn, req.MicOn, req.Sharing, req.Recording)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	if _, err := c.adapter.Heartbeat(r.Context(), sess.ParticipantToken, &media); err != nil {
		response.FailSystem(r, "媒体状态未同步到会议链路", err)
		return
	}
	response.Ok(r, v1.MeetingMediaStateRes{})
}

// Telemetry 收下发布端实测的编码码率样本。**只落会话、不立刻心跳** —— 泵每 tick 本来就
// 逐会话发一次，多插一次是白加往返（与 WS 的 `case "telemetry"` 同一口径）。
// 两条过滤（空 publicationId、码率 <=0）与 4 秒过期都在 registry 一处生效，REST 与 WS 共用，
// 这里不另立一套：发 0 会被上游当成"实测到 0"，比缺数更坏。
func (c *Controller) Telemetry(r *ghttp.Request) {
	var req v1.MeetingTelemetryReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	if _, ok := c.registry.Room(req.Id); !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	if _, ok := c.registry.Session(req.Id, userId); !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)
	items := make([]thirdparty.VideoSourceTelemetry, 0, len(req.Items))
	for _, it := range req.Items {
		items = append(items, thirdparty.VideoSourceTelemetry{
			PublicationId:              it.PublicationId,
			SourceVideoBitrateKbps:     it.SourceVideoBitrateKbps,
			SourceFps:                  it.SourceFps,
			AssociatedAudioBitrateKbps: it.AssociatedAudioBitrateKbps,
		})
	}
	c.registry.UpdateSourceTelemetry(req.Id, userId, items)
	response.Ok(r, v1.MeetingTelemetryRes{})
}

// StreamWhep 代理 WHEP 协商：浏览器发 recvonly offer，后端从上游状态里取预授权 WHEP 地址转发。
// 上游地址与参会令牌都不进浏览器；RTP 由浏览器与媒体服务直连。
func (c *Controller) StreamWhep(r *ghttp.Request) {
	var req v1.StreamWhepReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.FailStream(r, http.StatusUnauthorized, "请先加入会议")
		return
	}
	sess, ok := c.registry.Session(req.Id, userId)
	if !ok {
		response.FailStream(r, http.StatusUnauthorized, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)
	alias, ok := room.ResolveStream(req.StreamId)
	if !ok {
		response.FailStream(r, http.StatusNotFound, "该流已结束")
		return
	}
	c.focusPublication(r.Context(), room, sess, alias.PublicationId)
	state, source, gone := c.stateWithPublication(r.Context(), room, sess, alias.PublicationId)
	if gone {
		// 终态：回 410。前端把 404/410 判成"这路已经没了"（不重试、不挂红字），等下一轮 state 摘掉死流；
		// 回 503「还在准备中」等于让它每 1.5 秒再取一次一个已经不存在的会议，表现就是"起播失败"。
		response.FailStream(r, http.StatusGone, "这场会议已经结束，媒体不再可用")
		return
	}
	if state == nil {
		response.FailStream(r, http.StatusServiceUnavailable, "会议状态尚未就绪，请稍后重试")
		return
	}
	offer := r.GetBodyString()
	if offer == "" {
		response.FailStream(r, http.StatusBadRequest, "这路媒体的订阅请求没带上协商内容，正在重试")
		return
	}
	// 一条 PC 收什么，本来就在浏览器写好的 offer 里（m-line）；不再另开一个 kind 参数让两边各说一遍。
	wantVideo := offerWantsVideo(offer)
	legKind, kindLabel := consts.WhepKindAudio, "音频"
	if wantVideo {
		legKind, kindLabel = consts.WhepKindVideo, "视频"
	}
	var target string
	var pub thirdparty.Publication
	var found bool
	if wantVideo {
		target, pub, found = whepVideoChannel(state, alias.PublicationId)
	} else {
		target, pub, found = whepAudioChannel(state, alias.PublicationId)
	}
	if !found {
		glog.Warningf(r.Context(), "解析 WHEP %s失败 meeting=%d stream=%s publication=%s 来源=%s 可见发布=%s",
			kindLabel, req.Id, req.StreamId, alias.PublicationId, source, publicationSummary(state))
		response.FailStream(r, http.StatusServiceUnavailable, "这路媒体还在准备中，请稍后重试")
		return
	}
	if pub.PublicationId != "" && pub.PublicationId != alias.PublicationId {
		// 订阅的是兄弟别名（订到的那条还没 ready）：关注要跟着改报，不然上游会把在播的那条饿掉。
		c.focusPublication(r.Context(), room, sess, pub.PublicationId)
		glog.Infof(r.Context(), "改用就绪别名订阅%s meeting=%d stream=%s 订正=%s→%s",
			kindLabel, req.Id, req.StreamId, alias.PublicationId, pub.PublicationId)
	}
	if target == "" {
		// 上游到底给了哪些通道只进日志：那串里有 WHEP/板卡通道这些用户不认识也不该知道的东西，
		// 排查时看日志即可，弹窗要说的是本域中文（第 10/34 项）。
		hint := audioChannelsHint(pub)
		if wantVideo {
			hint = videoChannelsHint(pub)
		}
		glog.Warningf(r.Context(), "该%s发布没有可接收通道 meeting=%d stream=%s：%s", kindLabel, req.Id, req.StreamId, hint)
		response.FailStream(r, http.StatusNotImplemented, "这路"+kindLabel+"暂时收不到，对端可能只开了画面")
		return
	}
	prev, hadPrev := room.WhepFor(userId, req.StreamId, legKind)
	// 局域网那条视频腿的槽要船端 RK 的接收进程来灌。实测 2026-10-12（本机两实例复现，
	// 与船端现场同一形态）：三方对 `browser_whip` 发布的 prepare{role:"consumer"} 回
	// 404 `publication_not_found` —— 这个口子在船端网关上**不认这条发布**，所以它不是可用的开关。
	// 于是只在"上游说槽里没流"时叫一次：给不出流也要把三方自己给的原因落到日志，
	// 那才是能交给三方的证据（订阅前无条件叫一次，等于给每条正常订阅白加一次失败往返）。
	lanVideoLeg := wantVideo && service.VideoLegChannel(pub) == consts.VideoChannelLanWhep
	whepBearer := ""
	if c.adapter.IsSinosatV1(r.Context()) {
		whepBearer = sess.ParticipantToken
	}
	answer, location, err := c.adapter.PostSdpAuth(r.Context(), target, offer, whepBearer)
	if err != nil && lanVideoLeg && slotHasNoStream(err) &&
		c.armRkReceiver(r.Context(), sess.ParticipantToken, pub.PublicationId, rkArmBudgetRetry) {
		// 三方哪天认了这个口子，这里就自动变成一次真恢复：起来了就重试**恰好一次**
		// （不在这里循环 —— 循环的活交给前端那套 ~12 秒重挂，它每轮会重新走到这条路径）。
		answer, location, err = c.adapter.PostSdpAuth(r.Context(), target, offer, whepBearer)
	}
	if err != nil {
		// 带上腿别与地址形状：船端那条腿有两种写法（网关给的路径槽 / 直接给的地址），
		// 不记这两样就说不清"订的是哪条 lane"，也就对不上三方那边该看哪条接收进程。
		glog.Warningf(r.Context(), "订阅失败 meeting=%d stream=%s 腿=%s 地址=%s 可见发布=%s: %v",
			req.Id, req.StreamId, legKind, thirdparty.LoggableTarget(target), publicationSummary(state), err)
		response.FailStream(r, http.StatusBadGateway, subscribeUserMessage(err, legKind, hadPrev))
		return
	}
	if location == "" {
		// 三方没回 Location 就沿用上一轮的会话 URI，否则释放凭据会被空值覆盖掉。
		location = prev.SessionURL
	}
	room.BindWhep(session.WhepTarget{
		UserId:     userId,
		StreamId:   req.StreamId,
		Kind:       legKind,
		OfferURL:   target,
		SessionURL: location,
		AuthBearer: whepBearer,
	})
	// 换流/重连会在三方留下上一条订阅，三方不自己收：当场拆掉，否则一路挂一路。
	if hadPrev && prev.SessionURL != "" && prev.SessionURL != location {
		c.releaseWhepTarget(r, prev)
	}
	r.Response.Header().Set("Content-Type", "application/sdp")
	r.Response.Header().Set("Cache-Control", "no-store")
	r.Response.Write(answer)
}

// StreamFrameTimes 代理船端局域网接收槽的**帧时刻表**，统计条「采集时间」那一格只有它有。
// 只有 lanWhep 那条腿需要它：直连腿的采集时刻就在容器帧头里，浏览器自己拿得到，不必多一跳。
// 响应**原样透传**、不在本仓解析（理由见 adapter.GetLocalTelemetry：Unix 纳秒会毁在 float 上）。
func (c *Controller) StreamFrameTimes(r *ghttp.Request) {
	var req v1.StreamFrameTimesReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.FailStream(r, http.StatusUnauthorized, "请先加入会议")
		return
	}
	sess, ok := c.registry.Session(req.Id, userId)
	if !ok {
		response.FailStream(r, http.StatusUnauthorized, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)
	alias, ok := room.ResolveStream(req.StreamId)
	if !ok {
		response.FailStream(r, http.StatusNotFound, "该流已结束")
		return
	}
	state, _, gone := c.stateWithPublication(r.Context(), room, sess, alias.PublicationId)
	if gone {
		// 与订阅那条一致：404/410 前端判成终态（不重试），回 503 等于让它反复取一个已经不存在的会。
		response.FailStream(r, http.StatusGone, "这场会议已经结束，媒体不再可用")
		return
	}
	if state == nil {
		response.FailStream(r, http.StatusServiceUnavailable, "会议状态尚未就绪，请稍后重试")
		return
	}
	pub, found := findPublication(state, alias.PublicationId)
	// 判据与选腿那条（VideoLegChannel）同源，不另立一套：三件套齐了才算有这条腿。
	// 槽号越界说明三方还没给这条发布分配接收槽 —— 回 404 让界面留「统计中」，
	// 绝不猜一个 lane=1 去查：那会查到别人的槽，报出一个看着合理的假采集时刻。
	if !found || service.DeploymentSide != "edge" || pub.RkDeliveryMode != "raw_hevc_forward" ||
		pub.RkReceiverLaneId < 1 || pub.RkReceiverLaneId > 32 {
		glog.Infof(r.Context(), "这路没有可查的局域网接收槽 meeting=%d stream=%s 侧=%s 模式=%s 槽=%d",
			req.Id, req.StreamId, service.DeploymentSide, pub.RkDeliveryMode, pub.RkReceiverLaneId)
		response.FailStream(r, http.StatusNotFound, "这一路的采集时刻暂时查不到")
		return
	}
	body, err := c.adapter.GetLocalTelemetry(r.Context(),
		fmt.Sprintf("/api/local/frame-times?lane=%d", pub.RkReceiverLaneId))
	if err != nil {
		// 槽里没流时上游回 404，那是事实不是故障：界面同样留「统计中」，只是把原因落到日志。
		glog.Warningf(r.Context(), "查帧时刻失败 meeting=%d stream=%s lane=%d: %v",
			req.Id, req.StreamId, pub.RkReceiverLaneId, err)
		response.FailStream(r, http.StatusBadGateway, "这一路的采集时刻暂时查不到")
		return
	}
	// 包进我方信封：前端所有请求都过 `request.ts` 的拦截器，裸透传 `{ok:true,…}` 会被判成"系统异常"。
	// 用 json.RawMessage 而不是解析成 struct —— 表里的采集时刻是 Unix **纳秒**、源钟标识是 64 位整数，
	// 过一遍 Go 的 float 就改掉末几位；原样嵌入，让浏览器自己去解释那个字面量。
	response.OkWithData(r, json.RawMessage(body), "ok")
}

// StreamWhepDelete 释放本端对这一路流的全部 WHEP 订阅会话。
// 请求里没有腿别（音视频两条腿在三方侧是两个会话，各自按 (用户, 流, 腿) 记账），
// 而调用方说的是"这路我不要了" —— 那就把这路的每条腿都拆掉，留一条就是漏。
// 浏览器侧目前不调这里 —— 见契约 ADR-0057（三方是否自行回收订阅会话从未实测，WHIP 的实测值指向"会"）。
func (c *Controller) StreamWhepDelete(r *ghttp.Request) {
	var req v1.StreamWhepDeleteReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.OkWithMessage(r, "已停止订阅")
		return
	}
	c.registry.Touch(req.Id, userId)
	c.releaseWhepSessions(r, room.TakeWhepsForStream(userId, req.StreamId))
	response.OkWithMessage(r, "已停止订阅")
}

// releaseWhepTarget 向三方 DELETE 一条 WHEP 会话；失败只进日志——
// 订阅方已经不等它了，把拆流失败回给用户只会让离会/换流卡住。
func (c *Controller) releaseWhepTarget(r *ghttp.Request, t session.WhepTarget) {
	if err := c.adapter.DeleteSessionAuth(r.Context(), t.SessionURL, t.AuthBearer); err != nil {
		glog.Warningf(r.Context(), "whep delete user %d stream %s failed: %v", t.UserId, t.StreamId, err)
	}
}

// releaseWhepSessions 拆掉若干 WHEP 会话（离会/回收路径用）。
func (c *Controller) releaseWhepSessions(r *ghttp.Request, targets []session.WhepTarget) {
	for _, t := range targets {
		if t.SessionURL == "" {
			continue
		}
		c.releaseWhepTarget(r, t)
	}
}

// whepAudioChannel 取这条发布可订阅的云端 WHEP 音频地址，并带回发布本身
// —— 报错时要用它说清上游到底给了哪些通道。
// 不优先 rkReceiverAudioWhepUrl：那是船端同局域网通道（三方文档 §10.2），**云端实例**的浏览器连不通它
// （协商能回 200、ICE 永不可达，症状是"连上了听不到对方声音"）。边端实例的消费者在船内网，
// 那条腿是可达的 —— 所以可达性判据按 deployment.side 走，视频腿就是这么开的（见 service.VideoLegChannel）。
func whepAudioChannel(state *thirdparty.MeetingResponse, publicationId string) (string, thirdparty.Publication, bool) {
	req, ok := findPublication(state, publicationId)
	if !ok {
		return "", thirdparty.Publication{}, false
	}
	// 同一路音频也可能挂着新旧两个别名，ready 的那个才有能用的 WHEP 通道。
	for _, p := range subscribableAliases(state, publicationId) {
		if p.AudioWhepUrl != "" {
			return p.AudioWhepUrl, p, true
		}
	}
	// 上游没给通用音频 WHEP 时，船端还有一条**船内局域网**音频车道（三方船端客户端走的就是它）。
	// 只在边端实例上开：那条地址属船内网段，岸端签出去只会换出一个永远不亮的等待。
	// 这条分支的意义不只是"能听到声音"——它把音频从直连流换成浏览器 PC，播放时刻才有得量，
	// 音画差那一格才可能出数（见 lanWhepAudioURL 的注释）。
	if service.DeploymentSide == "edge" {
		for _, p := range subscribableAliases(state, publicationId) {
			if u := lanWhepAudioURL(p); u != "" {
				return u, p, true
			}
		}
	}
	return "", req, true
}

// whepVideoChannel 取这条发布可订阅的**视频** WHEP 地址。上游给的视频 WHEP 只有船端局域网那一条腿，
// 所以它等于"本实例能不能接这路视频"的判据：云端实例一律回空（岸端浏览器 ICE 不到船内网）。
func whepVideoChannel(state *thirdparty.MeetingResponse, publicationId string) (string, thirdparty.Publication, bool) {
	req, ok := findPublication(state, publicationId)
	if !ok {
		return "", thirdparty.Publication{}, false
	}
	for _, p := range subscribableAliases(state, publicationId) {
		switch service.VideoLegChannel(p) {
		case consts.VideoChannelCloudWhep:
			if p.CloudWhepUrl != "" {
				return p.CloudWhepUrl, p, true
			}
		case consts.VideoChannelLanWhep:
			return lanWhepURL(p), p, true
		}
	}
	return "", req, true
}

// lanWhepURL 按三方船端客户端自己的取序拼这条腿的地址：优先用 `rkReceiverPath` 拼网关的
// 局域网 WHEP 入口，其次才用它直接给的 `rkReceiverWhepUrl`。
//
// 更正（实测 2026-10-12）：此前这里写着"`rkReceiverWhepUrl` 订出去回 404，因为那是网关回填的
// 本机 RK **输入**槽名、不是这路发布的接收槽"—— 那个结论是**误判**。日志里 `lane=1 → path=conference/cam1`、
// `lane=2 → path=conference/cam2` 逐参会者对应，且这些发布全是 `src=browser_whip`（不是 RK 摄像头），
// 所以 `conference/camN` 就是**这条发布自己的接收槽**；两个字段指向的是同一个槽，只是两种写法。
// 那次"改取序"因此没治到病根（症状随后复发就是证据），真正的成因是槽里没有流 —— 见 `armRkReceiver`。
// 取序本身仍然照三方保留：与它的客户端逐字一致，少一处差异少一处可错。
func lanWhepURL(pub thirdparty.Publication) string {
	if p := strings.Trim(pub.RkReceiverPath, "/"); p != "" {
		return "/__ship_lan_whep/" + p + "/whep"
	}
	return pub.RkReceiverWhepUrl
}

// lanWhepAudioURL 拼船内那条**音频**局域网 WHEP 地址。
//
// 为什么要有：三方的船端客户端收音频也走浏览器 PC（`audioReceiver.samplePlayoutTiming("audio")`），
// 它的地址是 `/__ship_lan_whep/{rkReceiverPath}_audio/whep`（路径多一个 `_audio` 后缀，实测自其客户端）。
// 我方此前 `whepAudioChannel` 只认上游给的 `audioWhepUrl`，船端那条就永远拼不出来 —— 于是音频只能
// 退到直连流，而直连腿没有 RTCPeerConnection，**播放时刻结构上取不到**，音画差在边端页永远算不出来
// （同会对照：三方那一格有 `播放音画差 +38 ms · 轨道交付`，我方是 `—`）。
//
// 取序与视频那条 `lanWhepURL` **逐字一致：先按路径拼、再用上游给的显式地址**。
// 这个顺序不是随手写的：拼出来的地址是相对路径，由 `resolveTarget` 接到本实例配置的船端网关
// baseUrl 上；而 `rkReceiverAudioWhepUrl` 可能是网关回填的**绝对**地址（指向船内某个 host），
// 从岸端或本机发出去只能得到传输层失败（实测表现是 `upstream_unreachable`，不是 404）。
func lanWhepAudioURL(pub thirdparty.Publication) string {
	if p := strings.Trim(pub.RkReceiverPath, "/"); p != "" {
		return "/__ship_lan_whep/" + p + "_audio/whep"
	}
	return pub.RkReceiverAudioWhepUrl
}

// 武装接收槽的预算：只在"上游说槽里没流"这一条分支上用（订阅前不叫，见 StreamWhep 那段注释）。
const (
	rkArmBudgetRetry = 4 * time.Second
	rkArmPollEvery   = 200 * time.Millisecond // 契约 §10.1 给的轮询间隔是 150–200ms
	// 发布侧武装卡在"创建发布"这个 HTTP 请求里，前端那条 axios 是 10 秒超时，
	// 所以给它比消费侧更紧的预算：够 12 轮，又不至于把整个请求逼近上限。
	rkArmBudgetPublish = 2500 * time.Millisecond
)

// armRkReceiver 叫三方把这条发布在船端 RK 上的接收进程起来（§10.1 `prepare{role:"consumer"}`），
// 轮询到 `receiverReady` 为止，最多 `budget`。局域网那条视频腿的槽本该由它灌满。
//
// 实测边界（2026-10-12，本机两实例 + 船端现场同形）：**三方对 browser_whip 的发布回
// 404 `publication_not_found`** —— 这个口子目前不认这类发布，所以它现在只是"把三方自己的
// 原因落到日志"的诊断动作，不是恢复手段。三方客户端自己的消费侧也没有任何武装调用
// （它全部 API 面只有 heartbeat/focus/WHEP），所以这不是"我们少调了一步"。
//
// 两条别在下次改动里抹掉的边界：
//   - **等不到/被拒也照样往下订，不把它当硬前置**：否则三方哪天改了行为，我方先挂。
//   - **不等参考实现那 90 秒**：这条链路是浏览器发起的 HTTP，长等会撞前端超时。
//
// 回 true 只表示"三方说就绪了"，用于决定值不值得再试一次；原因一律进日志。
func (c *Controller) armRkReceiver(ctx context.Context, token, publicationId string, budget time.Duration) bool {
	deadline := time.Now().Add(budget)
	var lastReason string
	for {
		res, err := c.adapter.PreparePublication(ctx, token, publicationId, thirdparty.PrepareRoleConsumer)
		if err != nil {
			// 非 2xx = 三方明确说"这条 lane 起不来"（404 + §17 的 reason）。继续轮只是空烧，
			// 记下原因收手，让调用方照订一次 —— 订出来的结果才是真判据。
			reason := ""
			if res != nil {
				reason = res.WhyNotReady()
			}
			glog.Warningf(ctx, "武装接收槽 publication=%s 三方拒绝 reason=%s: %v", publicationId, reason, err)
			return false
		}
		if res.ReceiverReady {
			glog.Infof(ctx, "武装接收槽就绪 publication=%s consumerAttached=%v", publicationId, res.ConsumerAttached)
			return true
		}
		lastReason = res.WhyNotReady()
		if !time.Now().Before(deadline) {
			glog.Warningf(ctx, "武装接收槽未就绪 publication=%s 已等=%s 最后原因=%s", publicationId, budget, lastReason)
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(rkArmPollEvery):
		}
	}
}

// offerWantsVideo 判这条 PC 的 offer 要不要收视频。m-line 是浏览器自己写的，拿它当唯一真源，
// 比再开一个 kind 参数可靠 —— 两边说得不一样时，实际会协商的是 offer 那一侧。
func offerWantsVideo(offer string) bool {
	return strings.Contains(offer, "m=video")
}

// parsePublication 兼容三方回包的两个位置：实测 `whipUrl` 在**顶层**，
// 而 `publication` 对象里那个同名字段是空串；不能因为拿到了嵌套 publicationId 就提前返回。
func parsePublication(raw []byte) (publicationId, whipURL string) {
	var envelope struct {
		Publication struct {
			PublicationId string `json:"publicationId"`
			WhipUrl       string `json:"whipUrl"`
		} `json:"publication"`
		PublicationId string `json:"publicationId"`
		WhipUrl       string `json:"whipUrl"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return "", ""
	}
	if envelope.Publication.PublicationId != "" {
		publicationId = envelope.Publication.PublicationId
	} else {
		publicationId = envelope.PublicationId
	}
	whipURL = envelope.WhipUrl
	if whipURL == "" {
		whipURL = envelope.Publication.WhipUrl
	}
	return publicationId, whipURL
}

func (c *Controller) Cancel(r *ghttp.Request) {
	var req v1.MeetingCancelReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	cu := c.callerOf(r)
	reason, err := c.meetingSvc.Cancel(r.Context(), req.Id, cu.UserId, cu.Account)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	if reason != "" {
		glog.Warningf(r.Context(), "本地已取消但会议服务未同步: %s", reason)
		response.OkWithMessage(r, "会议已取消，但尚未同步到会议服务")
		return
	}
	response.OkWithMessage(r, "会议已取消")
}

// 删除会议这条口子已按第 6 项撤掉：会议可以取消（置 cancelled、行保留），
// 但本系统不提供"把预约单删掉"。三方也没有删除会议这个动作，停会只让它变 ended。

func (c *Controller) Update(r *ghttp.Request) {
	var req v1.MeetingUpdateReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	cu := c.callerOf(r)
	m, inviteeReason, err := c.meetingSvc.Update(r.Context(), req.Id, &service.ScheduleInput{
		Title: req.Title, StartTime: req.StartTime, DurationMinutes: req.DurationMinutes,
		CloudRecord: req.CloudRecord,
		MuteOnJoin:  req.MuteOnJoin == nil || *req.MuteOnJoin, CameraOffOnJoin: req.CameraOff != nil && *req.CameraOff,
		AllowWaiting:   req.AllowWaiting != nil && *req.AllowWaiting,
		ParticipantIds: req.ParticipantIds,
	}, cu.UserId, cu.Account)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	brief := c.creatorBriefMap(r.Context(), []entity.MeetingAppointment{*m})
	vo := c.meetingToVo(r.Context(), m, brief, c.callerOf(r))
	if inviteeReason != "" {
		response.OkWithData(r, vo, "会议已修改，但受邀名单更新失败："+inviteeReason)
		return
	}
	response.Ok(r, vo)
}

// hostInMeeting 主持人这个端在不在会里（第 10 项的门禁判据），两个信号任一成立即算在：
//  1. 本系统里有他的一条入会会话 —— 他从我们这个页面进过会；
//  2. 本库把这场会记成 running —— 会已经被带起来（实测没人入会的 scheduled 不会报 running）。
//
// 主持人是板卡/手机这类本库没有档案的账号时信号 1 永远取不到，只能靠信号 2；
// 两边都不成立才拦，宁可让成员进会也别把人永久关在门外。
func (c *Controller) hostInMeeting(ctx context.Context, local *entity.MeetingAppointment, roomKey int64) bool {
	if local.Status == consts.MeetingStatusRunning {
		return true
	}
	if uid, ok := c.meetingSvc.UserIdByThirdAccount(ctx, local.HostThirdPartyAccount); ok {
		if _, in := c.registry.Session(roomKey, uid); in {
			return true
		}
	}
	return false
}

func (c *Controller) creatorBriefMap(ctx context.Context, list []entity.MeetingAppointment) map[int64]service.CreatorBrief {
	seen := make(map[int64]struct{}, len(list))
	ids := make([]int64, 0, len(list))
	for _, m := range list {
		if _, ok := seen[m.CreatorId]; ok || m.CreatorId == 0 {
			continue
		}
		seen[m.CreatorId] = struct{}{}
		ids = append(ids, m.CreatorId)
	}
	brief, err := c.meetingSvc.GetCreatorBrief(ctx, ids)
	if err != nil {
		return map[int64]service.CreatorBrief{}
	}
	return brief
}

// scheduleCreatorBrief 只给有本地预约单的那部分补发起人档案（外部会议没有本系统发起人）。
func (c *Controller) scheduleCreatorBrief(ctx context.Context, items []service.ScheduleItem) map[int64]service.CreatorBrief {
	locals := make([]entity.MeetingAppointment, 0, len(items))
	for _, it := range items {
		if it.Local != nil {
			locals = append(locals, *it.Local)
		}
	}
	return c.creatorBriefMap(ctx, locals)
}

func (c *Controller) attendanceCountsFor(ctx context.Context, list []service.ScheduleItem) map[string]int {
	ids := make([]string, 0, len(list))
	seen := make(map[string]struct{}, len(list))
	for _, it := range list {
		id := it.Upstream.MeetingId
		if id == "" && it.Local != nil {
			id = it.Local.ThirdPartyMeetingId
		}
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return service.AttendanceCounts(ctx, ids)
}

// scheduleToVo 是日程条目的对外形状。字段该信谁由 service.ScheduleItem 的方法定，
// 这里只负责摊平成契约字段；三方和本库都没有的（外部会议的同步态、发起人档案）留空。
func (c *Controller) scheduleToVo(ctx context.Context, it service.ScheduleItem, brief map[int64]service.CreatorBrief, cu Caller, att map[string]int) v1.MeetingVo {
	vo := v1.MeetingVo{
		Id:              it.RoomKey,
		Title:           it.Title(),
		MeetingNo:       it.Number(),
		DurationMinutes: it.DurationMin(),
		CloudRecord:     it.CloudRecord(),
		HostName:        it.HostAccount(),
		Status:          it.Status(),
		Kind:            it.Kind(),
		// Managed 告诉前端这场会本库有没有预约单：外部会议不可改、不可取消、不由本系统提前开始。
		Managed: it.Local != nil,
	}
	if at := it.StartAt(); at > 0 {
		vo.StartTime = formatTime(gtime.NewFromTimeStamp(at))
	}
	if at := it.CreatedAt(); at > 0 {
		vo.CreatedAt = formatTime(gtime.NewFromTimeStamp(at))
	}
	if m := it.Local; m != nil {
		vo.LocalStatus = m.LocalStatus
		vo.MuteOnJoin = m.MuteOnJoin == 1
		vo.CameraOffOnJoin = m.CameraOffOnJoin == 1
		vo.AllowWaiting = m.AllowWaiting == 1
		vo.CreatorId = m.CreatorId
		if m.StartedAt != nil {
			vo.StartedAt = formatTime(m.StartedAt)
		}
		if b, ok := brief[m.CreatorId]; ok {
			vo.CreatorName = b.DisplayName
			vo.CreatorPositionName = c.dictSvc.LabelOf(ctx, consts.DictTypePosition, b.PositionCode)
		}
	}
	// 三方会议 ID：回放页需要它去查录制清单，与 MeetingNo（入会拨号）不同。
	if it.Upstream.MeetingId != "" {
		vo.ThirdPartyMeetingId = it.Upstream.MeetingId
	} else if it.Local != nil {
		vo.ThirdPartyMeetingId = it.Local.ThirdPartyMeetingId
	}
	// 有预约单的会按本库口径判主持人，外部会只能按三方给的主持人账号判（第 6 项）。
	if it.Local != nil {
		vo.IsHost = service.CanManage(it.Local, cu.UserId, cu.Account)
	} else {
		vo.IsHost = cu.Account != "" && it.HostAccount() == cu.Account
	}
	if n := it.Upstream.ParticipantCount; n > 0 {
		vo.ParticipantCount = n
	} else if n := it.Upstream.ActiveParticipantCount; n > 0 {
		vo.ParticipantCount = n
	} else if att != nil {
		vo.ParticipantCount = att[vo.ThirdPartyMeetingId]
	}
	vo.RecordingState = "none"
	if it.CloudRecord() {
		vo.RecordingState = "planned"
	}
	vo.HasMinutes = false
	return vo
}

func (c *Controller) meetingToVo(ctx context.Context, m *entity.MeetingAppointment, brief map[int64]service.CreatorBrief, cu Caller) v1.MeetingVo {
	vo := v1.MeetingVo{
		Id:              m.Id,
		Title:           m.Title,
		MeetingNo:       m.ThirdPartyMeetingNumber,
		DurationMinutes: m.DurationMinutes,
		CloudRecord:     m.CloudRecord == 1,
		MuteOnJoin:      m.MuteOnJoin == 1,
		CameraOffOnJoin: m.CameraOffOnJoin == 1,
		AllowWaiting:    m.AllowWaiting == 1,
		CreatorId:       m.CreatorId,
		HostName:        m.HostThirdPartyAccount,
		Status:          m.Status,
		Kind:   service.NormalizeLaunchKind(m.LaunchKind, m.Status == consts.MeetingStatusScheduled),
		IsHost: service.CanManage(m, cu.UserId, cu.Account),
		// 这个入口的入参一定是本库预约单，所以恒为 true：漏赋值会让前端把刚预约的会
		// 当成外部会（实测预约响应 managed=false，而入会前页按这个标志选路由与可改与否）。
		Managed:             true,
		LocalStatus:         m.LocalStatus,
		ThirdPartyMeetingId: m.ThirdPartyMeetingId,
		HasMinutes:          false,
	}
	if m.CloudRecord == 1 {
		vo.RecordingState = "planned"
	} else {
		vo.RecordingState = "none"
	}
	if b, ok := brief[m.CreatorId]; ok {
		vo.CreatorName = b.DisplayName
		vo.CreatorPositionName = c.dictSvc.LabelOf(ctx, consts.DictTypePosition, b.PositionCode)
	}
	if m.StartTime != nil {
		vo.StartTime = formatTime(m.StartTime)
	}
	if m.StartedAt != nil {
		vo.StartedAt = formatTime(m.StartedAt)
	}
	if m.CreatedAt != nil {
		vo.CreatedAt = formatTime(m.CreatedAt)
	}
	return vo
}

func formatTime(t *gtime.Time) string {
	if t == nil {
		return ""
	}
	return t.Format("Y-m-d\\TH:i:sP")
}

func webClientId(userId int64) string {
	return "web-" + strconv.FormatInt(userId, 10)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// joinUserMessage 把上游参会失败翻译成本域文案。
// 上游的 reason 词形不外泄给用户（用户看不懂也不关心），未识别的失败只进服务端日志。
func joinUserMessage(ctx context.Context, err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "recording_consent_required"):
		return "该会议已开启录制，需你同意后方可入会"
	case strings.Contains(msg, "meeting_not_found"):
		return "会议不存在或尚未开始"
	case strings.Contains(msg, "meeting_ended"):
		return "会议已结束"
	case strings.Contains(msg, "account_auth_required"):
		return "登录身份与会议账号不一致，请联系管理员"
	case strings.Contains(msg, "account_active_on_other_endpoint"):
		return "该账号已在其他端在线，请先退出"
	}
	glog.Errorf(ctx, "入会失败未匹配到本域文案: %v", err)
	return "加入会议失败，请稍后重试；若持续失败请联系管理员"
}

func recordingUserMessage(ctx context.Context, err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "insufficient_recording_space"):
		return "录制空间不足，未能开始录制"
	case strings.Contains(msg, "board_recording_join_this_board_required"):
		return "只能录制本端设备承载的会议"
	case strings.Contains(msg, "board_recording_admin_required"):
		return "需要设备管理员权限才能开关录制"
	case strings.Contains(msg, "board_recording_requires_local_gateway"):
		return "云端录制需在会议设备侧发起，本页面无法开启"
	case strings.Contains(msg, "meeting_not_recordable"):
		return "该会议未开启云端录制"
	case strings.Contains(msg, "board_recording_busy"):
		return "录制设备正忙，请稍后重试"
	}
	glog.Errorf(ctx, "录制指令失败未匹配到本域文案: %v", err)
	return "录制操作未成功，请稍后重试"
}
