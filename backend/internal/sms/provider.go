// Package sms 短信发送通道抽象：业务只认 Provider，换通道只改配置与实现，不动登录/找回流程。
package sms

import "context"

// Provider 把一条验证码发到手机。实现方负责拼签名/模板；调用方只给号码与码。
type Provider interface {
	Name() string
	SendCode(ctx context.Context, mobile, code, purpose string) error
}

// Config 从 config.yaml 的 auth.sms 段读出。
type Config struct {
	Provider string // console | smsbao
	Sign     string // 短信签名，如 【卫通会议】；空时各实现自带默认
	// smsbao
	SmsbaoUser   string
	SmsbaoApiKey string
}

func New(cfg Config) Provider {
	switch cfg.Provider {
	case "smsbao":
		return NewSmsbao(cfg)
	default:
		return NewConsole(cfg)
	}
}
