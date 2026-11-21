package model

type RecordingStateVo struct {
	Active bool   `json:"active"`
	State  string `json:"state"` // idle/starting/recording/stopping/error
}

type ParticipantVo struct {
	Id        string `json:"id"`
	Name      string `json:"name"`
	IsHost    bool   `json:"isHost"`
	NodeType  string `json:"nodeType"` // edge/cloud
	CameraOn  bool   `json:"cameraOn"`
	MicOn     bool   `json:"micOn"`
	Sharing   bool   `json:"sharing"`
	Recording bool   `json:"recording"`
	Account   string `json:"-"`                // 三方账号名，只在服务内部匹配头像/受邀名单，不外泄给前端（契约 §2）
	Avatar    string `json:"avatar,omitempty"` // 由 sys_user.third_party_account 匹配得出，无则空
}

// InvitedVo 是"受邀名单"里的一条。上游只上报已入会成员，受邀未入会者只能由本域数据得出。
type InvitedVo struct {
	UserId        int64  `json:"userId"`
	Name          string `json:"name"`
	Avatar        string `json:"avatar,omitempty"` // sys_user.avatar 路径；没传过头像就空（契约 §invited）
	Joined        bool   `json:"joined"`
	ParticipantId string `json:"participantId"`
}

type StreamEndpointsVo struct {
	Video string `json:"video,omitempty"`
	Audio string `json:"audio,omitempty"`
}

// VideoStats contains observations of one video publication. Nil means no current sample.
type VideoStats struct {
	CaptureFps      *float64 `json:"captureFps"`
	PublishFps      *float64 `json:"publishFps"`
	CloudInputFps   *float64 `json:"cloudInputFps"`
	CloudOutputFps  *float64 `json:"cloudOutputFps"`
	CloudInputKbps  *float64 `json:"cloudInputKbps"`
	CloudOutputKbps *float64 `json:"cloudOutputKbps"`
}

type StreamVo struct {
	VideoStats        *VideoStats `json:"videoStats,omitempty"`
	TransportMode     string      `json:"transportMode,omitempty"`
	EncodingStrategy  string      `json:"encodingStrategy,omitempty"`
	Revision          int         `json:"revision,omitempty"`
	TargetBitrateKbps int         `json:"targetBitrateKbps,omitempty"`

	Id                string `json:"id"`
	OwnerId           string `json:"ownerId"`
	OwnerName         string `json:"ownerName"`
	Kind              string `json:"kind"`
	Video             bool   `json:"video"`
	Audio             bool   `json:"audio"`
	Width             int    `json:"width"`
	Height            int    `json:"height"`
	Fps               int    `json:"fps"`
	SourceBitrateKbps int    `json:"sourceBitrateKbps"`
	// IngressBitrateKbps 这一路**进入分发面时实测到的出站码率**，与 SourceBitrateKbps 在同一条腿上。
	// 本端那一路的压缩比分母就是它 —— 不是本端下行接收速率（那是另一条腿，混进来倍率没有意义）。
	// 0 = 没给，前端显示"统计中"。不加 omitempty：与 sourceBitrateKbps 同策略，"没给"要显式可判。
	IngressBitrateKbps int `json:"ingressBitrateKbps"`
	// CompressionKind 本域语义枚举 none|edgeRoi|cloudSoftwareRoi|unknown：这一路经过哪一道二次压缩。
	// 三方的 sourceType / cloudSoftwareRoi 不外溢到契约；'none' 时前端不报压缩倍率（第 26 项）。
	CompressionKind string `json:"compressionKind"`
	// CompressionRatio 三方在该路发布记录里直接上报的压缩倍率：本端两个数凑不出倍率时的退路。
	// 0 = 三方没给，前端显示"统计中"，不许拿派生值冒充。倍率无单位，带小数原样传（取整会把 2.31 倍说成 2 倍）。
	CompressionRatio float64 `json:"compressionRatio,omitempty"`
	// CompressionEstimated true = 上面那个值是三方估算而非实测，界面要照实标出来。
	CompressionEstimated bool `json:"compressionEstimated,omitempty"`
	// VideoCodec 本域语义枚举 h264|hevc：这一路直连视频实际是什么编码，前端据此探测解码器。
	// 取错就是一条永远"还在准备中"的死瓦片（后端按另一条腿取流时上游只回 425）。
	VideoCodec string `json:"videoCodec"`
	// VideoChannel 本域语义枚举 direct|lanWhep|cloudWhep|空：这一路的视频腿走哪条通道，前端按它选播放器。
	// 空 = 上游有视频端点但本实例一条腿都接不通（例如云端实例收到只给了船端局域网通道的发布）。
	// 直连是 GET 拉流（endpoints.video），lanWhep 是船端局域网 WHEP（streams/:id/whep）。
	VideoChannel string            `json:"videoChannel,omitempty"`
	Active       bool              `json:"active"`
	Endpoints    StreamEndpointsVo `json:"endpoints"`
}

type MeetingStateVo struct {
	MeetingId        int64            `json:"meetingId"`
	Status           string           `json:"status"`
	StartedAt        string           `json:"startedAt"`
	ServerTime       int64            `json:"serverTime"`
	ClockDriftMs     float64          `json:"clockDriftMs"`
	HostId           string           `json:"hostId"`
	ParticipantCount int              `json:"participantCount"`
	CloudRecord      bool             `json:"cloudRecord"`
	Recording        RecordingStateVo `json:"recording"`
	Participants     []ParticipantVo  `json:"participants"`
	Invited          []InvitedVo      `json:"invited"`
	Streams          []StreamVo       `json:"streams"`
}
