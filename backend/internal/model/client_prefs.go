package model

// VideoDeliveryPref 摄像头 / 共享屏幕各一份的传输偏好，发布时作为默认值下发。
type VideoDeliveryPref struct {
	TransportMode     string `json:"transportMode"`
	EncodingStrategy  string `json:"encodingStrategy"`
	TargetBitrateKbps int    `json:"targetBitrateKbps"`
}

// ClientPrefsVo 是原先只存在浏览器 localStorage 里的那批个人偏好，
// 落库后换设备、换浏览器登录同一账号都能拿到同一份。
// 与 PreferenceVo 分开：那边 PUT 是全量覆盖，这里按键增量更新，滑块拖动不会冲掉别的字段。
type ClientPrefsVo struct {
	VideoEnhance    bool              `json:"videoEnhance"`
	SpeakerVolume   int               `json:"speakerVolume"`
	CaptionLanguage string            `json:"captionLanguage"`
	CameraDelivery  VideoDeliveryPref `json:"cameraDelivery"`
	ScreenDelivery  VideoDeliveryPref `json:"screenDelivery"`
}

// ClientPrefsPatch 只带要改的键；缺省键保持库里原值。
type ClientPrefsPatch struct {
	VideoEnhance    *bool              `json:"videoEnhance"`
	SpeakerVolume   *int               `json:"speakerVolume"`
	CaptionLanguage *string            `json:"captionLanguage"`
	CameraDelivery  *VideoDeliveryPref `json:"cameraDelivery"`
	ScreenDelivery  *VideoDeliveryPref `json:"screenDelivery"`
}

func DefaultVideoDeliveryPref() VideoDeliveryPref {
	return VideoDeliveryPref{TransportMode: "original", EncodingStrategy: "source_frames", TargetBitrateKbps: 300}
}

func DefaultClientPrefsVo() *ClientPrefsVo {
	return &ClientPrefsVo{
		VideoEnhance:    true,
		SpeakerVolume:   80,
		CaptionLanguage: "zh",
		CameraDelivery:  DefaultVideoDeliveryPref(),
		ScreenDelivery:  DefaultVideoDeliveryPref(),
	}
}
