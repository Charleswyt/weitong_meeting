package consts

const (
	JwtClaimUserId      = "userId"
	JwtClaimUsername    = "username"
	JwtClaimAccountType = "accountType"
)

// 三方账号类型（对齐 sys_dict_data.dict_type='account_type'）。
const (
	AccountTypeMeetingParticipant = "meeting_participant"
	AccountTypeTempUser           = "temp_user"
	AccountTypeDeviceAdmin        = "device_admin"
	AccountTypeSuperAdmin         = "super_admin"
)

// 字典类型编码（对齐 sys_dict_type.dict_type）。
const (
	DictTypeAccountType      = "account_type"
	DictTypePosition         = "position"
	DictTypeMeetingStatus    = "meeting_status"
	DictTypeLocalSyncStatus  = "local_sync_status"
	DictTypeRecordingQuality = "recording_quality"
	DictTypeVideoResolution  = "video_resolution"
	DictTypeVbMode           = "vb_mode"
)

// 与 meeting_appointment.local_status 列同名 dict_value（见 create.sql）。
const (
	LocalStatusPending = "pending"
	LocalStatusSynced  = "synced"
	LocalStatusFailed  = "failed"
)

// 与 meeting_appointment.status 列同名 dict_value（见 create.sql）。
const (
	MeetingStatusScheduled = "scheduled"
	MeetingStatusStarting  = "starting"
	MeetingStatusRunning   = "running"
	MeetingStatusEnded     = "ended"
	MeetingStatusFailed    = "failed"
	MeetingStatusCancelled = "cancelled"
)

// 会议结束原因（meeting_appointment.end_reason）：区分主持人正常结束与开会人异常退出/离会超时自动结束。
const (
	MeetingEndReasonNormal       = "normal"
	MeetingEndReasonAbnormalExit = "abnormal_exit"
)

// 视频腿的通道机器值（对外契约 StreamVo.videoChannel，不是库里的字典列）。
// 前端按它选播放器，不去猜错误文案：direct 走 GET 拉流，lanWhep 走 WHEP 订阅接口。
const (
	VideoChannelDirect   = "direct"
	VideoChannelLanWhep  = "lanWhep"
	VideoChannelCloudWhep = "cloudWhep" // 公网会议族浏览器 WHEP（sinosat）
)

// 发布来源（三方 publication.sourceType）。三方的判据是"这条视频是不是船端浏览器发的"：
// 船端摄像头/屏幕 → rk_browser_roi（要过 RK 那条接收槽），其余（含船端音频）→ browser_whip。
// 值域还有第三方 rtsp 源的 `rk_roi`，我方不发布那种。
const (
	SourceTypeBrowserWhip  = "browser_whip"
	SourceTypeRkBrowserRoi = "rk_browser_roi"
)

// WHEP 订阅的腿别。同一路流的两条腿在三方侧是两个独立会话，
// 会话键必须带上它（见 session.WhepTarget），否则后订的把先订的拆掉。
const (
	WhepKindAudio = "audio"
	WhepKindVideo = "video"
)
