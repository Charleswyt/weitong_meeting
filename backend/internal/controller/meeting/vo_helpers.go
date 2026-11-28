package meeting

import (
	"context"
	"strconv"
	"strings"

	"github.com/gogf/gf/v2/os/glog"
	"github.com/gogf/gf/v2/os/gtime"

	v1 "cloud-conference-backend/api/v1"
	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/model/entity"
	"cloud-conference-backend/internal/service"
)

// 两边都不成立才拦，宁可让成员进会也别把人永久关在门外。
func (c *Controller) hostInMeeting(ctx context.Context, local *entity.MeetingAppointment, roomKey int64) bool {
	if local.Status == consts.MeetingStatusRunning {
		return true
	}
	hostUid, ok := c.hostUserId(ctx, local)
	if !ok {
		return false
	}
	_, in := c.registry.Session(roomKey, hostUid)
	return in
}

// hostUserId 解析主持人的本库用户 id，口径与 service.CanManage 保持一致：
// 预约单记了三方主持人账号就按账号反查；没记（建会人自己没有三方账号）时主持人就是建会人。
// 之前这里对空账号直接返回失败，于是建会人亲自入会后，成员永远被挡在"等待主持人"页。
func (c *Controller) hostUserId(ctx context.Context, local *entity.MeetingAppointment) (int64, bool) {
	if local.HostThirdPartyAccount == "" {
		return local.CreatorId, local.CreatorId != 0
	}
	return c.meetingSvc.UserIdByThirdAccount(ctx, local.HostThirdPartyAccount)
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
		vo.EndReason = m.EndReason
		vo.LocalStatus = m.LocalStatus
		vo.MuteOnJoin = m.MuteOnJoin == 1
		vo.CameraOffOnJoin = m.CameraOffOnJoin == 1
		vo.AllowWaiting = m.AllowWaiting == 1
		vo.HasPassword = m.MeetingPassword != ""
		vo.CreatorId = m.CreatorId
		if m.StartedAt != nil {
			vo.StartedAt = formatTime(m.StartedAt)
		}
		if m.Status == consts.MeetingStatusEnded && m.UpdatedAt != nil {
			vo.EndedAt = formatTime(m.UpdatedAt)
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
		HasPassword:     m.MeetingPassword != "",
		CreatorId:       m.CreatorId,
		HostName:        m.HostThirdPartyAccount,
		Status:          m.Status,
		EndReason:       m.EndReason,
		Kind:            service.NormalizeLaunchKind(m.LaunchKind, m.Status == consts.MeetingStatusScheduled),
		IsHost:          service.CanManage(m, cu.UserId, cu.Account),
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
	if m.Status == consts.MeetingStatusEnded && m.UpdatedAt != nil {
		vo.EndedAt = formatTime(m.UpdatedAt)
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
