package service

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/gogf/gf/v2/frame/g"

	"cloud-conference-backend/internal/errs"
	"cloud-conference-backend/internal/model"
)

var captionLanguagePattern = regexp.MustCompile(`^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$`)

// GetClientPrefs 读 user_client_pref；行不存在时返回默认值（惰性，不落库）。
func (s *SettingsService) GetClientPrefs(ctx context.Context, userId int64) (*model.ClientPrefsVo, error) {
	out := model.DefaultClientPrefsVo()
	rec, err := g.DB().Model("user_client_pref").Ctx(ctx).Where("USER_ID", userId).One()
	if err != nil {
		return nil, fmt.Errorf("查询个人偏好失败: %w", err)
	}
	if rec.IsEmpty() {
		return out, nil
	}
	out.VideoEnhance = rec["VIDEO_ENHANCE"].Int() == 1
	out.SpeakerVolume = clampInt(rec["SPEAKER_VOLUME"].Int(), 0, 100)
	if lang := strings.TrimSpace(rec["CAPTION_LANGUAGE"].String()); lang != "" {
		out.CaptionLanguage = lang
	}
	out.CameraDelivery = decodeDelivery(rec["CAMERA_DELIVERY"].String())
	out.ScreenDelivery = decodeDelivery(rec["SCREEN_DELIVERY"].String())
	return out, nil
}

// PatchClientPrefs 只覆盖请求里带了的键，返回合并后的完整偏好。
func (s *SettingsService) PatchClientPrefs(ctx context.Context, userId int64, in *model.ClientPrefsPatch) (*model.ClientPrefsVo, error) {
	cur, err := s.GetClientPrefs(ctx, userId)
	if err != nil {
		return nil, err
	}
	if in.VideoEnhance != nil {
		cur.VideoEnhance = *in.VideoEnhance
	}
	if in.SpeakerVolume != nil {
		cur.SpeakerVolume = clampInt(*in.SpeakerVolume, 0, 100)
	}
	if in.CaptionLanguage != nil {
		lang := strings.TrimSpace(*in.CaptionLanguage)
		if !captionLanguagePattern.MatchString(lang) {
			return nil, errs.Bizf("字幕语言不正确")
		}
		cur.CaptionLanguage = lang
	}
	if in.CameraDelivery != nil {
		if err := validateDelivery(in.CameraDelivery); err != nil {
			return nil, err
		}
		cur.CameraDelivery = *in.CameraDelivery
	}
	if in.ScreenDelivery != nil {
		if err := validateDelivery(in.ScreenDelivery); err != nil {
			return nil, err
		}
		cur.ScreenDelivery = *in.ScreenDelivery
	}

	camera, _ := json.Marshal(cur.CameraDelivery)
	screen, _ := json.Marshal(cur.ScreenDelivery)
	_, err = g.DB().Exec(ctx, `
		INSERT INTO user_client_pref (USER_ID, VIDEO_ENHANCE, SPEAKER_VOLUME, CAPTION_LANGUAGE, CAMERA_DELIVERY, SCREEN_DELIVERY, UPDATED_AT)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(USER_ID) DO UPDATE SET
			VIDEO_ENHANCE = excluded.VIDEO_ENHANCE,
			SPEAKER_VOLUME = excluded.SPEAKER_VOLUME,
			CAPTION_LANGUAGE = excluded.CAPTION_LANGUAGE,
			CAMERA_DELIVERY = excluded.CAMERA_DELIVERY,
			SCREEN_DELIVERY = excluded.SCREEN_DELIVERY,
			UPDATED_AT = excluded.UPDATED_AT
	`, userId, boolToInt(cur.VideoEnhance), cur.SpeakerVolume, cur.CaptionLanguage,
		string(camera), string(screen), time.Now().Format("2006-01-02 15:04:05"))
	if err != nil {
		return nil, fmt.Errorf("保存个人偏好失败: %w", err)
	}
	return cur, nil
}

func validateDelivery(d *model.VideoDeliveryPref) error {
	switch d.TransportMode {
	case "original", "cloud":
	default:
		return errs.Bizf("传输方式不正确")
	}
	switch d.EncodingStrategy {
	case "source_frames", "bandwidth_first", "optimized":
	default:
		return errs.Bizf("压缩策略不正确")
	}
	if d.TargetBitrateKbps < 20 || d.TargetBitrateKbps > 6000 {
		return errs.Bizf("云端目标码率需在 20 至 6000 kbps 之间")
	}
	return nil
}

func decodeDelivery(raw string) model.VideoDeliveryPref {
	def := model.DefaultVideoDeliveryPref()
	if strings.TrimSpace(raw) == "" {
		return def
	}
	var d model.VideoDeliveryPref
	if err := json.Unmarshal([]byte(raw), &d); err != nil || validateDelivery(&d) != nil {
		return def
	}
	return d
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
