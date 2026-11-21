package service

import (
	"context"
	"fmt"

	"cloud-conference-backend/internal/dao"
	"cloud-conference-backend/internal/model"
	"cloud-conference-backend/internal/model/do"
	"cloud-conference-backend/internal/model/entity"
)

type SettingsService struct{}

func NewSettingsService() *SettingsService {
	return &SettingsService{}
}

// GetPreferences 读 user_settings；行不存在时返回全默认值且不落库（惰性）。
func (s *SettingsService) GetPreferences(ctx context.Context, userId int64) (*model.PreferenceVo, error) {
	// 没写过偏好是正常首访（注释里就写着"惰性"），不是故障：Scan 零行会返回 sql.ErrNoRows，
	// 若顺着 err 分支走，用户第一次打开设置页就会撞「系统异常」。
	rec, err := dao.UserSettings.Ctx(ctx).Where(do.UserSettings{UserId: userId}).One()
	if err != nil {
		return nil, fmt.Errorf("查询用户偏好失败: %w", err)
	}
	if rec.IsEmpty() {
		return model.DefaultPreferenceVo(), nil
	}
	var row entity.UserSettings
	if err := rec.Struct(&row); err != nil {
		return nil, fmt.Errorf("解析用户偏好失败: %w", err)
	}
	return &model.PreferenceVo{
		CameraDeviceId:         row.CameraDeviceId,
		MicrophoneDeviceId:     row.MicrophoneDeviceId,
		SpeakerDeviceId:        row.SpeakerDeviceId,
		VideoResolution:        row.VideoResolution,
		VideoMaxFps:            row.VideoMaxFps,
		VideoTargetBitrateKbps: row.VideoTargetBitrateKbps,
		VbMode:                 row.VbMode,
		VbCustomImageUrl:       row.VbCustomImageUrl,
		FaceEnhancement:        row.FaceEnhancement,
		CloudRecordDefault:     row.CloudRecordDefault,
		RecordingQuality:       row.RecordingQuality,
		RecordingFps:           normalizeRecordingFps(row.RecordingFps),
		MirrorVideo:            row.MirrorVideo == 1,
		BgBlur:                 row.BgBlur == 1,
		MicVolume:              row.MicVolume,
		AutoGain:               row.AutoGain == 1,
		NoiseSuppression:       row.NoiseSuppression == 1,
		RecordingSaveDir:       row.RecordingSaveDir,
	}, nil
}

// UpdatePreferences 先 Update；RowsAffected==0 时 Insert（user_id 主键天然 upsert 安全）。
// 达梦 UPDATE 命中即 1（含值不变），不存在 0 —— 见项目记忆 `dm-update-rows-affected-matched`。
func (s *SettingsService) UpdatePreferences(ctx context.Context, userId int64, in *model.PreferenceVo) error {
	data := do.UserSettings{
		UserId:                 userId,
		CameraDeviceId:         in.CameraDeviceId,
		MicrophoneDeviceId:     in.MicrophoneDeviceId,
		SpeakerDeviceId:        in.SpeakerDeviceId,
		VideoResolution:        in.VideoResolution,
		VideoMaxFps:            in.VideoMaxFps,
		VideoTargetBitrateKbps: in.VideoTargetBitrateKbps,
		VbMode:                 in.VbMode,
		VbCustomImageUrl:       in.VbCustomImageUrl,
		FaceEnhancement:        in.FaceEnhancement,
		CloudRecordDefault:     in.CloudRecordDefault,
		RecordingQuality:       in.RecordingQuality,
		RecordingFps:           normalizeRecordingFps(in.RecordingFps),
		MirrorVideo:            boolToInt(in.MirrorVideo),
		BgBlur:                 boolToInt(in.BgBlur),
		MicVolume:              in.MicVolume,
		AutoGain:               boolToInt(in.AutoGain),
		NoiseSuppression:       boolToInt(in.NoiseSuppression),
		RecordingSaveDir:       in.RecordingSaveDir,
	}
	res, err := dao.UserSettings.Ctx(ctx).Where(do.UserSettings{UserId: userId}).Data(data).Update()
	if err != nil {
		return fmt.Errorf("更新用户偏好失败: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("读取影响行数失败: %w", err)
	}
	if affected > 0 {
		return nil
	}
	if _, err := dao.UserSettings.Ctx(ctx).Data(data).Insert(); err != nil {
		return fmt.Errorf("插入用户偏好失败: %w", err)
	}
	return nil
}

// normalizeRecordingFps：新档 25/30/60/120；0 与旧档 10/15 一律落到默认 30。
func normalizeRecordingFps(fps int) int {
	switch fps {
	case 25, 30, 60, 120:
		return fps
	default:
		return 30
	}
}
