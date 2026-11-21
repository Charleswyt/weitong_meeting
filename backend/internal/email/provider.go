// Package email 邮件验证码通道：业务只认 Provider，换 SMTP/开发通道只改配置。
package email

import "context"

// Provider 把一条验证码发到邮箱。
type Provider interface {
	Name() string
	SendCode(ctx context.Context, toEmail, code, purpose string) error
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
