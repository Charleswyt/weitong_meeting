package middleware

import (
	"net/http/httptest"
	"testing"

	"github.com/gogf/gf/v2/net/ghttp"
)

// 票参只该接住"浏览器原生加载器取只读资产"这一类请求。
// 写操作一旦因票参可达，一个泄露的 URL 就不再只是"被人看到一帧画面"，而是"被人停掉一场会"。
func TestAcceptsQueryToken_ReadOnlyAssetShapes(t *testing.T) {
	cases := []struct {
		method string
		path   string
		want   bool
	}{
		{"GET", "/api/v1/meetings/97/media/stream_1/video", true},
		{"GET", "/api/v1/meetings/97/media/stream_1/audio", true},
		{"GET", "/api/v1/users/2/avatar", true},
		{"GET", "/api/v1/recordings/5/playlist.m3u8", true},
		{"GET", "/api/v1/recordings/5/hls/seg-1.ts", true},
		{"GET", "/api/v1/recordings/5/download", true},

		{"DELETE", "/api/v1/meetings/97", false},
		{"POST", "/api/v1/meetings/97/end", false},
		{"POST", "/api/v1/meetings/97/stop", false},
		{"POST", "/api/v1/meetings/97/focus", false},
		{"POST", "/api/v1/meetings/97/recording/start", false},
		{"POST", "/api/v1/meetings/97/publications/pub_1/whip", false},
		{"DELETE", "/api/v1/meetings/97/publications/pub_1/whip", false},
		{"POST", "/api/v1/meetings/97/media-state", false},
		{"POST", "/api/v1/meetings/97/telemetry", false},
		{"POST", "/api/v1/meetings/97/leave", false},
		{"POST", "/api/v1/meetings/schedule", false},
		{"GET", "/api/v1/meetings/97", false},
		{"GET", "/api/v1/meetings/97/state", false},
		{"GET", "/api/v1/meetings/list", false},
		{"GET", "/api/v1/meetings/97/media/stream_1", false},
		{"GET", "/api/v1/meetings/97/media/stream_1/video/extra", false},
		{"GET", "/api/v1/meetings/97/media//video", false},
		{"GET", "/api/v1/meetings//media/s/video", false},

		{"GET", "/api/v1/users", false},
		{"GET", "/api/v1/users/me/avatar", false},
		{"DELETE", "/api/v1/users/me/avatar", false},
		{"POST", "/api/v1/users/me/avatar", false},
		{"GET", "/api/v1/recordings/list", false},
		{"GET", "/api/v1/recordings/97/playback", false},
		{"DELETE", "/api/v1/recordings/5", false},
		{"GET", "/api/v1/chat/messages", false},
		{"GET", "/api/v1/settings/", false},
	}
	for _, c := range cases {
		r := &ghttp.Request{Request: httptest.NewRequest(c.method, c.path, nil)}
		if got := acceptsQueryToken(r); got != c.want {
			t.Errorf("%s %s: acceptsQueryToken=%v, want %v", c.method, c.path, got, c.want)
		}
	}
}

// 会被交给解码器的媒体路径必须回真 4xx；其余仍走统一信封。
// 判错方向的两种后果都不轻：清单/分片走信封 → hls.js 把错误文本当媒体喂给解复用器；
// 下载走真状态码 → 前端那段"先试 JSON 再落 blob"的取词逻辑读不到 msg，用户只剩一句「下载失败」。
func TestIsDecodedMediaPath(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"/api/v1/recordings/5/playlist.m3u8", true},
		{"/api/v1/recordings/5/hls/seg-1.ts", true},
		{"/api/v1/recordings/5/hls/variant/audio.m3u8", true},
		{"/api/v1/meetings/97/media/stream_1/video", true},

		{"/api/v1/recordings/5/download", false},
		{"/api/v1/recordings/list", false},
		{"/api/v1/recordings/97/playback", false},
		{"/api/v1/recordings//playlist.m3u8", false},
		{"/api/v1/recordings/5/hls", false},
		{"/api/v1/meetings/97", false},
		{"/api/v1/users/2/avatar", false},
	}
	for _, c := range cases {
		if got := isDecodedMediaPath(c.path); got != c.want {
			t.Errorf("%s: isDecodedMediaPath=%v, want %v", c.path, got, c.want)
		}
	}
}
