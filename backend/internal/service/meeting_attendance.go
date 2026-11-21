package service

import (
	"context"

	"github.com/gogf/gf/v2/database/gdb"
	"github.com/gogf/gf/v2/os/glog"
	"github.com/gogf/gf/v2/os/gtime"

	"cloud-conference-backend/internal/dao"
	"cloud-conference-backend/internal/model/do"
)

// AttendanceCounts 按三方 meetingId 统计去重参会人数，供近期会议列表展示。
func AttendanceCounts(ctx context.Context, meetingIds []string) map[string]int {
	out := make(map[string]int, len(meetingIds))
	if len(meetingIds) == 0 {
		return out
	}
	type row struct {
		MeetingId string `json:"meetingId"`
		Cnt       int    `json:"cnt"`
	}
	var rows []row
	err := dao.MeetingAttendance.Ctx(ctx).
		Fields(dao.MeetingAttendance.Columns().MeetingId+" as meetingId", "COUNT(1) as cnt").
		WhereIn(dao.MeetingAttendance.Columns().MeetingId, meetingIds).
		Group(dao.MeetingAttendance.Columns().MeetingId).
		Scan(&rows)
	if err != nil {
		glog.Warningf(ctx, "统计参会人数失败: %v", err)
		return out
	}
	for _, r := range rows {
		if r.MeetingId != "" {
			out[r.MeetingId] = r.Cnt
		}
	}
	return out
}

// recordAttendance 记一笔「这个账号进过这场会」（第 5 项）。
//
// 只在入会已经成功之后写 —— 入会被拒（要录制同意、会议没开始）不算参加过。
// meetingId 为空就不写：三方 meetingId 才是一场会的稳定身份，会议号是拨号用的、
// 不保证一场一号，拿它当键就是给将来对不上的记录留一行假账。
//
// 达梦没有 INSERT IGNORE，而 (meeting_id, user_id) 是唯一约束，所以走
// 「查有则推、查无则插」一个事务：重复入会只把 last_joined_at 往前推、join_count 加一。
func recordAttendance(ctx context.Context, meetingId, meetingNumber string, appointmentId, userId int64) error {
	if meetingId == "" || userId == 0 {
		return nil
	}
	cols := dao.MeetingAttendance.Columns()
	return dao.MeetingAttendance.Ctx(ctx).Transaction(ctx, func(ctx context.Context, tx gdb.TX) error {
		row, err := tx.Model(dao.MeetingAttendance.Table()).Ctx(ctx).
			Where(cols.MeetingId, meetingId).
			Where(cols.UserId, userId).
			Fields(cols.Id, cols.JoinCount).
			One()
		if err != nil {
			return err
		}
		now := gtime.Now()
		if row.IsEmpty() {
			_, err = tx.Model(dao.MeetingAttendance.Table()).Ctx(ctx).Data(do.MeetingAttendance{
				MeetingId:     meetingId,
				MeetingNumber: meetingNumber,
				AppointmentId: appointmentId,
				UserId:        userId,
				FirstJoinedAt: now,
				LastJoinedAt:  now,
				JoinCount:     1,
			}).Insert()
			return err
		}
		_, err = tx.Model(dao.MeetingAttendance.Table()).Ctx(ctx).
			WherePri(row[cols.Id].Int64()).
			Data(do.MeetingAttendance{
				LastJoinedAt:  now,
				JoinCount:     row[cols.JoinCount].Int() + 1,
				AppointmentId: appointmentId,
				MeetingNumber: meetingNumber,
			}).Update()
		return err
	})
}

// RecordAttendance 入会成功后记一笔参会历史（第 5 项），并让日程立刻重算。
// 记账失败只记日志：这场会已经成功进去了，不能因为历史没写下就给用户报一次故障。
func (s *MeetingService) RecordAttendance(ctx context.Context, meetingId, meetingNumber string, appointmentId, userId int64) {
	if err := recordAttendance(ctx, meetingId, meetingNumber, appointmentId, userId); err != nil {
		glog.Errorf(ctx, "登记参会历史失败 meeting=%s user=%d: %v", meetingId, userId, err)
		return
	}
	clearScheduleCache()
}

// attendedMeetingIds 取这个账号参加过的三方 meetingId 集合，供日程合并放行
// "别人主持、我进过"的那一场（第 5 项）。整表按人读而不是逐条 EXISTS：
// 日程一支要翻页取三方列表，绝不能再在里面叠 N+1 次库查询。
// 读失败按"没有参加过"继续出列表并记 error —— 日程宁可少几行，不能白屏。
func attendedMeetingIds(ctx context.Context, userId int64) map[string]struct{} {
	values, err := dao.MeetingAttendance.Ctx(ctx).
		Fields(dao.MeetingAttendance.Columns().MeetingId).
		Where(dao.MeetingAttendance.Columns().UserId, userId).
		Array()
	if err != nil {
		glog.Errorf(ctx, "读取 %d 的参会历史失败（本轮不按参加过放行）: %v", userId, err)
		return nil
	}
	set := make(map[string]struct{}, len(values))
	for _, v := range values {
		if id := v.String(); id != "" {
			set[id] = struct{}{}
		}
	}
	return set
}

// UserIdByThirdAccount 按三方账号反查本库用户 id。
// 等候室要判断"主持人这个端在不在会里"，而会话是按本库 userId 键控的，
// 预约单上只有三方账号，所以这一步是那座桥。查不到（主持人是板卡/手机这类
// 本库没有档案的账号）就回 false，调用方据此只能靠会议状态判，不猜。
func (s *MeetingService) UserIdByThirdAccount(ctx context.Context, account string) (int64, bool) {
	if account == "" {
		return 0, false
	}
	cols := dao.SysUser.Columns()
	v, err := dao.SysUser.Ctx(ctx).
		Fields(cols.Id).
		Where(cols.ThirdPartyAccount, account).
		WhereNull(cols.DeletedAt).
		Value()
	if err != nil {
		glog.Warningf(ctx, "按三方账号反查用户失败 account=%s: %v", account, err)
		return 0, false
	}
	uid := v.Int64()
	return uid, uid != 0
}
