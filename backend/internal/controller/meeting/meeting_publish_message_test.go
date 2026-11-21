package meeting

import (
	"errors"
	"strings"
	"testing"

	"cloud-conference-backend/internal/consts"
)

// 第 38 项：三方只回 meeting_not_running，"还没开始"和"已经散会"必须由我方状态分清，
// 不能对预约会议说"会议已结束"。
func TestThirdPartyUserMessageDistinguishesNotRunning(t *testing.T) {
	notRunning := errors.New("thirdparty: 400 meeting_not_running")
	ended := errors.New("thirdparty: 400 meeting_ended")
	cases := []struct {
		name   string
		err    error
		status string
		want   string
	}{
		{"未开始-预约会议", notRunning, consts.MeetingStatusScheduled, "会议尚未开始，暂时无法推流"},
		{"启动中", notRunning, consts.MeetingStatusStarting, "会议正在启动，请稍候再试"},
		{"已结束态", notRunning, consts.MeetingStatusEnded, "会议已结束，无法推流"},
		{"已取消态", notRunning, consts.MeetingStatusCancelled, "会议已结束，无法推流"},
		{"状态未知", notRunning, "", "这场会议当前不在进行中（可能还没开始或已经结束），暂时无法推流"},
		{"三方明说结束", ended, consts.MeetingStatusScheduled, "会议已结束，无法推流"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := thirdPartyUserMessage(c.err, "兜底", c.status); got != c.want {
				t.Fatalf("status=%q 时文案应为 %q，实得 %q", c.status, c.want, got)
			}
		})
	}
}

// 未开始会议的所有说法都不能出现"已结束"：这正是用户报的那句误导文案。
func TestScheduledNeverSaysEnded(t *testing.T) {
	for _, msg := range []string{
		thirdPartyUserMessage(errors.New("meeting_not_running"), "兜底", consts.MeetingStatusScheduled),
		notRunningUserMessage(consts.MeetingStatusScheduled),
	} {
		if containsEnded(msg) {
			t.Fatalf("预约会议不该被说成已结束，实得 %q", msg)
		}
	}
}

func containsEnded(s string) bool { return strings.Contains(s, "已结束") }

// 第 40 项：离会收尾撞上"这个端早就不在会中了"必须是幂等成功，不能报系统异常。
func TestIsAlreadyGoneUpstream(t *testing.T) {
	cases := []struct {
		msg  string
		want bool
	}{
		{"third-party API POST /api/conference/meetings/leave returned 401: {\"reason\":\"participant_not_joined\"}", true},
		{"third-party API POST /api/conference/meetings/leave returned 404: {\"reason\":\"meeting_not_found\"}", true},
		{"third-party API POST /api/conference/meetings/leave returned 404: not found", true},
		{"third-party API POST /api/conference/meetings/leave returned 500: boom", false},
		{"context deadline exceeded", false},
	}
	for _, c := range cases {
		if got := isAlreadyGoneUpstream(errors.New(c.msg)); got != c.want {
			t.Fatalf("%q 判为 %v，应为 %v", c.msg, got, c.want)
		}
	}
	if isAlreadyGoneUpstream(nil) {
		t.Fatal("nil 不该被当成已 gone")
	}
}
