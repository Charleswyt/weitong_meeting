package service

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/glog"
)

type LoginAuditInfo struct {
	LastLoginAt       string
	LastLoginIp       string
	LastLoginLocation string
}

// RecordLoginAudit 在登录成功后滚动记录上次登录时间、客户端 IP 与位置。
func RecordLoginAudit(ctx context.Context, userId int64, clientIP string) {
	if userId <= 0 {
		return
	}
	ip := normalizeClientIP(clientIP)
	loc := inferLocationFromIP(ip)
	nowStr := time.Now().Format("2006-01-02 15:04:05")

	var prevAt, prevIp, prevLoc string
	if rec, err := g.DB().Model("user_login_audit").Ctx(ctx).Where("USER_ID", userId).One(); err == nil && !rec.IsEmpty() {
		prevAt = rec["LAST_LOGIN_AT"].String()
		prevIp = rec["LAST_LOGIN_IP"].String()
		prevLoc = rec["LAST_LOGIN_LOCATION"].String()
	}

	_, err := g.DB().Exec(ctx, `
		INSERT INTO user_login_audit (USER_ID, LAST_LOGIN_AT, LAST_LOGIN_IP, LAST_LOGIN_LOCATION, PREV_LOGIN_AT, PREV_LOGIN_IP, PREV_LOGIN_LOCATION)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(USER_ID) DO UPDATE SET
			PREV_LOGIN_AT = excluded.PREV_LOGIN_AT,
			PREV_LOGIN_IP = excluded.PREV_LOGIN_IP,
			PREV_LOGIN_LOCATION = excluded.PREV_LOGIN_LOCATION,
			LAST_LOGIN_AT = excluded.LAST_LOGIN_AT,
			LAST_LOGIN_IP = excluded.LAST_LOGIN_IP,
			LAST_LOGIN_LOCATION = excluded.LAST_LOGIN_LOCATION
	`, userId, nowStr, ip, loc, prevAt, prevIp, prevLoc)
	if err != nil {
		glog.Warningf(ctx, "写入登录审计失败 user=%d: %v", userId, err)
		return
	}
	if loc == "公网接入" {
		go refineLoginLocation(userId, ip, nowStr)
	}
}

var geoCache = struct {
	sync.Mutex
	items map[string]geoCacheItem
}{items: map[string]geoCacheItem{}}

type geoCacheItem struct {
	location string
	at       time.Time
}

// refineLoginLocation 公网 IP 归属地由服务端查询后回填；离线部署查不到就保留「公网接入」。
func refineLoginLocation(userId int64, ip, loginAt string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	loc := lookupIPLocation(ctx, ip)
	if loc == "" {
		return
	}
	if _, err := g.DB().Exec(ctx,
		`UPDATE user_login_audit SET LAST_LOGIN_LOCATION = ? WHERE USER_ID = ? AND LAST_LOGIN_AT = ? AND LAST_LOGIN_IP = ?`,
		loc, userId, loginAt, ip,
	); err != nil {
		glog.Warningf(ctx, "回填登录归属地失败 user=%d: %v", userId, err)
	}
}

func lookupIPLocation(ctx context.Context, ip string) string {
	geoCache.Lock()
	if it, ok := geoCache.items[ip]; ok && time.Since(it.at) < 24*time.Hour {
		geoCache.Unlock()
		return it.location
	}
	geoCache.Unlock()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://get.geojs.io/v1/ip/geo/"+url.PathEscape(ip)+".json", nil)
	if err != nil {
		return ""
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	var data struct {
		Country string `json:"country"`
		Region  string `json:"region"`
		City    string `json:"city"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&data); err != nil {
		return ""
	}
	parts := make([]string, 0, 3)
	for _, p := range []string{data.Country, data.Region, data.City} {
		if p = strings.TrimSpace(p); p != "" {
			parts = append(parts, p)
		}
	}
	loc := strings.Join(parts, " · ")
	if loc == "" {
		return ""
	}
	geoCache.Lock()
	geoCache.items[ip] = geoCacheItem{location: loc, at: time.Now()}
	geoCache.Unlock()
	return loc
}

// GetLoginAudit 获取用于账号信息页展示的上次登录记录（若首次登录则展示本次记录）。
func GetLoginAudit(ctx context.Context, userId int64) LoginAuditInfo {
	if userId <= 0 {
		return LoginAuditInfo{}
	}
	rec, err := g.DB().Model("user_login_audit").Ctx(ctx).Where("USER_ID", userId).One()
	if err != nil || rec.IsEmpty() {
		return LoginAuditInfo{}
	}
	if prev := strings.TrimSpace(rec["PREV_LOGIN_AT"].String()); prev != "" {
		return LoginAuditInfo{
			LastLoginAt:       prev,
			LastLoginIp:       rec["PREV_LOGIN_IP"].String(),
			LastLoginLocation: rec["PREV_LOGIN_LOCATION"].String(),
		}
	}
	return LoginAuditInfo{
		LastLoginAt:       rec["LAST_LOGIN_AT"].String(),
		LastLoginIp:       rec["LAST_LOGIN_IP"].String(),
		LastLoginLocation: rec["LAST_LOGIN_LOCATION"].String(),
	}
}

func normalizeClientIP(raw string) string {
	ip := strings.TrimSpace(raw)
	if idx := strings.Index(ip, ","); idx > 0 {
		ip = strings.TrimSpace(ip[:idx])
	}
	if host, _, err := net.SplitHostPort(ip); err == nil {
		ip = host
	}
	if ip == "::1" {
		return "127.0.0.1"
	}
	return ip
}

func inferLocationFromIP(ipStr string) string {
	parsed := net.ParseIP(ipStr)
	if parsed == nil {
		return "未知位置"
	}
	if parsed.IsLoopback() {
		return "本机"
	}
	if parsed.IsPrivate() || parsed.IsLinkLocalUnicast() {
		return "局域网"
	}
	return "公网接入"
}
