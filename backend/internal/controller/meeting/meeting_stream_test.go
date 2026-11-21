package meeting

import (
	"errors"
	"testing"
)

// 订阅路径上两类上游回包必须分开：425/not_ready 是会自己变好的中间态（该重试），
// meeting_not_found 是终态（重试到永远也拿不到流）。混成一类就是用户报的"有时起播失败"。
func TestStreamErrorClassification(t *testing.T) {
	cases := []struct {
		name        string
		msg         string
		wantWarming bool
		wantGone    bool
	}{
		// 现网日志 2026-09-28 14:45。注意：这条 404 后来被证实是**我方自己**把会议ID
		// 当会议号传给 /state 造成的（见契约 ADR-0009），不是会议真结束了。
		// 分类上仍按终态处理是对的 —— 同一个 URL 反复 404 时继续重试没有意义。
		{"上游回404(终态，不重试)", `third-party API GET /api/conference/meetings/meeting_1790576021_qCQWo5vj/state returned 404: {"ok":false,"reason":"meeting_not_found"}`, false, true},
		{"只有 reason 没有状态码", `upstream said: meeting_not_found`, false, true},
		{"上游说这路还没好", `third-party API GET /stream returned 425: {"ok":false,"reason":"not_ready"}`, true, false},
		{"只有 not_ready", `media not_ready yet`, true, false},
		{"真故障", `third-party API GET /state returned 500: internal error`, false, false},
		{"连接被重置", `dial tcp 47.114.83.151:443: connectex: connection refused`, false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := errors.New(c.msg)
			if got := isStreamWarmingUp(err); got != c.wantWarming {
				t.Fatalf("isStreamWarmingUp(%q) = %v，期望 %v", c.msg, got, c.wantWarming)
			}
			if got := isMeetingGone(err); got != c.wantGone {
				t.Fatalf("isMeetingGone(%q) = %v，期望 %v", c.msg, got, c.wantGone)
			}
		})
	}
}

// 同一条回包不能既是"再试试"又是"别试了"——那会让前端一边短间隔重试一边收终态。
func TestClassificationsAreMutuallyExclusive(t *testing.T) {
	for _, msg := range []string{
		`returned 404: {"ok":false,"reason":"meeting_not_found"}`,
		`returned 425: {"ok":false,"reason":"not_ready"}`,
		`returned 503: upstream unavailable`,
	} {
		err := errors.New(msg)
		if isStreamWarmingUp(err) && isMeetingGone(err) {
			t.Fatalf("%q 同时被判成中间态与终态", msg)
		}
	}
}
