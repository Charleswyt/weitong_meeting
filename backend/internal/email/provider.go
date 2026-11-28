// Package email 邮件验证码通道：业务只认 Provider，换 SMTP/开发通道只改配置。
package email

import "context"

// Provider 把验证码或会议邀请发到邮箱。
type Provider interface {
	Name() string
	SendCode(ctx context.Context, toEmail, code, purpose string) error
	SendMeetingInvite(ctx context.Context, toEmail string, inv MeetingInvite) error
}

// MeetingInvite 一封会议邀请邮件的内容。
type MeetingInvite struct {
	InviteeName     string
	InviterName     string
	Title           string
	MeetingNo       string
	StartTime       string // 已按业务时区格式化好的可读时间
	DurationMinutes int
	JoinUrl         string
	HasPassword     bool
}

// Config 来自 config.yaml 的 auth.email 段。
type Config struct {
	Provider string // console | smtp
	From     string // 发件人展示地址，如 charles_wyt@126.com
	Subject  string
	// SMTP（网易 126 等）
	SMTPHost     string
	SMTPPort     int
	SMTPUser     string // 通常等于 From 全地址
	SMTPPassword string // 邮箱「授权码」，不是登录口令；只写 gitignore 的 config.yaml
}

func New(cfg Config) Provider {
	switch cfg.Provider {
	case "smtp":
		return NewSMTP(cfg)
	default:
		return NewConsole(cfg)
	}
}
