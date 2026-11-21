package service

import (
	"strings"
	"testing"
)

// 平台侧的原始失败里有域名、接口路径和 Go 运行时错误。实测停会超时时整段被当成 msg 弹到界面上
// （`三方结束会议失败: http request POST /api/frontend/... context deadline exceeded`），
// 用户不可操作、又把外部系统暴露进了界面（第 10/34 项）。这里钉住"不外泄"这条。
func TestManagementUserMessageKeepsInternalsOutOfCopy(t *testing.T) {
	raw := `http request POST /api/frontend/conference-management/meetings/meeting_1790596849_2wVZlcY_/stop: ` +
		`Post "https://47.114.83.151/api/frontend/conference-management": context deadline exceeded`
	got := managementUserMessage(raw, "stop")
	for _, leak := range []string{"47.114.83.151", "conference-management", "context deadline", "http request", "meeting_1790596849", "三方"} {
		if strings.Contains(got, leak) {
			t.Fatalf("文案泄漏了 %q：%s", leak, got)
		}
	}
	if !strings.Contains(got, "没有回应") || !strings.Contains(got, "结束") {
		t.Fatalf("超时应说成平台没回应 + 动作没确认，实际：%s", got)
	}

	cases := []struct {
		raw, action, want string
	}{
		{"status 401 participant_not_joined", "start", "登录身份已失效"},
		{"status 404 meeting_not_found", "stop", "已经不存在"},
		{"status 409 meeting_not_running", "stop", "不在进行中"},
		{"connection refused", "create", "没有回应"},
		{"something else entirely", "create", "创建没能完成"},
	}
	for _, c := range cases {
		if got := managementUserMessage(c.raw, c.action); !strings.Contains(got, c.want) {
			t.Fatalf("raw=%q action=%s 期望含 %q，实际：%s", c.raw, c.action, c.want, got)
		}
	}
}
