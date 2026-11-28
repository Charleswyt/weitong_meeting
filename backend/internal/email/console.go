package email

import (
	"context"

	"github.com/gogf/gf/v2/frame/g"
)

// Console 不真正发信：验证码进服务端日志，联调时响应可带 debugCode。
type Console struct {
	from string
}

func NewConsole(cfg Config) *Console {
	from := cfg.From
	if from == "" {
		from = "noreply@localhost"
	}
	return &Console{from: from}
}

func (c *Console) Name() string { return "console" }

func (c *Console) SendCode(ctx context.Context, toEmail, code, purpose string) error {
	g.Log().Infof(ctx,
		"[email/console] 验证码未经 SMTP 下发（开发通道） from=%s to=%s purpose=%s code=%s",
		c.from, toEmail, purpose, code)
	return nil
}

func (c *Console) SendMeetingInvite(ctx context.Context, toEmail string, inv MeetingInvite) error {
	g.Log().Infof(ctx,
		"[email/console] 会议邀请未经 SMTP 下发（开发通道） from=%s to=%s meeting=%s title=%s join=%s",
		c.from, toEmail, inv.MeetingNo, inv.Title, inv.JoinUrl)
	return nil
}
