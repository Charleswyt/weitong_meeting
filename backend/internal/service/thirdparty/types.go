package thirdparty

import "cloud-conference-backend/internal/model"

// 三方字段命名与语义以 shared/contracts/edge-to-cloud/EXTERNAL_HTTPS_CONFERENCE_API_20260924.md 为准。

type AuthResult struct {
	OK          bool     `json:"ok"`
	Token       string   `json:"token"`
	Username    string   `json:"username"`
	Role        string   `json:"role"`
	AccountType string   `json:"accountType"`
	Permissions []string `json:"permissions"`
	IssuedAt    int64    `json:"issuedAt"`
	ExpiresAt   int64    `json:"expiresAt"`
}

type HostAccount struct {
	Username string `json:"username"`
	Role     string `json:"role"`
}

type ThirdMeeting struct {
	MeetingId              string `json:"meetingId"`
	MeetingNumber          string `json:"meetingNumber"`
	Title                  string `json:"title"`
	MeetingType            string `json:"meetingType"`
	Status                 string `json:"status"`
	StartAt                int64  `json:"startAt"`
	StartAtText            string `json:"startAtText"`
	ScheduledEndAt         int64  `json:"scheduledEndAt"`
	StoppedAt              int64  `json:"stoppedAt"`
	DurationMin            int    `json:"durationMinutes"`
	ParticipantCount       int    `json:"participantCount"`
	ActiveParticipantCount int    `json:"activeParticipantCount"`
	HostUsername           string `json:"hostUsername"`
	CreatedBy              string `json:"createdBy"`
	RecordingCount         int    `json:"recordingCount"`
	CloudRecord            bool   `json:"cloudRecord"`
}

// MeetingPage 是 /meetings 集合查询的信封（实测 2026-09-28：~100ms 返回，远快于 /state 聚合）。
// total 是过滤后、分页前的总数，不能拿 meetings.length 当总数。
type MeetingPage struct {
	OK         bool           `json:"ok"`
	Meetings   []ThirdMeeting `json:"meetings"`
	Pagination struct {
		Meetings PageWindow `json:"meetings"`
	} `json:"pagination"`
}

type PageWindow struct {
	Total   int  `json:"total"`
	Limit   int  `json:"limit"`
	Offset  int  `json:"offset"`
	HasMore bool `json:"hasMore"`
}

type ThirdRecording struct {
	RecordingId   string          `json:"recordingId"`
	MeetingId     string          `json:"meetingId"`
	RoomId        string          `json:"roomId"`
	ParticipantId string          `json:"participantId"`
	Title         string          `json:"title"`
	Status        string          `json:"status"`
	Mode          string          `json:"mode"`
	PlaybackUrl   string          `json:"playbackUrl"`
	DownloadUrl   string          `json:"downloadUrl"`
	SourceDevice  string          `json:"sourceDeviceId"`
	PublicationId string          `json:"publicationId"`
	LocalPaths    []string        `json:"localPaths"`
	Error         string          `json:"error"`
	Access        RecordingAccess `json:"access"`
	StartedAt     int64           `json:"startedAt"`
	StartedAtText string          `json:"startedAtText"`
	StoppedAt     int64           `json:"stoppedAt"`
	DurationSec   float64         `json:"durationSeconds"`
	FileSizeBytes int64           `json:"fileSizeBytes"`

	// 下面五个不是三方返回的字段，是适配层从 title/分组摘要里派生出来的**本域语义**
	// （见 lane.go）。消费方要用这几个，别再回去拆 Title 字符串。
	MeetingTitle string `json:"-"`
	Participant  string `json:"-"`
	MediaKind    string `json:"-"`
	MediaLabel   string `json:"-"`
	// MeetingNumber 是**三方会议号**，只有分组摘要有（title 里根本没有这一段，拆不出来）。
	// 历史孤立录像（meeting 为 null、key 为 legacy:<id>）拿不到，留空串而不是编一个。
	MeetingNumber string `json:"-"`

	// 同场聚合：这一场会的起点锚（该场最早那一路的 RFC3339 文本）与时间轴跨度。
	// 由列表侧在**过滤之后、分页之前**对全集算出（见 service.attachSessionSpans 与契约 §6.5），
	// 所以同一场的每一行带的是同一个数，与前端翻到第几页无关。meetingId 为空的孤行不给。
	MeetingStartedAtText string  `json:"-"`
	MeetingSpanSec       float64 `json:"-"`
}

// RecordingAccess 是服务端给的操作权限。删除按钮只看 canDelete，不按角色自己推。
type RecordingAccess struct {
	Role      string `json:"role"`
	CanDelete bool   `json:"canDelete"`
}

// RecordingGroupQuery 是 /recordings 云端录像目录的查询条件（实测 2026-09-28）。
type RecordingGroupQuery struct {
	Q         string
	DeviceId  string
	MeetingId string
	Status    string
	StartFrom int64
	StartTo   int64
	Owner     string
	Limit     int // 每页**会议分组数**，1–50
	Offset    int
}

// RecordingGroup 是目录里的一个会议分组。meeting 可为 nil（历史孤立录像，key 为 legacy:<id>）。
type RecordingGroup struct {
	Key        string           `json:"key"`
	Meeting    *ThirdMeeting    `json:"meeting"`
	Recordings []ThirdRecording `json:"recordings"`
}

// RecordingGroupPage 是分页后的录像目录信封。
// pagination.total 是**分组数**、totalRecordings 是**条数**，两者都是分页前统计，不能混用。
type RecordingGroupPage struct {
	OK              bool             `json:"ok"`
	Groups          []RecordingGroup `json:"groups"`
	DeviceIds       []string         `json:"deviceIds"`
	TotalRecordings int              `json:"totalRecordings"`
	Pagination      struct {
		Total   int  `json:"total"`
		Limit   int  `json:"limit"`
		Offset  int  `json:"offset"`
		HasMore bool `json:"hasMore"`
	} `json:"pagination"`
}

type ScheduleReq struct {
	Title           string   `json:"title"`
	MeetingNumber   string   `json:"meetingNumber"`
	StartAt         int64    `json:"startAt"`
	DurationMinutes int      `json:"durationMinutes"`
	HostUsername    string   `json:"hostUsername"`
	CloudRecord     bool     `json:"cloudRecord"`
	RkRecord        bool     `json:"rkRecord"`
	Sources         []string `json:"sources"`
	TargetDevices   []string `json:"targetDevices"`
}

type QuickStartReq struct {
	Title           string `json:"title"`
	MeetingNumber   string `json:"meetingNumber"`
	DurationMinutes int    `json:"durationMinutes"`
	HostUsername    string `json:"hostUsername"`
	CloudRecord     bool   `json:"cloudRecord"`
}

type JoinReq struct {
	Password         string `json:"password,omitempty"`
	MeetingNumber    string `json:"meetingNumber"`
	DisplayName      string `json:"displayName"`
	AccountName      string `json:"accountName"`
	EndpointType     string `json:"endpointType"`
	DeviceId         string `json:"deviceId"`
	CameraLabel      string `json:"cameraLabel"`
	ClientId         string `json:"clientId"`
	RecordingConsent bool   `json:"recordingConsent"`
}

type JoinResult struct {
	ParticipantId    string        `json:"participantId"`
	ParticipantToken string        `json:"participantToken"`
	ServerUnixMs     int64         `json:"serverUnixMs"`
	MeetingUrl       string        `json:"meetingUrl"`
	Meeting          MeetingInfo   `json:"-"`
	State            *MeetingState `json:"-"`
}

// MeetingResponse 是 /state 与 heartbeat 响应的信封：{serverUnixMs, meeting, participants, publications}。
type MeetingResponse struct {
	ServerUnixMs int64 `json:"serverUnixMs"`
	// 船端网关实测发的是**小数**毫秒（如 84.35057750355918），声明成 int64 会让整个 /state 与
	// heartbeat 反序列化失败（2026-10-10 现场："查询会议状态失败"→前端弹「系统异常」）。
	ServerClockUncertaintyMs float64            `json:"serverClockUncertaintyMs"`
	StateSync                *StateSync         `json:"stateSync"`
	Meeting                  MeetingInfo        `json:"meeting"`
	Participants             []ParticipantState `json:"participants"`
	Publications             []Publication      `json:"publications"`
}

type StateSync struct {
	GatewayId string `json:"gatewayId"`
	Revision  int64  `json:"revision"`
}

type MeetingInfo struct {
	Title             string           `json:"title"`
	MeetingNumber     string           `json:"meetingNumber"`
	Status            string           `json:"status"`
	HostParticipantId string           `json:"hostParticipantId"`
	ParticipantCount  int              `json:"participantCount"`
	CloudRecord       bool             `json:"cloudRecord"`
	StartAt           int64            `json:"startAt"` // Unix 秒（实测 /state 原文）
	MeetingId         string           `json:"meetingId"`
	HostUsername      string           `json:"hostUsername"`
	PublicationCount  int              `json:"publicationCount"`
	RecordingMode     string           `json:"recordingMode"`
	RecordingDeviceId string           `json:"recordingDeviceId"`
	DurationMinutes   int              `json:"durationMinutes"`
	BoardRecordings   []BoardRecording `json:"boardRecordings"`
}

// StartedAtMs 把三方的 Unix 秒 startAt 归一成毫秒；三方未给时返回 0。
func (m MeetingInfo) StartedAtMs() int64 {
	if m.StartAt <= 0 {
		return 0
	}
	return m.StartAt * 1000
}

type BoardRecording struct {
	DeviceId  string `json:"deviceId"`
	State     string `json:"state"`
	Requested bool   `json:"requested"`
	RunId     string `json:"runId"`
}

type MeetingState struct {
	Participants []ParticipantState `json:"participants"`
	Status       string             `json:"status"`
	ServerTime   int64              `json:"serverTime"`
}

type ParticipantState struct {
	ParticipantId       string `json:"participantId"`
	DisplayName         string `json:"displayName"`
	IsHost              bool   `json:"isHost"`
	EndpointType        string `json:"endpointType"`
	DeviceId            string `json:"deviceId"`
	AccountName         string `json:"accountName"`
	Status              string `json:"status"`
	JoinedAt            int64  `json:"joinedAt"`
	LastSeenAt          int64  `json:"lastSeenAt"`
	CameraOn            bool   `json:"cameraEnabled"`
	MicOn               bool   `json:"microphoneEnabled"`
	ScreenShare         bool   `json:"screenSharing"`
	LocalRecording      bool   `json:"localRecording"`
	MediaStateUpdatedAt int64  `json:"mediaStateUpdatedAt"`
}

// Publication 里 width/height/fps/*BitrateKbps 一律收 float64：
// 这些是 WebRTC 实测值，三方回的是带一位小数的数（实测 487.2、338.0、392.9），
// 而 encoding/json 对 int 字段遇到任何带小数点的字面量都会整体报错 ——
// 2026-09-29 就是因为把它们声明成 int，导致 /state 与心跳解析全线失败。
// 计数、id、时间戳这类真整数字段保持 int/int64 不动。
type Publication struct {
	VideoStats        *model.VideoStats `json:"videoStats,omitempty"`
	TransportMode     string            `json:"transportMode,omitempty"`
	EncodingStrategy  string            `json:"encodingStrategy,omitempty"`
	Revision          int               `json:"revision,omitempty"`
	TargetBitrateKbps int               `json:"targetBitrateKbps,omitempty"`

	PublicationId          string            `json:"publicationId"`
	ParticipantId          string            `json:"participantId"`
	MediaKind              string            `json:"mediaKind"`
	MediaLabel             string            `json:"mediaLabel"`
	Status                 string            `json:"status"`
	HdReady                bool              `json:"hdReady"`
	Width                  float64           `json:"width"`
	Height                 float64           `json:"height"`
	Fps                    float64           `json:"fps"`
	SourceVideoBitrateKbps float64           `json:"sourceVideoBitrateKbps"`
	SourceType             string            `json:"sourceType"`
	CloudSoftwareRoi       bool              `json:"cloudSoftwareRoi"`
	TransportMetrics       *TransportMetrics `json:"transportMetrics"`
	FocusedBy              []string          `json:"focusedBy"`
	RkDeliveryMode         string            `json:"rkDeliveryMode"`
	DirectDeliveryMode     string            `json:"directDeliveryMode"`
	RkReceiverLaneId       int               `json:"rkReceiverLaneId"`
	RkReceiverPath         string            `json:"rkReceiverPath"`
	DirectVideoCodec       string            `json:"directVideoCodec"`
	DirectVideoFormat      string            `json:"directVideoFormat"`
	DirectVideoUrl         string            `json:"directVideoUrl"`
	DirectAudioUrl         string            `json:"directAudioUrl"`
	AudioWhepUrl           string            `json:"audioWhepUrl"`
	RkReceiverWhepUrl      string            `json:"rkReceiverWhepUrl"`
	RkReceiverAudioWhepUrl string            `json:"rkReceiverAudioWhepUrl"`
	// CloudWhepUrl 是公网会议族（sinosat）浏览器 WHEP 绝对地址；Ocean 族不会填。
	CloudWhepUrl string `json:"cloudWhepUrl"`
	HDWhepURL    string `json:"hdWhepUrl"`
	WhipUrl      string `json:"whipUrl"`
}

// Prepare 的两个 role（§10.1）。consumer 是消费侧武装接收进程，publisher 是发布侧预热通道。
const (
	PrepareRoleConsumer  = "consumer"
	PrepareRolePublisher = "publisher"
)

// PrepareResult 是 §10.1 `prepare` 的回答。**消费侧也要读它**：`role=consumer` 的语义是
// "把这条发布在船端 RK 上的接收进程起来"，只有它回 `receiverReady`，
// `rkReceiverPath` 那条局域网槽里才会有流（实测 2026-10-12：不叫这一步，槽永远空着）。
//
// Reason 有两种来源，都要接住：就绪中三方回 200 + `receiverReason`，起不来回 404 + §17 的
// `reason`（实测过 `rtsp_describe_404`）。两者是同一件事的两种写法，缺了就没法定责。
type PrepareResult struct {
	SoftwareRoiAttached bool   `json:"softwareRoiAttached"`
	ReceiverReady       bool   `json:"receiverReady"`
	ReceiverReason      string `json:"receiverReason"`
	ConsumerAttached    bool   `json:"consumerAttached"`
	ConsumerProbeOk     bool   `json:"consumerProbeOk"`
	// Reason 是 §17 错误体的 `reason`，与 ReceiverReason 二选一填。
	Reason string `json:"reason"`
}

// WhyNotReady 归并两种写法给日志用；就绪时回空串（不拿"ok"冒充原因）。
func (p PrepareResult) WhyNotReady() string {
	if p.ReceiverReady {
		return ""
	}
	if p.ReceiverReason != "" {
		return p.ReceiverReason
	}
	return p.Reason
}

// TransportMetrics 是三方在每条发布记录里带的那一组实测值。
// 2026-09-29 扫 854 条真实 publication 定形（探针 frontend/scratch/probe-26c-shape.mjs，
// 只回键名与计数）：**源码率不在 publication 顶层，只在这里** ——
// 我方此前按顶层键解析，等于一直在读一个不存在的键，`sourceBitrateKbps` 恒为 0。
// 只声明本域要用的字段，其余（timestamp* / downstream* / bitrateUpdatedAt 等）留给解码器忽略。
//
// **这些字段一律用 float64 零值表示"没有"，即缺键与值为 0 不可分。** 三方是分得开的：它的
// `localTransportSample` 用 `hasOwnProperty` 判"有没有这个测量"，缺键才允许回落到服务端字段，
// 键在而值为 null 就落到底显示"统计中"（`refreshLocalTransportStats` 的注释原文：缺本机遥测
// **不许退回**高码率局域网流、也不许拿别的云端消费者的平均吞吐顶数）。我方今天只有一级数值回落，
// 两种情况处置完全相同，所以分离出来没有消费方、不改指针。
// ⚠️ 触发条件：**若将来引入两级回落（代理 `/api/local/transport-stats` 那类本机遥测），
// 必须先把这两个字段换成 `*float64`** —— 否则"网关有槽但当前空"会被当成缺键而静默回落。
// 这条由 `types_test.go` 的 TestRoundIntFloorAtZero 钉着：真引入两级回落时它会红。
type TransportMetrics struct {
	SourceVideoBitrateKbps   float64 `json:"sourceVideoBitrateKbps"`
	UpstreamVideoBitrateKbps float64 `json:"upstreamVideoBitrateKbps"`
	CompressionRatio         float64 `json:"compressionRatio"`
	CompressionEstimate      bool    `json:"compressionEstimate"`
}

// 对外契约（StreamVo）这几项是整数，所以取整只发生在我方边界上，三方的形状不外溢。
func (p Publication) WidthPx() int  { return roundInt(p.Width) }
func (p Publication) HeightPx() int { return roundInt(p.Height) }
func (p Publication) FpsInt() int   { return roundInt(p.Fps) }

// SourceBitrateKbps 取该路的**编码码率**。顺序：顶层（实测恒缺，留着只为三方哪天改回去）
// → transportMetrics。两处都没有就是 0，消费方必须显示 —，不许拿派生值冒充。
func (p Publication) SourceBitrateKbps() int {
	if p.SourceVideoBitrateKbps > 0 {
		return roundInt(p.SourceVideoBitrateKbps)
	}
	if p.TransportMetrics != nil && p.TransportMetrics.SourceVideoBitrateKbps > 0 {
		return roundInt(p.TransportMetrics.SourceVideoBitrateKbps)
	}
	return 0
}

func roundInt(f float64) int {
	if f <= 0 {
		return 0
	}
	return int(f + 0.5)
}

// UpstreamBitrateKbps 取该路**进入分发面时实测到的出站码率**（三方键名
// `upstreamVideoBitrateKbps`，按规则不外溢到契约，对外叫 `ingressBitrateKbps`）。
//
// 它与 `SourceBitrateKbps()` 在**同一条腿**上：分子是发布端编码器自己的输出
// （发布端 getStats 实测后上报），这个数是平台侧实测到的该路出站 —— 三方对**本端发布**
// 算压缩比时用的正是它做分母（`tp-meeting.js` 的 ownRows 那支
// `compressionText(publication, sourceRate, cloudSoftwareRoi ? metrics.upstreamVideoBitrateKbps : upstreamRate)`，
// 副本哈希 9f519d23a7358482…）。注意那个三元**只在 ownRows**，远端那一路三方传的是
// 裸的本地接收速率，本来就跨腿。
//
// 顶层没有这个键，只读 transportMetrics。没有就是 0，消费方必须显示"统计中"，
// **不许拿本端下行接收速率顶上去** —— 那是另一条腿上的数，混进来倍率就没有意义了。
//
// 〔我方不用它做分子分母的商，但仍在用它〕2026-11-05 云边对拍证明：这两个数虽然是同一条腿上的，
// 但平台侧的出站量是**瞬时**值，秒级摆 ±30%、还会出现出站 > 编码输出的倒挂（30 s 内比值 0.74–1.84）。
// 所以前端 `basis='ingress'` 那一支**不再拿它相除报倍率**，只用它显示"压缩后速率"这一格
// （证据 `evidence/2026-11-05-同侧分母配对-云边对拍.md`，契约 §6.3.1 第 5 条）。字段本身照留。
//
// 〔两条"不可达所以不加守卫"的账，Part 3 落地后重估过一遍〕
//
//	① 三方的 `sameRkSource → 0` 那支（远端行：`sourceDeviceId === rkTransportMetrics.deviceId` 时不采本机下行）
//	   要求 `publication.rkTransportMetrics` 存在。**我方从不解析这个字段**，三方自己也只刷新已存在的对象、
//	   从不创建它（`tp-meeting.js` 的 `refreshLocalTransportStats`）—— 所以即便船端来源已改成 `rk_browser_roi`，
//	   这一支在我方仍然**结构上不可达**，按"不可达就不加守卫"只记账。
//	② 三方算 `rk` 那一路的分母时**优先用 `localTransportSample`**（船内网关的本机遥测），拿不到才退到
//	   `metrics.upstreamVideoBitrateKbps`。我方没有那条本机遥测（不代理 `/api/local/transport-stats`），
//	   所以直接用服务端那个字段 —— 这正是三方的**同级回落**，不是自创口径。
func (p Publication) UpstreamBitrateKbps() int {
	if p.TransportMetrics == nil || p.TransportMetrics.UpstreamVideoBitrateKbps <= 0 {
		return 0
	}
	return roundInt(p.TransportMetrics.UpstreamVideoBitrateKbps)
}

// CompressionRatio 取三方在该路发布记录里**直接上报**的压缩倍率。
// 它是本端两个数（编码码率、实传速率）凑不出倍率时的退路 —— 三方自己就是这么退的
// （其 compressionText 里 `ratio = source/rate`，任一非正就取 metrics.compressionRatio），
// 不是我方发明的兜底。没给就是 0，消费方必须显示"统计中"，不许拿派生值冒充。
// 保留两位小数不取整：三方这值本来就带小数，取整会把"2.31 倍"说成"2 倍"。
func (p Publication) CompressionRatio() float64 {
	if p.TransportMetrics == nil || p.TransportMetrics.CompressionRatio <= 0 {
		return 0
	}
	return p.TransportMetrics.CompressionRatio
}

// CompressionEstimated 那个上报值是实测还是估算 —— 三方用这个词区分，界面要照实标出来。
func (p Publication) CompressionEstimated() bool {
	return p.TransportMetrics != nil && p.TransportMetrics.CompressionEstimate
}

// CompressionKind 把三方的 sourceType + cloudSoftwareRoi 折成本域语义，
// 外部字段名不外溢到前后端契约（工作区硬规则）。取值与 contracts/api-contract.md 一致。
// 三方对没经过二次压缩的那一路根本不报压缩倍率（只写「直传（无 ROI 二次压缩）」），
// 所以这个判据是"要不要报倍率"的唯一依据，不能靠数值大小猜。
func (p Publication) CompressionKind() string {
	switch {
	case p.SourceType == "rk_roi" || p.SourceType == "rk_browser_roi":
		return "edgeRoi"
	case p.CloudSoftwareRoi:
		return "cloudSoftwareRoi"
	case p.SourceType == "":
		// 键缺失说明三方这份响应没带这个字段，不能据此断言"没压缩"。
		return "unknown"
	default:
		return "none"
	}
}

// VideoSourceTelemetry 是**发布端**实测出来的"压缩前"编码码率，随 heartbeat 的 mediaState 上行。
// 它是「原始速率/压缩倍率/节省带宽」这三个量的唯一真源：订阅端自己算不出压缩前的数，
// 只能读服务端转发进该路 `transportMetrics.sourceVideoBitrateKbps` 的这份上报。
//
// 三方未公开的取数约定（逆向所得，三方改了就断）：字段名与大小写照它的解析器，不我方另立一套。
// 发送条件见 session 侧 —— 不满足时**整条不发**，发 0 会被服务端当成"实测到 0"，比缺数更坏。
type VideoSourceTelemetry struct {
	PublicationId              string   `json:"publicationId"`
	SourceVideoBitrateKbps     float64  `json:"sourceVideoBitrateKbps"`
	SourceFps                  float64  `json:"sourceFps"`
	CaptureFps                 *float64 `json:"captureFps,omitempty"`
	PublishFps                 *float64 `json:"publishFps,omitempty"`
	PublishKbps                *float64 `json:"publishKbps,omitempty"`
	DecodedFrameKbps           *float64 `json:"decodedFrameKbps,omitempty"`
	AssociatedAudioBitrateKbps float64  `json:"associatedAudioBitrateKbps"`
}

type MediaState struct {
	Revision       int64 `json:"revision,omitempty"`
	CameraOn       bool  `json:"cameraEnabled"`
	MicOn          bool  `json:"microphoneEnabled"`
	ScreenShare    bool  `json:"screenSharing"`
	LocalRecording bool  `json:"localRecording"`
	// omitempty：不满足发送条件时整段消失，而不是发一个 `[]` 让上游以为"报过了但没有"。
	VideoSourceTelemetry []VideoSourceTelemetry `json:"videoSourceTelemetry,omitempty"`
}

type ChatMessage struct {
	Id                 int64  `json:"messageId"`
	Text               string `json:"text"`
	SenderName         string `json:"displayName"`
	SenderEndpointType string `json:"endpointType"`
	DeviceId           string `json:"deviceId"`
	IsOwn              bool   `json:"isOwn"`
	SentAt             int64  `json:"sentAt"`
	SentAtMs           int64  `json:"sentAtMs"`
	SentAtText         string `json:"sentAtText"`
	ClientId           string `json:"clientId"`
}

type ChatListResult struct {
	Messages      []ChatMessage `json:"messages"`
	LastMessageId int64         `json:"lastMessageId"`
}

type PlaybackData struct {
	Partial  bool              `json:"partial"`
	Meeting  *PlaybackMeeting  `json:"meeting"`
	Timeline *PlaybackTimeline `json:"timeline"`
	Streams  []PlaybackStream  `json:"streams"`
}

type PlaybackMeeting struct {
	MeetingId     string `json:"meetingId"`
	MeetingNumber string `json:"meetingNumber"`
	Title         string `json:"title"`
	StartedAt     int64  `json:"startedAt"`
}

type PlaybackTimeline struct {
	StartAt     int64   `json:"startAt"`
	DurationSec float64 `json:"durationSeconds"`
}

type PlaybackStream struct {
	RecordingId string `json:"recordingId"`
	DisplayName string `json:"displayName"`
	MediaKind   string `json:"mediaKind"`
	MediaLabel  string `json:"mediaLabel"`
	StreamLabel string `json:"streamLabel"`
	// HasVideo/HasAudio 是上游对这条发布**实际有没有画面/声音**的判定，回看页就是靠它决定
	// `media.muted = 全局 || 本路 || !hasAudio`（逆向文档 §12）。不许拿 mediaKind 反推：
	// 一路发布可能同时带画面与声音，mediaKind 只描述主通路（实测相机发布也可携带音轨）。
	HasVideo    bool    `json:"hasVideo"`
	HasAudio    bool    `json:"hasAudio"`
	PlaybackUrl string  `json:"playbackUrl"`
	DownloadUrl string  `json:"downloadUrl"`
	OffsetSec   float64 `json:"offsetSeconds"`
	DurationSec float64 `json:"durationSeconds"`
}

type Sm2PublicKey struct {
	OK                 bool   `json:"ok"`
	Algorithm          string `json:"algorithm"`
	Curve              string `json:"curve"`
	CipherMode         string `json:"cipherMode"`
	CiphertextEncoding string `json:"ciphertextEncoding"`
	PublicKey          string `json:"publicKey"`
	KeyID              string `json:"keyId"`
	Challenge          string `json:"challenge"`
	ChallengeExpiresAt int64  `json:"challengeExpiresAt"`
}

// BrowserWHEP returns the public receive leg issued for this publication.
// A native processed video may already have its own direct delivery channel.
func (p Publication) BrowserWHEP() string {
	if p.CloudWhepUrl != "" {
		return p.CloudWhepUrl
	}
	if p.DirectVideoUrl == "" {
		return p.HDWhepURL
	}
	return ""
}
