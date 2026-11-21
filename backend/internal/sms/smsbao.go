package sms

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Smsbao 对接短信宝国内短信 API（https://api.smsbao.com/sms）。
// 新账号有测试额度；正式用量需充值。凭据只进 gitignore 的 config.yaml。
type Smsbao struct {
	user   string
	apiKey string
	sign   string
	client *http.Client
}

func NewSmsbao(cfg Config) *Smsbao {
	sign := cfg.Sign
	if sign == "" {
		sign = "卫通会议"
	}
	return &Smsbao{
		user:   cfg.SmsbaoUser,
		apiKey: cfg.SmsbaoApiKey,
		sign:   sign,
		client: &http.Client{Timeout: 8 * time.Second},
	}
}

func (s *Smsbao) Name() string { return "smsbao" }

func (s *Smsbao) SendCode(ctx context.Context, mobile, code, purpose string) error {
	if s.user == "" || s.apiKey == "" {
		return fmt.Errorf("短信宝账号或 ApiKey 未配置")
	}
	op := "登录"
	if purpose == "reset" {
		op = "找回密码"
	}
	// 内容须含【签名】；字数与通道规则以短信宝控制台为准。
	content := fmt.Sprintf("【%s】您正在进行%s，验证码%s，5分钟内有效，请勿泄露。", s.sign, op, code)

	q := url.Values{}
	q.Set("u", s.user)
	q.Set("p", s.apiKey)
	q.Set("m", mobile)
	q.Set("c", content)
	q.Set("f", "json")

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.smsbao.com/sms?"+q.Encode(), nil)
	if err != nil {
		return err
	}
	res, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("短信通道请求失败: %w", err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 4096))
	text := strings.TrimSpace(string(body))
	// json 成功：{"code":"0",...}；也兼容历史 txt 返回 "0"
	if text == "0" || strings.Contains(text, `"code":"0"`) || strings.Contains(text, `"code":0`) {
		return nil
	}
	return fmt.Errorf("短信提交失败: %s", text)
}
