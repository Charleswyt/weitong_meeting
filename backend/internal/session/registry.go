// Package session 持有 本系统用户 ↔ 三方参会身份 的服务端映射与状态快照。
// 三方参会令牌只存活于此包与 backend 适配层，绝不下发前端（契约第 5 节）。
package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"hash/fnv"
	"strconv"
	"sync"
	"time"

	"github.com/gogf/gf/v2/os/gcache"

	"cloud-conference-backend/internal/service/thirdparty"
)

// StreamAlias 是我方签发的稳定流号 ↔ 三方 publication 的映射项。
type StreamAlias struct {
	ParticipantId string
	StreamId      string
	PublicationId string
	Kind          string
}

type Session struct {
	UserId           int64
	ParticipantId    string
	ParticipantToken string
	MediaState       thirdparty.MediaState
	// sourceTelemetryAt = 本端实测编码码率最近一次上报的时刻。三方只认 4 秒内的新鲜度，
	// 过期的必须在取用时整段摘掉（见 NextMediaState）——留着旧值等于把"半分钟前的码率"
	// 当成当前值转发给所有订阅者，那会算出一个看起来合理的压缩倍率。
	sourceTelemetryAt time.Time
	Revision          int64
	JoinedAt          time.Time
	LastSeen          time.Time // 最近一次"这个客户端还活着"的证据（WS 消息或 REST 调用）
}

// MeetingRoom 是一场（本库 id 视角）会议的服务端聚合：成员会话、状态快照、流别名。
type MeetingRoom struct {
	mu           sync.RWMutex
	MeetingId    int64
	ExternalNo   string // 三方会议号
	ThirdPartyId string // 三方 meetingId（录制/板卡操作用）
	Sessions     map[int64]*Session
	lastState    *thirdparty.MeetingResponse
	// stateByUser = 每个参会者"用自己令牌拉的"那份状态，按人分键。三方在 publications 里
	// 给每条订阅地址都嵌了一张绑到该参会者的票据，所以这份缓存不是"谁都能复用的快照"：
	// 另一个人拿它去订 WHEP，用的就是别人的票（实测这类回答是 401 authentication error）。
	// 与下面 whep 表同理 —— 键必须带用户，否则等于把 A 的凭证交给 B 用。
	// 写入方有两类：请求路径（/state、会议详情、录制指令）与泵每 tick 的 heartbeat 响应
	// （heartbeat 同样是用该会话自己的令牌拉的，票据归属天然正确）。
	stateByUser map[int64]*thirdparty.MeetingResponse
	// whip 保存"我方 publicationId → 三方签发的 whipUrl / 会话 URI"。
	// 真实地址只留在服务端：前端只拿我方 publicationId 去访问代理路径，
	// 既不外泄三方 URL，也不给请求方任何可控的目标地址（避免 SSRF）。
	whip map[string]WhipTarget
	// roiHintAt 是"这个人上一次上报人脸框的时刻"：三方只要求约 250ms 一次，
	// 后端再兜一层，避免客户端异常时把上游打成每秒几十次。
	roiHintAt map[int64]time.Time
	// whep 保存"(订阅方用户, 流号) → 三方 WHEP 会话 URI"。同一publication 会被多个端各自
	// 订阅，各有独立会话，所以键必须带用户；三方不会自己收这些会话，不记就永远拆不掉。
	whep       map[string]WhepTarget
	Streams    []StreamAlias
	streamById map[string]StreamAlias
}

type Registry struct {
	mu            sync.RWMutex
	rooms         map[int64]*MeetingRoom // key: 本系统预约单 id，或外部会议的会话键
	externalRooms map[string]int64       // 三方会议号 -> 会话键，同一号多次入会必须拿到同一个键
	wsTickets     *gcache.Cache
}

func NewRegistry() *Registry {
	return &Registry{
		rooms:         make(map[int64]*MeetingRoom),
		externalRooms: make(map[string]int64),
		wsTickets:     gcache.New(),
	}
}

// 会话键的两段来源用**显式标记位**区分，不用数值区间：位 52 置位 = 外部派生键
// （低 40 位是三方会议号的哈希），未置位的正整数 = 本系统预约单主键。
// 刻意不写 `key < 1e15` 这类区间判据 —— 那等于把"预约单主键长不到那个量级"这个隐含假设
// 焊死在判据里；这张表的键是达梦 IDENTITY 递增，哪天真换成大整数 id 就会悄悄串台。
// 上限 2^52+2^40 < 2^53：仍在 JS 安全整数内，前端拿它拼 URL 不掉精度。
const (
	externalKeyMark = int64(1) << 52
	externalKeyMask = int64(1<<40) - 1
)

// RoomKey 返回这场会议在注册表里的键。本系统有预约单的用主键；没有的按三方会议号
// 稳定派生——不能让它们共用 0 号房间，否则两场外部会议的成员、流别名和心跳互相串台。
// 键本身由会议号哈希出来：同一个号在任何时刻（含后端重启后）都拿到同一个键，
// 前端把它存在 localStorage 里，重启后不能指向另一场会。
func (rg *Registry) RoomKey(localId int64, externalNo string) int64 {
	if localId > 0 {
		return localId
	}
	if externalNo == "" {
		return 0
	}
	rg.mu.Lock()
	defer rg.mu.Unlock()
	if key, ok := rg.externalRooms[externalNo]; ok {
		return key
	}
	h := fnv.New64a()
	_, _ = h.Write([]byte(externalNo))
	key := externalKeyMark | (int64(h.Sum64()&uint64(externalKeyMask)) + 1)
	// 40 位哈希撞上的概率可以忽略，但撞上了就是两场会共用房间，宁可往后挪一位。
	for taken := false; !taken; {
		taken = true
		for _, k := range rg.externalRooms {
			if k == key {
				key++
				taken = false
				break
			}
		}
	}
	rg.externalRooms[externalNo] = key
	return key
}

// IsManaged 判断这个键是不是本系统自己的预约单主键；外部会议的键不是，
// 任何按主键改库的路径都要先问一句，否则会拿会话键去 UPDATE 预约单。
func IsManaged(roomKey int64) bool {
	return roomKey > 0 && roomKey&externalKeyMark == 0
}

// ExternalNoFor 反查会话键对应的三方会议号。未入会的外部会议没有房间，只能查分配表。
func (rg *Registry) ExternalNoFor(roomKey int64) (string, bool) {
	rg.mu.RLock()
	defer rg.mu.RUnlock()
	for no, k := range rg.externalRooms {
		if k == roomKey {
			return no, true
		}
	}
	if room, ok := rg.rooms[roomKey]; ok && room.ExternalNo != "" {
		return room.ExternalNo, true
	}
	return "", false
}

func (rg *Registry) roomFor(meetingId int64) *MeetingRoom {
	rg.mu.Lock()
	defer rg.mu.Unlock()
	room, ok := rg.rooms[meetingId]
	if !ok {
		room = &MeetingRoom{
			MeetingId:  meetingId,
			Sessions:   make(map[int64]*Session),
			streamById: make(map[string]StreamAlias),
		}
		rg.rooms[meetingId] = room
	}
	return room
}

func (rg *Registry) Join(meetingId int64, externalNo, thirdPartyId string, s *Session) {
	room := rg.roomFor(meetingId)
	room.mu.Lock()
	defer room.mu.Unlock()
	room.ExternalNo = externalNo
	if thirdPartyId != "" {
		room.ThirdPartyId = thirdPartyId
	}
	s.LastSeen = time.Now()
	room.Sessions[s.UserId] = s
}

// WhipTarget 是一条 WHIP 发布在三方侧的地址对。
type WhipTarget struct {
	// UserId 是**这条发布的归属**（我方本地用户 id）。缺了它，控制层就只能校验"调用者在这场会里"，
	// 那是会议级成员资格而不是发布所有权 —— 多用户同场下等于允许任何人往别人的流里推 SDP、或拆掉它。
	UserId     int64
	OfferURL   string // 三方签发的预授权发布地址（公网会议则为绝对 WHIP 路径）
	SessionURL string // WHIP 响应的 Location，用于 DELETE 拆流
	// AuthBearer 公网会议族 WHIP/WHEP 需要参会令牌；Ocean 预授权 URL 留空。
	AuthBearer string
}

func (room *MeetingRoom) BindWhip(publicationId string, t WhipTarget) {
	room.mu.Lock()
	defer room.mu.Unlock()
	if room.whip == nil {
		room.whip = make(map[string]WhipTarget)
	}
	cur, ok := room.whip[publicationId]
	if ok && cur.SessionURL != "" {
		t.SessionURL = cur.SessionURL
	}
	room.whip[publicationId] = t
}

// WhipForUser 按"publicationId + 归属"取发布。刻意**不提供**无归属的读法：
// 两个调用方（推流转发、拆流）都必须先证明这条发布是自己的。
func (room *MeetingRoom) WhipForUser(publicationId string, userId int64) (WhipTarget, bool) {
	room.mu.RLock()
	defer room.mu.RUnlock()
	t, ok := room.whip[publicationId]
	if !ok || t.UserId != userId {
		return WhipTarget{}, false
	}
	return t, true
}

func (room *MeetingRoom) SetWhipSession(publicationId, sessionURL string) {
	room.mu.Lock()
	defer room.mu.Unlock()
	if t, ok := room.whip[publicationId]; ok {
		t.SessionURL = sessionURL
		room.whip[publicationId] = t
	}
}

func (room *MeetingRoom) UnbindWhip(publicationId string) {
	room.mu.Lock()
	defer room.mu.Unlock()
	delete(room.whip, publicationId)
}

// AllowRoiHint 按用户做节流；返回 false 表示这一次应直接丢弃。
func (room *MeetingRoom) AllowRoiHint(userId int64, minInterval time.Duration) bool {
	room.mu.Lock()
	defer room.mu.Unlock()
	now := time.Now()
	if room.roiHintAt == nil {
		room.roiHintAt = make(map[int64]time.Time)
	}
	if last, ok := room.roiHintAt[userId]; ok && now.Sub(last) < minInterval {
		return false
	}
	room.roiHintAt[userId] = now
	return true
}

// WhepTarget 是一次 WHEP 订阅在三方侧的地址对。
// Kind 是这条订阅收哪条腿（audio|video）：同一路流的两条腿在三方侧是**两个独立会话**，
// 键里少了它就变成后订的那条把先订的那条覆盖掉、并在换流时对它发 DELETE ——
// 症状是"画面起来之后声音哑了"（或反过来）。
type WhepTarget struct {
	UserId     int64
	StreamId   string
	Kind       string
	OfferURL   string // 三方签发的预授权订阅地址
	SessionURL string // WHEP 响应的 Location，用于 DELETE 释放会话
	AuthBearer string // 公网会议族需要；Ocean 留空
}

func whepKey(userId int64, streamId, kind string) string {
	return strconv.FormatInt(userId, 10) + "|" + streamId + "|" + kind
}

func (room *MeetingRoom) BindWhep(t WhepTarget) {
	room.mu.Lock()
	defer room.mu.Unlock()
	if room.whep == nil {
		room.whep = make(map[string]WhepTarget)
	}
	room.whep[whepKey(t.UserId, t.StreamId, t.Kind)] = t
}

func (room *MeetingRoom) WhepFor(userId int64, streamId, kind string) (WhepTarget, bool) {
	room.mu.RLock()
	defer room.mu.RUnlock()
	t, ok := room.whep[whepKey(userId, streamId, kind)]
	return t, ok
}

// TakeWhep 取出并解除绑定某一条腿，由调用方去三方释放。
func (room *MeetingRoom) TakeWhep(userId int64, streamId, kind string) (WhepTarget, bool) {
	room.mu.Lock()
	defer room.mu.Unlock()
	key := whepKey(userId, streamId, kind)
	t, ok := room.whep[key]
	if ok {
		delete(room.whep, key)
	}
	return t, ok
}

// TakeWhepsForStream 摘掉本端对这一路流的全部订阅会话（调用方说"这路我不要了"，不区分腿）。
func (room *MeetingRoom) TakeWhepsForStream(userId int64, streamId string) []WhepTarget {
	room.mu.Lock()
	defer room.mu.Unlock()
	var out []WhepTarget
	for key, t := range room.whep {
		if t.UserId != userId || t.StreamId != streamId {
			continue
		}
		out = append(out, t)
		delete(room.whep, key)
	}
	return out
}

// TakeWhepForUser 摘掉该用户在本场会的全部 WHEP 订阅（离会/回收时调用）。
func (room *MeetingRoom) TakeWhepForUser(userId int64) []WhepTarget {
	room.mu.Lock()
	defer room.mu.Unlock()
	var out []WhepTarget
	for key, t := range room.whep {
		if t.UserId != userId {
			continue
		}
		out = append(out, t)
		delete(room.whep, key)
	}
	return out
}

// UpdateMedia 按本域词形合并媒体意图位，返回合并后的快照。
// 传 nil 表示该位不上报，保持原值。
func (rg *Registry) UpdateMedia(meetingId, userId int64, cameraOn, micOn, sharing, recording *bool) (thirdparty.MediaState, bool) {
	room, ok := rg.Room(meetingId)
	if !ok {
		return thirdparty.MediaState{}, false
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	s, ok := room.Sessions[userId]
	if !ok {
		return thirdparty.MediaState{}, false
	}
	if cameraOn != nil {
		s.MediaState.CameraOn = *cameraOn
	}
	if micOn != nil {
		s.MediaState.MicOn = *micOn
	}
	if sharing != nil {
		s.MediaState.ScreenShare = *sharing
	}
	if recording != nil {
		s.MediaState.LocalRecording = *recording
	}
	// 意图一变就盖新 revision（Unix 毫秒，全局单调）：三方按 revision 过滤，
	// 带着旧 revision 的快速通道上报会被当作过期状态忽略。
	s.MediaState.Revision = time.Now().UnixMilli()
	return s.MediaState, true
}

// Touch 记录一次客户端活动：WS 消息或 REST 调用都算。
func (rg *Registry) Touch(meetingId, userId int64) {
	room, ok := rg.Room(meetingId)
	if !ok {
		return
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	if s, ok := room.Sessions[userId]; ok {
		s.LastSeen = time.Now()
	}
}

func (rg *Registry) Leave(meetingId, userId int64) {
	room, ok := rg.rooms[meetingId]
	if !ok {
		return
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	delete(room.Sessions, userId)
	// 带票据的状态按人分键，人走了这份就不能再被读到（也不该继续占内存）。
	delete(room.stateByUser, userId)
	if len(room.Sessions) == 0 {
		rg.mu.Lock()
		delete(rg.rooms, meetingId)
		rg.mu.Unlock()
	}
}

func (rg *Registry) Session(meetingId, userId int64) (*Session, bool) {
	room, ok := rg.rooms[meetingId]
	if !ok {
		return nil, false
	}
	room.mu.RLock()
	defer room.mu.RUnlock()
	s, ok := room.Sessions[userId]
	return s, ok
}

func (rg *Registry) Room(meetingId int64) (*MeetingRoom, bool) {
	rg.mu.RLock()
	defer rg.mu.RUnlock()
	room, ok := rg.rooms[meetingId]
	return room, ok
}

// ExternalMeetingNo 取三方的**会议号**（拨号用的那串数字），不是会议ID。
// 原先这里一次返回 (会议号, 会议ID) 两个串，调用方按位置解包时把第二个当成了会议号，
// 于是 /state 全量回源都拿会议ID 去查 —— 上游只认会议号，一律 404 meeting_not_found。
// 单返回值让这类误用在编译期就不成立。
func (room *MeetingRoom) ExternalMeetingNo() string {
	room.mu.RLock()
	defer room.mu.RUnlock()
	return room.ExternalNo
}

// StoreState 记下这轮三方状态**以及它是用谁的令牌拉的**。
// 忘记是谁拉的就没有安全复用这回事：状态里的订阅地址带着绑定参会者的票据。
func (room *MeetingRoom) StoreState(state *thirdparty.MeetingResponse, byUserId int64) {
	room.mu.Lock()
	defer room.mu.Unlock()
	room.lastState = state
	if room.stateByUser == nil {
		room.stateByUser = make(map[int64]*thirdparty.MeetingResponse)
	}
	room.stateByUser[byUserId] = state
}

func (room *MeetingRoom) State() *thirdparty.MeetingResponse {
	room.mu.RLock()
	defer room.mu.RUnlock()
	return room.lastState
}

// StateFor 只给**这个用户自己令牌拉到的那份**。
// 给订阅路径用：那里要拿的是带票据的地址，别人的票订不动（实测 401）。
// 只读会议状态、发布清单这类无票据信息的调用方仍用 State()。
func (room *MeetingRoom) StateFor(userId int64) *thirdparty.MeetingResponse {
	room.mu.RLock()
	defer room.mu.RUnlock()
	return room.stateByUser[userId]
}

// SetStreams 用本轮三方 publications 重建流别名：已存在的流号保持稳定，新流签发新号。
func (room *MeetingRoom) SetStreams(pubs []thirdparty.Publication) {
	room.mu.Lock()
	defer room.mu.Unlock()
	byPub := make(map[string]StreamAlias, len(room.Streams))
	for _, a := range room.Streams {
		byPub[a.PublicationId] = a
	}
	next := make([]StreamAlias, 0, len(pubs))
	nextById := make(map[string]StreamAlias, len(pubs))
	for _, p := range pubs {
		// stopped/failed 是终态，不再签发/保留别名：给死发布留着条目，
		// 前端拿旧流号来订会收到误导性的"该流已结束"。
		if p.Status == "stopped" || p.Status == "failed" {
			continue
		}
		alias, ok := byPub[p.PublicationId]
		if !ok {
			alias = StreamAlias{StreamId: newHexId("st_"), PublicationId: p.PublicationId}
		}
		alias.Kind = p.MediaKind
		alias.ParticipantId = p.ParticipantId
		next = append(next, alias)
		nextById[alias.StreamId] = alias
	}
	room.Streams = next
	room.streamById = nextById
}

func (room *MeetingRoom) ResolveStream(streamId string) (StreamAlias, bool) {
	room.mu.RLock()
	defer room.mu.RUnlock()
	a, ok := room.streamById[streamId]
	return a, ok
}

// SessionsSnapshot 返回当前全部成员会话的浅拷贝，供心跳逐个续期使用。
// 心跳不能只绑某一个会话：那个会话所在的 WS 一断，全场令牌就会停止续期并被上游判定掉线。
func (room *MeetingRoom) SessionsSnapshot() []*Session {
	room.mu.RLock()
	defer room.mu.RUnlock()
	out := make([]*Session, 0, len(room.Sessions))
	for _, s := range room.Sessions {
		cp := *s
		out = append(out, &cp)
	}
	return out
}

// NextMediaState 取出该用户最新媒体意图并盖上 revision。
// 三方按 revision 单调过滤媒体状态（实测：收到过更大的 revision 后，小 revision 直接丢弃、
// 连 mediaStateUpdatedAt 都不刷新）——所以 revision 必须**全局单调**，不能用会话级计数器：
// 后端重启/重新入会会把计数器打回 1，之后所有意图上报都会被三方静默忽略。
// Unix 毫秒天然单调递增，直接当 revision 用。
func (room *MeetingRoom) NextMediaState(userId int64) (thirdparty.MediaState, bool) {
	room.mu.Lock()
	defer room.mu.Unlock()
	s, ok := room.Sessions[userId]
	if !ok {
		return thirdparty.MediaState{}, false
	}
	s.MediaState.Revision = time.Now().UnixMilli()
	// 过期的实测码率一律不带：三方把它当"发布端此刻的编码码率"转发给所有订阅者，
	// 带一份旧的等于让远端算出一个看起来很合理的压缩倍率。宁缺不假。
	if time.Since(s.sourceTelemetryAt) > sourceTelemetryTTL {
		s.MediaState.VideoSourceTelemetry = nil
	}
	return s.MediaState, true
}

// sourceTelemetryTTL 照三方自己那条：它的组装条件是 `Date.now() - updatedAt <= 4000`。
const sourceTelemetryTTL = 4 * time.Second

// UpdateSourceTelemetry 记下本端实测的编码码率，等下一次心跳带出去。
// 三条发送条件在这里先过两条（值 >0、归属是自己），第三条（4 秒新鲜）在取用时判。
func (rg *Registry) UpdateSourceTelemetry(meetingId, userId int64, items []thirdparty.VideoSourceTelemetry) bool {
	room, ok := rg.Room(meetingId)
	if !ok {
		return false
	}
	room.mu.Lock()
	defer room.mu.Unlock()
	s, ok := room.Sessions[userId]
	if !ok {
		return false
	}
	kept := items[:0]
	for _, it := range items {
		// 0 不是"没测到"而是"实测为 0"，两者在上游无法区分；没测到就不发这一条。
		if it.PublicationId == "" || (it.SourceVideoBitrateKbps <= 0 && it.CaptureFps == nil && it.PublishFps == nil && it.PublishKbps == nil && it.DecodedFrameKbps == nil) {
			continue
		}
		if (it.CaptureFps != nil && !(*it.CaptureFps >= 0 && *it.CaptureFps <= 240)) ||
			(it.PublishFps != nil && !(*it.PublishFps >= 0 && *it.PublishFps <= 240)) ||
			(it.PublishKbps != nil && !(*it.PublishKbps >= 0 && *it.PublishKbps <= 1e9)) ||
			(it.DecodedFrameKbps != nil && !(*it.DecodedFrameKbps >= 0 && *it.DecodedFrameKbps <= 1e9)) || len(kept) >= 2 {
			continue
		}
		kept = append(kept, it)
	}
	s.MediaState.VideoSourceTelemetry = kept
	if len(kept) > 0 {
		s.sourceTelemetryAt = time.Now()
	}
	return true
}

// IssueWsTicket 一次性短时票，供 WebSocket 握手（浏览器 WS 不能带 Authorization 头）。
func (rg *Registry) IssueWsTicket(ctx context.Context, userId, meetingId int64) (string, time.Duration, error) {
	ticket := newHexId("")
	ttl := 60 * time.Second
	if err := rg.wsTickets.Set(ctx, "wst:"+ticket, fmt.Sprintf("%d:%d", userId, meetingId), ttl); err != nil {
		return "", 0, err
	}
	return ticket, ttl, nil
}

// RedeemWsTicket 取出即销毁。
func (rg *Registry) RedeemWsTicket(ctx context.Context, ticket string) (userId, meetingId int64, ok bool) {
	v, err := rg.wsTickets.Remove(ctx, "wst:"+ticket)
	if err != nil || v == nil {
		return 0, 0, false
	}
	var u, m int64
	if _, err := fmt.Sscanf(v.String(), "%d:%d", &u, &m); err != nil {
		return 0, 0, false
	}
	return u, m, true
}

func (rg *Registry) SessionsSnapshot(meetingId int64) []*Session {
	room, ok := rg.Room(meetingId)
	if !ok {
		return nil
	}
	return room.SessionsSnapshot()
}

func (rg *Registry) NextMediaState(meetingId, userId int64) (thirdparty.MediaState, bool) {
	room, ok := rg.Room(meetingId)
	if !ok {
		return thirdparty.MediaState{}, false
	}
	return room.NextMediaState(userId)
}

// BindPublicationIds 用三方 publications 重建某场会议的流别名（REST 与 WS 共用）。
func (rg *Registry) BindPublicationIds(meetingId int64, pubs []thirdparty.Publication) {
	room, ok := rg.Room(meetingId)
	if !ok {
		return
	}
	room.SetStreams(pubs)
}

func newHexId(prefix string) string {
	buf := make([]byte, 16)
	_, _ = rand.Read(buf)
	return prefix + hex.EncodeToString(buf)
}
