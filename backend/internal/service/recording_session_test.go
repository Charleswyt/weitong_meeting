package service

import (
	"fmt"
	"testing"

	"cloud-conference-backend/internal/service/thirdparty"
)

// 卡片上那个"这一场录了多久"必须由服务端对**全集**算，不能留给前端已加载的那几行。
// 现网事故形状：列表按条翻页（一页 60 行），一场会最早的那几行最后才到，
// 同一场会卡片 1297 秒、回放页 1423 秒（契约 ADR-0076 三）。
func TestAttachSessionSpans(t *testing.T) {
	const meeting = "meeting_1"

	build := func(starts []string, durs []float64, meetingId string) []thirdparty.ThirdRecording {
		out := make([]thirdparty.ThirdRecording, len(starts))
		for i := range starts {
			out[i] = thirdparty.ThirdRecording{
				RecordingId:   fmt.Sprintf("r%d", i),
				MeetingId:     meetingId,
				StartedAtText: starts[i],
				DurationSec:   durs[i],
			}
		}
		return out
	}

	t.Run("跨度是时间轴跨度而不是最长一路", func(t *testing.T) {
		// 第二路中途入会：21:38:12 起录 600 秒；第一路 21:37:12 起录 300 秒
		got := build([]string{"2026-10-08T21:37:12+08:00", "2026-10-08T21:38:12+08:00"}, []float64{300, 600}, meeting)
		attachSessionSpans(got)
		if got[0].MeetingSpanSec != 660 || got[1].MeetingSpanSec != 660 {
			t.Fatalf("同一场每一行要带同一个跨度：got %v / %v want 660", got[0].MeetingSpanSec, got[1].MeetingSpanSec)
		}
		if got[0].MeetingStartedAtText != "2026-10-08T21:37:12+08:00" {
			t.Fatalf("起点锚要是最早那一路的时刻，got %q", got[0].MeetingStartedAtText)
		}
	})

	// 这条是"为什么必须在分页前聚合"的自证：同一场少给一行，算出来的就必然偏短。
	// 反过来（两半各自完整）说明判据没命中，别报"通过"。
	t.Run("少一行就必然算短", func(t *testing.T) {
		full := build([]string{"2026-10-08T21:37:12+08:00", "2026-10-08T21:50:00+08:00", "2026-10-08T22:00:00+08:00"},
			[]float64{1423, 120, 60}, meeting)
		attachSessionSpans(full)
		if full[0].MeetingSpanSec != 1428 {
			t.Fatalf("全集跨度 got %v want 1428", full[0].MeetingSpanSec)
		}
		// 前端第一页只拿到倒序的头两行（21:50、22:00），最早那行还没翻到
		loaded := build([]string{"2026-10-08T21:50:00+08:00", "2026-10-08T22:00:00+08:00"}, []float64{120, 60}, meeting)
		attachSessionSpans(loaded)
		if loaded[0].MeetingSpanSec >= full[0].MeetingSpanSec {
			t.Fatalf("已加载行算出的跨度必须短于全集：loaded=%v full=%v", loaded[0].MeetingSpanSec, full[0].MeetingSpanSec)
		}
		if loaded[0].MeetingStartedAtText != "2026-10-08T21:50:00+08:00" {
			t.Fatalf("已加载行不许凭空长出没加载到的那个起点，got %q", loaded[0].MeetingStartedAtText)
		}
	})

	t.Run("meetingId 为空的孤行不聚合", func(t *testing.T) {
		orphan := build([]string{"2026-10-08T21:37:12+08:00", "2026-10-08T23:37:12+08:00"}, []float64{100, 100}, "")
		attachSessionSpans(orphan)
		for _, r := range orphan {
			if r.MeetingStartedAtText != "" || r.MeetingSpanSec != 0 {
				t.Fatalf("空会议 id 不能共用一个聚合（那会把不相关的几场并成一张假卡）：%+v", r)
			}
		}
	})

	t.Run("时间文本读不出来时宁缺不猜", func(t *testing.T) {
		got := []thirdparty.ThirdRecording{
			{RecordingId: "a", MeetingId: meeting, StartedAtText: "", DurationSec: 100},
			{RecordingId: "b", MeetingId: meeting, StartedAtText: "2026-10-08T21:37:12+08:00", DurationSec: 100},
			{RecordingId: "c", MeetingId: "other", StartedAtText: "不是时间", DurationSec: 100},
		}
		attachSessionSpans(got)
		if got[0].MeetingSpanSec != 100 || got[0].MeetingStartedAtText != "2026-10-08T21:37:12+08:00" {
			t.Fatalf("读不出时间的那一行要跟着同场的聚合走：%+v", got[0])
		}
		if got[2].MeetingStartedAtText != "" || got[2].MeetingSpanSec != 0 {
			t.Fatalf("全场都读不出来时不许造一个起点：%+v", got[2])
		}
	})

	t.Run("跨时区偏移按文本自己的偏移算", func(t *testing.T) {
		// 21:37:12+08 = 13:37:12Z：跨度按绝对时刻算，不是按字面时分秒
		got := build([]string{"2026-10-08T21:37:12+08:00", "2026-10-08T13:47:12Z"}, []float64{60, 60}, meeting)
		attachSessionSpans(got)
		if got[0].MeetingSpanSec != 660 {
			t.Fatalf("got %v want 660", got[0].MeetingSpanSec)
		}
	})
}
