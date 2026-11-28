package middleware

import (
	"net/http"
	"strings"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
	"github.com/golang-jwt/jwt/v5"

	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/response"
)

const (
	meetingsPrefix   = "/api/v1/meetings/"
	recordingsPrefix = "/api/v1/recordings/"
	usersPrefix      = "/api/v1/users/"
	chatImagesPrefix = "/api/v1/chat/images/"
)

// acceptsQueryToken 判定这条请求能不能用 ?token= 票参代替 Authorization 头。
// 只放行**只读资产**，一条形状一种，写操作一律不因票参可达。
// 会中只有帧流出口 GET /meetings/{id}/media/{streamId}/{kind} 可用票参（托管播放器自己 fetch，加不了请求头）；
// WHIP 的 POST/DELETE 由我方 fetch 显式带 Authorization，不在其列。
// 录制侧只按"GET + 前缀 + 单段 id + 固定尾段"精确放行三类只读资产：HLS 清单、清单指向的分片、
// 归档下载 —— Safari 与无 MSE 分支的 <video> 带不了请求头，只能靠票参；列表与回放元数据走
// axios（带 Authorization）不在其列，删除（DELETE /recordings/{id}）更不在其列。
// 头像同理：只有 GET /users/<数字 id>/avatar 这一种形状可用票参，同前缀下的
// POST/DELETE /users/me/avatar（写）与 GET /users（列表）都不因票参可达。
func acceptsQueryToken(r *ghttp.Request) bool {
	path := r.URL.Path
	if r.Method != http.MethodGet {
		return false
	}
	if strings.HasPrefix(path, meetingsPrefix) {
		return isMediaFrameStream(path)
	}
	if isAvatarRead(path) || isChatImageRead(path) {
		return true
	}
	if !strings.HasPrefix(path, recordingsPrefix) {
		return false
	}
	id, tail, found := strings.Cut(strings.TrimPrefix(path, recordingsPrefix), "/")
	if !found || id == "" {
		return false
	}
	return tail == "playlist.m3u8" || tail == "download" || strings.HasPrefix(tail, "hls/")
}

// isMediaFrameStream 形状恒为 /api/v1/meetings/{id}/media/{streamId}/{kind}，多一段少一段都不算。
// 这是会中唯一一处非带票参不可的地方：帧流由托管播放器自己 fetch，那条请求加不了自定义头。
// WHIP 的 POST/DELETE 是我方 fetch 显式带 Authorization 的，不在此列；
// 停会/删会/取消/录制开关/focus 这些写操作更不因票参可达 —— 否则一个含票参的 URL
// 就能把整场会议停掉，票参泄露的爆炸半径从"看到一帧画面"变成"操作别人的会"。
func isMediaFrameStream(path string) bool {
	rest, found := strings.CutPrefix(path, meetingsPrefix)
	if !found {
		return false
	}
	id, tail, found := strings.Cut(rest, "/")
	if !found || id == "" {
		return false
	}
	media, found := strings.CutPrefix(tail, "media/")
	if !found {
		return false
	}
	streamId, kind, found := strings.Cut(media, "/")
	return found && streamId != "" && kind != "" && !strings.Contains(kind, "/")
}

// isAvatarRead 形状恒为 /api/v1/users/{数字}/avatar，多一段少一段都不算。
// id 只收数字：否则 /users/me/avatar 这类同形状路径会被票参接住，放行面就不止"读头像"了。
func isAvatarRead(path string) bool {
	rest, found := strings.CutPrefix(path, usersPrefix)
	if !found {
		return false
	}
	id, tail, found := strings.Cut(rest, "/")
	if !found || id == "" || tail != "avatar" {
		return false
	}
	for _, c := range id {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// isChatImageRead 形状恒为 /api/v1/chat/images/{数字}：会中聊天里的 <img> 带不了请求头。
func isChatImageRead(path string) bool {
	id, found := strings.CutPrefix(path, chatImagesPrefix)
	if !found || id == "" {
		return false
	}
	for _, c := range id {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// isDecodedMediaPath 判断"这条响应会被交给解码器，而不是被我方前端代码读"的路径：
// 录制回放的 HLS 清单/分片，以及会中帧流。
// 这类请求失败必须回**真 4xx** —— 沿用 HTTP 200 + JSON 错误体的话，
// hls.js 与托管播放器会把那段错误文本当媒体数据往下喂，报出来的是与真因无关的解析错误
// （`controller/recording.openAsset` 的注释立的是同一条原则，这里是它漏掉的那一半）。
func isDecodedMediaPath(path string) bool {
	if isMediaFrameStream(path) {
		return true
	}
	rest, found := strings.CutPrefix(path, recordingsPrefix)
	if !found {
		return false
	}
	id, tail, found := strings.Cut(rest, "/")
	return found && id != "" && (tail == "playlist.m3u8" || strings.HasPrefix(tail, "hls/"))
}

// authFailure 按"谁来读这份响应"选写法：
// 解码器要真状态码，前端代码要统一信封（`msg` 仍是后端写好的那句人话，第 7 项口径不变）。
func authFailure(r *ghttp.Request, msg string) {
	if r.Method == http.MethodGet && isDecodedMediaPath(r.URL.Path) {
		response.FailStream(r, http.StatusUnauthorized, msg)
		return
	}
	response.Unauthorized(r, msg)
}

// 不需要持令牌就能打的端点：登录那两步，以及免登录。
// auto-login 在这里放行**不等于任何人能进** —— 能不能签、签给谁，由 service.AutoLogin 按配置判，
// 开关关着它自己回 403（契约 §5.1）。
var publicAuthPaths = map[string]struct{}{
	"/api/v1/auth/login":              {},
	"/api/v1/auth/sm2-public-key":     {},
	"/api/v1/auth/auto-login":         {},
	"/api/v1/auth/sms/send":           {},
	"/api/v1/auth/sms/login":          {},
	"/api/v1/auth/sms/reset-password": {},
	"/api/v1/auth/email/send":         {},
	"/api/v1/auth/email/login":        {},
	// 登录页「关于我们」的点赞与反馈：匿名可提交，服务端按客户端摘要去重、限频。
	"/api/v1/feedback/summary": {},
	"/api/v1/feedback/like":    {},
	"/api/v1/feedback/submit":  {},
}

func Auth(r *ghttp.Request) {
	if _, ok := publicAuthPaths[r.URL.Path]; ok {
		r.Middleware.Next()
		return
	}

	authHeader := r.Header.Get("Authorization")
	tokenStr := strings.TrimPrefix(authHeader, "Bearer ")
	// 媒体代理路由供 <video>/流式 fetch 使用，无法带自定义头时走 ?token= 兜底。
	if authHeader == "" && acceptsQueryToken(r) {
		tokenStr = r.GetQuery("token").String()
	}
	if tokenStr == "" {
		authFailure(r, "未登录")
		return
	}
	ctx := r.Context()

	secret := g.Cfg().MustGet(ctx, "jwt.secret").String()
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		return []byte(secret), nil
	})
	if err != nil || !token.Valid {
		authFailure(r, "登录已过期")
		return
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		authFailure(r, "登录已过期")
		return
	}

	userIdVal, okU := claims[consts.JwtClaimUserId].(float64)
	username, okN := claims[consts.JwtClaimUsername].(string)
	accountType, okT := claims[consts.JwtClaimAccountType].(string)
	if !okU || !okN || !okT {
		authFailure(r, "登录信息不完整，请重新登录")
		return
	}

	r.SetCtxVar(consts.JwtClaimUserId, int64(userIdVal))
	r.SetCtxVar(consts.JwtClaimUsername, username)
	r.SetCtxVar(consts.JwtClaimAccountType, accountType)

	r.Middleware.Next()
}
