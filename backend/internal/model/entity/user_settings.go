// =================================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// =================================================================================

package entity

import (
	"github.com/gogf/gf/v2/os/gtime"
)

// UserSettings is the golang structure for table user_settings.
type UserSettings struct {
	UserId                 int64       `json:"uSERID"                 orm:"USER_ID"                   ` // 主键即外键语义，逻辑引用 sys_user.id；无 DB 外键；行不存在时后端返回全默认值且不落库（惰性）
	CameraDeviceId         string      `json:"cAMERADEVICEID"         orm:"CAMERA_DEVICE_ID"          ` // 浏览器 MediaStreamTrack.deviceId，128 而非 64 因为 Chrome 值较长；换机器即失效故仅作偏好
	MicrophoneDeviceId     string      `json:"mICROPHONEDEVICEID"     orm:"MICROPHONE_DEVICE_ID"      ` // 同上，麦克风 deviceId
	SpeakerDeviceId        string      `json:"sPEAKERDEVICEID"        orm:"SPEAKER_DEVICE_ID"         ` // 同上，扬声器 deviceId
	VideoResolution        string      `json:"vIDEORESOLUTION"        orm:"VIDEO_RESOLUTION"          ` // 字典 video_resolution：480p/720p/1080p，作为采集约束的 ideal 值
	VideoMaxFps            int         `json:"vIDEOMAXFPS"            orm:"VIDEO_MAX_FPS"             ` // 最大帧率，作为采集约束的 ideal 值
	VideoTargetBitrateKbps int         `json:"vIDEOTARGETBITRATEKBPS" orm:"VIDEO_TARGET_BITRATE_KBPS" ` // 目标码率 Kbps，UI 偏好，不直接下发三方
	VbMode                 string      `json:"vBMODE"                 orm:"VB_MODE"                   ` // 字典 vb_mode：off/blur/custom
	VbCustomImageUrl       string      `json:"vBCUSTOMIMAGEURL"       orm:"VB_CUSTOM_IMAGE_URL"       ` // 自定义背景图 URL，vb_mode=custom 时生效
	FaceEnhancement        int         `json:"fACEENHANCEMENT"        orm:"FACE_ENHANCEMENT"          ` // 浏览器端美颜开关：1 开 0 关
	CloudRecordDefault     int         `json:"cLOUDRECORDDEFAULT"     orm:"CLOUD_RECORD_DEFAULT"      ` // 预约弹窗初始值，不覆盖用户当场改动：1 默认开 0 默认关
	RecordingQuality       string      `json:"rECORDINGQUALITY"       orm:"RECORDING_QUALITY"         ` // 字典 recording_quality：high/medium/low
	RecordingFps           int         `json:"rECORDINGFPS"           orm:"RECORDING_FPS"             ` // 本地录制画布帧率（UI 只给 10/15/25）
	MirrorVideo            int         `json:"mIRRORVIDEO"            orm:"MIRROR_VIDEO"              ` // 视频镜像开关：1 开 0 关
	BgBlur                 int         `json:"bGBLUR"                 orm:"BG_BLUR"                   ` // 背景虚化开关：1 开 0 关；vb_mode 非 off 时以 vb_mode 为准
	MicVolume              int         `json:"mICVOLUME"              orm:"MIC_VOLUME"                ` // 麦克风音量 0-100
	AutoGain               int         `json:"aUTOGAIN"               orm:"AUTO_GAIN"                 ` // 自动增益
	NoiseSuppression       int         `json:"nOISESUPPRESSION"       orm:"NOISE_SUPPRESSION"         ` // 降噪
	RecordingSaveDir       string      `json:"rECORDINGSAVEDIR"       orm:"RECORDING_SAVE_DIR"        ` // 本地录制保存目录显示名
	CreatedAt              *gtime.Time `json:"cREATEDAT"              orm:"CREATED_AT"                ` // 创建时间
	UpdatedAt              *gtime.Time `json:"uPDATEDAT"              orm:"UPDATED_AT"                ` // 更新时间。本表无 deleted_at：随 sys_user 软删，读时以 sys_user 状态过滤
}
