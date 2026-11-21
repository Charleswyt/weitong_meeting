package sms

import (
	"context"

	"github.com/gogf/gf/v2/frame/g"
)

// Console 不真正发短信：把验证码打进服务端日志，供本地/联调先跑通。
// 真发短信时把 auth.sms.provider 换成 smsbao（或后续别的实现）即可。
type Console struct {
	sign string
}

func NewConsole(cfg Config) *Console {
	sign := cfg.Sign
	if sign == "" {
		sign = "卫通会议"
	}
	return &Console{sign: sign}
}

func (c *Console) Name() string { return "console" }

func (c *Console) SendCode(ctx context.Context, mobile, code, purpose string) error {
	g.Log().Infof(ctx,
		"[sms/console] 验证码未经运营商下发（开发通道） mobile=%s purpose=%s code=%s sign=%s",
		mobile, purpose, code, c.sign)
	return nil
}
