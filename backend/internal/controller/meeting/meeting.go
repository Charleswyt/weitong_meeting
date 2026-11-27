package meeting

import (
	"context"
	"errors"
	"strings"

	"github.com/gogf/gf/v2/net/ghttp"
	"github.com/gogf/gf/v2/os/glog"
	"github.com/gogf/gf/v2/os/gtime"

	v1 "cloud-conference-backend/api/v1"
	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/errs"
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
	userSvc    *service.UserService
	dictSvc    *service.DictService
	adapter    *thirdparty.Adapter
	registry   *session.Registry
	pump       RoomPump
}

func New(meetingSvc *service.MeetingService, authSvc *service.AuthService, userSvc *service.UserService, dictSvc *service.DictService, adapter *thirdparty.Adapter, registry *session.Registry, pump RoomPump) *Controller {
	return &Controller{meetingSvc: meetingSvc, authSvc: authSvc, userSvc: userSvc, dictSvc: dictSvc, adapter: adapter, registry: registry, pump: pump}
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
		Password:       req.Password,
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
			case errors.Is(err, thirdparty.ErrEmptyRoomEnded):
				_ = c.meetingSvc.SyncUpstreamStatus(ctx, local.Id, consts.MeetingEndReasonEmpty)
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
	requiresPassword := false
	if local != nil && local.MeetingPassword != "" {
		cu := c.callerOf(r)
		if !service.CanManage(local, cu.UserId, cu.Account) {
			requiresPassword = true
		}
	}
	response.Ok(r, v1.MeetingPrecheckRes{Joinable: true, RequiresPassword: requiresPassword})
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
	// 入会密码校验：主持人免密，其余参会人必须提供匹配的入会密码。
	if local != nil && local.MeetingPassword != "" && !service.CanManage(local, userId, user.ThirdPartyAccount) {
		if strings.TrimSpace(req.Password) == "" {
			response.Fail(r, "该会议已设置入会密码，请输入密码")
			return
		}
		if strings.TrimSpace(req.Password) != local.MeetingPassword {
			response.Fail(r, "入会密码不正确，请重新输入")
			return
		}
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
	var preLocalId int64
	if local != nil {
		preLocalId = local.Id
	}
	if preKey := c.registry.RoomKey(preLocalId, externalNo); preKey != 0 {
		if existingRoom, ok := c.registry.Room(preKey); ok {
			if override := existingRoom.GetDisplayNameOverride(userId); override != "" {
				displayName = override
			}
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
		if local.Status == consts.MeetingStatusScheduled {
			c.meetingSvc.MarkRunning(r.Context(), local.Id)
			status = consts.MeetingStatusRunning
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
	if room, ok := c.registry.Room(roomKey); ok {
		if ct := room.GetCustomTitle(); ct != "" {
			title = ct
		}
		room.SyncParticipantCount(1, gtime.Now().Time)
	}
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
	if !c.adapter.IsSinosatV1(r.Context()) {
		if m, err := c.meetingSvc.GetDetail(r.Context(), req.MeetingId); err == nil && m != nil && m.CreatorId == userId {
			c.meetingSvc.MarkHostLeft(req.MeetingId, userId)
		}
	}
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
	if err := c.meetingSvc.SyncUpstreamStatusWithReason(r.Context(), req.MeetingId, "ended", consts.MeetingEndReasonNormal); err != nil {
		glog.Warningf(r.Context(), "结束会议后回写 %d 终态失败: %v", req.MeetingId, err)
	}
	response.OkWithMessage(r, "会议已结束")
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
	in := &service.ScheduleInput{
		Title: req.Title, StartTime: req.StartTime, DurationMinutes: req.DurationMinutes,
		CloudRecord: req.CloudRecord,
		MuteOnJoin:  req.MuteOnJoin == nil || *req.MuteOnJoin, CameraOffOnJoin: req.CameraOff != nil && *req.CameraOff,
		AllowWaiting:   req.AllowWaiting != nil && *req.AllowWaiting,
		ParticipantIds: req.ParticipantIds,
	}
	if req.Password != nil {
		in.Password = *req.Password
		in.PasswordSet = true
	}
	m, inviteeReason, err := c.meetingSvc.Update(r.Context(), req.Id, in, cu.UserId, cu.Account)
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
