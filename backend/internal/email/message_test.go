package email

import (
	"strings"
	"testing"
)

func TestBuildCodeMessageHighlightsCode(t *testing.T) {
	msg := buildCodeMessage("from@126.com", "to@example.com", "卫通会议登录验证码", "482917", "login")
	if !strings.Contains(msg, "482917") {
		t.Fatal("邮件必须包含验证码明文")
	}
	if !strings.Contains(msg, "multipart/alternative") {
		t.Fatal("应使用 multipart/alternative")
	}
	if !strings.Contains(msg, "text/html") || !strings.Contains(msg, "text/plain") {
		t.Fatal("应同时提供 HTML 与纯文本")
	}
	if !strings.Contains(msg, "letter-spacing:0.28em") {
		t.Fatal("HTML 中验证码应有醒目样式")
	}
	if strings.Count(msg, "482917") < 2 {
		t.Fatalf("纯文本与 HTML 都应出现验证码，实际出现 %d 次", strings.Count(msg, "482917"))
	}
}

func TestBuildInviteMessageEscapesAndLinks(t *testing.T) {
	msg := buildInviteMessage("from@126.com", "to@example.com", MeetingInvite{
		InviteeName: "<b>张三</b>", InviterName: "李四", Title: "周会", MeetingNo: "1234567890",
		StartTime: "2026-11-28 10:00", DurationMinutes: 60, JoinUrl: "https://example.com/meeting/pre/no/1234567890",
	})
	if !strings.Contains(msg, "1234567890") || !strings.Contains(msg, "https://example.com/meeting/pre/no/1234567890") {
		t.Fatal("邀请邮件必须包含会议号与入会链接")
	}
	if strings.Contains(msg, "<b>张三</b>，您好") && !strings.Contains(msg, "&lt;b&gt;") {
		t.Fatal("HTML 正文里的用户输入必须转义")
	}
}

func TestPurposeSubject(t *testing.T) {
	if got := purposeSubject("卫通会议登录验证码", "reset"); got != "卫通会议找回密码验证码" {
		t.Fatalf("reset subject = %q", got)
	}
}
