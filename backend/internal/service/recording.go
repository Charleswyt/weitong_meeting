package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gogf/gf/v2/database/gdb"
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/glog"
	"github.com/gogf/gf/v2/os/gtime"

	"cloud-conference-backend/internal/dao"
	"cloud-conference-backend/internal/model/do"
	"cloud-conference-backend/internal/service/thirdparty"
)

type RecordingService struct {
	adapter *thirdparty.Adapter
}

func NewRecordingService(adapter *thirdparty.Adapter) *RecordingService {
	return &RecordingService{adapter: adapter}
}

// List 从三方的云端录像目录取数（实测 ~150ms），不再等同步的 /state 聚合。
//
// 目录按**会议分组**分页（pagination.total 是组数、totalRecordings 是条数），
// 我方列表是按条分页 + 类型过滤，所以这里取回分组后展开、再自己排分页。
// 关键字与天数交给服务端（q / startFrom），不在本侧二次猜。
// 用户删过的条目（压制表里的 recordingId）在这里被摘掉且**不进 total** ——
// 上游有删不掉的孤儿行，不压回去就会出现"报成功、刷新又回来"。
/**
 * 按 recordingId 去重，保留**首次**出现的那条（同一条在上游目录里出现两次时字段应当一致）。
 *
 * 为什么需要（2026-10-01 现场"云端录制列表有重复"）：上游目录是按**分组 offset 翻页**摊平的
 * （`GetRecordingGroups`），而目录本身一直在变（会议结束、录制归档、用户删除）—— 偏移在两次请求
 * 之间会滑动，同一个分组可能被取两次，摊平后就是同一个 recordingId 两行。
 * 前端翻页 append 那侧也不去重，两边叠起来就是用户看到的"重复"。
 *
 * 没有 recordingId 的行去不了重，照原样保留（去重不能把无从判断的行吞掉）。
 */
func dedupeRecordings(in []thirdparty.ThirdRecording) []thirdparty.ThirdRecording {
	if len(in) < 2 {
		return in
	}
	seen := make(map[string]struct{}, len(in))
	out := in[:0:0] // 另起一个数组：不能就地写，否则会把还在被读的 `in` 覆盖掉
	for _, r := range in {
		if r.RecordingId == "" {
			out = append(out, r)
			continue
		}
		if _, hit := seen[r.RecordingId]; hit {
			continue
		}
		seen[r.RecordingId] = struct{}{}
		out = append(out, r)
	}
	return out
}

func (s *RecordingService) List(ctx context.Context, token string, pageNum, pageSize int, recordingType, keyword string, days int) ([]thirdparty.ThirdRecording, int, error) {
	cutoff := int64(0)
	if days > 0 {
		cutoff = time.Now().AddDate(0, 0, -days).Unix()
	}

	flat := make([]thirdparty.ThirdRecording, 0, 64)
	// 分组摘要里的会议名是结构字段，比拆 title 更可靠，先记下备查（历史孤行的 meeting 可为 null）。
	groupTitles := make(map[string]string, 16)
	// 会议号只有分组摘要里有（三方录像行的 title 不含号），所以同样先摊下来备查；
	// 摘不到会的那类条目从此只能是空串 —— 本域没有"本地会议号"这种东西，不拿别的键冒充。
	groupNos := make(map[string]string, 16)
	offset := 0
	for {
		page, err := s.adapter.GetRecordingGroups(ctx, token, thirdparty.RecordingGroupQuery{
			Q:         keyword,
			StartFrom: cutoff,
			Limit:     50,
			Offset:    offset,
		})
		if err != nil {
			return nil, 0, fmt.Errorf("查询录制列表失败: %w", err)
		}
		for _, group := range page.Groups {
			if group.Meeting != nil && group.Meeting.Title != "" {
				groupTitles[group.Meeting.MeetingId] = group.Meeting.Title
			}
			// 键按会议 id，与 groupTitles 同一把尺；id 空的摘要不进表（否则所有孤行会共享同一个号）
			if group.Meeting != nil && group.Meeting.MeetingId != "" && group.Meeting.MeetingNumber != "" {
				groupNos[group.Meeting.MeetingId] = group.Meeting.MeetingNumber
			}
			flat = append(flat, group.Recordings...)
		}
		if !page.Pagination.HasMore || len(page.Groups) == 0 {
			break
		}
		offset += len(page.Groups)
		if offset > 2000 { // 分组偏移上限 1000000，但翻到这儿说明上游异常，不该把请求挂住
			glog.Warningf(ctx, "录制目录翻页超出预期偏移，停止于 offset=%d", offset)
			break
		}
	}

	suppressed := suppressedRecordingIds(ctx)
	// 上游按分组 offset 翻页摊平时可能重复取到同一组（目录在变）：先去重再过滤，别把同一行给前端两次。
	flat = dedupeRecordings(flat)
	filtered := make([]thirdparty.ThirdRecording, 0, len(flat))
	for _, r := range flat {
		if _, hit := suppressed[r.RecordingId]; hit {
			continue
		}
		// 三方删除后保留 status=media_deleted 的墓碑行：既不可播也不可下。
		// 它留在列表里就是"删除成功但项还在"，所以在服务端就摘掉，且不进 total
		// —— 前端因此不需要为了躲墓碑把整个目录拉成一遍。
		if r.Status == "media_deleted" {
			continue
		}
		// 实测（2026-09-28）174 条里有 30 条 status=not_started：playbackUrl 空、
		// fileSizeBytes=0、error=recording_not_started —— 那是一路**从没开始录**的通路。
		// 把它列出来就是"点不动的卡 + 黑屏"，用户只会当成播放坏了；摘掉，也不进 total。
		if !playable(r) {
			continue
		}
		if recordingType != "" && RecordingKindOf(r) != recordingType {
			continue
		}
		// 通路语义在本域侧派生一次：前端只拿 mediaKind/mediaLabel/participant/会议名，
		// 不去拆三方的拼接串（契约 §1.2、AGENTS.md「前端只知后端」）。
		r.Participant, r.MediaKind, r.MediaLabel = thirdparty.LaneOf(r.Title)
		r.MeetingTitle = laneMeetingTitle(groupTitles, r)
		// 摊平时把号一起留下：卡片那一行要的就是它，别到前端再拆一次 title
		r.MeetingNumber = groupNos[r.MeetingId]
		r.StartedAtText = thirdparty.NormalizeTimeText(r.StartedAtText)
		filtered = append(filtered, r)
	}
	sort.SliceStable(filtered, func(i, j int) bool { return filtered[i].StartedAt > filtered[j].StartedAt })
	// 同场聚合必须在**分页之前**做：卡片那个跨度要的是这一场全部条目，而返回给前端的只是一页。
	attachSessionSpans(filtered)
	sessions := groupBySession(filtered)

	total := len(sessions)
	start := (pageNum - 1) * pageSize
	if start >= total {
		return []thirdparty.ThirdRecording{}, total, nil
	}
	end := start + pageSize
	if end > total {
		end = total
	}
	rows := make([]thirdparty.ThirdRecording, 0, pageSize)
	for _, g := range sessions[start:end] {
		rows = append(rows, g...)
	}
	return rows, total, nil
}

// groupBySession 把**已按开始时间倒序**的行聚成"一场 = 一组"，分页单位随之从"路"变成"场"。
//
// 为什么必须在这儿改：列表一张卡就是一场会（分组键见前端 `groupRecordingsBySession`），
// 而 `total` 一路数到 104、屏幕只有 9 张卡 —— 页头"共 104 个录制"和"已显示 20/104"
// 与屏幕永远对不上（2026-10-09 用户报"统计是错的"）。要前端自己数卡片也不行：
// 卡片要翻完所有页才数得全，而页头那个数第一页就要给。
//
// 分组**边界**必须与前端 `groupRecordingsBySession` 一致（键串本身不必相同，前端拿到的是行、自己再合）：
// 有 `meetingId` 的归同一场；**空 `meetingId` 的孤行各自成场**（并一起就是一张假卡）；
// 本机录制（`local`）也各自成场 —— 它永远不与云端那一路合卡，所以"云端场次数 + 本机条数"
// 是精确的，不受翻页进度影响。
func groupBySession(rows []thirdparty.ThirdRecording) [][]thirdparty.ThirdRecording {
	groups := make([][]thirdparty.ThirdRecording, 0, len(rows))
	index := make(map[string]int, len(rows))
	for _, r := range rows {
		key := "cloud:" + r.MeetingId
		if r.MeetingId == "" || RecordingKindOf(r) == "local" {
			key = "orphan:" + r.RecordingId
		}
		if i, ok := index[key]; ok {
			groups[i] = append(groups[i], r)
			continue
		}
		index[key] = len(groups)
		groups = append(groups, []thirdparty.ThirdRecording{r})
	}
	return groups
}

// attachSessionSpans 给同一场会的每一行挂上"这一场从什么时候开始、一共跨多久"。
//
// 为什么在服务端算而不是让前端多翻一页去凑：`List` 本来就把上游整个目录摊平、去重、过滤完
// 之后才切片分页（分页对上游没有任何节省），此刻全集就在手上；而前端列表是按**条**翻页的，
// 一场会**最早的那几行最后才到**，卡片只用已加载的行算跨度就会算短 —— 现网同一场会实测
// 卡片 1297 秒、点进回放页 1423 秒（推导见契约 ADR-0076 三）。
//
// `meetingId` 为空的孤行**不参与**聚合：它们不属于任何一场，按空串合到一起就是一张假卡。
// 起点取的是那一路自己的时间文本（已经是 RFC3339，见 NormalizeTimeText），不再格式化一遍 ——
// 进程时区与三方偏移都在那个串里，重排一次就多一处真源。
func attachSessionSpans(rows []thirdparty.ThirdRecording) {
	type span struct {
		anchorText string
		minMs      int64
		maxEndMs   int64
	}
	byMeeting := make(map[string]*span, 16)
	for _, r := range rows {
		if r.MeetingId == "" {
			continue
		}
		start, err := time.Parse(time.RFC3339, r.StartedAtText)
		if err != nil {
			continue
		}
		ms := start.UnixMilli()
		end := ms + int64(r.DurationSec*1000)
		s := byMeeting[r.MeetingId]
		if s == nil {
			byMeeting[r.MeetingId] = &span{anchorText: r.StartedAtText, minMs: ms, maxEndMs: end}
			continue
		}
		if ms < s.minMs {
			s.minMs, s.anchorText = ms, r.StartedAtText
		}
		if end > s.maxEndMs {
			s.maxEndMs = end
		}
	}
	for i := range rows {
		if rows[i].MeetingId == "" {
			continue
		}
		s := byMeeting[rows[i].MeetingId]
		if s == nil {
			continue // 这一场的时间文本一条都读不出来：宁缺，不猜一个起点
		}
		rows[i].MeetingStartedAtText = s.anchorText
		if s.maxEndMs > s.minMs {
			rows[i].MeetingSpanSec = float64(s.maxEndMs-s.minMs) / 1000
		}
	}
}

// RecordingKindOf 判这条录制属于"本地(设备)录制"还是"云端录制"。
//
// 实测（2026-09-28）：可见 174 条里 27 条来自板卡（RK3588-BJ 13、RK3588-BJ3 10、rk3588-001 4），
// 但它们的 mode 仍是 publication_cloud_copy_ts、localPaths 仍是空数组 —— 板卡的通路是**复制进云端目录**的，
// 所以"源设备是板卡"不等于"本地录制"。判据只有 localPaths 非空这一条。
// 两者都拿不准时按 local 归，不假装认识未知值。
func RecordingKindOf(r thirdparty.ThirdRecording) string {
	if len(r.LocalPaths) > 0 {
		return "local"
	}
	if strings.Contains(strings.ToLower(r.Mode), "cloud") {
		return "cloud"
	}
	return "local"
}

// playable 判这条通路有没有拿得出来的归档产物。
// 进行中/转码中（recording、finalizing、pending）暂时没 URL 是事实而不是坏数据，照样列出；
// 其余没有 URL 的行（实测 not_started：fileSizeBytes=0、error=recording_not_started）
// 列出来就是一张永远点不动的卡 —— 用户的感受是"回放黑屏"，那是我们的展示缺陷不是上游的。
func playable(r thirdparty.ThirdRecording) bool {
	if strings.TrimSpace(r.PlaybackUrl) != "" {
		return true
	}
	switch r.Status {
	case "recording", "finalizing", "pending":
		return true
	}
	return false
}

// laneMeetingTitle 优先用分组摘要里的会议名（结构字段），摘要缺失的历史孤行退回 title 的会议名段。
func laneMeetingTitle(groupTitles map[string]string, r thirdparty.ThirdRecording) string {
	if t := groupTitles[r.MeetingId]; t != "" {
		return t
	}
	return thirdparty.MeetingTitleOf(r.Title)
}

func (s *RecordingService) GetPlayback(ctx context.Context, token, meetingId string) (*thirdparty.PlaybackData, error) {
	data, err := s.adapter.GetPlayback(ctx, token, meetingId)
	if err != nil {
		return nil, err
	}
	// 回放元数据同样是"由 recordings[] 派生的出口"：用户删过的那几路不能还让他点得动。
	suppressed := suppressedRecordingIds(ctx)
	if len(suppressed) == 0 || len(data.Streams) == 0 {
		return data, nil
	}
	kept := make([]thirdparty.PlaybackStream, 0, len(data.Streams))
	for _, stream := range data.Streams {
		if _, hit := suppressed[stream.RecordingId]; hit {
			continue
		}
		// 三方的 mediaLabel 给的是**设备型号**（实测 "USB Camera (30c9:0041)"、
		// "本机麦克风 (适用于数字麦克风的英特尔® 智音技术)"），那是技术细节，不进界面；
		// 用本域的"画面/声音/共享屏幕"覆盖，型号只留在适配层内部。
		stream.MediaLabel = thirdparty.LabelOfKind(stream.MediaKind)
		kept = append(kept, stream)
	}
	data.Streams = kept
	return data, nil
}

// Download 代理三方归档下载（三方地址在自签证书主机上，浏览器直连必被拦）。
func (s *RecordingService) Download(ctx context.Context, token, recordingId string) (io.ReadCloser, http.Header, error) {
	return s.adapter.DownloadRecording(ctx, token, recordingId)
}

// Asset 代理某条录制目录下的一个 HLS 资产（playlist.m3u8 或分片）。
func (s *RecordingService) Asset(ctx context.Context, token, recordingId, rel string) (io.ReadCloser, http.Header, error) {
	return s.adapter.GetRecordingAsset(ctx, token, recordingId, rel)
}

// ErrRecordingNotFound 本侧看不见这条录制（未归档或已删）—— 属业务态，不是系统异常。
// 从 Delete 返回它时，压制行**已经落库**：调用方可以按"删除成功"回话，用户不会再看到这一行。
var ErrRecordingNotFound = errors.New("recording_not_found")

// ErrRecordingNotDeletable 上游说这条不归当前账号删（access.canDelete=false）。
// 必须在动上游之前拦住：拦不住就会让"删除"变成一次注定失败的请求，用户看到的是
// 报完错、行还在 —— 那是第 1 项抱怨的形状，不是上游的问题。
var ErrRecordingNotDeletable = errors.New("recording_not_deletable")

// Delete 三方没有"按录制 id 单删"的口子，只有整场会议的 DELETE，
// 所以先用全量列表定位它属于哪场会，再把整场的文件撤下。
//
// 无论三方是"删成了"还是"这场会本来就没有"（isUpstreamGone，实测孤儿行走这一支），
// 本侧都必须把这场会议的每一条录制登记进压制表后才回话 —— 只靠上游清理，
// 列表下一轮就从 recordings[] 把它重建出来，用户看到的就是"删了还在"。
func (s *RecordingService) Delete(ctx context.Context, token, recordingId string) (meetingId string, files int, bytes int64, err error) {
	// 目录是按会议分组的，meetingId 直接就在组上，不必再拉全量聚合去找。
	page, err := s.adapter.GetRecordingGroups(ctx, token, thirdparty.RecordingGroupQuery{Limit: 50})
	if err != nil {
		return "", 0, 0, fmt.Errorf("查询录制列表失败: %w", err)
	}
	var target *thirdparty.RecordingGroup
	var row *thirdparty.ThirdRecording
	for i := range page.Groups {
		for j := range page.Groups[i].Recordings {
			if page.Groups[i].Recordings[j].RecordingId == recordingId {
				target, row = &page.Groups[i], &page.Groups[i].Recordings[j]
				break
			}
		}
		if target != nil {
			break
		}
	}
	if target == nil || target.Meeting == nil {
		// 看不见这条录制：要么已结束清理过，要么本账号无权看见。两者对用户都是"这行没了"。
		return "", 0, 0, ErrRecordingNotFound
	}
	meetingId = target.Meeting.MeetingId

	// 上游已经明确告诉能不能删（access.canDelete），就别让用户点下去再看错误。
	// 实测（2026-09-28）普通参会者可见的 174 条全是 canDelete=false —— 不拦在这里，
	// 点删除只会拿到上游 403，然后被当成"系统异常"，看着像我们把它删了又没删。
	if !row.Access.CanDelete {
		return meetingId, 0, 0, ErrRecordingNotDeletable
	}

	// 整场删除 ⇒ 同场其它录制也不可用了，一并压制（用户下次点它们同样删不掉）。
	siblings := make([]thirdparty.ThirdRecording, 0, len(target.Recordings))
	for _, rec := range target.Recordings {
		if rec.MeetingId == meetingId {
			siblings = append(siblings, rec)
		}
	}

	files, bytes, err = s.adapter.DeleteMeetingRecordings(ctx, token, meetingId)
	gone := false
	if err != nil {
		// 上游说这场会/这条录制不在了 —— 与"删除成功"是同一个终态：本侧已经没有可删的东西。
		// 当失败抛出去，用户就会看到"删了但还留着"，那正是最误导人的形态。
		if !isUpstreamGone(err.Error()) {
			return meetingId, 0, 0, fmt.Errorf("删除三方录制失败: %w", err)
		}
		gone = true
		files, bytes = 0, 0
		g.Log().Infof(ctx, "三方已无这场会议的录制（%v），按幂等成功处理并登记压制: meetingId=%s recordingId=%s", err, meetingId, recordingId)
	}

	if writeErr := suppressRecordings(ctx, siblings); writeErr != nil {
		// 压制没落库 = 这一行下一轮还会回来。这时候回 200 就是本次要修的那个缺陷本身，
		// 所以如实报错（响应侧是 500「系统异常」），让用户重试而不是以为删干净了。
		g.Log().Errorf(ctx, "录制压制登记失败: meetingId=%s recordingId=%s err=%v", meetingId, recordingId, writeErr)
		return meetingId, 0, 0, fmt.Errorf("录制压制登记失败: %w", writeErr)
	}
	if gone {
		return meetingId, 0, 0, ErrRecordingNotFound
	}
	return meetingId, files, bytes, nil
}

// suppressedRecordingIds 一次性取回压制集合供列表/回放过滤用。
//
// 整表读而不是逐条 EXISTS：这张表只有"用户点过删除的录制"，行数 = 删除次数（现网个位数量级），
// 而 /recordings/list 的上游本身要 100–150 秒，绝不能再在里面叠 N+1 次库查询。
// 读失败时按"没有压制项"继续出列表（只记日志）：列表页挂掉比多显示一行陈旧条目更伤，
// 而且 GetThirdPartyToken 已经先打过库，库真坏到读不了这张表时请求根本走不到这里。
// 不加修剪策略：压制是永久语义，按时间过期等于把删不掉的孤儿行还给用户。
//
// 时刻列叫 suppressed_at 而不是 deleted_at，就是为了不让 gdb 的逻辑删除拦这一句
// （`deleted_at` 会被自动加 `WHERE DELETED_AT IS NULL`，那等于把所有压制行滤空 —— 实测踩过）。
func suppressedRecordingIds(ctx context.Context) map[string]struct{} {
	values, err := dao.RecordingDeleted.Ctx(ctx).Fields(dao.RecordingDeleted.Columns().RecordingId).Array()
	if err != nil {
		g.Log().Errorf(ctx, "读取录制压制集合失败（本轮不过滤）: %v", err)
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

// suppressRecordings 幂等登记压制行：先物理删这批 id 的旧行，再插新行。
// 重复删除（含用户连点两次、多条同场录制各点一次）必须都能落，而达梦没有 INSERT IGNORE，
// 直接 Insert 会撞主键；删+插同时把 suppressed_at 刷成最近一次删除的时刻。
func suppressRecordings(ctx context.Context, items []thirdparty.ThirdRecording) error {
	if len(items) == 0 {
		return nil
	}
	ids := make([]any, 0, len(items))
	rows := make([]do.RecordingDeleted, 0, len(items))
	now := gtime.Now()
	for _, item := range items {
		if item.RecordingId == "" {
			continue
		}
		ids = append(ids, item.RecordingId)
		rows = append(rows, do.RecordingDeleted{
			RecordingId:  item.RecordingId,
			MeetingId:    item.MeetingId,
			SuppressedAt: now,
		})
	}
	if len(rows) == 0 {
		return nil
	}
	return dao.RecordingDeleted.Ctx(ctx).Transaction(ctx, func(ctx context.Context, _ gdb.TX) error {
		if _, err := dao.RecordingDeleted.Ctx(ctx).
			WhereIn(dao.RecordingDeleted.Columns().RecordingId, ids).
			Delete(); err != nil {
			return err
		}
		_, err := dao.RecordingDeleted.Ctx(ctx).Data(rows).Insert()
		return err
	})
}

// isUpstreamGone 判定上游的"找不到"类原因码。
func isUpstreamGone(msg string) bool {
	for _, reason := range []string{"meeting_not_found", "recording_not_found", "not_found"} {
		if strings.Contains(msg, reason) {
			return true
		}
	}
	return false
}
