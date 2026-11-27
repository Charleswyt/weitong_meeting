package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/gogf/gf/v2/database/gdb"
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/glog"
	"github.com/gogf/gf/v2/os/gtime"

	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/dao"
	"cloud-conference-backend/internal/errs"
	"cloud-conference-backend/internal/model/do"
	"cloud-conference-backend/internal/model/entity"
	"cloud-conference-backend/internal/service/thirdparty"
	"cloud-conference-backend/internal/session"
)

type MeetingService struct {
	adapter *thirdparty.Adapter
	// thirdPartyToken 解析当前用户可用的三方 Bearer；预约/开始/结束都要它，
	// 由 cmd 注入 AuthService.GetThirdPartyToken，避免 service 内部互相构造。
	thirdPartyToken func(ctx context.Context, userId int64) (string, error)
	// refreshThirdPartyToken 丢掉缓存里的三方令牌并重登（同样由 cmd 注入 AuthService.RefreshThirdPartyToken）：
	// 三方把会话作废后要能换一个再试一次，见 token_retry.go。
	refreshThirdPartyToken func(ctx context.Context, userId int64) (string, error)
	// roomKey 由 cmd 注入 session.Registry.RoomKey：日程里的会不一定有预约单，
	// 前端要拿一个能访问 /meetings/{id}/... 的键，本库主键不够用。
	roomKey func(localId int64, externalNo string) int64

	// hostAbsentSince 记录「开会人（CreatorId）已退出但会议仍在 running」的起始时刻，
	// 超过 5 分钟仍未重新入会则自动结束会议并标记 abnormal_exit，避免会议室持续被占用。
	hostAbsentMu    sync.Mutex
	hostAbsentSince map[int64]time.Time
}

func NewMeetingService(adapter *thirdparty.Adapter) *MeetingService {
	return &MeetingService{
		adapter:         adapter,
		hostAbsentSince: make(map[int64]time.Time),
	}
}

func (s *MeetingService) WithThirdPartyToken(f func(ctx context.Context, userId int64) (string, error)) *MeetingService {
	s.thirdPartyToken = f
	return s
}

// WithTokenRefresher 注入"丢掉缓存令牌并重登"的能力（cmd 传 AuthService.RefreshThirdPartyToken），
// 用于 login_required 后的重试，见 token_retry.go。
func (s *MeetingService) WithTokenRefresher(f func(ctx context.Context, userId int64) (string, error)) *MeetingService {
	s.refreshThirdPartyToken = f
	return s
}

type MeetingStats struct {
	WeekCount    int
	PendingCount int
	MyCount      int
	TotalMinutes int
}

func (s *MeetingService) GetDetail(ctx context.Context, id int64) (*entity.MeetingAppointment, error) {
	// 用 One + IsEmpty 判"没这条会"：Scan 在零行时返回 sql.ErrNoRows，
	// 若把它当系统错就会回 500/系统异常 —— 而"会议不存在或已删除"是业务态（第 34/38/42 项同源）。
	rec, err := dao.MeetingAppointment.Ctx(ctx).Where(do.MeetingAppointment{Id: id}).One()
	if err != nil {
		return nil, fmt.Errorf("查询会议详情失败: %w", err)
	}
	if rec.IsEmpty() {
		return nil, errs.Bizf("会议不存在")
	}
	var meeting entity.MeetingAppointment
	if err := rec.Struct(&meeting); err != nil {
		return nil, fmt.Errorf("解析会议详情失败: %w", err)
	}
	return &meeting, nil
}

// Schedule 先落库，再尽力同步三方；三方失败不回滚本地预约单，
// 但把 local_status 置为 failed 并把原因原样返回，由 controller 如实提示。
func (s *MeetingService) Schedule(ctx context.Context, userId int64, in *ScheduleInput) (*entity.MeetingAppointment, string, error) {
	startTimeGT, err := gtime.StrToTime(in.StartTime)
	if err != nil {
		return nil, "", fmt.Errorf("开始时间格式错误: %w", err)
	}

	// 不再生成本地会议号：对外只认三方号，同步成功回填 THIRD_PARTY_MEETING_NUMBER 之前这场会没有号。
	meeting := &do.MeetingAppointment{
		Title:                 in.Title,
		CreatorId:             userId,
		HostThirdPartyAccount: in.HostAccount,
		StartTime:             startTimeGT,
		DurationMinutes:       in.DurationMinutes,
		CloudRecord:           boolToInt(in.CloudRecord),
		MuteOnJoin:            boolToInt(in.MuteOnJoin),
		CameraOffOnJoin:       boolToInt(in.CameraOffOnJoin),
		AllowWaiting:          boolToInt(in.AllowWaiting),
		LaunchKind:            NormalizeLaunchKind(in.LaunchKind, true),
		MeetingPassword:       strings.TrimSpace(in.Password),
		LocalStatus:           consts.LocalStatusPending,
		Status:                consts.MeetingStatusScheduled,
	}

	id, err := dao.MeetingAppointment.Ctx(ctx).Data(meeting).InsertAndGetId()
	if err != nil {
		return nil, "", fmt.Errorf("创建会议预约失败: %w", err)
	}
	clearScheduleCache()
	if err := PersistInvitees(ctx, id, in.ParticipantIds); err != nil {
		// 原文只进日志，给用户的那句不带 SQL/驱动细节（第 7 项）。
		glog.Errorf(ctx, "预约 %d 已创建，但受邀名单写入失败: %v", id, err)
		return nil, "", errs.Bizf("会议预约已创建，但受邀名单写入失败，请修改会议重新保存名单")
	}

	result := &entity.MeetingAppointment{
		Id:                    id,
		Title:                 in.Title,
		CreatorId:             userId,
		HostThirdPartyAccount: in.HostAccount,
		StartTime:             startTimeGT,
		DurationMinutes:       in.DurationMinutes,
		CloudRecord:           boolToInt(in.CloudRecord),
		LocalStatus:           consts.LocalStatusPending,
		Status:                consts.MeetingStatusScheduled,
	}

	syncReason := s.syncSchedule(ctx, userId, id, in, false)
	if syncReason == "" {
		// 回填后的行才是这场会的完整事实（含三方号）；拿内存里的 result 回给前端会让
		// "刚创建的会"显示本地号，而列表/详情显示三方号，两个号对不上。
		if fresh, ferr := s.GetDetail(ctx, id); ferr == nil {
			result = fresh
		} else {
			result.LocalStatus = consts.LocalStatusSynced
		}
	}
	return result, syncReason, nil
}

type ScheduleInput struct {
	Title           string
	MuteOnJoin      bool
	CameraOffOnJoin bool
	AllowWaiting    bool
	Password        string
	PasswordSet     bool
	StartTime       string
	DurationMinutes int
	CloudRecord     bool
	HostAccount     string
	ParticipantIds  []int64
	// LaunchKind：quick / scheduled / share / voice。
	LaunchKind string
}

func NormalizeLaunchKind(kind string, scheduled bool) string {
	k := strings.TrimSpace(strings.ToLower(kind))
	switch k {
	case "share", "voice", "quick", "scheduled":
		return k
	}
	if scheduled {
		return "scheduled"
	}
	return "quick"
}

func (s *MeetingService) QuickStart(ctx context.Context, userId int64, in *ScheduleInput) (*entity.MeetingAppointment, string, error) {
	now := gtime.Now()

	meeting := &do.MeetingAppointment{
		Title:                 in.Title,
		CreatorId:             userId,
		HostThirdPartyAccount: in.HostAccount,
		StartTime:             now,
		DurationMinutes:       in.DurationMinutes,
		CloudRecord:           boolToInt(in.CloudRecord),
		CameraOffOnJoin:       boolToInt(in.CameraOffOnJoin),
		LaunchKind:            NormalizeLaunchKind(in.LaunchKind, false),
		LocalStatus:           consts.LocalStatusPending,
		Status:                consts.MeetingStatusRunning,
	}

	id, err := dao.MeetingAppointment.Ctx(ctx).Data(meeting).InsertAndGetId()
	if err != nil {
		return nil, "", fmt.Errorf("创建快速会议失败: %w", err)
	}
	clearScheduleCache()

	result := &entity.MeetingAppointment{
		Id:                    id,
		Title:                 in.Title,
		CreatorId:             userId,
		HostThirdPartyAccount: in.HostAccount,
		StartTime:             now,
		DurationMinutes:       in.DurationMinutes,
		CloudRecord:           boolToInt(in.CloudRecord),
		LocalStatus:           consts.LocalStatusPending,
		Status:                consts.MeetingStatusRunning,
	}

	syncReason := s.syncSchedule(ctx, userId, id, in, true)
	if syncReason == "" {
		if fresh, ferr := s.GetDetail(ctx, id); ferr == nil {
			result = fresh
		} else {
			result.LocalStatus = consts.LocalStatusSynced
		}
	}
	return result, syncReason, nil
}

// syncSchedule 把本地预约单同步到三方；成功回填三方 id/会议号，失败返回原因。
// 三方把会话作废时（login_required）由 WithTokenRetry 重登后重试一次 —— 令牌缓存 2 小时且原先没有
// 失效重试，三方一侧作废后会一直用死令牌，表现就是"同一身份刚刚还行、忽然一律 401"。
func (s *MeetingService) syncSchedule(ctx context.Context, userId, localId int64, in *ScheduleInput, quick bool) string {
	if s.thirdPartyToken == nil || s.adapter == nil {
		return "会议服务当前不可用，" + managementVerb("create") + "没能发出，请稍后重试"
	}
	var startAt int64
	if !quick {
		startTimeGT, perr := gtime.StrToTime(in.StartTime)
		if perr != nil {
			s.discardUnsyncedAppointment(ctx, localId)
			return "开始时间无法解析"
		}
		startAt = startTimeGT.Timestamp()
	}

	var third *thirdparty.ThirdMeeting
	err := s.WithTokenRetry(ctx, userId, func(token string) error {
		if quick {
			t, callErr := s.adapter.QuickStart(ctx, token, &thirdparty.QuickStartReq{
				Title: in.Title, DurationMinutes: in.DurationMinutes,
				HostUsername: in.HostAccount, CloudRecord: in.CloudRecord,
			})
			if callErr == nil {
				third = t
			}
			return callErr
		}
		t, callErr := s.adapter.ScheduleMeeting(ctx, token, &thirdparty.ScheduleReq{
			Title: in.Title, StartAt: startAt, DurationMinutes: in.DurationMinutes,
			HostUsername: in.HostAccount, CloudRecord: in.CloudRecord,
			Sources: []string{}, TargetDevices: []string{},
		})
		if callErr == nil {
			third = t
		}
		return callErr
	})
	if err != nil {
		s.discardUnsyncedAppointment(ctx, localId)
		glog.Warningf(ctx, "会议平台创建/预约失败 meeting=%d: %v", localId, err)
		return managementUserMessage(err.Error(), "create")
	}

	if _, err := dao.MeetingAppointment.Ctx(ctx).Where(do.MeetingAppointment{Id: localId}).
		Data(do.MeetingAppointment{
			ThirdPartyMeetingId:     third.MeetingId,
			ThirdPartyMeetingNumber: third.MeetingNumber,
			LocalStatus:             consts.LocalStatusSynced,
		}).Update(); err != nil {
		glog.Errorf(ctx, "会议 %d 已在平台建好但本地回填失败: %v", localId, err)
		return "会议已经建好，但本地没能记下，列表里可能暂时看不到，请稍后刷新"
	}
	return ""
}

// discardUnsyncedAppointment 撤销一条"没能同步到三方"的本地预约单（连同受邀名单）。
//
// 为什么是撤销而不是留成 `failed`：三方那侧根本没有这场会，留一行只会在日程里冒充"可入会的会"，
// 用户点进去只得到"这场会还没准备好"，而且**清不掉**（取消要求待开始、结束要求主持人）——
// 2026-10-10 现场用户连撞四次，都是这种残留。发起失败就该当没发生过，把原因如实回给用户。
func (s *MeetingService) discardUnsyncedAppointment(ctx context.Context, localId int64) {
	err := dao.MeetingAppointment.Ctx(ctx).Transaction(ctx, func(ctx context.Context, _ gdb.TX) error {
		if _, err := dao.MeetingParticipant.Ctx(ctx).
			Where(dao.MeetingParticipant.Columns().AppointmentId, localId).Delete(); err != nil {
			return err
		}
		_, err := dao.MeetingAppointment.Ctx(ctx).Where(do.MeetingAppointment{Id: localId}).Delete()
		return err
	})
	if err != nil {
		glog.Errorf(ctx, "撤销未同步的预约单 %d 失败（会留下一条日程残留）: %v", localId, err)
		return
	}
	clearScheduleCache()
	glog.Infof(ctx, "已撤销没能同步到三方的预约单 %d", localId)
}

// Start 先同步三方再改本地态；三方失败则本地不变（避免"我们显示进行中但没人能入会"）。
func (s *MeetingService) Start(ctx context.Context, id, userId int64, account string) (string, error) {
	m, err := s.GetDetail(ctx, id)
	if err != nil {
		return "", err
	}
	// 开始也是主持人的动作。等候室（第 10 项）把"本地状态到 running"当放行信号之一，
	// 谁都能 start 就等于谁都能替主持人把成员放进会里。
	if !CanManage(m, userId, account) {
		return "", errs.Bizf("只有会议主持人可以开始这场会议")
	}
	if reason := s.callManagement(ctx, userId, m, "start"); reason != "" {
		return reason, nil
	}
	if err := s.setStatus(ctx, id, consts.MeetingStatusRunning); err != nil {
		return "", err
	}
	return "", nil
}

// MarkRunning 将仍处于 scheduled 的本地预约单推进为 running（用于首次有人通过门禁入会时）。
func (s *MeetingService) MarkRunning(ctx context.Context, id int64) {
	if id <= 0 {
		return
	}
	if err := s.setStatus(ctx, id, consts.MeetingStatusRunning); err != nil {
		glog.Warningf(ctx, "入会后回写会议 %d running 状态失败: %v", id, err)
	}
}

func (s *MeetingService) Stop(ctx context.Context, id, userId int64) (string, error) {
	m, err := s.GetDetail(ctx, id)
	if err != nil {
		return "", err
	}
	if reason := s.callManagement(ctx, userId, m, "stop"); reason != "" {
		// 平台侧已经不在跑：本地仍要落终态，否则首页永远挂着「进行中」。
		if platformAlreadyStopped(reason) {
			if err := s.setStatusWithReason(ctx, id, consts.MeetingStatusEnded, consts.MeetingEndReasonNormal); err != nil {
				return "", err
			}
			s.ClearHostAbsent(id)
			return "", nil
		}
		return reason, nil
	}
	if err := s.setStatusWithReason(ctx, id, consts.MeetingStatusEnded, consts.MeetingEndReasonNormal); err != nil {
		return "", err
	}
	s.ClearHostAbsent(id)
	return "", nil
}

func platformAlreadyStopped(reason string) bool {
	return strings.Contains(reason, "已经不存在") || strings.Contains(reason, "不在进行中")
}

func (s *MeetingService) callManagement(ctx context.Context, userId int64, m *entity.MeetingAppointment, action string) string {
	if s.thirdPartyToken == nil || s.adapter == nil {
		return "会议服务当前不可用，" + managementVerb(action) + "没能发出，请稍后重试"
	}
	if m.ThirdPartyMeetingId == "" {
		// 从没同步成功过 = 平台上根本没有这场会，这不是故障，说清楚就行。
		return "这场会议还没在会议平台上建起来，无法" + managementVerb(action)
	}
	token, err := s.thirdPartyToken(ctx, userId)
	if err != nil {
		glog.Warningf(ctx, "取会议平台令牌失败 user=%d meeting=%d: %v", userId, m.Id, err)
		return "登录身份没能续上，请重新登录后再试"
	}
	var raw error
	if action == "start" {
		raw = s.adapter.StartMeeting(ctx, token, m.ThirdPartyMeetingId)
	} else {
		raw = s.adapter.StopMeeting(ctx, token, m.ThirdPartyMeetingId)
	}
	if raw == nil {
		return ""
	}
	glog.Warningf(ctx, "会议平台%s失败 meeting=%d vendorId=%s: %v", managementVerb(action), m.Id, m.ThirdPartyMeetingId, raw)
	return managementUserMessage(raw.Error(), action)
}

func managementVerb(action string) string {
	switch action {
	case "start":
		return "启动"
	case "create":
		return "创建"
	}
	return "结束"
}

// managementUserMessage 把平台侧的原始失败原因收进服务端日志，只回给用户一句能行动的中文。
// 原始串里有平台域名、接口路径和 Go 运行时错误 —— 实测停会超时整段被当作 msg 弹到界面上
// （`三方结束会议失败: http request POST /api/frontend/... : context deadline exceeded`），
// 用户既看不懂也没法操作，还把外部系统暴露进了界面（第 10/34 项、契约 §1.1）。
func managementUserMessage(raw, action string) string {
	verb := managementVerb(action)
	switch {
	case strings.Contains(raw, "deadline"), strings.Contains(raw, "timeout"),
		strings.Contains(raw, "connection refused"), strings.Contains(raw, "no such host"),
		strings.Contains(raw, "EOF"):
		return "会议平台暂时没有回应，" + verb + "没能确认，请稍后重试"
	case strings.Contains(raw, "participant_not_joined"), strings.Contains(raw, "401"):
		return "登录身份已失效，请重新登录后再试"
	case strings.Contains(raw, "meeting_not_found"), strings.Contains(raw, "404"):
		return "这场会议在平台上已经不存在，刷新列表确认一下"
	case strings.Contains(raw, "meeting_not_running"), strings.Contains(raw, "409"):
		return "这场会议当前不在进行中，刷新列表看看最新状态"
	}
	return "会议平台处理失败，" + verb + "没能完成，请稍后重试"
}

func (s *MeetingService) setStatus(ctx context.Context, id int64, status string) error {
	return s.setStatusWithReason(ctx, id, status, "")
}

func (s *MeetingService) setStatusWithReason(ctx context.Context, id int64, status, endReason string) error {
	data := do.MeetingAppointment{Status: status}
	if endReason != "" {
		data.EndReason = endReason
	}
	_, err := dao.MeetingAppointment.Ctx(ctx).
		Where(do.MeetingAppointment{Id: id}).
		Data(data).
		Update()
	clearScheduleCache()
	return err
}

// MarkHostLeft 记录开会人离开时刻（主动离会或幽灵回收时调用），用于 5 分钟超时自动结束计时。
func (s *MeetingService) MarkHostLeft(meetingId, userId int64) {
	if !session.IsManaged(meetingId) {
		return
	}
	s.hostAbsentMu.Lock()
	defer s.hostAbsentMu.Unlock()
	if s.hostAbsentSince == nil {
		s.hostAbsentSince = make(map[int64]time.Time)
	}
	if _, exists := s.hostAbsentSince[meetingId]; !exists {
		s.hostAbsentSince[meetingId] = time.Now()
	}
}

// ClearHostAbsent 清除某场会议的开会人缺席计时（重新入会或会议结束时调用）。
func (s *MeetingService) ClearHostAbsent(meetingId int64) {
	s.hostAbsentMu.Lock()
	delete(s.hostAbsentSince, meetingId)
	s.hostAbsentMu.Unlock()
}

// AutoEndIfHostAbsent 巡检所有进行中的会议：判断开会人当前是否在会中，
// 若开会人已退出超过 grace（默认 5 分钟），自动结束会议并标记为 abnormal_exit，避免会议室持续被占用。
func (s *MeetingService) AutoEndIfHostAbsent(ctx context.Context, registry *session.Registry, grace time.Duration) int {
	if registry == nil || grace <= 0 {
		return 0
	}
	var running []*entity.MeetingAppointment
	if err := dao.MeetingAppointment.Ctx(ctx).
		Where(do.MeetingAppointment{Status: consts.MeetingStatusRunning}).
		Limit(200).
		Scan(&running); err != nil {
		glog.Warningf(ctx, "扫描进行中会议（开会人离会超时检测）失败: %v", err)
		return 0
	}

	now := time.Now()
	activeIds := make(map[int64]struct{}, len(running))
	ended := 0

	for _, m := range running {
		activeIds[m.Id] = struct{}{}
		// 判断开会人当前是否在会中（有活跃会话即视为在会）
		if _, inMeeting := registry.Session(m.Id, m.CreatorId); inMeeting {
			s.ClearHostAbsent(m.Id)
			continue
		}

		s.hostAbsentMu.Lock()
		if s.hostAbsentSince == nil {
			s.hostAbsentSince = make(map[int64]time.Time)
		}
		since, recorded := s.hostAbsentSince[m.Id]
		if !recorded {
			since = now
			s.hostAbsentSince[m.Id] = since
		}
		s.hostAbsentMu.Unlock()

		if now.Sub(since) < grace {
			continue
		}

		// 开会人退出已满 5 分钟：通知三方停会并落库为异常退出（abnormal_exit）
		if reason := s.callManagement(ctx, m.CreatorId, m, "stop"); reason != "" && !platformAlreadyStopped(reason) {
			glog.Warningf(ctx, "自动结束超时会议 %d 调用三方停会未确认（仍将落库终态）: %s", m.Id, reason)
		}
		if err := s.setStatusWithReason(ctx, m.Id, consts.MeetingStatusEnded, consts.MeetingEndReasonAbnormalExit); err != nil {
			glog.Warningf(ctx, "自动结束超时会议 %d 回写终态失败: %v", m.Id, err)
			continue
		}
		s.ClearHostAbsent(m.Id)
		ended++
		glog.Infof(ctx, "会议 %d（%s）开会人已退出超过 %s，已自动结束（abnormal_exit）", m.Id, m.ThirdPartyMeetingNumber, grace)
	}

	// 清理已非 running 状态的旧计时项
	s.hostAbsentMu.Lock()
	for id := range s.hostAbsentSince {
		if _, ok := activeIds[id]; !ok {
			delete(s.hostAbsentSince, id)
		}
	}
	s.hostAbsentMu.Unlock()
	return ended
}

// IsTerminalStatus 判断会议状态是否已是终态：进了这个集合就不会再回到 running，
// 广播与错误文案都据此决定"这场会真的没了"还是"暂时拿不到状态"。
func IsTerminalStatus(status string) bool {
	switch status {
	case consts.MeetingStatusEnded, consts.MeetingStatusCancelled, consts.MeetingStatusFailed:
		return true
	}
	return false
}

// SyncUpstreamStatus 把三方的终态回写本地。三方会在会议时长耗尽后自行结束会议，
// 我们若不回写，本地记录会永远停在 running，首页一直挂"进行中"、入会才被拒。
// 只允许 running/starting → 终态 这一个方向，不去猜或改写别的状态。
// 键不是本系统预约单主键时（外部会议）库里没有对应记录，直接跳过。
func (s *MeetingService) SyncUpstreamStatus(ctx context.Context, id int64, upstream string) error {
	if upstream == consts.MeetingEndReasonEmpty {
		return s.SyncUpstreamStatusWithReason(ctx, id, consts.MeetingStatusEnded, consts.MeetingEndReasonEmpty)
	}
	return s.SyncUpstreamStatusWithReason(ctx, id, upstream, "")
}

func (s *MeetingService) SyncUpstreamStatusWithReason(ctx context.Context, id int64, upstream, endReason string) error {
	if !session.IsManaged(id) {
		return nil
	}
	var target string
	switch upstream {
	case "ended":
		target = consts.MeetingStatusEnded
	case "cancelled":
		target = consts.MeetingStatusCancelled
	case "failed":
		target = consts.MeetingStatusFailed
	default:
		return nil
	}
	m, err := s.GetDetail(ctx, id)
	if err != nil {
		return err
	}
	if m.Status != consts.MeetingStatusRunning && m.Status != consts.MeetingStatusStarting {
		return nil
	}
	s.ClearHostAbsent(id)
	return s.setStatusWithReason(ctx, id, target, endReason)
}

// staleAppointment 核对"僵尸会议"只用到这几个字段。
type staleAppointment struct {
	Id                      int64       `json:"id"`
	CreatorId               int64       `json:"creatorId"`
	ThirdPartyMeetingNumber string      `json:"thirdPartyMeetingNumber"`
	StartedAt               *gtime.Time `json:"startedAt"`
	StartTime               *gtime.Time `json:"startTime"`
	DurationMinutes         int         `json:"durationMinutes"`
}

// ReconcileStaleRunning 向三方核对"按预约时长早该结束、本地还挂着 running/starting"的会并回写终态。
// 三方在时长耗尽后会自行结束会议，而回写终态只发生在有人留在会中拉状态的时候；没人挂着的那批
// 就永远显示"进行中"，几天前的会也一直占在列表里。只核对时长已过的，未到期的会一律不动。
// ReconcileStaleRunning 用三方权威状态纠正本地挂在 running/starting 的会议。
//
// 之前这里先按「计划时长已过」过滤，只有过期的才去核对 —— 那正是列表里留着几天前 60 分钟会议
// 还显示运行中的原因：手动 stop 过的会、时长没填满的会永远进不了核对。现在**不再用时长推断**，
// 一律以三方报的运行集为准（/meetings?status=starting,running 实测 ~100ms，一次覆盖一个创建人）。
// 不在运行集里的行仍要逐会确认一次：看不见它有两种原因（真的结束了 / 本账号无权看见），
// 只有单查给出终态或 404 才回写，拿不到答案就保持原样，不猜。
func (s *MeetingService) ReconcileStaleRunning(ctx context.Context) int {
	if s.thirdPartyToken == nil || s.adapter == nil {
		return 0
	}
	var rows []*staleAppointment
	if err := dao.MeetingAppointment.Ctx(ctx).
		Fields("ID", "CREATOR_ID", "THIRD_PARTY_MEETING_NUMBER", "STARTED_AT", "START_TIME", "DURATION_MINUTES").
		WhereIn("STATUS", g.Slice{consts.MeetingStatusRunning, consts.MeetingStatusStarting}).
		Limit(200).
		Scan(&rows); err != nil {
		glog.Warningf(ctx, "扫描待核对会议失败: %v", err)
		return 0
	}

	byCreator := make(map[int64][]*staleAppointment)
	for _, row := range rows {
		byCreator[row.CreatorId] = append(byCreator[row.CreatorId], row)
	}

	fixed := 0
	for creatorId, list := range byCreator {
		token, err := s.thirdPartyToken(ctx, creatorId)
		if err != nil {
			glog.Warningf(ctx, "核对会议取不到令牌 creator=%d: %v", creatorId, err)
			continue
		}
		live := s.upstreamRunningNumbers(ctx, token)
		if live == nil {
			// 取不到权威运行集时退回逐会确认；这不是失败，只是少了一次批量优势。
			glog.Warningf(ctx, "取不到三方运行会议集 creator=%d，逐会确认", creatorId)
		}
		for _, row := range list {
			if row.ThirdPartyMeetingNumber == "" {
				continue
			}
			if live != nil && live[row.ThirdPartyMeetingNumber] {
				continue // 三方说它还在跑，本地不动
			}
			status, known := s.upstreamEndStatus(ctx, row)
			if !known {
				continue
			}
			if err := s.SyncUpstreamStatus(ctx, row.Id, status); err != nil {
				glog.Warningf(ctx, "核对回写会议 %d 终态失败: %v", row.Id, err)
				continue
			}
			fixed++
		}
	}
	return fixed
}

// upstreamRunningNumbers 返回三方当前仍在 starting/running 的会议号集合。
// 出错返回 nil（调用方据此知道"这次没有权威答案"），不返回空集冒充"一场都没在跑"。
func (s *MeetingService) upstreamRunningNumbers(ctx context.Context, token string) map[string]bool {
	page, err := s.adapter.GetMeetingPage(ctx, token, thirdparty.MeetingQuery{
		Status: []string{"starting", "running"},
		Detail: "summary",
		Limit:  1000,
	})
	if err != nil {
		glog.Warningf(ctx, "查三方运行会议集失败: %v", err)
		return nil
	}
	out := make(map[string]bool, len(page.Meetings))
	for _, m := range page.Meetings {
		if m.MeetingNumber != "" {
			out[m.MeetingNumber] = true
		}
	}
	if page.Pagination.Meetings.HasMore {
		// 超过 1000 场在跑不是这个系统会有的规模；真出现了就说明集合不完整，不能当权威用。
		glog.Warningf(ctx, "三方运行会议集超出单页，total=%d 已取=%d", page.Pagination.Meetings.Total, len(out))
		return nil
	}
	return out
}

// upstreamEndStatus 问三方这场会现在到底是什么态，只有拿到"已经没了"这一类事实才回写。
// 会议号在三方已经查不到同样是"没了"的事实，按 ended 处理；拿不到答案就返回 false，不猜。
func (s *MeetingService) upstreamEndStatus(ctx context.Context, row *staleAppointment) (string, bool) {
	if row.ThirdPartyMeetingNumber == "" {
		return "", false
	}
	token, err := s.thirdPartyToken(ctx, row.CreatorId)
	if err != nil {
		return "", false
	}
	info, err := s.adapter.GetMeetingByNumber(ctx, token, row.ThirdPartyMeetingNumber)
	if err != nil {
		msg := err.Error()
		if errors.Is(err, thirdparty.ErrEmptyRoomEnded) {
			return consts.MeetingEndReasonEmpty, true
		}
		if strings.Contains(msg, "meeting_ended") || strings.Contains(msg, "not_found") || strings.Contains(msg, "404") {
			return "ended", true
		}
		return "", false
	}
	switch info.Status {
	case "ended", "finished", "closed":
		return "ended", true
	case "cancelled":
		return "cancelled", true
	case "failed":
		return "failed", true
	}
	return "", false
}

// CanManage 谁能改/取消这场会（第 6 项：只有主持人）。
// 主持人以预约单上记的三方主持人账号为准；那个账号为空（建会时没落上主持人）时退回创建人，
// 否则刚建完的会会因为账号空而连建会人都改不动。
func CanManage(m *entity.MeetingAppointment, userId int64, account string) bool {
	if m.HostThirdPartyAccount != "" {
		return account != "" && m.HostThirdPartyAccount == account
	}
	return m.CreatorId == userId
}

// VisibleToUser 预约单详情可见性：与日程 localForUser 同口径（创建 / 受邀 / 参加过），
// 防免登录关掉之后仍用别人的预约 id 偷看详情。
func (s *MeetingService) VisibleToUser(ctx context.Context, appointmentId, userId int64) (bool, error) {
	if appointmentId == 0 || userId == 0 {
		return false, nil
	}
	cols := dao.MeetingAppointment.Columns()
	invited := dao.MeetingParticipant.Table()
	attended := dao.MeetingAttendance.Table()
	n, err := dao.MeetingAppointment.Ctx(ctx).
		Where(cols.Id, appointmentId).
		Where("("+cols.CreatorId+" = ? OR "+cols.Id+" IN (SELECT APPOINTMENT_ID FROM "+invited+
			" WHERE USER_ID = ? AND DELETED_AT IS NULL) OR "+cols.Id+" IN (SELECT APPOINTMENT_ID FROM "+attended+
			" WHERE USER_ID = ?))", userId, userId, userId).
		WhereNull(cols.DeletedAt).
		Count()
	if err != nil {
		return false, fmt.Errorf("校验会议可见性失败: %w", err)
	}
	return n > 0, nil
}

// 删除会议整条链路已按第 6 项撤除（会议可取消、不可删除）：
// 路由 DELETE /meetings/{id}、controller.Delete、service.Delete 都不在了。
// meeting_deleted 那张压制表仍然读 —— 历史删过的行要继续压住，否则它们会在日程里复活。

// Cancel 取消尚未开始的会议：置 status=cancelled，记录保留（不删行）。
//
// 三方没有"取消预约"这个动作，但它的**停止会议**就是撤下预约的口子 —— 实测对一场
// scheduled 的会调 `POST /meetings/{id}/stop` 后，三方把该会报成 `ended`、参会 0。
// 所以取消要真的通知三方，不能只改本地，否则同账号登三方控制台仍看得到这场"待开始"。
//
// 三方调用失败不挡本地取消（否则一场从未同步成功的会永远撤不掉），但原因要如实带回 msg。
// 返回 (三方侧的失败原因, 本地错误)。
func (s *MeetingService) Cancel(ctx context.Context, id, userId int64, account string) (string, error) {
	m, err := s.GetDetail(ctx, id)
	if err != nil {
		return "", err
	}
	if !CanManage(m, userId, account) {
		return "", errs.Bizf("只有会议主持人可以取消这场会议")
	}
	if m.Status != consts.MeetingStatusScheduled {
		return "", errs.Bizf("只有待开始的会议可以取消；这场会已经开始或已结束")
	}
	reason := s.callManagement(ctx, userId, m, "取消")
	if err := s.setStatus(ctx, id, consts.MeetingStatusCancelled); err != nil {
		return "", err
	}
	return reason, nil
}

// Update 修改尚未开始的会议。三方无「修改预约」接口，故只更新本地字段，不回写三方。
// 返回 (更新后的记录, 受邀名单写入失败原因)。
func (s *MeetingService) Update(ctx context.Context, id int64, in *ScheduleInput, userId int64, account string) (*entity.MeetingAppointment, string, error) {
	m, err := s.GetDetail(ctx, id)
	if err != nil {
		return nil, "", err
	}
	if !CanManage(m, userId, account) {
		return nil, "", errs.Bizf("只有会议主持人可以修改这场会议")
	}
	if m.Status != consts.MeetingStatusScheduled {
		return nil, "", errs.Bizf("只有待开始的会议可以修改；这场会已经开始或已结束")
	}
	startTimeGT, err := gtime.StrToTime(in.StartTime)
	if err != nil {
		return nil, "", fmt.Errorf("开始时间格式错误: %w", err)
	}

	data := do.MeetingAppointment{
		Title:           in.Title,
		StartTime:       startTimeGT,
		DurationMinutes: in.DurationMinutes,
		CloudRecord:     boolToInt(in.CloudRecord),
		MuteOnJoin:      boolToInt(in.MuteOnJoin),
		CameraOffOnJoin: boolToInt(in.CameraOffOnJoin),
		AllowWaiting:    boolToInt(in.AllowWaiting),
	}
	if in.PasswordSet {
		data.MeetingPassword = strings.TrimSpace(in.Password)
	}
	if _, err := dao.MeetingAppointment.Ctx(ctx).Where(do.MeetingAppointment{Id: id}).Data(data).Update(); err != nil {
		return nil, "", fmt.Errorf("修改会议失败: %w", err)
	}
	clearScheduleCache()

	inviteeReason := ""
	if in.ParticipantIds != nil {
		if err := PersistInvitees(ctx, id, in.ParticipantIds); err != nil {
			// 原文（SQL/驱动报错）只进日志；给用户的那句话不带技术细节（第 7 项）。
			glog.Errorf(ctx, "修改会议 %d 的受邀名单写入失败: %v", id, err)
			inviteeReason = "受邀名单更新失败，请稍后重试"
		}
	}

	m.Title = in.Title
	m.StartTime = startTimeGT
	m.DurationMinutes = in.DurationMinutes
	m.CloudRecord = boolToInt(in.CloudRecord)
	m.MuteOnJoin = boolToInt(in.MuteOnJoin)
	m.CameraOffOnJoin = boolToInt(in.CameraOffOnJoin)
	return m, inviteeReason, nil
}

// GetExternalNumber 按三方会议号取本地预约记录。
// 只认三方号：本地 6 位号已不再生成（2026-10-10 口径 —— 对外唯一入会号就是三方号），
// 历史行里存着的本地号一律不再作为查询键，免得又出现"用页面上看到的号入会却命中不到"的分叉。
func (s *MeetingService) GetExternalNumber(ctx context.Context, meetingNo string) (*entity.MeetingAppointment, error) {
	cols := dao.MeetingAppointment.Columns()
	// 按会议号查不到是用户输入错了号：必须是业务拒绝「会议不存在」，
	// 不能因为 Scan 零行返回 sql.ErrNoRows 就升级成「系统异常」（第 38/40 项的报错形态即源于此）。
	rec, err := dao.MeetingAppointment.Ctx(ctx).
		Where(cols.ThirdPartyMeetingNumber, meetingNo).
		WhereNull(cols.DeletedAt).
		One()
	if err != nil {
		return nil, fmt.Errorf("查询会议失败: %w", err)
	}
	if rec.IsEmpty() {
		return nil, errs.Bizf("会议不存在")
	}
	var m entity.MeetingAppointment
	if err := rec.Struct(&m); err != nil {
		return nil, fmt.Errorf("解析会议失败: %w", err)
	}
	return &m, nil
}

// ResolveExternal 把前端输入的会议号解析为三方会议号。只接三方号：
// 命中本地行就取它记下的三方号 —— 没记下说明这场会根本没同步成功，明确报错而不是回落本地号（三方不认本地号）；
// 本地没这行时，6 位以上的号按"三方建的会（手机/板卡发起）"放行，由上游判定存不存在。
func (s *MeetingService) ResolveExternal(ctx context.Context, meetingNo string) (external string, local *entity.MeetingAppointment, err error) {
	if local, err = s.GetExternalNumber(ctx, meetingNo); err == nil {
		if local.ThirdPartyMeetingNumber == "" {
			return "", nil, errs.Bizf("这场会还没准备好，暂时无法入会")
		}
		return local.ThirdPartyMeetingNumber, local, nil
	}
	if len(meetingNo) >= 6 {
		return meetingNo, nil, nil
	}
	return "", nil, err
}

func (s *MeetingService) BackfillStartedAt(ctx context.Context, id int64, startedAt *gtime.Time) {
	if id == 0 || startedAt == nil {
		return
	}
	_, _ = dao.MeetingAppointment.Ctx(ctx).Where(do.MeetingAppointment{Id: id}).
		Data(do.MeetingAppointment{StartedAt: startedAt}).Update()
}

// UpdateTitle 更新本系统会议的标题（会中改名或审批通过后落库）。
func (s *MeetingService) UpdateTitle(ctx context.Context, id int64, title string) error {
	if id <= 0 {
		return nil
	}
	_, err := dao.MeetingAppointment.Ctx(ctx).Where(do.MeetingAppointment{Id: id}).
		Data(do.MeetingAppointment{Title: strings.TrimSpace(title)}).Update()
	return err
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

// CreatorBrief 是 controller 层给会议 VO 富化 creatorName/positionCode 用的小结构。
type CreatorBrief struct {
	DisplayName  string
	PositionCode string
}

// GetCreatorBrief 批量按 id 查 creator 的展示名与职位码，供 controller 拼 VO。
func (s *MeetingService) GetCreatorBrief(ctx context.Context, userIds []int64) (map[int64]CreatorBrief, error) {
	out := make(map[int64]CreatorBrief, len(userIds))
	if len(userIds) == 0 {
		return out, nil
	}
	var rows []entity.SysUser
	if err := dao.SysUser.Ctx(ctx).FieldsEx(avatarBlobColumns()).WhereIn("ID", userIds).Scan(&rows); err != nil {
		return nil, fmt.Errorf("查询创建人失败: %w", err)
	}
	for _, u := range rows {
		out[u.Id] = CreatorBrief{DisplayName: u.DisplayName, PositionCode: u.PositionCode}
	}
	return out, nil
}
