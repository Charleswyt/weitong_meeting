package service

import (
	"math"
	"sort"
	"strings"
	"time"

	v1 "cloud-conference-backend/api/v1"
	"cloud-conference-backend/internal/consts"
)

// BuildMeetingOverview 按维度聚合当前用户的全量会议概览数据，前端仅做渲染与兜底格式化。
func BuildMeetingOverview(
	items []ScheduleItem,
	userId int64,
	account string,
	dimension string,
	startDate string,
	endDate string,
	now time.Time,
) v1.MeetingOverviewRes {
	dim := normalizeOverviewDimension(dimension)
	winStart, winEnd := overviewTimeWindow(dim, startDate, endDate, now)

	res := v1.MeetingOverviewRes{
		Dimension: dim,
		Tags: v1.MeetingOverviewTagsVo{
			AccessModes: []v1.MeetingOverviewTagCountVo{},
			Categories:  []v1.MeetingOverviewTagCountVo{},
		},
	}

	var (
		earliestItem *v1.MeetingOverviewExtremeItemVo
		earliestTs   int64
		longestItem  *v1.MeetingOverviewExtremeItemVo
		longestSec   int64 = -1
		longestTs    int64
		latestItem   *v1.MeetingOverviewExtremeItemVo
		latestTs     int64

		edgeCount    int
		cloudCount   int
		meetingCount int
		voiceCount   int
		activeDays   = map[string]struct{}{}
		catCounts    = map[string]int{}
	)

	for _, it := range items {
		st := it.Status()
		if st == consts.MeetingStatusCancelled || st == consts.MeetingStatusFailed {
			continue
		}
		startUnix := it.StartAt()
		if !inOverviewWindow(startUnix, winStart, winEnd) {
			continue
		}

		res.Volume.Total++

		isHost := isOverviewHost(it, userId, account)
		if isHost {
			res.Volume.Hosted++
		} else {
			res.Volume.Participated++
		}

		title := strings.TrimSpace(it.Title())
		if title == "" {
			title = "未命名会议"
		}

		switch classifyMeetingForm(title) {
		case "hybrid":
			res.Volume.Hybrid++
		case "offline":
			res.Volume.Offline++
		default:
			res.Volume.Online++
		}

		durMin := it.DurationMin()
		if durMin < 0 {
			durMin = 0
		}
		durSec := int64(durMin) * 60
		res.Duration.TotalSeconds += durSec
		if isHost {
			res.Duration.HostedSeconds += durSec
		} else {
			res.Duration.ParticipatedSeconds += durSec
		}

		isVoice := isVoiceMeeting(it, title)
		if isVoice {
			res.Volume.Voice++
		} else if it.Kind() == "scheduled" {
			res.Volume.Scheduled++
		} else {
			res.Volume.Quick++
		}
		if startUnix > 0 {
			activeDays[time.Unix(startUnix, 0).Format("2006-01-02")] = struct{}{}
		}
		if isVoice {
			voiceCount++
			res.DurationByKind.Voice.TotalSeconds += durSec
			if isHost {
				res.DurationByKind.Voice.HostedSeconds += durSec
			} else {
				res.DurationByKind.Voice.ParticipatedSeconds += durSec
			}
		} else {
			meetingCount++
			res.DurationByKind.Meeting.TotalSeconds += durSec
			if isHost {
				res.DurationByKind.Meeting.HostedSeconds += durSec
			} else {
				res.DurationByKind.Meeting.ParticipatedSeconds += durSec
			}
		}

		if it.CloudRecord() {
			res.Recording.Count++
			res.Duration.RecordingSeconds += durSec
			if isVoice {
				res.DurationByKind.Voice.RecordingSeconds += durSec
			} else {
				res.DurationByKind.Meeting.RecordingSeconds += durSec
			}
		}

		if startUnix > 0 {
			itemVo := buildExtremeVo(it, title, startUnix, durSec)
			if earliestItem == nil || startUnix < earliestTs {
				earliestTs = startUnix
				cp := itemVo
				earliestItem = &cp
			}
			if latestItem == nil || startUnix > latestTs {
				latestTs = startUnix
				cp := itemVo
				latestItem = &cp
			}
			if durSec > longestSec || (durSec == longestSec && startUnix > longestTs) {
				longestSec = durSec
				longestTs = startUnix
				cp := itemVo
				longestItem = &cp
			}
		}

		if isEdgeAccessTitle(title) {
			edgeCount++
		} else {
			cloudCount++
		}
		cat := classifyMeetingCategory(title)
		catCounts[cat]++
	}

	res.Volume.ActiveDays = len(activeDays)
	if res.Volume.Total > 0 {
		res.Duration.AverageSeconds = int64(math.Round(float64(res.Duration.TotalSeconds) / float64(res.Volume.Total)))
		res.Recording.CoverageRate = math.Round(float64(res.Recording.Count)*1000/float64(res.Volume.Total)) / 10
	}
	if meetingCount > 0 {
		res.DurationByKind.Meeting.AverageSeconds = int64(math.Round(float64(res.DurationByKind.Meeting.TotalSeconds) / float64(meetingCount)))
	}
	if voiceCount > 0 {
		res.DurationByKind.Voice.AverageSeconds = int64(math.Round(float64(res.DurationByKind.Voice.TotalSeconds) / float64(voiceCount)))
	}

	res.Extremes = v1.MeetingOverviewExtremesVo{
		Earliest: earliestItem,
		Longest:  longestItem,
		Latest:   latestItem,
	}

	res.Tags.AccessModes = []v1.MeetingOverviewTagCountVo{
		{Key: "edge", Label: "边缘入会", Count: edgeCount},
		{Key: "cloud", Label: "云端入会", Count: cloudCount},
	}

	cats := make([]v1.MeetingOverviewTagCountVo, 0, len(catCounts))
	for label, cnt := range catCounts {
		if cnt <= 0 {
			continue
		}
		cats = append(cats, v1.MeetingOverviewTagCountVo{
			Key:   label,
			Label: label,
			Count: cnt,
		})
	}
	sort.Slice(cats, func(i, j int) bool {
		if cats[i].Count != cats[j].Count {
			return cats[i].Count > cats[j].Count
		}
		return cats[i].Label < cats[j].Label
	})
	res.Tags.Categories = cats

	return res
}

func normalizeOverviewDimension(dim string) string {
	switch strings.ToLower(strings.TrimSpace(dim)) {
	case "month", "week", "custom":
		return strings.ToLower(strings.TrimSpace(dim))
	default:
		return "total"
	}
}

func overviewTimeWindow(dim, startDate, endDate string, now time.Time) (int64, int64) {
	loc := now.Location()
	switch dim {
	case "month":
		start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, loc)
		end := start.AddDate(0, 1, 0).Add(-time.Second)
		return start.Unix(), end.Unix()
	case "week":
		wd := int(now.Weekday())
		if wd == 0 {
			wd = 7
		}
		start := time.Date(now.Year(), now.Month(), now.Day()-(wd-1), 0, 0, 0, 0, loc)
		end := start.AddDate(0, 0, 7).Add(-time.Second)
		return start.Unix(), end.Unix()
	case "custom":
		var sUnix, eUnix int64
		if t, err := time.ParseInLocation("2006-01-02", strings.TrimSpace(startDate), loc); err == nil {
			sUnix = t.Unix()
		}
		if t, err := time.ParseInLocation("2006-01-02", strings.TrimSpace(endDate), loc); err == nil {
			eUnix = t.Add(24*time.Hour - time.Second).Unix()
		}
		return sUnix, eUnix
	default:
		return 0, 0
	}
}

func inOverviewWindow(ts, start, end int64) bool {
	if start == 0 && end == 0 {
		return true
	}
	if ts <= 0 {
		return false
	}
	if start > 0 && ts < start {
		return false
	}
	if end > 0 && ts > end {
		return false
	}
	return true
}

func isOverviewHost(it ScheduleItem, userId int64, account string) bool {
	if it.Local != nil && it.Local.CreatorId == userId {
		return true
	}
	if account != "" && strings.EqualFold(strings.TrimSpace(it.HostAccount()), strings.TrimSpace(account)) {
		return true
	}
	return false
}

func buildExtremeVo(it ScheduleItem, title string, startUnix, durSec int64) v1.MeetingOverviewExtremeItemVo {
	var id int64
	if it.Local != nil {
		id = it.Local.Id
	} else {
		id = it.RoomKey
	}
	st := time.Unix(startUnix, 0)
	et := st.Add(time.Duration(durSec) * time.Second)
	hostName := strings.TrimSpace(it.HostAccount())
	return v1.MeetingOverviewExtremeItemVo{
		Id:              id,
		Title:           title,
		HostName:        hostName,
		MeetingNo:       it.Number(),
		StartTime:       st.Format("2006-01-02 15:04"),
		EndTime:         et.Format("15:04"),
		DurationSeconds: durSec,
	}
}

func classifyMeetingForm(title string) string {
	t := strings.ToLower(title)
	if containsAny(t, "线上线下", "融合", "混合", "联动", "会场+线上") {
		return "hybrid"
	}
	if containsAny(t, "线下", "现场会", "实地", "座谈") && !containsAny(t, "线上", "视频", "远程") {
		return "offline"
	}
	return "online"
}

func isVoiceMeeting(it ScheduleItem, title string) bool {
	if it.Kind() == "voice" {
		return true
	}
	return containsAny(strings.ToLower(title), "语音", "对讲", "音频通话")
}

func isEdgeAccessTitle(title string) bool {
	t := strings.ToLower(title)
	return containsAny(t, "边缘", "边端", "卫星", "卫通", "板卡", "车载", "便携", "前指", "外场", "edge")
}

func classifyMeetingCategory(title string) string {
	t := strings.ToLower(title)
	switch {
	case containsAny(t, "评审", "验收", "立项", "复盘"):
		return "评审会"
	case containsAny(t, "保障", "值守", "应急", "演练", "巡检"):
		return "保障会"
	case containsAny(t, "调试", "联调", "对接", "排查", "测试", "排障"):
		return "调试对接"
	case containsAny(t, "技术", "交流", "研讨", "方案", "架构", "培训", "宣贯"):
		return "技术交流"
	case containsAny(t, "例会", "周会", "晨会", "月会", "同步", "汇报"):
		return "例会同步"
	default:
		return "日常会议"
	}
}

func containsAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}
