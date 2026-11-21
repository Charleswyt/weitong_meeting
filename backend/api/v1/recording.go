package v1

import "github.com/gogf/gf/v2/frame/g"

type RecordingListReq struct {
	g.Meta   `path:"/recordings/list" method:"get" tags:"录制"`
	PageNum  int    `json:"pageNum"`
	PageSize int    `json:"pageSize"`
	Type     string `v:"in:,cloud,local" json:"type"`
	Keyword  string `json:"keyword"`
	Days     int    `json:"days"`
}

type RecordingListRes struct {
	Rows  []RecordingVo `json:"rows"`
	Total int           `json:"total"`
}

type RecordingPlaybackReq struct {
	g.Meta    `path:"/recordings/{meetingId}/playback" method:"get" tags:"录制"`
	MeetingId string `json:"meetingId"`
}

type RecordingPlaybackRes struct {
	Partial  bool              `json:"partial"`
	Meeting  *PlaybackMeeting  `json:"meeting"`
	Timeline *PlaybackTimeline `json:"timeline"`
	Streams  []PlaybackStream  `json:"streams"`
}

type RecordingDownloadReq struct {
	g.Meta      `path:"/recordings/{recordingId}/download" method:"get" tags:"录制"`
	RecordingId string `json:"recordingId"`
}

type RecordingDownloadRes struct{}

type RecordingDeleteReq struct {
	g.Meta      `path:"/recordings/{recordingId}" method:"delete" tags:"录制"`
	RecordingId string `json:"recordingId"`
}

type RecordingDeleteRes struct {
	DeletedFiles int   `json:"deletedFiles"`
	DeletedBytes int64 `json:"deletedBytes"`
}

type RecordingVo struct {
	RecordingId string `json:"recordingId"`
	MeetingId   string `json:"meetingId"`
	// MeetingNumber 是**三方会议号** —— 本域只有这一个入会号，没有"本地会议号"这种东西。
	// Go 字段名镜像三方摘要里的字段名，线格式用我方形状 meetingNo（与 PlaybackMeeting 同例）。
	// 三方目录里挂不到会的孤立录像给空串，不拿别的键冒充。
	MeetingNumber string  `json:"meetingNo"`
	Title         string  `json:"title"` // 会议名（我方语义，不是上游拼接串）
	Participant   string  `json:"participant"`
	Status        string  `json:"status"`
	MediaKind     string  `json:"mediaKind"`     // camera / audio / screen，空为未识别
	MediaLabel    string  `json:"mediaLabel"`    // 画面 / 声音 / 共享屏幕
	RecordingType string  `json:"recordingType"` // cloud / local
	Deletable     bool    `json:"deletable"`     // 只看这条当前账号能不能删
	StartedAt     string  `json:"startedAt"`
	DurationSec   float64 `json:"durationSec"`
	// 同场聚合（该场**全部**条目算出，与本页翻了第几页无关）：起点锚 + 时间轴跨度。
	// 卡片只要按已加载的行推跨度就会算短，见契约 §6.5 与 ADR-0076 三。meetingId 为空时为空串/0。
	MeetingStartedAt string  `json:"meetingStartedAt"`
	MeetingSpanSec   float64 `json:"meetingSpanSec"`
	FileSizeBytes    int64   `json:"fileSizeBytes"`
	PlaybackUrl      string  `json:"playbackUrl"`
	DownloadUrl      string  `json:"downloadUrl"`
}

type PlaybackMeeting struct {
	MeetingId     string `json:"meetingId"`
	MeetingNumber string `json:"meetingNo"`
	Title         string `json:"title"`
	StartedAt     int64  `json:"startedAt"`
}

type PlaybackTimeline struct {
	StartAt     int64   `json:"startAt"`
	DurationSec float64 `json:"durationSeconds"`
}

type PlaybackStream struct {
	RecordingId string `json:"recordingId"`
	DisplayName string `json:"displayName"`
	MediaKind   string `json:"mediaKind"`
	MediaLabel  string `json:"mediaLabel"`
	// 上游对这条发布实际有没有画面/声音的判定，原样透传给回看页（契约 §6.5）。
	// 前端**不得**再由 mediaKind 推断：猜错一路就是整路静音。
	HasVideo    bool    `json:"hasVideo"`
	HasAudio    bool    `json:"hasAudio"`
	PlaybackUrl string  `json:"playbackUrl"`
	DownloadUrl string  `json:"downloadUrl"`
	OffsetSec   float64 `json:"offsetSeconds"`
	DurationSec float64 `json:"durationSeconds"`
}
