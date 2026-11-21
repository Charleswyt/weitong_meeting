package model

// PreferenceVo 与 user_settings 表的扁平列一一对应。
// GET /api/v1/settings/ 直接返回它；PUT /api/v1/settings/ 请求体也是它。
// 前端契约见 edge/conference/contracts/api-contract.md §6.6。
type PreferenceVo struct {
	CameraDeviceId         string `json:"cameraDeviceId"         v:"max-length:128"`
	MicrophoneDeviceId     string `json:"microphoneDeviceId"     v:"max-length:128"`
	SpeakerDeviceId        string `json:"speakerDeviceId"        v:"max-length:128"`
	VideoResolution        string `json:"videoResolution"        v:"required|in:480p,720p,1080p"`
	VideoMaxFps            int    `json:"videoMaxFps"            v:"required|between:5,60"`
	// 0 = 自适应（不设编码器 maxBitrate）；其余为上限 Kbps。
	VideoTargetBitrateKbps int    `json:"videoTargetBitrateKbps" v:"required|between:0,1000"`
	VbMode                 string `json:"vbMode"                 v:"required|in:off,blur,custom"`
	VbCustomImageUrl       string `json:"vbCustomImageUrl"       v:"max-length:256"`
	FaceEnhancement        int    `json:"faceEnhancement"        v:"in:0,1"`
	CloudRecordDefault     int    `json:"cloudRecordDefault"     v:"in:0,1"`
	RecordingQuality       string `json:"recordingQuality"       v:"required|in:high,medium,low"`
	RecordingFps           int    `json:"recordingFps"           v:"required|in:0,25,30,60,120"`
	MirrorVideo            bool   `json:"mirrorVideo"`
	BgBlur                 bool   `json:"bgBlur"`
	MicVolume              int    `json:"micVolume"  v:"between:0,100"`
	AutoGain               bool   `json:"autoGain"`
	NoiseSuppression       bool   `json:"noiseSuppression"`
	RecordingSaveDir       string `json:"recordingSaveDir" v:"max-length:256"`
}

// DefaultPreferenceVo 返回 user_settings 行不存在时的默认值。
// 与 create.sql 里各列的 DEFAULT 保持一致。
func DefaultPreferenceVo() *PreferenceVo {
	return &PreferenceVo{
		VideoResolution:        "1080p",
		VideoMaxFps:            30,
		VideoTargetBitrateKbps: 0,
		VbMode:                 "off",
		FaceEnhancement:        0,
		CloudRecordDefault:     1,
		RecordingQuality:       "high",
		RecordingFps:           30,
		MirrorVideo:            true,
		BgBlur:                 false,
		MicVolume:              80,
		AutoGain:               true,
		NoiseSuppression:       true,
	}
}
