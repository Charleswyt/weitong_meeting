package thirdparty

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// In shared-room mode the Ocean control service and the authenticated Weitong backend
// run on the same cloud host. These credentials authorize conference methods only.
func OceanFederation() bool        { return os.Getenv("WEITONG_OCEAN_ACCOUNT_KEY") != "" }
func OceanAccount(id int64) string { return "urn:weitong:" + strconv.FormatInt(id, 10) }
func (a *Adapter) oceanIdentity(ctx context.Context, id int64) (*AuthResult, error) {
	u, err := url.Parse(a.getBaseURL(ctx))
	if err != nil || u.Scheme != "http" || !net.ParseIP(u.Hostname()).IsLoopback() || u.User != nil || strings.Trim(u.Path, "/") != "" || u.RawQuery != "" || id < 1 {
		return nil, errors.New("共用会场的账号接口需要本机回环连接")
	}
	key, e := os.ReadFile(os.Getenv("WEITONG_OCEAN_ACCOUNT_KEY"))
	if e != nil || len(strings.TrimSpace(string(key))) < 32 {
		return nil, errors.New("共用会场身份服务不可用")
	}
	exp := time.Now().Add(30 * time.Minute)
	claims := fmt.Sprintf("wto1.%d.%d", id, exp.Unix())
	h := hmac.New(sha256.New, []byte(strings.TrimSpace(string(key))))
	h.Write([]byte(claims))
	return &AuthResult{OK: true, Token: claims + "." + base64.RawURLEncoding.EncodeToString(h.Sum(nil)), Username: OceanAccount(id), AccountType: "meeting_participant", ExpiresAt: exp.Unix()}, nil
}
