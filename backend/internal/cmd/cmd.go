package cmd

import (
	"context"
	"net/http"
	"time"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
	"github.com/gogf/gf/v2/os/gcmd"
	"github.com/gogf/gf/v2/os/gcron"
	"github.com/gogf/gf/v2/os/glog"

	"cloud-conference-backend/internal/controller/auth"
	"cloud-conference-backend/internal/controller/chat"
	"cloud-conference-backend/internal/controller/dict"
	"cloud-conference-backend/internal/controller/meeting"
	"cloud-conference-backend/internal/controller/netprobe"
	"cloud-conference-backend/internal/controller/recording"
	"cloud-conference-backend/internal/controller/settings"
	"cloud-conference-backend/internal/controller/user"
	"cloud-conference-backend/internal/email"
	"cloud-conference-backend/internal/middleware"
	"cloud-conference-backend/internal/observability"
	"cloud-conference-backend/internal/service"
	"cloud-conference-backend/internal/service/thirdparty"
	"cloud-conference-backend/internal/session"
	"cloud-conference-backend/internal/sms"
	"cloud-conference-backend/internal/websocket"
)

var Main = gcmd.Command{
	Name:  "main",
	Usage: "main",
	Brief: "conference backend",
	Func: func(ctx context.Context, parser *gcmd.Parser) (err error) {
		s := g.Server()
		// ghttp 的启动横幅走的是**它自己的 logger**（ghttp_server.go 里 s.Logger().Infof），
		// 不吃 glog 的包级设置，所以 `logger.level: "error"` 时那 3 行 INFO 照样会打。
		// 把它的 logger 指到包级默认这一个上，级别设置才管得住整份日志。
		s.SetLogger(glog.DefaultLogger())

		s.Use(middleware.Observability, middleware.Cors, middleware.ResponseHandler)

		adapter := thirdparty.New()
		tokenMgr := thirdparty.NewTokenManager(adapter)
		registry := session.NewRegistry()

		authSvc := service.NewAuthService(adapter, tokenMgr)
		userSvc := service.NewUserService()
		avatarSvc := service.NewAvatarService()
		meetingSvc := service.NewMeetingService(adapter).
			WithThirdPartyToken(authSvc.GetThirdPartyToken).
			WithTokenRefresher(authSvc.RefreshThirdPartyToken).
			WithRoomKey(registry.RoomKey)
		recordingSvc := service.NewRecordingService(adapter)
		chatSvc := service.NewChatService(adapter)
		settingsSvc := service.NewSettingsService()
		dictSvc := service.NewDictService()

		// 僵尸会议核对：三方会在预约时长耗尽后自行结束会议，而终态回写原先只在有人留在会中
		// 拉状态时才发生 —— 没人挂着的那批会就永远显示"进行中"。启动补一次，之后每分钟一次。
		// 同时巡检开会人已退出超过 5 分钟的进行中会议，自动结束并标记为异常退出（abnormal_exit）。
		reconcileStale := func(ctx context.Context) {
			if n := meetingSvc.ReconcileStaleRunning(ctx); n > 0 {
				glog.Infof(ctx, "核对并回写 %d 场已结束会议", n)
			}
			if !adapter.IsSinosatV1(ctx) {
				if n := meetingSvc.AutoEndIfHostAbsent(ctx, registry, 5*time.Minute); n > 0 {
					glog.Infof(ctx, "开会人退出超 5 分钟，自动结束 %d 场会议", n)
				}
			}
		}
		ensureMeetingLaunchKindColumn(ctx)
		ensureMeetingEndReasonColumn(ctx)
		ensureMeetingPasswordColumn(ctx)
		if err := g.DB().GetCore().ClearTableFields(ctx, "meeting_appointment"); err != nil {
			return err
		}
		go reconcileStale(ctx)
		if _, err := gcron.Add(ctx, "0 * * * * *", reconcileStale, "meeting-reconcile-stale"); err != nil {
			return err
		}

		sm2LoginSvc, err := service.NewSm2LoginService(ctx)
		if err != nil {
			return err
		}

		ensureUserMobileColumn(ctx)
		ensureUserEmailColumn(ctx)
		ensureAccountTypeLabels(ctx)
		smsProvider := sms.New(service.LoadSmsConfig(ctx))
		smsAuthSvc := service.NewSmsAuthService(authSvc, smsProvider)
		glog.Infof(ctx, "短信通道: %s", smsProvider.Name())
		emailProvider := email.New(service.LoadEmailConfig(ctx))
		emailAuthSvc := service.NewEmailAuthService(authSvc, emailProvider)
		glog.Infof(ctx, "邮件通道: %s", emailProvider.Name())

		authCtrl := auth.New(authSvc, smsAuthSvc, emailAuthSvc, dictSvc, sm2LoginSvc)
		meetingCtrl := meeting.New(meetingSvc, authSvc, userSvc, dictSvc, adapter, registry, websocket.DefaultHub)
		recordingCtrl := recording.New(recordingSvc, authSvc)
		chatCtrl := chat.New(chatSvc, registry)
		settingsCtrl := settings.New(settingsSvc)
		dictCtrl := dict.New(dictSvc)
		userCtrl := user.New(avatarSvc, userSvc, dictSvc)
		netProbeCtrl := netprobe.New()

		// 头像字节在库里，出口是 GET /api/v1/users/{id}/avatar（下面路由注册处），
		// 不再有本地静态目录 —— 磁盘上那一份既不在备份里，也不在任何鉴权之后。

		websocket.DefaultHub.Init(adapter, registry)
		observability.Default.BindRuntime(registry.Stats, websocket.DefaultHub.ClientCount)
		s.BindHandler("GET:/healthz", observability.HealthHandler)
		s.BindHandler("GET:/readyz", observability.ReadyHandler)
		s.BindHandler("GET:/metrics", observability.MetricsHandler)
		s.BindHandler("/ws/v1/meeting", websocket.DefaultHub.Serve)

		// 三方直连媒体播放器：由平台托管，这里做同源代理。
		// 不挂鉴权也不落盘副本 —— <script> 带不了 Authorization，而平台证书是自签的，
		// 浏览器直连会被拦；代理让前端能同源加载，同时仓内不存第二份（复制曾造成版本分叉事故）。
		// 播放器资产以**我方自己的路径**对外：厂商文件名只存在于适配层取数参数里，
		// 不泄漏到浏览器可见的 URL 上（第10项：前端只认识我方后端）。
		s.BindHandler("/assets/media-player.js", func(r *ghttp.Request) {
			body, err := adapter.FetchVendorAsset(r.Context(), "/assets/zwt-direct-media.js")
			if err != nil {
				// 原文（含三方地址、证书与底层错误）只进服务端日志；响应体必须是用户可读的一句 ——
				// 隐藏技术细节在这一步就做掉，不留给前端去改写（第 7 项口径）。
				glog.Errorf(r.Context(), "取三方媒体播放器资产失败: %v", err)
				r.Response.WriteStatus(http.StatusBadGateway, "媒体播放器暂时取不到，请刷新页面重试")
				return
			}
			r.Response.Header().Set("Content-Type", "application/javascript; charset=utf-8")
			r.Response.Header().Set("Cache-Control", "public, max-age=300")
			r.Response.Write(body)
		})

		s.Group("/api/v1", func(group *ghttp.RouterGroup) {
			group.Middleware(middleware.Auth)

			group.Group("/auth", func(g *ghttp.RouterGroup) {
				g.GET("/sm2-public-key", authCtrl.Sm2PublicKey)
				g.POST("/login", authCtrl.Login)
				g.POST("/auto-login", authCtrl.AutoLogin)
				g.POST("/sms/send", authCtrl.SmsSend)
				g.POST("/sms/login", authCtrl.SmsLogin)
				g.POST("/sms/reset-password", authCtrl.SmsResetPassword)
				g.POST("/email/send", authCtrl.EmailSend)
				g.POST("/email/login", authCtrl.EmailLogin)
				g.POST("/logout", authCtrl.Logout)
				g.GET("/me", authCtrl.Me)
			})

			group.Group("/meetings", func(g *ghttp.RouterGroup) {
				g.GET("/list", meetingCtrl.List)
				g.GET("/today", meetingCtrl.Today)
				g.GET("/stats", meetingCtrl.Stats)
				g.POST("/ws-ticket", meetingCtrl.WsTicket)
				g.POST("/schedule", meetingCtrl.Schedule)
				g.POST("/quick-start", meetingCtrl.QuickStart)
				g.POST("/join", meetingCtrl.Join)
				g.POST("/precheck", meetingCtrl.Precheck)
				g.POST("/leave", meetingCtrl.Leave)
				g.GET("/:id", meetingCtrl.Detail)
				g.PUT("/:id", meetingCtrl.Update)
				g.GET("/:id/state", meetingCtrl.State)
				g.POST("/:id/start", meetingCtrl.Start)
				g.POST("/:id/stop", meetingCtrl.Stop)
				g.POST("/:id/end", meetingCtrl.End)
				g.POST("/:id/mute-all", meetingCtrl.MuteAll)
				g.POST("/:id/kick", meetingCtrl.Kick)
				g.POST("/:id/title", meetingCtrl.RenameTitle)
				g.POST("/:id/title-requests/:requestId", meetingCtrl.DecideRenameTitle)
				g.POST("/:id/display-name", meetingCtrl.RenameSelf)
				g.POST("/:id/focus", meetingCtrl.Focus)
				g.POST("/:id/recording/:action", meetingCtrl.Recording)
				g.GET("/:id/media/:streamId/:kind", meetingCtrl.Media)
				g.POST("/:id/cancel", meetingCtrl.Cancel)
				g.POST("/:id/publications", meetingCtrl.CreatePublication)
				g.PUT("/:id/publications/:pubId/settings", meetingCtrl.SetVideoSettings)
				g.POST("/:id/publications/:pubId/whip", meetingCtrl.Whip)
				g.DELETE("/:id/publications/:pubId/whip", meetingCtrl.WhipDelete)
				g.POST("/:id/publications/:pubId/stop", meetingCtrl.StopPublication)
				g.POST("/:id/publications/:pubId/roi-hint", meetingCtrl.RoiHint)
				g.POST("/:id/streams/:streamId/whep", meetingCtrl.StreamWhep)
				g.DELETE("/:id/streams/:streamId/whep", meetingCtrl.StreamWhepDelete)
				g.GET("/:id/streams/:streamId/frame-times", meetingCtrl.StreamFrameTimes)
				g.POST("/:id/media-state", meetingCtrl.MediaState)
				g.POST("/:id/telemetry", meetingCtrl.Telemetry)
			})

			group.Group("/recordings", func(g *ghttp.RouterGroup) {
				g.GET("/list", recordingCtrl.List)
				g.GET("/:meetingId/playback", recordingCtrl.Playback)
				g.GET("/:recordingId/download", recordingCtrl.Download)
				g.DELETE("/:recordingId", recordingCtrl.Delete)
				g.GET("/:recordingId/playlist.m3u8", recordingCtrl.Playlist)
				g.GET("/:recordingId/hls/*path", recordingCtrl.HlsAsset)
			})

			group.Group("/chat", func(g *ghttp.RouterGroup) {
				g.GET("/messages", chatCtrl.ListMessages)
				g.POST("/messages", chatCtrl.SendMessage)
			})

			group.Group("/settings", func(g *ghttp.RouterGroup) {
				g.GET("/", settingsCtrl.Get)
				g.PUT("/", settingsCtrl.Update)
				g.GET("/capabilities", settingsCtrl.Capabilities)
			})

			group.Group("/net-probe", func(g *ghttp.RouterGroup) {
				g.GET("/down", netProbeCtrl.Down)
				g.POST("/up", netProbeCtrl.Up)
				g.GET("/upstream", netProbeCtrl.Upstream)
			})

			group.Group("/dicts", func(g *ghttp.RouterGroup) {
				g.GET("/{type}", dictCtrl.List)
			})

			group.GET("/users", userCtrl.List)
			group.Group("/users", func(g *ghttp.RouterGroup) {
				g.POST("/me/avatar", userCtrl.UploadAvatar)
				g.DELETE("/me/avatar", userCtrl.ClearAvatar)
				g.PUT("/me/display-name", userCtrl.UpdateDisplayName)
				// 头像字节出口：<img> 用它，鉴权走 Authorization 或票参（middleware.acceptsQueryToken 精确匹配此形状）。
				g.GET("/:id/avatar", userCtrl.Avatar)
			})
		})

		s.Run()
		return nil
	},
}

// normalizeAddr 给不带冒号的段补上 ":"，让 "8082"、"8082,8083" 与 ":8082"、"0.0.0.0:8082" 都能用。
