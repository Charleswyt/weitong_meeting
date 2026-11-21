// ==========================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// ==========================================================================

package internal

import (
	"context"

	"github.com/gogf/gf/v2/database/gdb"
	"github.com/gogf/gf/v2/frame/g"
)

// UserSettingsDao is the data access object for the table user_settings.
type UserSettingsDao struct {
	table    string              // table is the underlying table name of the DAO.
	group    string              // group is the database configuration group name of the current DAO.
	columns  UserSettingsColumns // columns contains all the column names of Table for convenient usage.
	handlers []gdb.ModelHandler  // handlers for customized model modification.
}

// UserSettingsColumns defines and stores column names for the table user_settings.
type UserSettingsColumns struct {
	UserId                 string // 主键即外键语义，逻辑引用 sys_user.id；无 DB 外键；行不存在时后端返回全默认值且不落库（惰性）
	CameraDeviceId         string // 浏览器 MediaStreamTrack.deviceId，128 而非 64 因为 Chrome 值较长；换机器即失效故仅作偏好
	MicrophoneDeviceId     string // 同上，麦克风 deviceId
	SpeakerDeviceId        string // 同上，扬声器 deviceId
	VideoResolution        string // 字典 video_resolution：480p/720p/1080p，作为采集约束的 ideal 值
	VideoMaxFps            string // 最大帧率，作为采集约束的 ideal 值
	VideoTargetBitrateKbps string // 目标码率 Kbps，UI 偏好，不直接下发三方
	VbMode                 string // 字典 vb_mode：off/blur/custom
	VbCustomImageUrl       string // 自定义背景图 URL，vb_mode=custom 时生效
	FaceEnhancement        string // 浏览器端美颜开关：1 开 0 关
	CloudRecordDefault     string // 预约弹窗初始值，不覆盖用户当场改动：1 默认开 0 默认关
	RecordingQuality       string // 字典 recording_quality：high/medium/low
	RecordingFps           string // 本地录制画布帧率（UI 只给 10/15/25）
	MirrorVideo            string // 视频镜像开关：1 开 0 关
	BgBlur                 string // 背景虚化开关：1 开 0 关；vb_mode 非 off 时以 vb_mode 为准
	MicVolume              string // 麦克风音量 0-100
	AutoGain               string // 自动增益
	NoiseSuppression       string // 降噪
	RecordingSaveDir       string // 本地录制保存目录显示名
	CreatedAt              string // 创建时间
	UpdatedAt              string // 更新时间。本表无 deleted_at：随 sys_user 软删，读时以 sys_user 状态过滤
}

// userSettingsColumns holds the columns for the table user_settings.
var userSettingsColumns = UserSettingsColumns{
	UserId:                 "USER_ID",
	CameraDeviceId:         "CAMERA_DEVICE_ID",
	MicrophoneDeviceId:     "MICROPHONE_DEVICE_ID",
	SpeakerDeviceId:        "SPEAKER_DEVICE_ID",
	VideoResolution:        "VIDEO_RESOLUTION",
	VideoMaxFps:            "VIDEO_MAX_FPS",
	VideoTargetBitrateKbps: "VIDEO_TARGET_BITRATE_KBPS",
	VbMode:                 "VB_MODE",
	VbCustomImageUrl:       "VB_CUSTOM_IMAGE_URL",
	FaceEnhancement:        "FACE_ENHANCEMENT",
	CloudRecordDefault:     "CLOUD_RECORD_DEFAULT",
	RecordingQuality:       "RECORDING_QUALITY",
	RecordingFps:           "RECORDING_FPS",
	MirrorVideo:            "MIRROR_VIDEO",
	BgBlur:                 "BG_BLUR",
	MicVolume:              "MIC_VOLUME",
	AutoGain:               "AUTO_GAIN",
	NoiseSuppression:       "NOISE_SUPPRESSION",
	RecordingSaveDir:       "RECORDING_SAVE_DIR",
	CreatedAt:              "CREATED_AT",
	UpdatedAt:              "UPDATED_AT",
}

// NewUserSettingsDao creates and returns a new DAO object for table data access.
func NewUserSettingsDao(handlers ...gdb.ModelHandler) *UserSettingsDao {
	return &UserSettingsDao{
		group:    "default",
		table:    "user_settings",
		columns:  userSettingsColumns,
		handlers: handlers,
	}
}

// DB retrieves and returns the underlying raw database management object of the current DAO.
func (dao *UserSettingsDao) DB() gdb.DB {
	return g.DB(dao.group)
}

// Table returns the table name of the current DAO.
func (dao *UserSettingsDao) Table() string {
	return dao.table
}

// Columns returns all column names of the current DAO.
func (dao *UserSettingsDao) Columns() UserSettingsColumns {
	return dao.columns
}

// Group returns the database configuration group name of the current DAO.
func (dao *UserSettingsDao) Group() string {
	return dao.group
}

// Ctx creates and returns a Model for the current DAO. It automatically sets the context for the current operation.
func (dao *UserSettingsDao) Ctx(ctx context.Context) *gdb.Model {
	model := dao.DB().Model(dao.table)
	for _, handler := range dao.handlers {
		model = handler(model)
	}
	return model.Safe().Ctx(ctx)
}

// Transaction wraps the transaction logic using function f.
// It rolls back the transaction and returns the error if function f returns a non-nil error.
// It commits the transaction and returns nil if function f returns nil.
//
// Note: Do not commit or roll back the transaction in function f,
// as it is automatically handled by this function.
func (dao *UserSettingsDao) Transaction(ctx context.Context, f func(ctx context.Context, tx gdb.TX) error) (err error) {
	return dao.Ctx(ctx).Transaction(ctx, f)
}
