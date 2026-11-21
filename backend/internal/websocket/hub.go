package websocket

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"sync"
	"time"

	"github.com/gogf/gf/v2/net/ghttp"
	"github.com/gogf/gf/v2/os/glog"
	"github.com/gogf/gf/v2/os/gtime"

	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/model"
	"cloud-conference-backend/internal/service"
	"cloud-conference-backend/internal/service/thirdparty"
	"cloud-conference-backend/internal/session"
)

type WsEvent struct {
	Type string      `json:"type"`
	Data interface{} `json:"data"`
}

// Hub 把三方轮询式状态桥接成我方 WebSocket 事件。
// 令牌只从 session.Registry 取，握手用一次性 ws-ticket（浏览器 WS 不能带请求头）。
type Hub struct {
	mu       sync.Mutex
	adapter  *thirdparty.Adapter
	registry *session.Registry
	rooms    map[int64]*Room
}

var DefaultHub = &Hub{rooms: make(map[int64]*Room)}

func (h *Hub) Init(adapter *thirdparty.Adapter, registry *session.Registry) {
	h.adapter = adapter
	h.registry = registry
}

type Room struct {
	meetingId int64
	hub       *Hub
	adapter   *thirdparty.Adapter
	registry  *session.Registry
	clients   map[*ghttp.WebSocket]int64 // ws → userId
	clientsMu sync.Mutex
	lastState *thirdparty.MeetingResponse
	// lastRosterFrame 是上一次真正发给前端的名单帧，用来判"这次要不要再发一遍"。
	lastRosterFrame map[string]interface{}
	lastMessageId   int64
	cancel          context.CancelFunc
	// terminalAnnounced 保证"这场会已经没了"只广播一次：状态变更本来就会由 applyState 发，
	// 会话被剔除时的补发只在那个变更没发生过的场景才需要。
	terminalAnnounced bool
	// roster 只由单一 poll 协程读写，无需加锁；受邀名单建会后不变，头像中途改动等重连即可。
	roster *service.Roster
}

// rosterSnapshot 懒加载本域补充信息（受邀名单 + 账号头像）。
func (room *Room) rosterSnapshot() *service.Roster {
	if room.roster != nil {
		return room.roster
	}
	ctx := context.Background()
	invitees, err := service.LoadInvitees(ctx, room.meetingId)
	if err != nil {
		invitees = nil
	}
	room.roster = &service.Roster{Invitees: invitees, Avatars: service.LoadAvatarByAccount(ctx)}
	return room.roster
}

func (h *Hub) Serve(r *ghttp.Request) {
	ctx := r.Context()
	// 只校验参数在不在，不能用 Int64()==0 当"没传"：外部会议的会话键本身就是负数，
	// 而 0 也是合法键位（既没传也解得出 0 时由下面的票据比对兜住）。
	meetingIdArg := r.GetQuery("meetingId")
	ticket := r.GetQuery("ticket").String()
	if meetingIdArg.IsNil() || meetingIdArg.String() == "" || ticket == "" {
		r.Response.WriteStatus(400, "meetingId 与 ticket 必填")
		return
	}
	meetingId := meetingIdArg.Int64()
	userId, roomMeetingId, ok := h.registry.RedeemWsTicket(ctx, ticket)
	if !ok || roomMeetingId != meetingId {
		r.Response.WriteStatus(401, "连接票无效或已过期，请重新入会")
		return
	}
	if _, exists := h.registry.Session(meetingId, userId); !exists {
		r.Response.WriteStatus(403, "请先加入会议")
		return
	}

	ws, err := r.WebSocket()
	if err != nil {
		glog.Errorf(ctx, "websocket upgrade failed: %v", err)
		return
	}

	room := h.ensureRoom(meetingId)
	room.clientsMu.Lock()
	room.clients[ws] = userId
	room.clientsMu.Unlock()

	room.readPump(ws, userId)

	room.clientsMu.Lock()
	delete(room.clients, ws)
	empty := len(room.clients) == 0
	room.clientsMu.Unlock()
	if empty {
		h.stopRoomIfEmpty(meetingId)
	}
	ws.Close()
}

func (h *Hub) ensureRoom(meetingId int64) *Room {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room, ok := h.rooms[meetingId]; ok {
		return room
	}
	room := &Room{
		meetingId: meetingId,
		hub:       h,
		adapter:   h.adapter,
		registry:  h.registry,
		clients:   make(map[*ghttp.WebSocket]int64),
	}
	ctx, cancel := context.WithCancel(context.Background())
	room.cancel = cancel
	h.rooms[meetingId] = room
	go room.poll(ctx)
	return room
}

// EnsureRoom 保证该会议的轮询协程在跑。入会成功即需调用 —— 心跳续期不能等浏览器再来连 WS，
// 否则只有 REST 会话时协程根本不存在，参会令牌会在约 80 秒后静默过期。
func (h *Hub) EnsureRoom(meetingId int64) {
	h.ensureRoom(meetingId)
}

func (h *Hub) stopRoomIfEmpty(meetingId int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room, ok := h.rooms[meetingId]
	if !ok {
		return
	}
	room.clientsMu.Lock()
	noClients := len(room.clients) == 0
	room.clientsMu.Unlock()
	if noClients && len(h.registry.SessionsSnapshot(meetingId)) == 0 {
		room.cancel()
		delete(h.rooms, meetingId)
	}
}

// retireRoom 停掉并摘掉这场会的心跳轮询。会话全没了却还挂着 WS 客户端时 stopRoomIfEmpty
// 永远不会触发，轮询协程就每秒空转一次并把 rooms 占死。
func (h *Hub) retireRoom(meetingId int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room, ok := h.rooms[meetingId]
	if !ok {
		return
	}
	room.cancel()
	delete(h.rooms, meetingId)
}

// poll 每秒为**该会议每一个在会会话**各发一次三方心跳（三方 heartbeat 即状态拉取兼令牌续期），
// 拿到全量状态后 diff 广播。
//
// 早先只挑"第一个 WS 客户端"当 master 代发，实测后果是：那个客户端一掉线（或根本没人连 WS、
// 只有 REST 会话），心跳就整轮停发，其余参会者的令牌不再续期，约 80 秒后被上游判
// participant_not_joined 静默踢出会议。令牌续期是每会话各自的责任，不能共享一个代理。
func (room *Room) poll(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			room.heartbeatAll(ctx)
		}
	}
}

// sessionIdleGrace 是"没有任何活动证据"的会话还能被续期多久。
// 浏览器关标签页不会调 /leave（前端没有 unload 处理），若一味替它续期，
// 幽灵成员会永久滞留在会议里 —— 到点就替它离开。
const sessionIdleGrace = 30 * time.Second

// heartbeatAll 逐个会话续期。返回 true 表示至少有一次心跳成功、状态已刷新。
func (room *Room) heartbeatAll(ctx context.Context) {
	sessions := room.registry.SessionsSnapshot(room.meetingId)
	var aliveToken string
	now := time.Now()
	reclaimed := 0
	for _, s := range sessions {
		if now.Sub(s.LastSeen) > sessionIdleGrace && !room.hasClientFor(s.UserId) {
			glog.Infof(ctx, "meeting %d user %d 静默超过 %s 且无 WS 连接，替其离开会议（回收幽灵会话）",
				room.meetingId, s.UserId, sessionIdleGrace)
			// 回收前拆掉该端仍活跃的发布：否则幽灵的 screen 发布会永久占住共享位。
			room.stopPublications(ctx, s)
			room.releaseWhepSessions(ctx, s.UserId)
			if err := room.adapter.LeaveMeeting(ctx, s.ParticipantToken); err != nil {
				glog.Warningf(ctx, "回收会话时离开三方失败 user %d: %v", s.UserId, err)
			}
			room.registry.Leave(room.meetingId, s.UserId)
			reclaimed++
			continue
		}
		media, ok := room.registry.NextMediaState(room.meetingId, s.UserId)
		if !ok {
			continue
		}
		resp, err := room.adapter.Heartbeat(ctx, s.ParticipantToken, &media)
		if err != nil {
			if isNotJoined(err) {
				glog.Warningf(ctx, "meeting %d user %d 已被上游判定不在会中，剔除本地会话: %v", room.meetingId, s.UserId, err)
				room.releaseWhepSessions(ctx, s.UserId)
				room.registry.Leave(room.meetingId, s.UserId)
				reclaimed++
			} else {
				glog.Warningf(ctx, "heartbeat meeting %d user %d failed: %v", room.meetingId, s.UserId, err)
			}
			continue
		}
		aliveToken = s.ParticipantToken
		room.applyState(resp, s.UserId)
	}
	if aliveToken != "" {
		room.pollMessages(ctx, aliveToken)
	}
	// 会话全没了就收掉轮询：心跳、聊天轮询都要参会令牌，没会话时它只是每秒空转，
	// 而且客户端还挂着 WS 的话 stopRoomIfEmpty 永远不会触发。
	if len(room.registry.SessionsSnapshot(room.meetingId)) == 0 {
		// 被上游判死/被判幽灵回收的会话不会自己通知前端，这里补发一次终态，
		// 否则页面拿着 sessionStorage 里的 meetingId 永远停在会中。
		// 主动 /leave 不在此列：那场会可能还在开，对它说"已结束"是撒谎。
		if reclaimed > 0 {
			room.announceMeetingEnded(ctx)
		}
		room.hub.retireRoom(room.meetingId)
	}
}

// announceMeetingEnded 广播一次终态 meeting 事件，形状与既有事件完全一致（MeetingStateVo）。
// 终态词取最后一次成功心跳里的上游状态；一次都没拿到过就按 ended 说（不编造 cancelled）。
func (room *Room) announceMeetingEnded(ctx context.Context) {
	if room.terminalAnnounced {
		return
	}
	room.terminalAnnounced = true

	status := consts.MeetingStatusEnded
	if room.lastState != nil && service.IsTerminalStatus(room.lastState.Meeting.Status) {
		status = room.lastState.Meeting.Status
	}
	var vo *model.MeetingStateVo
	if room.lastState != nil {
		roomState, _ := room.registry.Room(room.meetingId)
		vo = service.BuildMeetingStateVo(room.meetingId, room.lastState, roomState, room.rosterSnapshot())
	}
	if vo == nil {
		vo = &model.MeetingStateVo{
			MeetingId:    room.meetingId,
			Participants: make([]model.ParticipantVo, 0),
			Invited:      make([]model.InvitedVo, 0),
			Streams:      make([]model.StreamVo, 0),
		}
	}
	vo.Status = status
	glog.Infof(ctx, "meeting %d 会话已全部失效，向在连客户端广播终态 %s", room.meetingId, status)
	room.broadcast(WsEvent{Type: "meeting", Data: vo})
}

// releaseWhepSessions 拆掉该用户在本场会留下的 WHEP 订阅。
// 失败只进日志：会话都已经判死了，没有可操作的动作留给用户。
func (room *Room) releaseWhepSessions(ctx context.Context, userId int64) {
	roomState, ok := room.registry.Room(room.meetingId)
	if !ok {
		return
	}
	for _, t := range roomState.TakeWhepForUser(userId) {
		if t.SessionURL == "" {
			continue
		}
		if err := room.adapter.DeleteSession(ctx, t.SessionURL); err != nil {
			glog.Warningf(ctx, "回收订阅 stream %s 失败: %v", t.StreamId, err)
		}
	}
}

// hasClientFor 判断该用户是否还挂着活的 WS 连接。
func (room *Room) hasClientFor(userId int64) bool {
	room.clientsMu.Lock()
	defer room.clientsMu.Unlock()
	for _, uid := range room.clients {
		if uid == userId {
			return true
		}
	}
	return false
}

// isNotJoined 判定上游是否已不认这个参会令牌（该会话应当就地作废）。
// stopPublications 拆掉某会话仍活跃的全部发布（离会/回收前调用）。
func (room *Room) stopPublications(ctx context.Context, s *session.Session) {
	roomState, ok := room.registry.Room(room.meetingId)
	if !ok {
		return
	}
	state := roomState.State()
	if state == nil {
		return
	}
	for _, pub := range state.Publications {
		if pub.ParticipantId != s.ParticipantId || pub.Status == "stopped" || pub.Status == "failed" {
			continue
		}
		if _, err := room.adapter.StopPublication(ctx, s.ParticipantToken, pub.PublicationId); err != nil {
			glog.Warningf(ctx, "回收发布 %s 失败: %v", pub.PublicationId, err)
		}
		roomState.UnbindWhip(pub.PublicationId)
	}
}

func isNotJoined(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "participant_not_joined") || strings.Contains(msg, " 401")
}

func (room *Room) applyState(resp *thirdparty.MeetingResponse, byUserId int64) {
	prev := room.lastState
	room.lastState = resp
	room.registry.BindPublicationIds(room.meetingId, resp.Publications)

	roomState, _ := room.registry.Room(room.meetingId)
	// heartbeat 是用该会话自己的令牌拉的，响应里的订阅地址带着这个人的票据 ——
	// 落进按用户分键的缓存，订阅路径才能读到"新发布"，不必每次回源整份 /state
	// （船端那个端点实测 99–150 秒，订阅热路径上回源等于每次白等 10 秒）。
	if roomState != nil {
		roomState.StoreState(resp, byUserId)
	}
	states := service.BuildMeetingStateVo(room.meetingId, resp, roomState, room.rosterSnapshot())
	// 名单帧要按**我方发出去的那份**比，不能按上游的意图位比。
	// 徽标（看得见/听得到）是按真实发布算的，而上游的 cameraEnabled/microphoneEnabled
	// 是客户端自报意图 —— 一个人入会时就把意图位报成"开"、随后才真正 WHIP 发布，
	// 意图位前后没变过，于是原先的 diffParticipants 判定"没变化"，
	// 一帧 participants 都不发：前端那一格能收到 streams 把画面播出来，
	// 徽标却永远停在入会那一刻的"摄像头已关"（实测 2026-09-28 会议 85）。
	payload := map[string]interface{}{
		"participants": states.Participants,
		"invited":      states.Invited,
	}
	if room.lastRosterFrame == nil || !reflect.DeepEqual(room.lastRosterFrame, payload) {
		room.lastRosterFrame = payload
		room.broadcast(WsEvent{Type: "participants", Data: payload})
	}
	if prev == nil || prev.Meeting.Status != resp.Meeting.Status ||
		prev.Meeting.HostParticipantId != resp.Meeting.HostParticipantId ||
		prev.Meeting.ParticipantCount != resp.Meeting.ParticipantCount ||
		prev.Meeting.StartedAtMs() != resp.Meeting.StartedAtMs() {
		if service.IsTerminalStatus(resp.Meeting.Status) {
			// 上游已经把终态报出来了，这次广播就是前端要的那次，后面不再补发。
			room.terminalAnnounced = true
		}
		room.broadcast(WsEvent{Type: "meeting", Data: states})
	}
	if prev == nil || diffPublications(prev.Publications, resp.Publications) {
		room.broadcast(WsEvent{Type: "streams", Data: states.Streams})
	}
	room.broadcast(WsEvent{Type: "time", Data: map[string]interface{}{
		"serverTime":   resp.ServerUnixMs,
		"clockDriftMs": resp.ServerClockUncertaintyMs,
	}})
}

func (room *Room) pollMessages(ctx context.Context, token string) {
	msgs, lastId, err := room.adapter.ListMessages(ctx, token, int(room.lastMessageId), 100)
	if err != nil {
		return
	}
	if lastId > room.lastMessageId {
		room.lastMessageId = lastId
	}
	for _, m := range msgs {
		if m.Id > room.lastMessageId {
			room.lastMessageId = m.Id
		}
		ts := m.SentAtMs
		if ts == 0 {
			ts = m.SentAt * 1000
		}
		room.broadcast(WsEvent{Type: "chat", Data: map[string]interface{}{
			"id":             m.Id,
			"text":           m.Text,
			"senderName":     m.SenderName,
			"senderNodeType": service.NodeTypeOf(m.SenderEndpointType),
			"sentAt":         gtime.NewFromTimeStamp(ts / 1000).Format("Y-m-d\\TH:i:sP"),
		}})
	}
}

func diffPublications(prev, cur []thirdparty.Publication) bool {
	if len(prev) != len(cur) {
		return true
	}
	for i := range prev {
		a, b := prev[i], cur[i]
		if a.TransportMode != "" && (a.Revision != b.Revision || a.TransportMode != b.TransportMode ||
			a.EncodingStrategy != b.EncodingStrategy || a.DirectVideoCodec != b.DirectVideoCodec ||
			a.SourceBitrateKbps() != b.SourceBitrateKbps() || a.UpstreamBitrateKbps() != b.UpstreamBitrateKbps()) {
			return true
		}
		if a.PublicationId != b.PublicationId || a.Status != b.Status ||
			a.DirectVideoUrl != b.DirectVideoUrl || a.DirectAudioUrl != b.DirectAudioUrl ||
			a.AudioWhepUrl != b.AudioWhepUrl || a.RkReceiverWhepUrl != b.RkReceiverWhepUrl ||
			len(a.FocusedBy) != len(b.FocusedBy) {
			return true
		}
	}
	return false
}

func (room *Room) broadcast(evt WsEvent) {
	room.send(nil, evt)
}

func (room *Room) send(except *ghttp.WebSocket, evt WsEvent) {
	payload, err := json.Marshal(evt)
	if err != nil {
		return
	}
	room.clientsMu.Lock()
	defer room.clientsMu.Unlock()
	for ws := range room.clients {
		if ws == except {
			continue
		}
		_ = ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if err := ws.WriteMessage(1, payload); err != nil {
			glog.Warningf(context.Background(), "ws write failed: %v", err)
		}
	}
}

func (room *Room) readPump(ws *ghttp.WebSocket, userId int64) {
	ctx := context.Background()
	for {
		_, data, err := ws.ReadMessage()
		if err != nil {
			return
		}
		var evt WsEvent
		if err := json.Unmarshal(data, &evt); err != nil {
			continue
		}
		sess, ok := room.registry.Session(room.meetingId, userId)
		if !ok {
			continue
		}
		room.registry.Touch(room.meetingId, userId)
		switch evt.Type {
		case "media":
			// 入站按**本域词形**解析（cameraOn/micOn/sharing/recording，见契约 7 节）。
			// 早先这里直接反序列化三方 MediaState（词形是 cameraEnabled/…），
			// 前端发的字段一个都对不上，媒体意图位恒为 false。
			var intent struct {
				CameraOn  *bool `json:"cameraOn"`
				MicOn     *bool `json:"micOn"`
				Sharing   *bool `json:"sharing"`
				Recording *bool `json:"recording"`
			}
			if b, _ := json.Marshal(evt.Data); json.Unmarshal(b, &intent) != nil {
				continue
			}
			media, ok := room.registry.UpdateMedia(room.meetingId, userId, intent.CameraOn, intent.MicOn, intent.Sharing, intent.Recording)
			if !ok {
				continue
			}
			if _, err := room.adapter.Heartbeat(ctx, sess.ParticipantToken, &media); err != nil {
				glog.Warningf(ctx, "media forward failed: %v", err)
			}
		case "telemetry":
			// 发布端实测的"压缩前"编码码率。三方只认 4 秒内的新鲜度，所以前端要周期性报；
			// 这里只落盘不立刻心跳 —— 泵每 tick 本来就逐会话发一次，多插一次是白加往返。
			var payload struct {
				Items []thirdparty.VideoSourceTelemetry `json:"items"`
			}
			if b, _ := json.Marshal(evt.Data); json.Unmarshal(b, &payload) != nil {
				continue
			}
			room.registry.UpdateSourceTelemetry(room.meetingId, userId, payload.Items)
		case "chat":
			var payload struct {
				Text            string `json:"text"`
				ClientMessageId string `json:"clientMessageId"`
			}
			if b, _ := json.Marshal(evt.Data); json.Unmarshal(b, &payload) == nil {
				if err := room.adapter.SendChatMessage(ctx, sess.ParticipantToken, payload.Text, payload.ClientMessageId); err != nil {
					glog.Warningf(ctx, "chat forward failed: %v", err)
				}
			}
		case "speaking":
			var payload struct {
				Speaking bool `json:"speaking"`
			}
			if b, _ := json.Marshal(evt.Data); json.Unmarshal(b, &payload) == nil {
				room.send(ws, WsEvent{Type: "speaking", Data: map[string]interface{}{
					"participantId": sess.ParticipantId,
					"speaking":      payload.Speaking,
				}})
			}
		}
	}
}
