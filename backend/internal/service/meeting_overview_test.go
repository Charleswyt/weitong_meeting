package service

import (
	"testing"
	"time"

	"github.com/gogf/gf/v2/os/gtime"

	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/model/entity"
)

func TestBuildMeetingOverview(t *testing.T) {
	loc := time.Local
	now := time.Date(2026, 11, 28, 18, 0, 0, 0, loc) // Saturday

	mk := func(id int64, title string, creator int64, st time.Time, durMin int, cloudRec int, status string) ScheduleItem {
		return ScheduleItem{
			Local: &entity.MeetingAppointment{
				Id:                  id,
				Title:               title,
				CreatorId:           creator,
				StartTime:           gtime.New(st),
				DurationMinutes:     durMin,
				CloudRecord:         cloudRec,
				ThirdPartyMeetingId: "tp-" + title,
				Status:              status,
			},
		}
	}

	items := []ScheduleItem{
		mk(1, "边缘卫星保障会", 10, time.Date(2026, 11, 25, 9, 0, 0, 0, loc), 90, 1, consts.MeetingStatusEnded),
		mk(2, "线上线下融合评审会", 20, time.Date(2026, 11, 26, 14, 0, 0, 0, loc), 60, 1, consts.MeetingStatusEnded),
		mk(3, "线下现场座谈调试对接", 10, time.Date(2026, 11, 5, 10, 0, 0, 0, loc), 30, 0, consts.MeetingStatusEnded),
		mk(4, "云端技术交流会", 20, time.Date(2026, 10, 15, 15, 0, 0, 0, loc), 120, 0, consts.MeetingStatusEnded),
		mk(5, "已取消会议", 10, time.Date(2026, 11, 27, 10, 0, 0, 0, loc), 60, 1, consts.MeetingStatusCancelled),
	}

	// 1. 总体统计
	total := BuildMeetingOverview(items, 10, "host10", "total", "", "", now)
	if total.Volume.Total != 4 {
		t.Fatalf("expected total=4, got %d", total.Volume.Total)
	}
	if total.Volume.Hosted != 2 || total.Volume.Participated != 2 {
		t.Fatalf("expected hosted=2 participated=2, got %+v", total.Volume)
	}
	if total.Volume.Online+total.Volume.Offline+total.Volume.Hybrid != total.Volume.Total {
		t.Fatalf("expected online+offline+hybrid == total, got %+v", total.Volume)
	}
	if total.Volume.Online != 2 || total.Volume.Offline != 1 || total.Volume.Hybrid != 1 {
		t.Fatalf("unexpected form split: %+v", total.Volume)
	}
	if total.Duration.TotalSeconds != 300*60 || total.Duration.AverageSeconds != 75*60 {
		t.Fatalf("unexpected duration: %+v", total.Duration)
	}
	if total.Recording.Count != 2 || total.Recording.CoverageRate != 50 {
		t.Fatalf("unexpected recording: %+v", total.Recording)
	}
	if total.Extremes.Earliest == nil || total.Extremes.Earliest.Id != 4 {
		t.Fatalf("expected earliest=4, got %+v", total.Extremes.Earliest)
	}
	if total.Extremes.Longest == nil || total.Extremes.Longest.Id != 4 {
		t.Fatalf("expected longest=4, got %+v", total.Extremes.Longest)
	}
	if total.Extremes.Latest == nil || total.Extremes.Latest.Id != 2 {
		t.Fatalf("expected latest=2, got %+v", total.Extremes.Latest)
	}

	// 2. 本月统计（11 月共 3 场）
	month := BuildMeetingOverview(items, 10, "host10", "month", "", "", now)
	if month.Volume.Total != 3 {
		t.Fatalf("expected month total=3, got %d", month.Volume.Total)
	}

	// 3. 本周统计（11-23 周一起共 2 场）
	week := BuildMeetingOverview(items, 10, "host10", "week", "", "", now)
	if week.Volume.Total != 2 {
		t.Fatalf("expected week total=2, got %d", week.Volume.Total)
	}

	// 4. 空数据分母为 0 兜底
	empty := BuildMeetingOverview(nil, 10, "", "total", "", "", now)
	if empty.Duration.AverageSeconds != 0 || empty.Recording.CoverageRate != 0 {
		t.Fatalf("expected zero-safe empty stats, got %+v", empty)
	}
}
