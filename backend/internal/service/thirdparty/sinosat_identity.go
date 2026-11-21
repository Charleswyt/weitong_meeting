package thirdparty

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// The two services run on the same cloud host. The credential is never sent through public ingress.
func exchangeSinosatIdentity(ctx context.Context, endpoint string, id int64, username, displayName string) (*AuthResult, error) {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "http" || !net.ParseIP(u.Hostname()).IsLoopback() || u.User != nil ||
		u.RawQuery != "" || u.Fragment != "" || u.Path != "/zwt-meeting/api/v1/session/weitong" {
		return nil, fmt.Errorf("会议身份交换地址需要使用本机回环接口")
	}
	secret, err := os.ReadFile(os.Getenv("WEITONG_MEDIA_TOKEN_FILE"))
	if err != nil || len(strings.TrimSpace(string(secret))) < 32 {
		return nil, fmt.Errorf("未配置会议身份交换凭据")
	}
	payload, err := json.Marshal(map[string]interface{}{"id": id, "username": username, "displayName": displayName})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(secret)))
	client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("媒体身份交换失败 HTTP %d", res.StatusCode)
	}
	var body struct {
		Token     string
		Username  string
		ExpiresIn int64
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 16384)).Decode(&body); err != nil || body.Token == "" {
		return nil, fmt.Errorf("媒体身份响应无效")
	}
	return &AuthResult{OK: true, Token: body.Token, Username: body.Username, ExpiresAt: body.ExpiresIn}, nil
}
