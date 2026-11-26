package service

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/gogf/gf/v2/database/gdb"
	"github.com/gogf/gf/v2/os/gcache"
	"github.com/gogf/gf/v2/os/glog"
	"github.com/gogf/gf/v2/os/gtime"

	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/dao"
	"cloud-conference-backend/internal/model/do"
	"cloud-conference-backend/internal/model/entity"
	"cloud-conference-backend/internal/service/thirdparty"
)

// ScheduleItem 是日程里的一条。两边都可能有、都可能缺：
//   - Upstream 零值：本系统预约了但三方还没有（同步失败，或还没开始同步）；
//   - Local 为 nil：只在三方建的会（手机/板卡发起），本库没有预约单，也不该造一行。
//
// 取字段一律走下面的方法，不要在消费侧自己挑哪一边 —— 谁覆盖谁在这一个文件里说清楚。
type ScheduleItem struct {
	Upstream thirdparty.ThirdMeeting
	Local    *entity.MeetingAppointment
	RoomKey  int64
}

func orString(primary, fallback string) string {
	if primary != "" {
		return primary
	}
	return fallback
}

func (it ScheduleItem) Number() string {
	if it.Upstream.MeetingNumber != "" {
		return it.Upstream.MeetingNumber
	}
	if it.Local != nil {
		// 只回三方号：本地 6 位号已不再生成（2026-10-10 口径），没同步成功的会这一栏就是空。
		return it.Local.ThirdPartyMeetingNumber
	}
	return ""
}

func (it ScheduleItem) Title() string {
	if it.Local != nil && it.Local.Title != "" {
		return it.Local.Title
	}
	return it.Upstream.Title
}

// status 的优先级：本地「已取消」覆盖三方 —— 三方没有取消接口，取消是本系统单方面的决定，
// 让三方的 scheduled 把它冲掉等于把用户刚取消的会又挂回日程。
// 本地已知终态（ended/failed）也优先于三方 —— 三方列表端点的状态更新比单查端点慢，
// Precheck/Reconcile 通过单查端点回写的终态更实时，不应被列表端点的旧值覆盖。
// 本地预约为 scheduled 且上游还没有人入会时，保持「待开始」（公网会议族创建房间即报 running，
// 不能把刚预约的未来会议直接显示成「进行中」）。
func (it ScheduleItem) Status() string {
	if it.Local != nil && it.Local.Status == consts.MeetingStatusCancelled {
		return consts.MeetingStatusCancelled
	}
	if it.Local != nil && IsTerminalStatus(it.Local.Status) {
		return it.Local.Status
	}
	if it.Local != nil && it.Local.Status == consts.MeetingStatusScheduled &&
		it.Upstream.ActiveParticipantCount == 0 && it.Upstream.ParticipantCount == 0 {
		return consts.MeetingStatusScheduled
	}
	if it.Upstream.Status != "" {
		return it.Upstream.Status
	}
	if it.Local != nil {
		return it.Local.Status
	}
	return ""
}

func (it ScheduleItem) StartAt() int64 {
	// 本系统创建的预约/会议优先使用预约单记录的开始时间；
	// 公网会议族上游无预约时刻字段，会把房间创建时刻（当前时间）当 startAt 返回，不能覆盖用户预约的时间。
	if it.Local != nil && it.Local.StartTime != nil {
		return it.Local.StartTime.Timestamp()
	}
	if it.Upstream.StartAt > 0 {
		return it.Upstream.StartAt
	}
	return 0
}

func (it ScheduleItem) DurationMin() int {
	if it.Upstream.DurationMin > 0 {
		return it.Upstream.DurationMin
	}
	if it.Local != nil {
		return it.Local.DurationMinutes
	}
	return 0
}

// CloudRecord 这场会有没有云端录制。三方列表里取到就以三方为准；退回本地时必须要求这场会
// 确实在三方建起来过（ThirdPartyMeetingId 非空）—— cloud_record 那列只是预约时勾的意愿位，
// 从没建成的会（local_status=failed）拿它报 true，就是把没兑现的意愿当成事实报出去。
func (it ScheduleItem) CloudRecord() bool {
	if it.Upstream.MeetingId != "" {
		return it.Upstream.CloudRecord
	}
	return it.Local != nil && it.Local.ThirdPartyMeetingId != "" && it.Local.CloudRecord == 1
}

func (it ScheduleItem) HostAccount() string {
	if it.Upstream.HostUsername != "" {
		return it.Upstream.HostUsername
	}
	if it.Local != nil {
		return it.Local.HostThirdPartyAccount
	}
	return ""
}

// Kind 首页入口类型。本地有 LAUNCH_KIND 用它；否则按预约/快速推断。
func (it ScheduleItem) Kind() string {
	if it.Local != nil {
		if k := strings.TrimSpace(it.Local.LaunchKind); k != "" {
			return NormalizeLaunchKind(k, false)
		}
		if it.Local.Status == consts.MeetingStatusScheduled {
			return "scheduled"
		}
		if it.Local.CreatedAt != nil && it.Local.StartTime != nil {
			if it.Local.StartTime.Timestamp()-it.Local.CreatedAt.Timestamp() > 90 {
				return "scheduled"
			}
		}
		if strings.HasPrefix(it.Local.Title, "临时会议") {
			return "quick"
		}
	}
	return "quick"
}

// createdAtOf 只有本系统有"预约创建时间"这个概念；外部会议回落到三方的开始时刻。
func (it ScheduleItem) CreatedAt() int64 {
	if it.Local != nil && it.Local.CreatedAt != nil {
		return it.Local.CreatedAt.Timestamp()
	}
	return it.StartAt()
}

func (s *MeetingService) WithRoomKey(f func(localId int64, externalNo string) int64) *MeetingService {
	s.roomKey = f
	return s
}

// ScheduleBoard 组这个账号的日程：**自己创建的 + 别人邀请自己的**，不是全租户的会。
// 两个来源各有盲区，所以取并集：
//   - 三方 managementState 里主持人=本账号的会：覆盖手机/板卡直接发起、本库没有预约单的情况；
//   - 本地预约单（我建的 + 我受邀的）：覆盖"三方同步失败所以三方根本没有"，以及
//     "别人主持、邀请我"的会 —— 三方那份列表按主持人过滤就看不见它。
//
// 首页一次会打 List/Today/Stats 三个口，所以按用户缓存 5 秒；预约/修改/取消/状态回写即失效。
func (s *MeetingService) ScheduleBoard(ctx context.Context, userId int64, account string) ([]ScheduleItem, error) {
	if cached, err := scheduleCache.Get(ctx, scheduleCacheKey(userId)); err == nil && cached != nil {
		if items, ok := cached.Val().([]ScheduleItem); ok {
			return items, nil
		}
	}

	locals, err := s.localForUser(ctx, userId)
	if err != nil {
		return nil, err
	}
	byNumber := make(map[string]*entity.MeetingAppointment, len(locals))
	for i := range locals {
		r := locals[i]
		// 只按三方号对齐：本地 6 位号已不再生成（2026-10-10），历史行里那份也不参与匹配。
		if r.ThirdPartyMeetingNumber != "" {
			byNumber[r.ThirdPartyMeetingNumber] = &r
		}
	}

	// 三方会议列表走服务端分页端点（实测 ~100ms，返回该账号可见的全部状态），
	// 不再等 /state 全租户聚合那一支 —— 含活动会议的完整查询实测要 ~78 秒。
	// 取不到时降级为只出本地预约单：日程页宁可少几场，也不能白屏。
	var upstream []thirdparty.ThirdMeeting
	if token, terr := s.thirdPartyToken(ctx, userId); terr == nil {
		for offset := 0; ; {
			page, perr := s.adapter.GetMeetingPage(ctx, token, thirdparty.MeetingQuery{
				Detail: "summary", Limit: 200, Offset: offset,
			})
			if perr != nil {
				glog.Warningf(ctx, "取三方会议列表失败，日程降级为仅本地: %v", perr)
				upstream = nil
				break
			}
			upstream = append(upstream, page.Meetings...)
			if !page.Pagination.Meetings.HasMore || len(page.Meetings) == 0 {
				break
			}
			offset += len(page.Meetings)
			if offset > 5000 {
				glog.Warningf(ctx, "三方会议列表翻页超出预期 offset=%d，停止", offset)
				break
			}
		}
	} else {
		glog.Warningf(ctx, "取三方令牌失败，日程降级为仅本地: %v", terr)
	}

	matched := make(map[int64]bool, len(locals))
	items := make([]ScheduleItem, 0, len(locals)+8)
	suppressed := suppressedMeetingIds(ctx)
	// 第 5 项：加入过的会也要上日程。三方那份列表按主持人过滤只认"我主持的"，
	// 别人主持、我进去过的会在主持人过滤这一步就被丢掉，所以参加过是第二条放行凭据。
	attended := attendedMeetingIds(ctx, userId)
	for _, m := range upstream {
		// 本侧删过的会不再上日程：三方没有"删除会议"这个动作，停会只把它变成 ended
		// 继续留在列表里（实测 17 条已删预约中 16 条至今仍出现在近期会议，92323537 甚至仍报
		// scheduled 还能被拨号入会），所以"删了就不再出现"只能在这一句过滤上兑现。
		if _, hit := suppressed[m.MeetingId]; hit {
			continue
		}
		iHosted := account != "" && m.HostUsername == account
		_, iAttended := attended[m.MeetingId]
		local := byNumber[m.MeetingNumber]
		// 三条凭据任一成立就上日程：我主持的 / 我进过的 / 本库有这场会的预约单
		// （我建的或受邀的，走下面的 locals 分支也一样出得来，但三方这行字段更全，优先用它）。
		if account != "" && !iHosted && !iAttended && local == nil {
			continue
		}
		if local != nil {
			matched[local.Id] = true
		}
		items = append(items, ScheduleItem{Upstream: m, Local: local, RoomKey: s.roomKeyOf(idOf(local), m.MeetingNumber)})
	}
	// 本地有、三方没列出来的（同步失败，或主持人不是本账号的受邀会）也要上日程。
	for i := range locals {
		r := locals[i]
		if matched[r.Id] {
			continue
		}
		number := orString(r.ThirdPartyMeetingNumber, r.MeetingNumber)
		items = append(items, ScheduleItem{Local: &r, RoomKey: s.roomKeyOf(r.Id, number)})
	}

	sort.SliceStable(items, func(i, j int) bool { return items[i].StartAt() > items[j].StartAt() })
	_ = scheduleCache.Set(ctx, scheduleCacheKey(userId), items, 5*time.Second)
	return items, nil
}

func idOf(local *entity.MeetingAppointment) int64 {
	if local == nil {
		return 0
	}
	return local.Id
}

func (s *MeetingService) roomKeyOf(localId int64, externalNo string) int64 {
	if s.roomKey != nil {
		return s.roomKey(localId, externalNo)
	}
	return localId
}

// suppressedMeetingIds 一次性取回"本侧删过的会"的三方会议 id 集合，供日程合并过滤。
//
// 整表读而不是逐条 EXISTS：这张表行数 = 删除次数（个位到十位量级），而日程一支要翻页取三方
// 列表，绝不能再在里面叠 N+1 次库查询。读失败按"没有压制项"继续出列表并记 error：
// 日程页白屏比多显示一行陈旧条目更伤，且这一步之前已经取过三方令牌（同样打库），
// 库真读不了时请求走不到这里。与录制压制同一套取舍。
//
// 按三方 meetingId 而不是会议号判定：meetingId 才是"那一场会"的标识，日程合并也按它对齐；
// 会议号是给人拨号用的，不保证一场一号。
func suppressedMeetingIds(ctx context.Context) map[string]struct{} {
	values, err := dao.MeetingDeleted.Ctx(ctx).Fields(dao.MeetingDeleted.Columns().MeetingId).Array()
	if err != nil {
		glog.Errorf(ctx, "读取会议压制集合失败（本轮不过滤）: %v", err)
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

// suppressMeeting 登记这场会已被本侧删除。幂等：达梦没有 INSERT IGNORE，重复删同一场
// （用户连点两次）直接 Insert 会撞主键，所以先物理删旧行再插，顺带把时刻刷成最近一次。
//
// 必须在删本地预约单**之前**写：反过来的话，中间崩一次就得到"本地没行、三方还在报、
// 本侧也没记账"的野会 —— 那正是第 13 项的成因。
func suppressMeeting(ctx context.Context, meetingId, meetingNumber string, appointmentId int64) error {
	if meetingId == "" {
		return nil
	}
	return dao.MeetingDeleted.Ctx(ctx).Transaction(ctx, func(ctx context.Context, _ gdb.TX) error {
		if _, err := dao.MeetingDeleted.Ctx(ctx).
			Where(dao.MeetingDeleted.Columns().MeetingId, meetingId).Delete(); err != nil {
			return err
		}
		_, err := dao.MeetingDeleted.Ctx(ctx).Data(do.MeetingDeleted{
			MeetingId:     meetingId,
			MeetingNumber: meetingNumber,
			AppointmentId: appointmentId,
			SuppressedAt:  gtime.Now(),
		}).Insert()
		return err
	})
}

func scheduleCacheKey(userId int64) string { return fmt.Sprintf("sched:%d", userId) }

var scheduleCache = gcache.New()

// clearScheduleCache 在预约/修改/取消/状态回写后清缓存，别让改动最多 5 秒不可见。
func clearScheduleCache() {
	_ = scheduleCache.Clear(context.Background())
}

// localForUser 取这个账号的本地日程：自己预约的 + 受邀参加的 + 参加过的（第 5 项）。
// 三个来源是三件不同的事实：受邀不等于到过，预约也不等于到过，所以参会历史单列一支。
func (s *MeetingService) localForUser(ctx context.Context, userId int64) ([]entity.MeetingAppointment, error) {
	cols := dao.MeetingAppointment.Columns()
	invited := dao.MeetingParticipant.Table()
	attended := dao.MeetingAttendance.Table()
	var rows []entity.MeetingAppointment
	err := dao.MeetingAppointment.Ctx(ctx).
		Where("("+cols.CreatorId+" = ? OR "+cols.Id+" IN (SELECT APPOINTMENT_ID FROM "+invited+
			" WHERE USER_ID = ? AND DELETED_AT IS NULL) OR "+cols.Id+" IN (SELECT APPOINTMENT_ID FROM "+attended+
			" WHERE USER_ID = ?))", userId, userId, userId).
		// 没同步成功的预约单不上日程：三方没有这场会，留着只会冒充"可入会的会"。
		// 判据带上"有没有三方 id"，所以回填失败的**真会议**照旧显示，只压掉从没有过的那批。
		Where("("+cols.LocalStatus+" <> ? OR "+cols.ThirdPartyMeetingId+" <> '')", consts.LocalStatusFailed).
		WhereNull(cols.DeletedAt).
		Scan(&rows)
	if err != nil {
		return nil, fmt.Errorf("查询本地日程失败: %w", err)
	}
	return rows, nil
}

// FilterSchedule 按我方契约的查询参数过滤 + 排序 + 分页，返回当页与总数。
func FilterSchedule(items []ScheduleItem, status, keyword, orderBy, isAsc string, pageNum, pageSize int) ([]ScheduleItem, int) {
	if pageNum < 1 {
		pageNum = 1
	}
	if pageSize < 1 {
		pageSize = 10
	}
	kept := make([]ScheduleItem, 0, len(items))
	for _, it := range items {
		if status != "" && it.Status() != status {
			continue
		}
		if keyword != "" && !strings.Contains(strings.ToLower(scheduleHaystack(it)), strings.ToLower(keyword)) {
			continue
		}
		kept = append(kept, it)
	}
	sortSchedule(kept, orderBy, isAsc)
	start := (pageNum - 1) * pageSize
	if start > len(kept) {
		start = len(kept)
	}
	end := start + pageSize
	if end > len(kept) {
		end = len(kept)
	}
	return kept[start:end], len(kept)
}

func scheduleHaystack(it ScheduleItem) string {
	parts := []string{it.Title(), it.Number(), it.HostAccount()}
	if it.Local != nil {
		parts = append(parts, it.Local.MeetingNumber)
	}
	return strings.Join(parts, " ")
}

// sortSchedule 保持与原来按库排序时相同的可排序字段名；默认开始时间倒序（最近的在前）。
func sortSchedule(items []ScheduleItem, orderBy, isAsc string) {
	asc := isAsc == "asc"
	sort.SliceStable(items, func(i, j int) bool {
		var less bool
		switch orderBy {
		case "title":
			less = items[i].Title() < items[j].Title()
		case "meeting_number":
			less = items[i].Number() < items[j].Number()
		case "duration_minutes":
			less = items[i].DurationMin() < items[j].DurationMin()
		case "created_at":
			less = items[i].CreatedAt() < items[j].CreatedAt()
		default:
			less = items[i].StartAt() < items[j].StartAt()
		}
		if asc {
			return less
		}
		return !less
	})
}

// TodaySchedule 取今天该上首页的会：开始时刻落在今日，或此刻仍在进行中的会。
// 只按"今日开始"过滤会把跨天的进行时会藏掉，而手机建的快速会议通常就是当下这一场。
func TodaySchedule(items []ScheduleItem, now *gtime.Time) []ScheduleItem {
	startOfDay, endOfDay := now.StartOfDay().Timestamp(), now.EndOfDay().Timestamp()
	out := make([]ScheduleItem, 0, 8)
	for _, it := range items {
		at := it.StartAt()
		if at <= 0 {
			continue
		}
		if it.Status() == consts.MeetingStatusRunning || (at >= startOfDay && at <= endOfDay) {
			out = append(out, it)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].StartAt() < out[j].StartAt() })
	return out
}

// ScheduleStats 从同一份日程聚合，保证首页数字和列表说的是同一批会。
func ScheduleStats(items []ScheduleItem, userId int64) *MeetingStats {
	stats := &MeetingStats{}
	weekStart := time.Now().AddDate(0, 0, -7).Unix()
	for _, it := range items {
		if it.StartAt() >= weekStart {
			stats.WeekCount++
		}
		if it.Status() == consts.MeetingStatusScheduled {
			stats.PendingCount++
		}
		if it.Local != nil && it.Local.CreatorId == userId {
			stats.MyCount++
		}
		st := it.Status()
		if st == consts.MeetingStatusEnded || st == consts.MeetingStatusRunning {
			stats.TotalMinutes += it.DurationMin()
		}
	}
	return stats
}
