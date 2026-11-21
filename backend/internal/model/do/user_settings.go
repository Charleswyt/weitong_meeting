// =================================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// =================================================================================

package do

import (
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/gtime"
)

// UserSettings is the golang structure of table user_settings for DAO operations like Where/Data.
type UserSettings struct {
	g.Meta                 `orm:"table:user_settings, do:true"`
	UserId                 any         // 主键即外键语义，逻辑引用 sys_user.id；无 DB 外键；行不存在时后端返回全默认值且不落库（惰性）
	CameraDeviceId         any         // 浏览器 MediaStreamTrack.deviceId，128 而非 64 因为 Chrome 值较长；换机器即失效故仅作偏好
	MicrophoneDeviceId     any         // 同上，麦克风 deviceId
	SpeakerDeviceId        any         // 同上，扬声器 deviceId
	VideoResolution        any         // 字典 video_resolution：480p/720p/1080p，作为采集约束的 ideal 值
	VideoMaxFps            any         // 最大帧率，作为采集约束的 ideal 值
	VideoTargetBitrateKbps any         // 目标码率 Kbps，UI 偏好，不直接下发三方
	VbMode                 any         // 字典 vb_mode：off/blur/custom
	VbCustomImageUrl       any         // 自定义背景图 URL，vb_mode=custom 时生效
	FaceEnhancement        any         // 浏览器端美颜开关：1 开 0 关
	CloudRecordDefault     any         // 预约弹窗初始值，不覆盖用户当场改动：1 默认开 0 默认关
	RecordingQuality       any         // 字典 recording_quality：high/medium/low
	RecordingFps           any         // 本地录制画布帧率（UI 只给 10/15/25）
	MirrorVideo            any         // 视频镜像开关：1 开 0 关
	BgBlur                 any         // 背景虚化开关：1 开 0 关；vb_mode 非 off 时以 vb_mode 为准
	MicVolume              any         // 麦克风音量 0-100
	AutoGain               any         // 自动增益
	NoiseSuppression       any         // 降噪
	RecordingSaveDir       any         // 本地录制保存目录显示名
	CreatedAt              *gtime.Time // 创建时间
	UpdatedAt              *gtime.Time // 更新时间。本表无 deleted_at：随 sys_user 软删，读时以 sys_user 状态过滤
}
