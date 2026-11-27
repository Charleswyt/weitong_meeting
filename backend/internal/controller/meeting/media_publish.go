package meeting

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gogf/gf/v2/net/ghttp"
	"github.com/gogf/gf/v2/os/glog"

	v1 "cloud-conference-backend/api/v1"
	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/response"
	"cloud-conference-backend/internal/service"
	"cloud-conference-backend/internal/service/thirdparty"
	"cloud-conference-backend/internal/session"
)

// CreatePublication 替本端向上游登记一次发布，并把三方签发的 whipUrl 留在服务端，
// 只回给我方 publicationId 与代理路径 —— 三方地址与参会令牌都不外泄。
func (c *Controller) CreatePublication(r *ghttp.Request) {
	var req v1.PublicationCreateReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	sess, ok := c.registry.Session(req.Id, userId)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)

	endpointType, deviceID := service.JoinEndpoint(r.Context())
	sourceType, sourceDeviceID := publicationSourceType(req.MediaKind, endpointType, deviceID)
	payload := map[string]interface{}{
		"mediaKind":     req.MediaKind,
		"sourceType":    sourceType,
		"hasVideo":      req.HasVideo,
		"hasAudio":      req.HasAudio,
		"width":         req.Width,
		"height":        req.Height,
		"fps":           req.Fps,
		"sourceFpsHint": req.Fps,
		"mediaLabel":    req.MediaLabel,
	}
	if sourceDeviceID != "" {
		payload["sourceDeviceId"] = sourceDeviceID
	}
	if c.adapter.IsSinosatV1(r.Context()) || thirdparty.OceanFederation() {
		if req.TransportMode == "cloud" && (req.MediaKind == "audio" || req.EncodingStrategy == "dynamic_gop" || req.TargetBitrateKbps < 0 || req.TargetBitrateKbps > 6000 || (req.TargetBitrateKbps > 0 && req.TargetBitrateKbps < 20)) {
			response.FailValidate(r, fmt.Errorf("请为视频选择有效的云端压缩策略与目标码率"))
			return
		}
		payload["transportMode"] = req.TransportMode
		if thirdparty.OceanFederation() && (sess.EndpointType == "ship" || req.TransportMode != "cloud") {
			payload["transportMode"] = "original"
		}
	}
	if req.TargetBitrateKbps > 0 {
		payload["targetBitrateKbps"] = req.TargetBitrateKbps
	}
	if req.EncodingStrategy != "" && !(thirdparty.OceanFederation() && payload["transportMode"] == "original") {
		payload["encodingStrategy"] = req.EncodingStrategy
	}
	// 页面刷新会丢掉前端的 RTCPeerConnection，旧发布在三方还挂着；
	// 不清掉的话新建同类发布会被卡住，且现场留下永远 not-ready 的僵尸流。
	if state := room.State(); state != nil {
		for _, old := range state.Publications {
			if old.ParticipantId != sess.ParticipantId || old.MediaKind != req.MediaKind {
				continue
			}
			if _, err := c.adapter.StopPublication(r.Context(), sess.ParticipantToken, old.PublicationId); err != nil {
				glog.Warningf(r.Context(), "清理旧发布 %s 失败: %v", old.PublicationId, err)
			}
			room.UnbindWhip(old.PublicationId)
		}
	}
	raw, err := c.adapter.CreatePublication(r.Context(), sess.ParticipantToken, payload)
	if err != nil {
		glog.Errorf(r.Context(), "创建发布失败: %v", err)
		response.Fail(r, thirdPartyUserMessage(err, "发布创建失败，请稍后重试", c.knownMeetingStatus(r.Context(), req.Id, room)))
		return
	}
	pubId, whipURL := parsePublication(raw)
	if pubId == "" || whipURL == "" {
		glog.Errorf(r.Context(), "三方创建发布的响应解析不出 publicationId/whipUrl，原文: %s", string(raw))
		response.Fail(r, "暂时无法开始推流，请稍后重试")
		return
	}
	room.BindWhip(pubId, session.WhipTarget{
		OfferURL:         whipURL,
		UserId:           userId,
		CloudCompression: thirdparty.OceanFederation() && payload["transportMode"] == "cloud",
		AuthBearer:       sess.ParticipantToken, // 公网会议 WHIP 要 Bearer；Ocean 预授权 URL 忽略此字段
	})
	// 船端浏览器这一路要过船内的 RK 接收槽。三方自己的次序是"先把槽武装起来，再接上实时轨道"
	// （其注释原文：the RK reader cannot miss the only startup IDR），所以赶在把地址交给浏览器之前调。
	// 等不到也照样返回发布：武装失败不该挡掉推流（与消费侧同一条口径，见 armRkReceiver）。
	if sourceType == consts.SourceTypeRkBrowserRoi {
		c.armRkReceiver(r.Context(), sess.ParticipantToken, pubId, rkArmBudgetPublish)
	}
	response.OkWithData(r, v1.PublicationCreateRes{
		PublicationId: pubId,
		WhipPath:      "/api/v1/meetings/" + strconv.FormatInt(req.Id, 10) + "/publications/" + pubId + "/whip",
		SourceType:    sourceType,
	}, "操作成功")
}

// publicationSourceType 决定这次发布向三方申报哪种来源，以及要不要带设备号。
// 三方按"这条视频是不是船端浏览器发的"分：船端摄像头/屏幕是 rk_browser_roi，要过船内 RK 接收槽；
// 其余一律 browser_whip —— **音频在船端也仍是 browser_whip**（三方原实现就是这么写的，
// 顺手一起改会让音频也走 RK 路径）。端别判据复用入会那一处（service.JoinEndpoint），不另立。
// 缺设备号时回落 browser_whip，与入会回落岸端一致，并已由 JoinEndpoint 记过一条点名配置项的日志。
func publicationSourceType(mediaKind, endpointType, deviceID string) (sourceType, sourceDeviceID string) {
	if mediaKind == "audio" || endpointType != "ship" || deviceID == "" {
		return consts.SourceTypeBrowserWhip, ""
	}
	return consts.SourceTypeRkBrowserRoi, deviceID
}

// 船内 TCP-only 媒体网关的发布地址（三方 `localTcpWhipOffer` 用的同一条判据）。
var (
	localTcpWhipPathRe = regexp.MustCompile(`^/__ship_local_media/[0-9A-Za-z_-]+/whip$`)
	twccFeedbackRe     = regexp.MustCompile(`^a=rtcp-fb:\S+ transport-cc(\s|$)`)
	// TWCC 的两个 extmap URI（draft 版与正式版各一）。
	twccExtmapURIs = map[string]bool{
		"http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01": true,
		"urn:ietf:params:rtp-hdrext:transport-wide-cc-02":                           true,
	}
)

// stripTransportCCForLocalTcp 去掉船内 TCP 网关那一路 offer 里的 TWCC 反馈与扩展。
//
// 照三方 `localTcpWhipOffer`：这个端点是 TCP-only 的，TCP 队头阻塞之后 Chrome 自带的 TWCC
// 估算器会塌到 ~30 kbps，把 delta 帧饿在周期性关键帧后面。保留 TCP 自己的拥塞控制、RTCP 报告与
// NACK/PLI，不改媒体 PTS。
//
// 判据只说"这个端点是不是那个 TCP-only 网关"（看路径），不叠加来源申报：端点是不是 TCP-only
// 由端点自己决定，跟这条发布声明成哪种来源无关；而申报的一半只可能是"是"—— 那个地址本来只给
// 船内发布用。云端地址不匹配这条路径，所以这里对云端是空转。
func stripTransportCCForLocalTcp(offer, whipURL string) string {
	if offer == "" || !strings.Contains(offer, "m=video ") {
		return offer
	}
	u, err := url.Parse(whipURL)
	if err != nil || !localTcpWhipPathRe.MatchString(u.Path) {
		return offer
	}
	newline := "\n"
	if strings.Contains(offer, "\r\n") {
		newline = "\r\n"
	}
	lines := strings.Split(offer, newline)
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if twccFeedbackRe.MatchString(line) {
			continue
		}
		if strings.HasPrefix(line, "a=extmap:") {
			if f := strings.Fields(line); len(f) >= 2 && twccExtmapURIs[f[1]] {
				continue
			}
		}
		kept = append(kept, line)
	}
	if len(kept) == len(lines) {
		return offer
	}
	return strings.Join(kept, newline)
}

// Whip 把浏览器的 SDP offer 转发到三方预授权地址，并把 answer 原文回给浏览器。
// 响应不是统一信封：这一跳是媒体信令，浏览器要的是 application/sdp。
func (c *Controller) Whip(r *ghttp.Request) {
	var req v1.PublicationWhipReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	if _, ok := c.registry.Session(req.Id, userId); !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)
	target, ok := room.WhipForUser(req.PubId, userId)
	if !ok {
		response.Fail(r, "发布不存在或已结束")
		return
	}
	offer := stripTransportCCForLocalTcp(r.GetBodyString(), target.OfferURL)
	if offer == "" {
		response.Fail(r, "发布请求没带上媒体协商内容，请重新开启摄像头或麦克风")
		return
	}
	answer, location, err := c.adapter.PostSdpAuth(r.Context(), target.OfferURL, offer, target.AuthBearer)
	if err != nil {
		glog.Errorf(r.Context(), "WHIP 转发失败: %v", err)
		r.Response.ClearBuffer()
		r.Response.WriteStatus(http.StatusBadGateway, thirdPartyUserMessage(err, "媒体发布失败", c.knownMeetingStatus(r.Context(), req.Id, room)))
		return
	}
	if location != "" {
		room.SetWhipSession(req.PubId, location)
	}
	// 消费侧要哪条投放腿（zha1+h264 / zha1+hevc）取决于**这条连接实际编成了什么**，
	// 而三方 publications 里的 directVideoCodec 是它的标称值，两者可以不一致 ——
	// 不一致时上游不会说"编码不对"，只会一直回 425 direct_video_not_ready（见 adapter.go 的投放头注释）。
	// 所以把 answer 里选定的编码记下来，出问题时这是唯一的一手证据。
	glog.Debugf(r.Context(), "WHIP 协商完成 pub=%s answer选定视频编码=%s", req.PubId, answerVideoCodec(answer))
	if target.CloudCompression {
		// Publish the answer immediately. MediaMTX first needs the browser's ICE connection.
		go c.prepareCloudEncoder(target.AuthBearer, req.PubId)
	}
	r.Response.Header().Set("Content-Type", "application/sdp")
	r.Response.Header().Set("Cache-Control", "no-store")
	r.Response.Write(answer)
}

func (c *Controller) prepareCloudEncoder(token, pub string) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	ticker := time.NewTicker(650 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			glog.Warningf(ctx, "云端压缩未就绪 publication=%s", pub)
			return
		case <-ticker.C:
			res, err := c.adapter.PreparePublication(ctx, token, pub, thirdparty.PrepareRolePublisher)
			if err == nil && res != nil && res.SoftwareRoiAttached {
				return
			}
			if res != nil && (res.Reason == "publication_not_found" || res.Reason == "participant_not_joined") {
				return
			}
		}
	}
}

// answerVideoCodec 从 WHIP answer 的 SDP 里取出**实际选定**的视频编码（H.264 带上 profile 参数）。
// 只看第一条 m=video：我方一次 WHIP 只发一路媒体（音频另走一条 WHIP）。
func answerVideoCodec(sdp string) string {
	var payload string
	names := map[string]string{}
	fmtp := map[string]string{}
	for _, raw := range strings.Split(sdp, "\n") {
		line := strings.TrimSpace(raw)
		switch {
		case strings.HasPrefix(line, "m=video"):
			// m=video <port> <proto> <fmt> [payload...] —— 取第一个 payload，即应答方选中的那条。
			if f := strings.Fields(line); len(f) > 4 && payload == "" {
				payload = f[4]
			}
		case strings.HasPrefix(line, "a=rtpmap:"):
			if pt, name, ok := strings.Cut(strings.TrimPrefix(line, "a=rtpmap:"), " "); ok {
				names[pt] = strings.TrimSpace(name)
			}
		case strings.HasPrefix(line, "a=fmtp:"):
			if pt, params, ok := strings.Cut(strings.TrimPrefix(line, "a=fmtp:"), " "); ok {
				fmtp[pt] = strings.TrimSpace(params)
			}
		}
	}
	if payload == "" {
		return "无 m=video"
	}
	codec := names[payload]
	if codec == "" {
		codec = "pt" + payload + "(缺 rtpmap)"
	}
	if p := fmtp[payload]; p != "" {
		return codec + " " + p
	}
	return codec
}

// WhipDelete 对 WHIP 会话 URI 发 DELETE，真正拆掉这条实时连接。
func (c *Controller) WhipDelete(r *ghttp.Request) {
	var req v1.PublicationWhipDeleteReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)
	target, ok := room.WhipForUser(req.PubId, userId)
	if !ok {
		response.OkWithMessage(r, "发布已结束")
		return
	}
	if target.SessionURL != "" {
		if err := c.adapter.DeleteSessionAuth(r.Context(), target.SessionURL, target.AuthBearer); err != nil {
			glog.Warningf(r.Context(), "whip delete %s failed: %v", req.PubId, err)
		}
	}
	room.UnbindWhip(req.PubId)
	response.OkWithMessage(r, "已停止发布")
}

// StopPublication 通知三方结束该发布并解除本地绑定。
func (c *Controller) StopPublication(r *ghttp.Request) {
	var req v1.PublicationStopReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	sess, ok := c.registry.Session(req.Id, userId)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)
	if _, err := c.adapter.StopPublication(r.Context(), sess.ParticipantToken, req.PubId); err != nil {
		glog.Warningf(r.Context(), "stop publication %s failed: %v", req.PubId, err)
	}
	room.UnbindWhip(req.PubId)
	response.OkWithMessage(r, "已停止发布")
}

// SetVideoSettings changes only the published rendition. The WHIP capture remains live.
func (c *Controller) SetVideoSettings(r *ghttp.Request) {
	var req v1.PublicationSettingsReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	ctx := r.Context()
	userID := service.GetUserIdFromCtx(ctx)
	room, ok := c.registry.Room(req.Id)
	sess, joined := c.registry.Session(req.Id, userID)
	if !ok || !joined {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	if _, ok := room.WhipForUser(req.PubId, userID); !ok {
		response.FailStatus(r, http.StatusForbidden, "仅发布者可设置自己的媒体", "publication_owner_required")
		return
	}
	if thirdparty.OceanFederation() {
		response.FailStatus(r, http.StatusConflict, "请沿用当前采集轨道，以所选配置重新发布本路视频", "publication_republish_required")
		return
	}
	if !c.adapter.IsSinosatV1(ctx) {
		response.FailStatus(r, http.StatusConflict, "此入口用于中卫通公网会议", "unsupported_meeting")
		return
	}
	prefs := map[string]interface{}{"mode": req.TransportMode}
	if req.TransportMode == "cloud" {
		if req.EncodingStrategy == "" || req.TargetBitrateKbps < 20 || req.TargetBitrateKbps > 6000 {
			response.FailValidate(r, fmt.Errorf("请选择压缩策略并填写 20–6000 kbps 的目标码率"))
			return
		}
		prefs["encodingStrategy"] = req.EncodingStrategy
		prefs["videoKbps"] = req.TargetBitrateKbps
		prefs["codec"] = "h264"
	}
	result, err := c.adapter.SetVideoSettings(ctx, sess.ParticipantToken, req.PubId, prefs)
	if err != nil {
		response.Fail(r, thirdPartyUserMessage(err, "未能应用视频压缩设置", ""))
		return
	}
	var stream struct {
		Revision int `json:"revision"`
	}
	if err = json.Unmarshal(result, &stream); err != nil || stream.Revision < 1 {
		response.Fail(r, "媒体服务未确认设置")
		return
	}
	c.registry.Touch(req.Id, userID)
	response.OkWithData(r, stream, "已应用")
}

// RoiHint 上报人脸框，供三方编码器把码率花在人脸（外部契约 §10.3）。
// 只对 camera 发布有效；边端没有 ROI 增强通道，按部署侧直接拒绝。
func (c *Controller) RoiHint(r *ghttp.Request) {
	var req v1.RoiHintReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	sess, ok := c.registry.Session(req.Id, userId)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)
	if !service.FaceEnhancementSupported() {
		response.FailStatus(r, http.StatusConflict, service.FaceEnhancementUnsupportedMessage(), "face_enhancement_unsupported")
		return
	}
	if _, ok := room.WhipForUser(req.PubId, userId); !ok {
		response.Fail(r, "发布不存在或已结束")
		return
	}
	if err := validateRoiHint(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	// 前端已按 250ms 节流；这里兜一层，免得异常客户端把上游打成高频。
	if !room.AllowRoiHint(userId, 250*time.Millisecond) {
		response.OkWithMessage(r, "已跳过")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	_, err := c.adapter.PostRoiHint(ctx, sess.ParticipantToken, req.PubId, map[string]interface{}{
		"detector":          req.Detector,
		"sequence":          req.Sequence,
		"sourceTimestampMs": req.SourceTimestampMs,
		"inferenceMs":       req.InferenceMs,
		"regions":           req.Regions,
	})
	if err != nil {
		// 失败不重试、不弹窗：这条只影响编码器偏置，不该让用户以为画面坏了。
		glog.Warningf(r.Context(), "roi-hint %s 上报失败: %v", req.PubId, err)
		response.FailStatus(r, http.StatusBadGateway, "人脸增强没有生效", "roi_hint_failed")
		return
	}
	// 成功侧要能自证链路通：每 20 次留一条，开 debug 时逐条可见。
	// 现场问"这个开关到底有没有发出去"时，只看 UI 是答不出的。
	if n := atomic.AddUint64(&roiHintSuccess, 1); n == 1 || n%20 == 0 {
		glog.Infof(r.Context(), "roi-hint 已送达三方 pub=%s seq=%d 人脸框=%d 次=%d", req.PubId, req.Sequence, len(req.Regions), n)
	} else {
		glog.Debugf(r.Context(), "roi-hint 已送达三方 pub=%s seq=%d 人脸框=%d", req.PubId, req.Sequence, len(req.Regions))
	}
	response.Ok(r, v1.RoiHintRes{})
}

func validateRoiHint(req *v1.RoiHintReq) error {
	if req.Sequence < 0 || req.SourceTimestampMs < 0 {
		return fmt.Errorf("人脸增强上报的时间戳不合法")
	}
	if req.InferenceMs < 0 || req.InferenceMs > 60000 {
		return fmt.Errorf("人脸增强上报的耗时超出范围")
	}
	if len(req.Regions) > 8 {
		return fmt.Errorf("最多上报 8 个人脸框")
	}
	for i, rg := range req.Regions {
		for _, v := range []float64{rg.X, rg.Y, rg.Width, rg.Height, rg.Score} {
			// v != v 拦 NaN；±Inf 会被下一条的范围判断拦住。
			if v != v || v < 0 || v > 1 {
				return fmt.Errorf("第 %d 个人脸框的坐标超出范围", i+1)
			}
		}
		if rg.X+rg.Width > 1+1e-6 || rg.Y+rg.Height > 1+1e-6 {
			return fmt.Errorf("第 %d 个人脸框超出画面", i+1)
		}
	}
	return nil
}

// MediaState 是媒体意图的 REST 快速通道：更新会话意图位并立刻向三方提交一次带状态的
// 心跳（三方按意图位过滤发布可见性——位为 false 时手机端连画面都不渲染）。
// WS 的 media 消息保留作实时冗余，但正确性以本通道为准。
func (c *Controller) MediaState(r *ghttp.Request) {
	var req v1.MeetingMediaStateReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	if _, ok := c.registry.Room(req.Id); !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	sess, ok := c.registry.Session(req.Id, userId)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)
	media, ok := c.registry.UpdateMedia(req.Id, userId, req.CameraOn, req.MicOn, req.Sharing, req.Recording)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	if _, err := c.adapter.Heartbeat(r.Context(), sess.ParticipantToken, &media); err != nil {
		response.FailSystem(r, "媒体状态未同步到会议链路", err)
		return
	}
	response.Ok(r, v1.MeetingMediaStateRes{})
}

// Telemetry 收下发布端实测的编码码率样本。**只落会话、不立刻心跳** —— 泵每 tick 本来就
// 逐会话发一次，多插一次是白加往返（与 WS 的 `case "telemetry"` 同一口径）。
// 两条过滤（空 publicationId、码率 <=0）与 4 秒过期都在 registry 一处生效，REST 与 WS 共用，
// 这里不另立一套：发 0 会被上游当成"实测到 0"，比缺数更坏。
func (c *Controller) Telemetry(r *ghttp.Request) {
	var req v1.MeetingTelemetryReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	if _, ok := c.registry.Room(req.Id); !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	if _, ok := c.registry.Session(req.Id, userId); !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)
	items := make([]thirdparty.VideoSourceTelemetry, 0, len(req.Items))
	for _, it := range req.Items {
		items = append(items, thirdparty.VideoSourceTelemetry{
			PublicationId:          it.PublicationId,
			SourceVideoBitrateKbps: it.SourceVideoBitrateKbps,
			SourceFps:              it.SourceFps,
			CaptureFps:             it.CaptureFps, PublishFps: it.PublishFps,
			PublishKbps: it.PublishKbps, DecodedFrameKbps: it.DecodedFrameKbps,
			AssociatedAudioBitrateKbps: it.AssociatedAudioBitrateKbps,
		})
	}
	c.registry.UpdateSourceTelemetry(req.Id, userId, items)
	response.Ok(r, v1.MeetingTelemetryRes{})
}
