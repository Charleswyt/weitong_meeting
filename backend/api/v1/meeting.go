package v1

import (
	"github.com/gogf/gf/v2/frame/g"

	"cloud-conference-backend/internal/model"
)

type MeetingListReq struct {
	g.Meta        `path:"/meetings/list" method:"get" tags:"会议"`
	PageNum       int    `json:"pageNum"`
	PageSize      int    `json:"pageSize"`
	OrderByColumn string `json:"orderByColumn"`
	IsAsc         string `json:"isAsc"`
	Status        string `json:"status"`
	Keyword       string `json:"keyword"`
}

type MeetingListRes struct {
	Rows  []MeetingVo `json:"rows"`
	Total int         `json:"total"`
}

type MeetingTodayReq struct {
	g.Meta `path:"/meetings/today" method:"get" tags:"会议"`
}

type MeetingStatsReq struct {
	g.Meta `path:"/meetings/stats" method:"get" tags:"会议"`
}

type MeetingStatsRes struct {
	WeekCount    int `json:"weekCount"`
	PendingCount int `json:"pendingCount"`
	MyCount      int `json:"myCount"`
	TotalMinutes int `json:"totalMinutes"`
}

type MeetingDetailReq struct {
	g.Meta `path:"/meetings/{id}" method:"get" tags:"会议"`
	Id     int64 `json:"id"`
}

type MeetingScheduleReq struct {
	g.Meta          `path:"/meetings/schedule" method:"post" tags:"会议"`
	Title           string  `v:"required|length:1,64" json:"title"`
	StartTime       string  `v:"required" json:"startTime"`
	DurationMinutes int     `v:"required|min:1|max:120" json:"durationMinutes"`
	CloudRecord     bool    `json:"cloudRecord"`
	MuteOnJoin      *bool   `json:"muteOnJoin"`
	CameraOff       *bool   `json:"cameraOff"`
	AllowWaiting    *bool   `json:"allowWaiting"`
	Password        string  `v:"length:0,32" json:"password"`
	ParticipantIds  []int64 `json:"participantIds"`
}

// MeetingUpdateReq 仅允许修改尚未开始（status=scheduled）的会议。
// 三方接口无「修改预约」能力，故本接口只更新本地字段，不回写三方；
// 已同步的三方预约仍按原时间存在，开始会议时以本地记录为准。
type MeetingUpdateReq struct {
	g.Meta          `path:"/meetings/{id}" method:"put" tags:"会议"`
	Id              int64   `json:"id"`
	Title           string  `v:"required|length:1,64" json:"title"`
	StartTime       string  `v:"required" json:"startTime"`
	DurationMinutes int     `v:"required|min:1|max:120" json:"durationMinutes"`
	CloudRecord     bool    `json:"cloudRecord"`
	MuteOnJoin      *bool   `json:"muteOnJoin"`
	CameraOff       *bool   `json:"cameraOff"`
	AllowWaiting    *bool   `json:"allowWaiting"`
	Password        *string `v:"length:0,32" json:"password"`
	ParticipantIds  []int64 `json:"participantIds"`
}

type MeetingQuickStartReq struct {
	g.Meta          `path:"/meetings/quick-start" method:"post" tags:"会议"`
	Title           string `v:"required|length:1,64" json:"title"`
	DurationMinutes int    `json:"durationMinutes"`
	CloudRecord     bool   `json:"cloudRecord"`
	// LaunchKind：quick / share / voice；空按 quick。预约走 schedule，固定 scheduled。
	LaunchKind string `json:"launchKind"`
}

type MeetingStartReq struct {
	g.Meta `path:"/meetings/{id}/start" method:"post" tags:"会议"`
	Id     int64 `json:"id"`
}

type MeetingStartRes struct{}

type MeetingStopReq struct {
	g.Meta `path:"/meetings/{id}/stop" method:"post" tags:"会议"`
	Id     int64 `json:"id"`
}

type MeetingStopRes struct{}

type MeetingJoinReq struct {
	g.Meta           `path:"/meetings/join" method:"post" tags:"会议"`
	MeetingNo        string `v:"required" json:"meetingNo"`
	DisplayName      string `json:"displayName"`
	Password         string `json:"password"`
	RecordingConsent bool   `json:"recordingConsent"`
}

type MeetingJoinRes struct {
	MeetingId     int64          `json:"meetingId"`
	MeetingNo     string         `json:"meetingNo"`
	ParticipantId string         `json:"participantId"`
	Title         string         `json:"title"`
	Status        string         `json:"status"`
	InitialMedia  InitialMediaVo `json:"initialMedia"`
	// Kind：quick / scheduled / share / voice，会中页按入口区分默认媒体行为。
	Kind string `json:"kind"`
	// Waiting=true 表示这场会开了「允许成员在主持人入会前等待」（第 10 项），
	// 而主持人此刻不在场：本端没有真的加入三方，前端停在"等待主持人"页定时重试入会。
	Waiting bool `json:"waiting"`
}

// InitialMediaVo 回传预约时设定的入会初始媒体状态，由会议页在采集后实际应用。
type InitialMediaVo struct {
	MicOff    bool `json:"micOff"`
	CameraOff bool `json:"cameraOff"`
}

type MeetingLeaveReq struct {
	g.Meta    `path:"/meetings/leave" method:"post" tags:"会议"`
	MeetingId int64 `v:"required" json:"meetingId"`
}

type MeetingLeaveRes struct{}

type MeetingEndReq struct {
	g.Meta    `path:"/meetings/{id}/end" method:"post" tags:"会议"`
	MeetingId int64 `json:"id"`
}

type MeetingEndRes struct{}

type MeetingCancelReq struct {
	g.Meta `path:"/meetings/{id}/cancel" method:"post" tags:"会议"`
	Id     int64 `json:"id"`
}

type MeetingCancelRes struct{}

// 第 6 项：会议只可取消、不可删除，故不再有 MeetingDeleteReq/Res 与 DELETE /meetings/{id}。

// PublicationCreateReq 登记一次本端发布（三方第 10.1 节）。三方 whipUrl 由后端持有，
// 前端拿到的是**三方那侧**的 publicationId 与我方代理路径（PublicationId 取自三方响应原文）。
// 别拿它去 state.streams 里找自己那一路：那里的 id 是我方别名 `st_…`（service/meeting_state.go 的 aliasByPub），
// 定位本端发布要按 ownerId + kind。
type PublicationCreateReq struct {
	g.Meta            `path:"/meetings/{id}/publications" method:"post" tags:"会议"`
	Id                int64  `json:"id"`
	MediaKind         string `json:"mediaKind" v:"required|in:camera,screen,audio"`
	HasVideo          bool   `json:"hasVideo"`
	HasAudio          bool   `json:"hasAudio"`
	Width             int    `json:"width"`
	Height            int    `json:"height"`
	Fps               int    `json:"fps"`
	TargetBitrateKbps int    `json:"targetBitrateKbps"`
	EncodingStrategy  string `json:"encodingStrategy" v:"in:,source_frames,bandwidth_first,optimized,dynamic_gop"`
	TransportMode     string `json:"transportMode" v:"in:,original,cloud"`
	MediaLabel        string `json:"mediaLabel"`
}

type PublicationSettingsReq struct {
	g.Meta            `path:"/meetings/{id}/publications/{pubId}/settings" method:"put" tags:"会议"`
	Id                int64  `json:"id"`
	PubId             string `json:"pubId"`
	TransportMode     string `json:"transportMode" v:"required|in:original,cloud"`
	EncodingStrategy  string `json:"encodingStrategy" v:"in:,source_frames,bandwidth_first,optimized"`
	TargetBitrateKbps int    `json:"targetBitrateKbps"`
}

type PublicationCreateRes struct {
	PublicationId string `json:"publicationId"`
	WhipPath      string `json:"whipPath"`
	// SourceType 我方替这次发布申报的来源（browser_whip|rk_browser_roi）。前端只读它决定要不要
	// 把 H.264 排到编码偏好最前 —— 那一步只对船端浏览器那一路成立，别按"是不是边端"自己猜。
	SourceType string `json:"sourceType"`
}

// PublicationWhipReq 转发浏览器 SDP offer；响应是三方 answer（application/sdp 原文）。
type PublicationWhipReq struct {
	g.Meta `path:"/meetings/{id}/publications/{pubId}/whip" method:"post" tags:"会议"`
	Id     int64  `json:"id"`
	PubId  string `json:"pubId"`
}

type PublicationWhipDeleteReq struct {
	g.Meta `path:"/meetings/{id}/publications/{pubId}/whip" method:"delete" tags:"会议"`
	Id     int64  `json:"id"`
	PubId  string `json:"pubId"`
}

// StreamWhepReq 转发浏览器的 recvonly SDP offer 去订阅一路只有 WHEP 通道的媒体
// （实测岸端手机的音频就只有 audioWhepUrl，没有直连 ZAA1 地址）。响应是三方 answer 原文。
type StreamWhepReq struct {
	g.Meta   `path:"/meetings/{id}/streams/{streamId}/whep" method:"post" tags:"会议"`
	Id       int64  `json:"id"`
	StreamId string `json:"streamId"`
}

// StreamFrameTimesReq 查这一路在船端局域网接收槽上的帧时刻表 —— 统计条「采集时间」的真源。
// 只有 `videoChannel=lanWhep` 那一路有这件事：直连腿的采集时刻在容器帧头里，浏览器自己拿得到。
type StreamFrameTimesReq struct {
	g.Meta   `path:"/meetings/{id}/streams/{streamId}/frame-times" method:"get" tags:"会议"`
	Id       int64  `json:"id"`
	StreamId string `json:"streamId"`
}

// StreamWhepDeleteReq 释放本端订阅这路流时建立的 WHEP 会话（三方不随浏览器关连接回收）。
type StreamWhepDeleteReq struct {
	g.Meta   `path:"/meetings/{id}/streams/{streamId}/whep" method:"delete" tags:"会议"`
	Id       int64  `json:"id"`
	StreamId string `json:"streamId"`
}

type PublicationStopReq struct {
	g.Meta `path:"/meetings/{id}/publications/{pubId}/stop" method:"post" tags:"会议"`
	Id     int64  `json:"id"`
	PubId  string `json:"pubId"`
}

type PublicationStopRes struct{}

// RoiHintReq 上报人脸框，供三方编码器把码率花在人脸（外部契约 §10.3）。
// 坐标是相对编码画面的归一化值（0..1），空 regions 表示清除。
type RoiHintReq struct {
	g.Meta            `path:"/meetings/{id}/publications/{pubId}/roi-hint" method:"post" tags:"会议"`
	Id                int64       `json:"id"`
	PubId             string      `json:"pubId"`
	Detector          string      `json:"detector" v:"required|in:mediapipe_blazeface_short_range"`
	Sequence          int64       `json:"sequence"`
	SourceTimestampMs int64       `json:"sourceTimestampMs"`
	InferenceMs       int         `json:"inferenceMs"`
	Regions           []RoiRegion `json:"regions"`
}

type RoiRegion struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
	Score  float64 `json:"score"`
}

type RoiHintRes struct{}

type MeetingStateReq struct {
	g.Meta `path:"/meetings/{id}/state" method:"get" tags:"会议"`
	Id     int64 `json:"id"`
}

type MeetingFocusReq struct {
	g.Meta   `path:"/meetings/{id}/focus" method:"post" tags:"会议"`
	Id       int64  `json:"id"`
	StreamId string `v:"required" json:"streamId"`
}

type MeetingFocusRes struct{}

type MeetingRecordingReq struct {
	g.Meta `path:"/meetings/{id}/recording/{action}" method:"post" tags:"会议"`
	Id     int64  `json:"id"`
	Action string `v:"required|in:start,stop" json:"action"`
}
type MeetingRecordingRes struct {
	Recording model.RecordingStateVo `json:"recording"`
}

type MeetingMediaReq struct {
	g.Meta   `path:"/meetings/{id}/media/{streamId}/{kind}" method:"get" tags:"会议媒体"`
	Id       int64  `json:"id"`
	StreamId string `json:"streamId"`
	Kind     string `json:"kind"`
}

type WsTicketReq struct {
	g.Meta    `path:"/meetings/ws-ticket" method:"post" tags:"会议"`
	MeetingId int64 `v:"required" json:"meetingId"`
}

// MeetingMediaStateReq 是媒体意图的 REST 快速通道（对齐三方前端 heartbeat + media-state 双通道设计）：
// 意图位决定三方客户端是否渲染这个端的 camera/audio/screen 发布，绝不能只押在 WS 一条腿上——
// WS 未连上/重连窗口里发的 media 消息是静默丢弃的，对端就会整场看不见也听不见这个端。
type MeetingMediaStateReq struct {
	g.Meta    `path:"/meetings/{id}/media-state" method:"post" tags:"会议"`
	Id        int64 `json:"id"`
	CameraOn  *bool `json:"cameraOn"`
	MicOn     *bool `json:"micOn"`
	Sharing   *bool `json:"sharing"`
	Recording *bool `json:"recording"`
}

type MeetingMediaStateRes struct{}

// TelemetryItem 是发布端实测出来的一路编码码率样本，形状与 WS `telemetry` 帧**逐字相同**
// （契约 §6.3 的 TelemetryItem 是这两条通道共用的那一份定义）。
// 字段名照三方的解析器写：它是**原样透传给三方的载荷**、后端不改写就转发，
// 所以属"三方字段名不外溢到契约"那条规则的例外 —— 它不是我域 VO。
type TelemetryItem struct {
	PublicationId              string   `json:"publicationId"`
	SourceVideoBitrateKbps     float64  `json:"sourceVideoBitrateKbps"`
	SourceFps                  float64  `json:"sourceFps"`
	CaptureFps                 *float64 `json:"captureFps,omitempty"`
	PublishFps                 *float64 `json:"publishFps,omitempty"`
	PublishKbps                *float64 `json:"publishKbps,omitempty"`
	DecodedFrameKbps           *float64 `json:"decodedFrameKbps,omitempty"`
	AssociatedAudioBitrateKbps float64  `json:"associatedAudioBitrateKbps"`
}

// MeetingTelemetryReq 是发布端实测码率的 REST 通道。〔硬规则〕**不得只走 WS**：
// 这一项是「原始速率 / 压缩比 / 节省带宽」三个数的唯一真源（订阅端算不出压缩前的数），
// 而三方只认 4 秒内的新鲜样本 —— WS 未连上时消息静默丢弃，就会让**所有订阅者**
// （含三方自家页面）永远停在「原始码率统计中」。理由与 MeetingMediaStateReq 那条同源。
//
// 与 media-state 的关键差别：**只把样本落进会话、不立刻向三方心跳** ——
// 泵每 tick 本来就逐会话发一次（websocket/hub.go 的 poll），多插一次是白加往返，
// 还会把全局单调的 revision 无谓推高。口径与 WS 的 `case "telemetry"` 一致。
type MeetingTelemetryReq struct {
	g.Meta `path:"/meetings/{id}/telemetry" method:"post" tags:"会议"`
	Id     int64           `json:"id"`
	Items  []TelemetryItem `json:"items"`
}

type MeetingTelemetryRes struct{}

// MeetingPrecheckReq 入会前预检：前端在跳预检页之前先确认三方还能加入，
// 避免用户走完设备预览才发现"会议不存在"（第 27 项）。
type MeetingPrecheckReq struct {
	g.Meta    `path:"/meetings/precheck" method:"post" tags:"会议"`
	MeetingNo string `v:"required" json:"meetingNo"`
}

type MeetingPrecheckRes struct {
	Joinable         bool   `json:"joinable"`
	Message          string `json:"message,omitempty"`
	RequiresPassword bool   `json:"requiresPassword,omitempty"`
}

type MeetingMuteAllReq struct {
	g.Meta `path:"/meetings/{id}/mute-all" method:"post" tags:"会控"`
	Id     int64 `json:"id"`
}

type MeetingKickReq struct {
	g.Meta        `path:"/meetings/{id}/kick" method:"post" tags:"会控"`
	Id            int64  `json:"id"`
	ParticipantId string `v:"required" json:"participantId"`
}

type WsTicketRes struct {
	Ticket           string `json:"ticket"`
	ExpiresInSeconds int    `json:"expiresInSeconds"`
}

type MeetingVo struct {
	Id        int64  `json:"id"`
	Title     string `json:"title"`
	MeetingNo string `json:"meetingNo"`
	// ThirdPartyMeetingId 三方平台的会议 ID（UUID 形），回放页用它去查录制清单。
	// 与 MeetingNo（入会会议号）不同：MeetingNo 用于拨入/订阅，这个是录制 API 的路径参数。
	ThirdPartyMeetingId string `json:"thirdPartyMeetingId"`
	StartTime           string `json:"startTime"`
	StartedAt           string `json:"startedAt"`
	DurationMinutes     int    `json:"durationMinutes"`
	Status              string `json:"status"`
	// EndReason 记录正常结束、连续空房超时或历史异常退出。
	EndReason           string `json:"endReason,omitempty"`
	Managed             bool   `json:"managed"`
	LocalStatus         string `json:"localStatus"`
	CloudRecord         bool   `json:"cloudRecord"`
	MuteOnJoin          bool   `json:"muteOnJoin"`
	CameraOffOnJoin     bool   `json:"cameraOffOnJoin"`
	AllowWaiting        bool   `json:"allowWaiting"`
	HasPassword         bool   `json:"hasPassword"`
	HostName            string `json:"hostName"`
	// IsHost 这场会的主持人是不是当前登录用户。前端据此决定"修改/取消"按钮给不给（第 6 项），
	// 后端同样独立校验一遍 —— 前端隐藏按钮不是权限控制。
	IsHost              bool   `json:"isHost"`
	CreatorId           int64  `json:"creatorId"`
	CreatorName         string `json:"creatorName"`
	CreatorPositionName string `json:"creatorPositionName"`
	CreatedAt           string `json:"createdAt"`
	// Kind：quick / scheduled / share / voice，首页入口与近期会议展示用。
	Kind string `json:"kind"`
	// ParticipantCount：已入会人数（参会历史去重）；进行中且上游有数时取上游。
	ParticipantCount int `json:"participantCount"`
	// RecordingState：none 未开录制 / planned 预约了云录制 / ready 已有可回放录制。
	RecordingState string `json:"recordingState"`
	// HasMinutes：是否有可一键打开的会议纪要（当前产品未接纪要时恒 false）。
	HasMinutes bool `json:"hasMinutes"`
}

// MeetingRenameReq 会中修改会议名称：主持人直接生效，其他参会人向主持人发起审批。
type MeetingRenameReq struct {
	g.Meta `path:"/meetings/{id}/title" method:"post" tags:"会议"`
	Id     int64  `json:"id"`
	Title  string `json:"title" v:"required|length:1,100#请输入会议名称|会议名称长度不能超过100个字符"`
}

// MeetingRenameDecisionReq 主持人审批会中改名申请。
type MeetingRenameDecisionReq struct {
	g.Meta    `path:"/meetings/{id}/title-requests/{requestId}" method:"post" tags:"会议"`
	Id        int64  `json:"id"`
	RequestId string `json:"requestId"`
	Approve   bool   `json:"approve"`
}

// MeetingRenameSelfReq 会中修改自己的显示名称：scope=session 仅本场会议（退出重进保持），scope=permanent 同步改账号显示名。
type MeetingRenameSelfReq struct {
	g.Meta      `path:"/meetings/{id}/display-name" method:"post" tags:"会议"`
	Id          int64  `json:"id"`
	DisplayName string `json:"displayName" v:"required|length:1,40#请输入显示名称|显示名称长度不能超过40个字符"`
	Scope       string `json:"scope" v:"required|in:session,permanent#请选择修改范围|修改范围仅支持 session 或 permanent"`
}
