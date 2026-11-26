package meeting

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gogf/gf/v2/net/ghttp"
	"github.com/gogf/gf/v2/os/glog"

	v1 "cloud-conference-backend/api/v1"
	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/errs"
	"cloud-conference-backend/internal/model"
	"cloud-conference-backend/internal/response"
	"cloud-conference-backend/internal/service"
	"cloud-conference-backend/internal/service/thirdparty"
	"cloud-conference-backend/internal/session"
)

// State 返回入会首屏所需的全量状态。
func (c *Controller) State(r *ghttp.Request) {
	var req v1.MeetingStateReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	vo, err := c.buildState(r, req.Id)
	if err != nil {
		response.FailSystem(r, "查询会议状态失败", err)
		return
	}
	response.Ok(r, vo)
}

func (c *Controller) Focus(r *ghttp.Request) {
	var req v1.MeetingFocusReq
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
	alias, ok := room.ResolveStream(req.StreamId)
	if !ok {
		response.Fail(r, "该流已结束")
		return
	}
	sess, ok := c.registry.Session(req.Id, userId)
	if !ok {
		// 不能吞掉 ok：下面直接取 sess.ParticipantToken，非成员进来就是 nil 解引用（panic）。
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	if err := c.adapter.FocusPublication(r.Context(), sess.ParticipantToken, alias.PublicationId); err != nil {
		// 发布已终止是参会端要据此清瓦片的业务事实，其余失败原因只进日志。
		if strings.Contains(err.Error(), "publication_not_active") {
			response.Fail(r, "该流已结束")
			return
		}
		if strings.Contains(err.Error(), "participant_not_joined") {
			// 本端在上游已经不在会中（同账号被另一台设备顶号、心跳被判死）。这是"该离开会中页"
			// 的业务事实，不是我方坏了：回 not_in_meeting，别弹「系统异常」（第 6/34 项）。
			response.FailSystem(r, "关注该流失败", errs.BizReason(errs.Bizf("本端会议会话已失效，请重新入会"), "not_in_meeting"))
			return
		}
		response.FailSystem(r, "关注该流失败", err)
		return
	}
	response.OkWithMessage(r, "已关注")
}

// Recording 会中录制开关（本域语义，后端决定用哪个上游能力实现）。
func (c *Controller) Recording(r *ghttp.Request) {
	var req v1.MeetingRecordingReq
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
		// 同上：下面要取 sess.ParticipantToken，非成员进来不能让它成 nil。
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	if room.ThirdPartyId == "" {
		response.Fail(r, "该会议尚未同步到录制服务，无法在会中开关录制")
		return
	}
	bearer, err := c.authSvc.GetThirdPartyToken(r.Context(), userId)
	if err != nil {
		response.FailSystem(r, "获取录制服务令牌失败", err)
		return
	}
	if req.Action == "start" {
		err = c.adapter.StartBoardRecording(r.Context(), bearer, sess.ParticipantToken, room.ThirdPartyId)
	} else {
		err = c.adapter.StopBoardRecording(r.Context(), bearer, sess.ParticipantToken, room.ThirdPartyId)
	}
	if err != nil {
		response.Fail(r, recordingUserMessage(r.Context(), err))
		return
	}
	resp, err := c.adapter.GetMeetingState(r.Context(), sess.ParticipantToken, room.ExternalNo)
	if err != nil {
		response.FailSystem(r, "录制指令已发出，但状态拉取失败", err)
		return
	}
	room.StoreState(resp, userId)
	c.registry.Room(req.Id)
	vo := service.BuildMeetingStateVo(req.Id, resp, room, c.roster(r.Context(), req.Id))
	response.Ok(r, v1.MeetingRecordingRes{Recording: vo.Recording})
}

// Media 代理上游媒体流：前端只认我方路径与 JWT，上游令牌在此注入。
func (c *Controller) Media(r *ghttp.Request) {
	meetingId := r.GetRouter("id").Int64()
	streamId := r.GetRouter("streamId").String()
	kind := r.GetRouter("kind").String()
	userId := service.GetUserIdFromCtx(r.Context())

	room, ok := c.registry.Room(meetingId)
	if !ok {
		response.FailStream(r, http.StatusUnauthorized, "请先加入会议")
		return
	}
	alias, ok := room.ResolveStream(streamId)
	if !ok {
		response.FailStream(r, http.StatusNotFound, "该流已结束")
		return
	}
	sess, ok := c.registry.Session(meetingId, userId)
	if !ok {
		response.FailStream(r, http.StatusUnauthorized, "请先加入会议")
		return
	}
	// 来取流这件事本身就是"我要收这路"的意图，先把它报给上游再解析地址：
	// 实测没人关注的流会被饿着（下行 ~70kbps、首字节 700ms+，关注后 ~176kbps、1ms），
	// 而前端那次 fire-and-forget 的关注上报和这里的取流是并发的，等它落地再来取就晚了。
	c.focusPublication(r.Context(), room, sess, alias.PublicationId)
	state, source, gone := c.stateWithPublication(r.Context(), room, sess, alias.PublicationId)
	if gone {
		// 终态：回 410。前端把 404/410 判成"这路已经没了"（不重试、不挂红字），等下一轮 state 摘掉死流；
		// 回 503「还在准备中」等于让它每 1.5 秒再取一次一个已经不存在的会议，表现就是"起播失败"。
		response.FailStream(r, http.StatusGone, "这场会议已经结束，媒体不再可用")
		return
	}
	if state == nil {
		response.FailStream(r, http.StatusServiceUnavailable, "会议状态尚未就绪，请稍后重试")
		return
	}
	pub, target, accept, whyNot := pickStreamURL(state, alias.PublicationId, kind)
	if pub.PublicationId != "" && pub.PublicationId != alias.PublicationId {
		// 实际要打开的是兄弟别名（订到的那条还没 ready）：关注必须跟着改报，
		// 否则上游按"没人关注"把真正在播的那条饿掉。
		c.focusPublication(r.Context(), room, sess, pub.PublicationId)
		glog.Infof(r.Context(), "改用就绪别名取流 meeting=%d stream=%s kind=%s 订正=%s→%s",
			meetingId, streamId, kind, alias.PublicationId, pub.PublicationId)
	}
	// 定责用：直连腿的 Accept 完全由编码判定决定，判错就换来一个永不就绪的 425。
	if kind == "video" && target != "" {
		glog.Debugf(r.Context(), "直连取流 pub=%s sourceType=%s directVideoCodec=%q directVideoFormat=%q 判定=%s accept=%s",
			pub.PublicationId, pub.SourceType, pub.DirectVideoCodec, pub.DirectVideoFormat, pub.VideoCodec(), accept)
	}
	if target == "" {
		// whyNot 只进日志：它是"上游怎么没给这条发布"的诊断线索，不是给用户看的话。
		glog.Warningf(r.Context(), "解析流失败 meeting=%d stream=%s kind=%s publication=%s 来源=%s 可见发布=%s 原因=%s",
			meetingId, streamId, kind, alias.PublicationId, source, publicationSummary(state), whyNot)
		response.FailStream(r, http.StatusServiceUnavailable, "这路媒体还在准备中，请稍后重试")
		return
	}
	body, header, err := c.adapter.OpenStream(r.Context(), sess.ParticipantToken, target, accept)
	if err != nil {
		glog.Warningf(r.Context(), "打开流失败 meeting=%d stream=%s kind=%s publication=%s 投放=%s 来源=%s 可见发布=%s: %v",
			meetingId, streamId, kind, alias.PublicationId, accept, source, publicationSummary(state), err)
		if isStreamWarmingUp(err) {
			// 上游回 425「还没准备好」不是故障：稍后再取就有结果。用 503 说清，
			// 前端才不会把它当终态挂进长冷却，用户看到的是"还在准备"而不是"起播失败"。
			response.FailStream(r, http.StatusServiceUnavailable, "这路媒体还在准备中，请稍后重试")
			return
		}
		response.FailStream(r, http.StatusBadGateway, "这路媒体暂时无法接通，请稍后重试")
		return
	}
	defer body.Close()

	r.Response.Header().Set("Content-Type", accept)
	r.Response.Header().Set("Cache-Control", "no-store")
	// 三方播放器会校验这个头来确认"这路确实经过云端转码"，漏传会导致起播被拒
	// （实测报 direct_video_transcode_guard_failed）。
	if tc := header.Get("X-ZWT-Cloud-Transcode"); tc != "" {
		r.Response.Header().Set("X-ZWT-Cloud-Transcode", tc)
	}
	if cl := header.Get("Content-Length"); cl != "" {
		r.Response.Header().Set("Content-Length", cl)
	}
	r.Response.Status = http.StatusOK
	io.Copy(r.Response.Writer, body) //nolint:errcheck
}

// focusPublication 把"这一端要收这路发布"报给上游。失败只进日志：关注影响的是码率与
// 这路在我方状态里的可见性，取流本身仍值得继续试，不能因为一次上报失败就把人挡在会中页外。
func (c *Controller) focusPublication(ctx context.Context, room *session.MeetingRoom, sess *session.Session, pubId string) {
	if err := c.adapter.FocusPublication(ctx, sess.ParticipantToken, pubId); err != nil {
		glog.Warningf(ctx, "上报关注失败 meeting=%d publication=%s: %v", room.MeetingId, pubId, err)
	}
}

// isStreamWarmingUp 认出上游的"这路还没好"（425 / not_ready 一类）：那是会自己变好的中间态，
// 不是故障，也不该带着三方术语抛给前端。
func isStreamWarmingUp(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, " 425") || strings.Contains(msg, "not_ready")
}

// stateWithPublication 保证"要订阅的发布"在可见状态里：流别名由泵先签发、房间缓存随后才更新，
// 前端拿到新流立刻订阅时缓存里往往还没有这条发布（实测报"上游未回报该发布"）。
// 命中不了就实时回源三方拉一次——只用于本次解析，不覆盖泵缓存，避免拿旧快照踩掉新状态。
// 第二个返回值标明状态出处，失败时能一眼看出是"缓存陈旧"还是"上游真没给"。
// 第三个返回值是"上游已经没有这场会了"（实测 404 meeting_not_found）：这是终态，
// 不能继续回 503「还在准备中」——那会让前端按可重试的中间态一直取，用户看到的就是"起播失败"。
func (c *Controller) stateWithPublication(ctx context.Context, room *session.MeetingRoom, sess *session.Session, pubId string) (*thirdparty.MeetingResponse, string, bool) {
	// 只认**本人为这个用户拉的那一份**缓存：状态里的订阅地址嵌着绑定参会者的票据，
	// 复用别人的等于拿 A 的凭证去订 B 的订阅，三方回 401。
	st := room.StateFor(sess.UserId)
	if st != nil {
		for _, p := range st.Publications {
			if p.PublicationId == pubId {
				return st, "房间缓存", false
			}
		}
	}
	// ThirdPartyIds 的返回顺序是 (会议号, 会议ID)。/state 的路径参数只认**会议号**，
	// 传成会议ID 上游一律回 404 meeting_not_found（实测 2026-09-28：缓存未命中时
	// 每次回源都 404，于是"刚入会那位的发布"永远解析不出来 → 别人看不到他）。
	externalNo := room.ExternalMeetingNo()
	fresh, err := c.adapter.GetMeetingState(ctx, sess.ParticipantToken, externalNo)
	if err != nil {
		glog.Warningf(ctx, "订阅流时实时拉取会议状态失败 meeting=%d 号=%s: %v", room.MeetingId, externalNo, err)
		return st, "房间缓存(回源失败)", isMeetingGone(err)
	}
	for _, p := range fresh.Publications {
		if p.PublicationId == pubId {
			return fresh, "回源状态", false
		}
	}
	return fresh, "回源状态(不含该发布)", false
}

// isMeetingGone 认上游的"这场会不在了"（404 / meeting_not_found）。
// 与会自己刚结束、泵缓存还留着旧流别名的场景配对出现，是订阅路径上的常态而不是异常。
func isMeetingGone(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "meeting_not_found") || strings.Contains(msg, " 404")
}

// publicationSummary 把状态里的发布列成一行，供解析失败时定位"上游到底回报了哪些发布"。
// 每条带：媒体种类 / 状态 / 直连腿有无 / RK 腿的形状（投递模式、接收槽号、路径、来源类型）。
// RK 那几样是判"这条远端发布到底有没有接收槽"的唯一现场证据 —— 路径本身不是凭据，
// 但地址一律不打印（ticket 在三方 URL 的 query 里，见 thirdparty.LoggableTarget）。
func publicationSummary(state *thirdparty.MeetingResponse) string {
	if state == nil {
		return "(无状态)"
	}
	ids := make([]string, 0, len(state.Publications))
	for _, p := range state.Publications {
		urls := ""
		if p.DirectVideoUrl != "" {
			urls += "视频"
		}
		if p.DirectAudioUrl != "" {
			urls += "+音频"
		}
		if urls == "" {
			urls = "无直连"
		}
		rk := ""
		if p.RkDeliveryMode != "" || p.RkReceiverLaneId > 0 || p.RkReceiverPath != "" || p.RkReceiverWhepUrl != "" {
			whep := "无"
			if p.RkReceiverWhepUrl != "" {
				whep = "有"
			}
			rk = fmt.Sprintf(" rk{mode=%s lane=%d path=%s whep=%s}", p.RkDeliveryMode, p.RkReceiverLaneId, p.RkReceiverPath, whep)
		}
		src := ""
		if p.SourceType != "" {
			src = " src=" + p.SourceType
		}
		ids = append(ids, fmt.Sprintf("%s(%s/%s/%s%s%s)", p.PublicationId, p.MediaKind, p.Status, urls, src, rk))
	}
	return strings.Join(ids, " ")
}

// findPublication 按上游 publicationId 取回那条发布。
func findPublication(state *thirdparty.MeetingResponse, publicationId string) (thirdparty.Publication, bool) {
	for _, p := range state.Publications {
		if p.PublicationId == publicationId {
			return p, true
		}
	}
	return thirdparty.Publication{}, false
}

// subscribableAliases 把"同一位成员、同一种媒体"的上游别名按此刻能不能打开排序：ready 的排最前。
//
// 上游在同一路媒体重推时会同时留着新旧两个 publicationId：旧的还 ready、新的刚 publishing。
// 只按订到的那条取地址，实测（2026-09-28 会议 90）每轮都是 425 direct_video_not_ready ——
// 前端就一直挂着"这路媒体还在准备中"，而能播的兄弟别名就在同一份快照里。
func subscribableAliases(state *thirdparty.MeetingResponse, publicationId string) []thirdparty.Publication {
	self, ok := findPublication(state, publicationId)
	if !ok {
		return nil
	}
	ready := make([]thirdparty.Publication, 0, 2)
	unready := make([]thirdparty.Publication, 0, 2)
	requested := make([]thirdparty.Publication, 0, 1)
	for _, p := range state.Publications {
		if p.ParticipantId != self.ParticipantId || p.MediaKind != self.MediaKind {
			continue
		}
		if p.Status == "stopped" || p.Status == "failed" {
			continue
		}
		switch {
		case p.Status == "ready":
			ready = append(ready, p)
		case p.PublicationId == publicationId:
			requested = append(requested, p)
		default:
			unready = append(unready, p)
		}
	}
	return append(append(ready, requested...), unready...)
}

// pickStreamURL 选出可播地址，并带回这条地址所属的发布（调用方要按它上报关注）。
// 返回的 whyNot 用于把"为什么没有可播格式"说清楚 ——
// 只回一句"暂不可接收"会让人对着上游猜（音频只有 WHEP 兜底、没有直连地址时尤其容易误判）。
func pickStreamURL(state *thirdparty.MeetingResponse, publicationId, kind string) (thirdparty.Publication, string, string, string) {
	cands := subscribableAliases(state, publicationId)
	if len(cands) == 0 {
		return thirdparty.Publication{}, "", "", "上游未回报该发布"
	}
	for _, p := range cands {
		if kind == "audio" {
			if p.DirectAudioUrl != "" {
				return p, p.DirectAudioUrl, thirdparty.AcceptZaa1Aac, ""
			}
			continue
		}
		if p.DirectVideoUrl != "" {
			// 协商头跟着这一路的实际编码走，不是一律 h264：经边端 RKMPP 处理的那一路
			// 只有 HEVC 这条腿，按 h264 取会拿到一个永远不会就绪的 425。
			return p, p.DirectVideoUrl, thirdparty.AcceptForVideoCodec(p.VideoCodec()), ""
		}
	}
	// 这条通路只有 GET 拉流一种形态，因此只认直连压缩流；WHEP 那条腿要 POST + SDP，
	// 由 /streams/:id/whep 单独走，两件事不许混在一个端点里。
	req, _ := findPublication(state, publicationId)
	if kind == "audio" {
		return req, "", "", audioChannelsHint(req)
	}
	return req, "", "", videoChannelsHint(req)
}

// audioChannelsHint 说清上游给了哪些音频通道、本端为什么用不了 —— 只回一句"暂不可接收"
// 会让人对着上游猜（音频只有板卡通道、没有云端 WHEP 时尤其容易误判）。
func audioChannelsHint(p thirdparty.Publication) string {
	switch {
	case p.DirectAudioUrl != "":
		return "上游有直连音频地址，请走音频直连代理"
	case p.AudioWhepUrl != "":
		return "上游有云端 WHEP 音频通道，请走 WHEP 订阅接口"
	case p.RkReceiverAudioWhepUrl != "":
		return "上游只给了船端同局域网的音频通道，岸端页面连不通它"
	}
	return "上游未给该音频发布任何通道"
}

// videoChannelsHint 说清上游给了哪些视频通道、这条 GET 通路为什么用不了（只进日志）。
// 与音频那条同一用途：只回一句"无可用直连流"会让人对着上游猜，而"上游只给了船端局域网 WHEP"
// 在边端实例上是**能用的**，该走 /streams/:id/whep（2026-10-10 实测：船端形态下网关一条直连地址都不给）。
func videoChannelsHint(p thirdparty.Publication) string {
	switch {
	case p.DirectVideoUrl != "":
		return "上游有直连视频地址，请走视频直连代理"
	case p.RkReceiverWhepUrl != "" || p.RkReceiverPath != "":
		return "上游只给了船端局域网的 WHEP 视频通道，请走 WHEP 订阅接口"
	}
	return "上游未给该视频发布任何通道"
}

// WsTicket 给 WebSocket 握手用的一次性短时票。
func (c *Controller) WsTicket(r *ghttp.Request) {
	var req v1.WsTicketReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	if _, ok := c.registry.Session(req.MeetingId, userId); !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	ticket, ttl, err := c.registry.IssueWsTicket(r.Context(), userId, req.MeetingId)
	if err != nil {
		response.FailSystem(r, "签发连接票失败", err)
		return
	}
	response.Ok(r, v1.WsTicketRes{Ticket: ticket, ExpiresInSeconds: int(ttl.Seconds())})
}

// roster 取本域补充信息（受邀名单 + 账号头像）。名单读失败只降级为空，
// 不能因为通讯录出问题就把整个会中状态接口打挂——画面和成员比"谁还没来"更要紧。
func (c *Controller) roster(ctx context.Context, meetingId int64) *service.Roster {
	invitees, err := service.LoadInvitees(ctx, meetingId)
	if err != nil {
		invitees = nil
	}
	return &service.Roster{Invitees: invitees, Avatars: service.LoadAvatarByAccount(ctx)}
}

func (c *Controller) buildState(r *ghttp.Request, meetingId int64) (*model.MeetingStateVo, error) {
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(meetingId)
	if !ok {
		return nil, c.noMeetingError(r.Context(), meetingId, nil)
	}
	sess, ok := c.registry.Session(meetingId, userId)
	if !ok {
		return nil, c.noMeetingError(r.Context(), meetingId, room)
	}
	c.registry.Touch(meetingId, userId)
	resp, err := c.adapter.GetMeetingState(r.Context(), sess.ParticipantToken, room.ExternalNo)
	if err != nil {
		// 上游说"这端不在会中/会已终"时，前端要的是离开会中页，不是一句系统异常。
		if isUpstreamGone(err) {
			if st, terminal := c.meetingTerminalStatus(r.Context(), meetingId, room); terminal {
				return nil, errs.BizReason(terminalMeetingError(st), "not_in_meeting")
			}
			return nil, errs.BizReason(errs.Bizf("请先加入会议"), "not_in_meeting")
		}
		return nil, err
	}
	room.StoreState(resp, userId)
	c.registry.BindPublicationIds(meetingId, resp.Publications)
	// 三方可能已自行结束会议（时长耗尽），这里顺手把终态回写本地。
	if err := c.meetingSvc.SyncUpstreamStatus(r.Context(), meetingId, resp.Meeting.Status); err != nil {
		glog.Warningf(r.Context(), "回写会议 %d 终态失败: %v", meetingId, err)
	}
	vo := service.BuildMeetingStateVo(meetingId, resp, room, c.roster(r.Context(), meetingId))
	return vo, nil
}

// isUpstreamGone 判断上游的失败是不是"这端已经不在这场会里 / 会已经开完"。
// 这类失败对前端是一个动作（离开会中页），不是故障，不能报系统异常。
func isUpstreamGone(err error) bool {
	msg := err.Error()
	for _, m := range []string{"participant_not_joined", "meeting_ended", "meeting_not_running", "meeting_not_found", "session_not_found"} {
		if strings.Contains(msg, m) {
			return true
		}
	}
	return false
}

// meetingTerminalStatus 找出这场会已知的终态：先看房间缓存，再看预约单。
// 两个来源都拿不到终态时返回 false —— 那时"取不到状态"就真是故障，不能编一句"会议已结束"。
func (c *Controller) meetingTerminalStatus(ctx context.Context, meetingId int64, room *session.MeetingRoom) (string, bool) {
	if room != nil {
		if st := room.State(); st != nil && service.IsTerminalStatus(st.Meeting.Status) {
			return st.Meeting.Status, true
		}
	}
	if session.IsManaged(meetingId) {
		if m, err := c.meetingSvc.GetDetail(ctx, meetingId); err == nil && service.IsTerminalStatus(m.Status) {
			return m.Status, true
		}
	}
	return "", false
}

// noMeetingError 把"取不到这场会的状态"说成前端能区分的话：终态就说终态，本端没在会中就说
// 请先加入会议，两边都拿不到事实（外部会议的键、库里没有预约单）才说"不存在或已结束"。
// room 为 nil 表示服务端已经没有这场会的房间（无人入会或后端重启过）。
// 这几类都带 reason=not_in_meeting：它们对前端是同一个动作 —— 离开会中页，而不是弹一句报错。
func (c *Controller) noMeetingError(ctx context.Context, meetingId int64, room *session.MeetingRoom) error {
	if st, terminal := c.meetingTerminalStatus(ctx, meetingId, room); terminal {
		return errs.BizReason(terminalMeetingError(st), "not_in_meeting")
	}
	if room != nil || session.IsManaged(meetingId) {
		return errs.BizReason(errs.Bizf("请先加入会议"), "not_in_meeting")
	}
	return errs.BizReason(errs.Bizf("会议不存在或已结束"), "not_in_meeting")
}

// terminalMeetingError 用三方的终态词选一句本域中文：ended/cancelled/failed 是同一件事的三种
// 结束方式，前端要能分清"会开完了"和"会被撤了"。
func terminalMeetingError(status string) error {
	switch status {
	case consts.MeetingStatusCancelled:
		return errs.Bizf("会议已取消")
	case consts.MeetingStatusFailed:
		return errs.Bizf("会议已异常结束")
	}
	return errs.Bizf("会议已结束")
}

// subscribeUserMessage 把订阅侧失败翻成一句本域中文。原始错误只进日志：那里头有上游地址、
// 协议名和运行时错误，用户看不懂也做不了任何事（第 10/34 项）。
//
// legKind 是这条腿的机器值（video/audio），用户文案里的感官词由它派生 —— 不拿显示词做判据，
// 那样一改措辞分支就静默失灵。音频腿共用"画面"那句是错的（实测两侧同屏）。
// everHadMedia 只回答一件事 —— **这位用户在这条腿上真的收到过媒体吗**。它改变的是
// "槽里没流"那一句的说法，因为那一个上游回答对应两件不同的事实。
func subscribeUserMessage(err error, legKind string, everHadMedia bool) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "participant_not_joined"):
		return "请先加入会议"
	case strings.Contains(msg, "meeting_ended"), strings.Contains(msg, "meeting_not_found"):
		return "会议已结束，这路媒体不再可用"
	case strings.Contains(msg, "deadline"), strings.Contains(msg, "timeout"), strings.Contains(msg, "connection refused"):
		return "媒体服务没有回应，正在重试"
	case slotHasNoStream(err):
		// 网关**认得**这条槽却回答"里面没流"：船端 RK 的接收进程没在把云端流灌进 `rkReceiverPath`。
		// 实测 2026-10-12 从本机免凭据直 POST 那条槽，回的是同一句 —— 与我方 SDP/令牌/取址无关。
		word := "画面"
		if legKind == consts.WhepKindAudio {
			word = "声音"
		}
		if !everHadMedia {
			// 这一路**从来没起来过**：实测两场会里三条这样的发布，在各自四套实例逐次回源的
			// 快照中 ready 均为 0 次（会 90 的 `pub…343` 是 0/1833，会 91 的 `…353/360/370` 是 0/135）。
			// 对这样的路说"已中断"是断言了一次根本没发生过的中断，还要人去"退出重进"——
			// 而那个动作能不能恢复，代码自己标着未重测（见 docs/adr/0094-be-rk-receiver-slot.md）。
			return "这路" + word + "一直没准备好"
		}
		// 确实从有画面掉下来的：说中断，但不承诺那个没验过的动作。
		// 重连是前端在做的实事（冷却后重挂），所以这句不撒谎。
		return "这一路" + word + "中断了，正在自动重连"
	}
	return "这路媒体没能订阅成功，正在重试"
}

// slotHasNoStream 判"槽认得、里面没流"这一类上游回答。
// 这个字面量在本域只此一处：`subscribeUserMessage` 的文案和订阅前的重试都按它判，
// 两边各写一遍必然分叉（一边改了重试就静默失效）。
func slotHasNoStream(err error) bool {
	return err != nil && strings.Contains(err.Error(), "no stream is available on path")
}

// thirdPartyUserMessage 把三方的机器码翻成用户能行动的一句话。
// 三方 reason 不外泄给前端（契约 §1：弹窗只透出我方 msg），原始错误只进日志。
// knownStatus 是我方已知的会议状态：三方只说"not running"，"还没开始"和"已经散会"对用户是
// 两句不同的话 —— 拿状态判，不要把预约会议说成"已结束"（第 38 项实测）。
func thirdPartyUserMessage(err error, fallback, knownStatus string) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "publication_has_no_media"):
		return "这条发布没有可推的媒体轨，请确认摄像头或麦克风已开启"
	case strings.Contains(msg, "bad_publication_video_spec"):
		return "会议服务不接受该视频规格，请在设置里调低分辨率或帧率后重试"
	case strings.Contains(msg, "participant_not_joined"):
		return "请先加入会议"
	case strings.Contains(msg, "meeting_ended"):
		return "会议已结束，无法推流"
	case strings.Contains(msg, "meeting_not_running"):
		return notRunningUserMessage(knownStatus)
	case strings.Contains(msg, "sdp"), strings.Contains(msg, "offer"):
		return "媒体协商被拒，请重试；仍失败时更换浏览器或检查到媒体服务的连通性"
	}
	return fallback
}

// notRunningUserMessage 用我方已知的状态把"这不在进行中"说准：未开始说未开始，
// 已终态说已结束，两边都不确定时只说"当前不在进行中"，不猜。
func notRunningUserMessage(status string) string {
	switch status {
	case consts.MeetingStatusScheduled:
		return "会议尚未开始，暂时无法推流"
	case consts.MeetingStatusStarting:
		return "会议正在启动，请稍候再试"
	case consts.MeetingStatusEnded, consts.MeetingStatusCancelled, consts.MeetingStatusFailed:
		return "会议已结束，无法推流"
	}
	return "这场会议当前不在进行中（可能还没开始或已经结束），暂时无法推流"
}

// knownMeetingStatus 取我方对这场会当前状态的了解：先看房间缓存（最后一次成功心跳/回源），
// 缓存还没建立时（刚重启、刚入会就点开关）回落预约单。两边都不知道才返回空串，
// 那时宁可说"当前不在进行中"，也不要猜一个方向给用户。
func (c *Controller) knownMeetingStatus(ctx context.Context, meetingId int64, room *session.MeetingRoom) string {
	if room != nil {
		if st := room.State(); st != nil && st.Meeting.Status != "" {
			return st.Meeting.Status
		}
	}
	if session.IsManaged(meetingId) {
		if m, err := c.meetingSvc.GetDetail(ctx, meetingId); err == nil {
			return m.Status
		}
	}
	return ""
}



// StreamWhep 代理 WHEP 协商：浏览器发 recvonly offer，后端从上游状态里取预授权 WHEP 地址转发。
// 上游地址与参会令牌都不进浏览器；RTP 由浏览器与媒体服务直连。
func (c *Controller) StreamWhep(r *ghttp.Request) {
	var req v1.StreamWhepReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.FailStream(r, http.StatusUnauthorized, "请先加入会议")
		return
	}
	sess, ok := c.registry.Session(req.Id, userId)
	if !ok {
		response.FailStream(r, http.StatusUnauthorized, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)
	alias, ok := room.ResolveStream(req.StreamId)
	if !ok {
		response.FailStream(r, http.StatusNotFound, "该流已结束")
		return
	}
	if alias.ParticipantId != "" && alias.ParticipantId == sess.ParticipantId && c.adapter.IsSinosatV1(r.Context()) {
		response.FailStream(r, http.StatusForbidden, "本端发布的视频和音频使用本地预览")
		return
	}
	c.focusPublication(r.Context(), room, sess, alias.PublicationId)
	state, source, gone := c.stateWithPublication(r.Context(), room, sess, alias.PublicationId)
	if gone {
		// 终态：回 410。前端把 404/410 判成"这路已经没了"（不重试、不挂红字），等下一轮 state 摘掉死流；
		// 回 503「还在准备中」等于让它每 1.5 秒再取一次一个已经不存在的会议，表现就是"起播失败"。
		response.FailStream(r, http.StatusGone, "这场会议已经结束，媒体不再可用")
		return
	}
	if state == nil {
		response.FailStream(r, http.StatusServiceUnavailable, "会议状态尚未就绪，请稍后重试")
		return
	}
	offer := r.GetBodyString()
	if offer == "" {
		response.FailStream(r, http.StatusBadRequest, "这路媒体的订阅请求没带上协商内容，正在重试")
		return
	}
	// 一条 PC 收什么，本来就在浏览器写好的 offer 里（m-line）；不再另开一个 kind 参数让两边各说一遍。
	wantVideo := offerWantsVideo(offer)
	legKind, kindLabel := consts.WhepKindAudio, "音频"
	if wantVideo {
		legKind, kindLabel = consts.WhepKindVideo, "视频"
	}
	var target string
	var pub thirdparty.Publication
	var found bool
	if wantVideo {
		target, pub, found = whepVideoChannel(state, alias.PublicationId)
	} else {
		target, pub, found = whepAudioChannel(state, alias.PublicationId)
	}
	if !found {
		glog.Warningf(r.Context(), "解析 WHEP %s失败 meeting=%d stream=%s publication=%s 来源=%s 可见发布=%s",
			kindLabel, req.Id, req.StreamId, alias.PublicationId, source, publicationSummary(state))
		response.FailStream(r, http.StatusServiceUnavailable, "这路媒体还在准备中，请稍后重试")
		return
	}
	if pub.PublicationId != "" && pub.PublicationId != alias.PublicationId {
		// 订阅的是兄弟别名（订到的那条还没 ready）：关注要跟着改报，不然上游会把在播的那条饿掉。
		c.focusPublication(r.Context(), room, sess, pub.PublicationId)
		glog.Infof(r.Context(), "改用就绪别名订阅%s meeting=%d stream=%s 订正=%s→%s",
			kindLabel, req.Id, req.StreamId, alias.PublicationId, pub.PublicationId)
	}
	if target == "" {
		// 上游到底给了哪些通道只进日志：那串里有 WHEP/板卡通道这些用户不认识也不该知道的东西，
		// 排查时看日志即可，弹窗要说的是本域中文（第 10/34 项）。
		hint := audioChannelsHint(pub)
		if wantVideo {
			hint = videoChannelsHint(pub)
		}
		glog.Warningf(r.Context(), "该%s发布没有可接收通道 meeting=%d stream=%s：%s", kindLabel, req.Id, req.StreamId, hint)
		response.FailStream(r, http.StatusNotImplemented, "这路"+kindLabel+"暂时收不到，对端可能只开了画面")
		return
	}
	prev, hadPrev := room.WhepFor(userId, req.StreamId, legKind)
	// 局域网那条视频腿的槽要船端 RK 的接收进程来灌。实测 2026-10-12（本机两实例复现，
	// 与船端现场同一形态）：三方对 `browser_whip` 发布的 prepare{role:"consumer"} 回
	// 404 `publication_not_found` —— 这个口子在船端网关上**不认这条发布**，所以它不是可用的开关。
	// 于是只在"上游说槽里没流"时叫一次：给不出流也要把三方自己给的原因落到日志，
	// 那才是能交给三方的证据（订阅前无条件叫一次，等于给每条正常订阅白加一次失败往返）。
	lanVideoLeg := wantVideo && service.VideoLegChannel(pub) == consts.VideoChannelLanWhep
	whepBearer := ""
	if c.adapter.IsSinosatV1(r.Context()) {
		whepBearer = sess.ParticipantToken
	}
	answer, location, err := c.adapter.PostSdpAuth(r.Context(), target, offer, whepBearer)
	if err != nil && lanVideoLeg && slotHasNoStream(err) &&
		c.armRkReceiver(r.Context(), sess.ParticipantToken, pub.PublicationId, rkArmBudgetRetry) {
		// 三方哪天认了这个口子，这里就自动变成一次真恢复：起来了就重试**恰好一次**
		// （不在这里循环 —— 循环的活交给前端那套 ~12 秒重挂，它每轮会重新走到这条路径）。
		answer, location, err = c.adapter.PostSdpAuth(r.Context(), target, offer, whepBearer)
	}
	if err != nil {
		// 带上腿别与地址形状：船端那条腿有两种写法（网关给的路径槽 / 直接给的地址），
		// 不记这两样就说不清"订的是哪条 lane"，也就对不上三方那边该看哪条接收进程。
		glog.Warningf(r.Context(), "订阅失败 meeting=%d stream=%s 腿=%s 地址=%s 可见发布=%s: %v",
			req.Id, req.StreamId, legKind, thirdparty.LoggableTarget(target), publicationSummary(state), err)
		response.FailStream(r, http.StatusBadGateway, subscribeUserMessage(err, legKind, hadPrev))
		return
	}
	if location == "" {
		// 三方没回 Location 就沿用上一轮的会话 URI，否则释放凭据会被空值覆盖掉。
		location = prev.SessionURL
	}
	room.BindWhep(session.WhepTarget{
		UserId:     userId,
		StreamId:   req.StreamId,
		Kind:       legKind,
		OfferURL:   target,
		SessionURL: location,
		AuthBearer: whepBearer,
	})
	// 换流/重连会在三方留下上一条订阅，三方不自己收：当场拆掉，否则一路挂一路。
	if hadPrev && prev.SessionURL != "" && prev.SessionURL != location {
		c.releaseWhepTarget(r, prev)
	}
	r.Response.Header().Set("Content-Type", "application/sdp")
	r.Response.Header().Set("Cache-Control", "no-store")
	r.Response.Write(answer)
}

// StreamFrameTimes 代理船端局域网接收槽的**帧时刻表**，统计条「采集时间」那一格只有它有。
// 只有 lanWhep 那条腿需要它：直连腿的采集时刻就在容器帧头里，浏览器自己拿得到，不必多一跳。
// 响应**原样透传**、不在本仓解析（理由见 adapter.GetLocalTelemetry：Unix 纳秒会毁在 float 上）。
func (c *Controller) StreamFrameTimes(r *ghttp.Request) {
	var req v1.StreamFrameTimesReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.FailStream(r, http.StatusUnauthorized, "请先加入会议")
		return
	}
	sess, ok := c.registry.Session(req.Id, userId)
	if !ok {
		response.FailStream(r, http.StatusUnauthorized, "请先加入会议")
		return
	}
	c.registry.Touch(req.Id, userId)
	alias, ok := room.ResolveStream(req.StreamId)
	if !ok {
		response.FailStream(r, http.StatusNotFound, "该流已结束")
		return
	}
	state, _, gone := c.stateWithPublication(r.Context(), room, sess, alias.PublicationId)
	if gone {
		// 与订阅那条一致：404/410 前端判成终态（不重试），回 503 等于让它反复取一个已经不存在的会。
		response.FailStream(r, http.StatusGone, "这场会议已经结束，媒体不再可用")
		return
	}
	if state == nil {
		response.FailStream(r, http.StatusServiceUnavailable, "会议状态尚未就绪，请稍后重试")
		return
	}
	pub, found := findPublication(state, alias.PublicationId)
	// 判据与选腿那条（VideoLegChannel）同源，不另立一套：三件套齐了才算有这条腿。
	// 槽号越界说明三方还没给这条发布分配接收槽 —— 回 404 让界面留「统计中」，
	// 绝不猜一个 lane=1 去查：那会查到别人的槽，报出一个看着合理的假采集时刻。
	if !found || service.DeploymentSide != "edge" || pub.RkDeliveryMode != "raw_hevc_forward" ||
		pub.RkReceiverLaneId < 1 || pub.RkReceiverLaneId > 32 {
		glog.Infof(r.Context(), "这路没有可查的局域网接收槽 meeting=%d stream=%s 侧=%s 模式=%s 槽=%d",
			req.Id, req.StreamId, service.DeploymentSide, pub.RkDeliveryMode, pub.RkReceiverLaneId)
		response.FailStream(r, http.StatusNotFound, "这一路的采集时刻暂时查不到")
		return
	}
	body, err := c.adapter.GetLocalTelemetry(r.Context(),
		fmt.Sprintf("/api/local/frame-times?lane=%d", pub.RkReceiverLaneId))
	if err != nil {
		// 槽里没流时上游回 404，那是事实不是故障：界面同样留「统计中」，只是把原因落到日志。
		glog.Warningf(r.Context(), "查帧时刻失败 meeting=%d stream=%s lane=%d: %v",
			req.Id, req.StreamId, pub.RkReceiverLaneId, err)
		response.FailStream(r, http.StatusBadGateway, "这一路的采集时刻暂时查不到")
		return
	}
	// 包进我方信封：前端所有请求都过 `request.ts` 的拦截器，裸透传 `{ok:true,…}` 会被判成"系统异常"。
	// 用 json.RawMessage 而不是解析成 struct —— 表里的采集时刻是 Unix **纳秒**、源钟标识是 64 位整数，
	// 过一遍 Go 的 float 就改掉末几位；原样嵌入，让浏览器自己去解释那个字面量。
	response.OkWithData(r, json.RawMessage(body), "ok")
}

// StreamWhepDelete 释放本端对这一路流的全部 WHEP 订阅会话。
// 请求里没有腿别（音视频两条腿在三方侧是两个会话，各自按 (用户, 流, 腿) 记账），
// 而调用方说的是"这路我不要了" —— 那就把这路的每条腿都拆掉，留一条就是漏。
// 浏览器侧目前不调这里 —— 见契约 ADR-0057（三方是否自行回收订阅会话从未实测，WHIP 的实测值指向"会"）。
func (c *Controller) StreamWhepDelete(r *ghttp.Request) {
	var req v1.StreamWhepDeleteReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	room, ok := c.registry.Room(req.Id)
	if !ok {
		response.OkWithMessage(r, "已停止订阅")
		return
	}
	c.registry.Touch(req.Id, userId)
	c.releaseWhepSessions(r, room.TakeWhepsForStream(userId, req.StreamId))
	response.OkWithMessage(r, "已停止订阅")
}

// releaseWhepTarget 向三方 DELETE 一条 WHEP 会话；失败只进日志——
// 订阅方已经不等它了，把拆流失败回给用户只会让离会/换流卡住。
func (c *Controller) releaseWhepTarget(r *ghttp.Request, t session.WhepTarget) {
	if err := c.adapter.DeleteSessionAuth(r.Context(), t.SessionURL, t.AuthBearer); err != nil {
		glog.Warningf(r.Context(), "whep delete user %d stream %s failed: %v", t.UserId, t.StreamId, err)
	}
}

// releaseWhepSessions 拆掉若干 WHEP 会话（离会/回收路径用）。
func (c *Controller) releaseWhepSessions(r *ghttp.Request, targets []session.WhepTarget) {
	for _, t := range targets {
		if t.SessionURL == "" {
			continue
		}
		c.releaseWhepTarget(r, t)
	}
}

// whepAudioChannel 取这条发布可订阅的云端 WHEP 音频地址，并带回发布本身
// —— 报错时要用它说清上游到底给了哪些通道。
// 不优先 rkReceiverAudioWhepUrl：那是船端同局域网通道（三方文档 §10.2），**云端实例**的浏览器连不通它
// （协商能回 200、ICE 永不可达，症状是"连上了听不到对方声音"）。边端实例的消费者在船内网，
// 那条腿是可达的 —— 所以可达性判据按 deployment.side 走，视频腿就是这么开的（见 service.VideoLegChannel）。
func whepAudioChannel(state *thirdparty.MeetingResponse, publicationId string) (string, thirdparty.Publication, bool) {
	req, ok := findPublication(state, publicationId)
	if !ok {
		return "", thirdparty.Publication{}, false
	}
	// 同一路音频也可能挂着新旧两个别名，ready 的那个才有能用的 WHEP 通道。
	for _, p := range subscribableAliases(state, publicationId) {
		if p.AudioWhepUrl != "" {
			return p.AudioWhepUrl, p, true
		}
	}
	// 上游没给通用音频 WHEP 时，船端还有一条**船内局域网**音频车道（三方船端客户端走的就是它）。
	// 只在边端实例上开：那条地址属船内网段，岸端签出去只会换出一个永远不亮的等待。
	// 这条分支的意义不只是"能听到声音"——它把音频从直连流换成浏览器 PC，播放时刻才有得量，
	// 音画差那一格才可能出数（见 lanWhepAudioURL 的注释）。
	if service.DeploymentSide == "edge" {
		for _, p := range subscribableAliases(state, publicationId) {
			if u := lanWhepAudioURL(p); u != "" {
				return u, p, true
			}
		}
	}
	return "", req, true
}

// whepVideoChannel 取这条发布可订阅的**视频** WHEP 地址。上游给的视频 WHEP 只有船端局域网那一条腿，
// 所以它等于"本实例能不能接这路视频"的判据：云端实例一律回空（岸端浏览器 ICE 不到船内网）。
func whepVideoChannel(state *thirdparty.MeetingResponse, publicationId string) (string, thirdparty.Publication, bool) {
	req, ok := findPublication(state, publicationId)
	if !ok {
		return "", thirdparty.Publication{}, false
	}
	for _, p := range subscribableAliases(state, publicationId) {
		switch service.VideoLegChannel(p) {
		case consts.VideoChannelCloudWhep:
			if p.CloudWhepUrl != "" {
				return p.CloudWhepUrl, p, true
			}
		case consts.VideoChannelLanWhep:
			return lanWhepURL(p), p, true
		}
	}
	return "", req, true
}

// lanWhepURL 按三方船端客户端自己的取序拼这条腿的地址：优先用 `rkReceiverPath` 拼网关的
// 局域网 WHEP 入口，其次才用它直接给的 `rkReceiverWhepUrl`。
//
// 更正（实测 2026-10-12）：此前这里写着"`rkReceiverWhepUrl` 订出去回 404，因为那是网关回填的
// 本机 RK **输入**槽名、不是这路发布的接收槽"—— 那个结论是**误判**。日志里 `lane=1 → path=conference/cam1`、
// `lane=2 → path=conference/cam2` 逐参会者对应，且这些发布全是 `src=browser_whip`（不是 RK 摄像头），
// 所以 `conference/camN` 就是**这条发布自己的接收槽**；两个字段指向的是同一个槽，只是两种写法。
// 那次"改取序"因此没治到病根（症状随后复发就是证据），真正的成因是槽里没有流 —— 见 `armRkReceiver`。
// 取序本身仍然照三方保留：与它的客户端逐字一致，少一处差异少一处可错。
func lanWhepURL(pub thirdparty.Publication) string {
	if p := strings.Trim(pub.RkReceiverPath, "/"); p != "" {
		return "/__ship_lan_whep/" + p + "/whep"
	}
	return pub.RkReceiverWhepUrl
}

// lanWhepAudioURL 拼船内那条**音频**局域网 WHEP 地址。
//
// 为什么要有：三方的船端客户端收音频也走浏览器 PC（`audioReceiver.samplePlayoutTiming("audio")`），
// 它的地址是 `/__ship_lan_whep/{rkReceiverPath}_audio/whep`（路径多一个 `_audio` 后缀，实测自其客户端）。
// 我方此前 `whepAudioChannel` 只认上游给的 `audioWhepUrl`，船端那条就永远拼不出来 —— 于是音频只能
// 退到直连流，而直连腿没有 RTCPeerConnection，**播放时刻结构上取不到**，音画差在边端页永远算不出来
// （同会对照：三方那一格有 `播放音画差 +38 ms · 轨道交付`，我方是 `—`）。
//
// 取序与视频那条 `lanWhepURL` **逐字一致：先按路径拼、再用上游给的显式地址**。
// 这个顺序不是随手写的：拼出来的地址是相对路径，由 `resolveTarget` 接到本实例配置的船端网关
// baseUrl 上；而 `rkReceiverAudioWhepUrl` 可能是网关回填的**绝对**地址（指向船内某个 host），
// 从岸端或本机发出去只能得到传输层失败（实测表现是 `upstream_unreachable`，不是 404）。
func lanWhepAudioURL(pub thirdparty.Publication) string {
	if p := strings.Trim(pub.RkReceiverPath, "/"); p != "" {
		return "/__ship_lan_whep/" + p + "_audio/whep"
	}
	return pub.RkReceiverAudioWhepUrl
}

// 武装接收槽的预算：只在"上游说槽里没流"这一条分支上用（订阅前不叫，见 StreamWhep 那段注释）。
const (
	rkArmBudgetRetry = 4 * time.Second
	rkArmPollEvery   = 200 * time.Millisecond // 契约 §10.1 给的轮询间隔是 150–200ms
	// 发布侧武装卡在"创建发布"这个 HTTP 请求里，前端那条 axios 是 10 秒超时，
	// 所以给它比消费侧更紧的预算：够 12 轮，又不至于把整个请求逼近上限。
	rkArmBudgetPublish = 2500 * time.Millisecond
)

// armRkReceiver 叫三方把这条发布在船端 RK 上的接收进程起来（§10.1 `prepare{role:"consumer"}`），
// 轮询到 `receiverReady` 为止，最多 `budget`。局域网那条视频腿的槽本该由它灌满。
//
// 实测边界（2026-10-12，本机两实例 + 船端现场同形）：**三方对 browser_whip 的发布回
// 404 `publication_not_found`** —— 这个口子目前不认这类发布，所以它现在只是"把三方自己的
// 原因落到日志"的诊断动作，不是恢复手段。三方客户端自己的消费侧也没有任何武装调用
// （它全部 API 面只有 heartbeat/focus/WHEP），所以这不是"我们少调了一步"。
//
// 两条别在下次改动里抹掉的边界：
//   - **等不到/被拒也照样往下订，不把它当硬前置**：否则三方哪天改了行为，我方先挂。
//   - **不等参考实现那 90 秒**：这条链路是浏览器发起的 HTTP，长等会撞前端超时。
//
// 回 true 只表示"三方说就绪了"，用于决定值不值得再试一次；原因一律进日志。
func (c *Controller) armRkReceiver(ctx context.Context, token, publicationId string, budget time.Duration) bool {
	deadline := time.Now().Add(budget)
	var lastReason string
	for {
		res, err := c.adapter.PreparePublication(ctx, token, publicationId, thirdparty.PrepareRoleConsumer)
		if err != nil {
			// 非 2xx = 三方明确说"这条 lane 起不来"（404 + §17 的 reason）。继续轮只是空烧，
			// 记下原因收手，让调用方照订一次 —— 订出来的结果才是真判据。
			reason := ""
			if res != nil {
				reason = res.WhyNotReady()
			}
			glog.Warningf(ctx, "武装接收槽 publication=%s 三方拒绝 reason=%s: %v", publicationId, reason, err)
			return false
		}
		if res.ReceiverReady {
			glog.Infof(ctx, "武装接收槽就绪 publication=%s consumerAttached=%v", publicationId, res.ConsumerAttached)
			return true
		}
		lastReason = res.WhyNotReady()
		if !time.Now().Before(deadline) {
			glog.Warningf(ctx, "武装接收槽未就绪 publication=%s 已等=%s 最后原因=%s", publicationId, budget, lastReason)
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(rkArmPollEvery):
		}
	}
}

// offerWantsVideo 判这条 PC 的 offer 要不要收视频。m-line 是浏览器自己写的，拿它当唯一真源，
// 比再开一个 kind 参数可靠 —— 两边说得不一样时，实际会协商的是 offer 那一侧。
func offerWantsVideo(offer string) bool {
	return strings.Contains(offer, "m=video")
}

// parsePublication 兼容三方回包的两个位置：实测 `whipUrl` 在**顶层**，
// 而 `publication` 对象里那个同名字段是空串；不能因为拿到了嵌套 publicationId 就提前返回。
func parsePublication(raw []byte) (publicationId, whipURL string) {
	var envelope struct {
		Publication struct {
			PublicationId string `json:"publicationId"`
			WhipUrl       string `json:"whipUrl"`
		} `json:"publication"`
		PublicationId string `json:"publicationId"`
		WhipUrl       string `json:"whipUrl"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return "", ""
	}
	if envelope.Publication.PublicationId != "" {
		publicationId = envelope.Publication.PublicationId
	} else {
		publicationId = envelope.PublicationId
	}
	whipURL = envelope.WhipUrl
	if whipURL == "" {
		whipURL = envelope.Publication.WhipUrl
	}
	return publicationId, whipURL
}

