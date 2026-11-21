package thirdparty

import "testing"

// 实测样本（2026-09-28，当前账号可见 174/174 条 title 都是四段）：
// "测试会议2 · ruanqiang · 麦克风 · 默认值 - 麦克风 (High Definition Audio D"
// "媒体采集复验 · 郑骐 · 摄像头 · XuvLmvqn0XOGHn21HawBOEqBxLztbvAH6M"
func TestLaneOf(t *testing.T) {
	cases := []struct {
		name, title, wantWho, wantKind, wantLabel string
	}{
		{"麦克风通路", "测试会议2 · ruanqiang · 麦克风 · 默认值 - 麦克风", "ruanqiang", "audio", "声音"},
		{"摄像头通路", "媒体采集复验 · 郑骐 · 摄像头 · 相机型号", "郑骐", "camera", "画面"},
		{"屏幕共享通路", "周会 · 张三 · 屏幕共享 · 整机", "张三", "screen", "共享屏幕"},
		{"段内空格", "周会 · 张三  · 摄像头  · 整机", "张三", "camera", "画面"},
		{"未知通路类型不猜", "周会 · 张三 · 未知设备 · 整机", "张三", "", "录制"},
		{"段数不足不猜", "一场没有分隔符的标题", "", "", "录制"},
		{"空串", "", "", "", "录制"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			who, kind, label := LaneOf(c.title)
			if who != c.wantWho || kind != c.wantKind || label != c.wantLabel {
				t.Fatalf("LaneOf(%q) = (%q,%q,%q)，期望 (%q,%q,%q)", c.title, who, kind, label, c.wantWho, c.wantKind, c.wantLabel)
			}
		})
	}
}

func TestMeetingTitleOf(t *testing.T) {
	if got := MeetingTitleOf("测试会议2 · ruanqiang · 麦克风 · 默认值"); got != "测试会议2" {
		t.Fatalf("会议名段 = %q，期望 %q", got, "测试会议2")
	}
	// 孤行标题（历史遗留、无分组摘要）没有分隔符时原样返回，不许返回空串把卡片做成空白。
	if got := MeetingTitleOf("没有分隔符的标题"); got != "没有分隔符的标题" {
		t.Fatalf("无分隔符时应原样返回，实得 %q", got)
	}
}
