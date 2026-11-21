package thirdparty

import (
	"encoding/json"
	"testing"
)

// 夹具的键名照 2026-09-29 扫三方 854 条真实 publication 得到的形状写
// （探针 edge/conference/frontend/scratch/probe-26c-shape.mjs）：
// **源码率只在 transportMetrics 里，顶层没有这个键**。
// 这条测试存在的唯一理由就是我方曾经按顶层解析，于是 sourceBitrateKbps 恒为 0。
const realPublicationWithMetrics = `{
  "publicationId": "pub_x",
  "participantId": "p_1",
  "mediaKind": "camera",
  "status": "ready",
  "hdReady": true,
  "width": 1280,
  "height": 720,
  "fps": 20,
  "sourceType": "rk_browser_roi",
  "cloudSoftwareRoi": false,
  "targetBitrateKbps": 600,
  "transportMetrics": {
    "sourceVideoBitrateKbps": 2400,
    "upstreamVideoBitrateKbps": 610,
    "compressionRatio": 3.93,
    "compressionEstimate": true,
    "bitrateUpdatedAt": 1789000000000,
    "timestampMode": "au_pts"
  }
}`

func decodePub(t *testing.T, raw string) Publication {
	t.Helper()
	var p Publication
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatalf("解码失败: %v", err)
	}
	return p
}

func TestSourceBitrateKbpsReadsTransportMetrics(t *testing.T) {
	p := decodePub(t, realPublicationWithMetrics)
	if got := p.SourceBitrateKbps(); got != 2400 {
		t.Fatalf("源码率应取 transportMetrics 里的 2400，实得 %d（回到顶层读老键就是这个症状）", got)
	}
}

func TestSourceBitrateKbpsPrefersTopLevelWhenPresent(t *testing.T) {
	// 顶层键实测恒缺；留着这条兼容分支是为了三方哪天把值挪回顶层时不必改代码。
	p := decodePub(t, `{"sourceVideoBitrateKbps":1800,"transportMetrics":{"sourceVideoBitrateKbps":900}}`)
	if got := p.SourceBitrateKbps(); got != 1800 {
		t.Fatalf("两处都有值时应以顶层为准，实得 %d", got)
	}
}

func TestSourceBitrateKbpsZeroWhenNeitherLayerHasIt(t *testing.T) {
	// 历史会议的遥测就是空的（854 条样本里非 0 的是 0 条）：必须回 0，
	// 让前端显示 —，不许拿派生值冒充（第 26 项）。
	p := decodePub(t, `{"mediaKind":"camera","transportMetrics":{"upstreamVideoBitrateKbps":0}}`)
	if got := p.SourceBitrateKbps(); got != 0 {
		t.Fatalf("两处都没有时应为 0，实得 %d", got)
	}
}

// 2026-09-29 线上回归的固化：三方把实测值写成一位小数（487.2 / 338.0 / 29.97 / 640.0），
// 而我方这些字段曾声明成 int —— encoding/json 把带小数点的字面量喂给 int 直接报错，
// 于是 /state 与心跳解析全线失败（日志里每 200ms 一条 heartbeat ... failed）。
// 这类字段必须收得下小数，取整只发生在我方边界。
func TestFractionalMeasuredValuesDecode(t *testing.T) {
	p := decodePub(t, `{
	  "width": 640.0,
	  "height": 480.0,
	  "fps": 29.97,
	  "transportMetrics": {"sourceVideoBitrateKbps": 487.2, "upstreamVideoBitrateKbps": 338.0}
	}`)
	if got := p.SourceBitrateKbps(); got != 487 {
		t.Fatalf("487.2 应四舍五入成 487，实得 %d", got)
	}
	// 同一个夹具里的 338.0 此前没人断言：出站码率这一路同样带一位小数，收不进小数
	// 就会把"1072.4 → 1072"变成"1072.4 → 1071"。写成 int(f) 这条必红。
	if got := p.UpstreamBitrateKbps(); got != 338 {
		t.Fatalf("338.0 应取整成 338，实得 %d", got)
	}
	if got := p.FpsInt(); got != 30 {
		t.Fatalf("29.97 应取整成 30，实得 %d", got)
	}
	if p.WidthPx() != 640 || p.HeightPx() != 480 {
		t.Fatalf("分辨率取整错: %dx%d", p.WidthPx(), p.HeightPx())
	}
}

// 出站码率**只有 transportMetrics 这一处**，且没有就是 0。
// 最要紧的一条：源码率有值而出站没有时**绝不许回落到源码率** —— 那两个数是同一条腿上的
// 分子与分母，混成一个就等于把压缩比硬算成 1.00，比不给数更坏。
func TestUpstreamBitrateKbpsNeverFallsBackToSource(t *testing.T) {
	cases := []struct {
		name string
		json string
		want int
	}{
		{"transportMetrics 整个缺失", `{"mediaKind":"camera"}`, 0},
		{"出站值为 0", `{"transportMetrics":{"upstreamVideoBitrateKbps":0}}`, 0},
		{"出站值为负", `{"transportMetrics":{"upstreamVideoBitrateKbps":-12.7}}`, 0},
		{"只有顶层键（三方不这么发，留着也要读到）", `{"upstreamVideoBitrateKbps":500}`, 0},
		{"源码率有、出站没有 —— 必须 0，不许回落成 487",
			`{"sourceVideoBitrateKbps":487.2,"transportMetrics":{"sourceVideoBitrateKbps":487.2}}`, 0},
		{"正常一位小数", `{"transportMetrics":{"upstreamVideoBitrateKbps":1072.4}}`, 1072},
		// 四舍五入而不是截断：338.0 这种整值对 int() 截断是**不敏感**的（两边都得 338），
		// 所以必须有一个 .5 以上的值才能把 roundInt 与 int 分开。这条是 roundInt 方向的唯一钉子。
		{".6 要进位不是截断", `{"transportMetrics":{"upstreamVideoBitrateKbps":1072.6}}`, 1073},
	}
	for _, c := range cases {
		p := decodePub(t, c.json)
		if got := p.UpstreamBitrateKbps(); got != c.want {
			t.Errorf("%s: 应得 %d，实得 %d", c.name, c.want, got)
		}
	}
}

// 缺键与负数都必须落到 0，不能让前端拿到负数去算压缩比。
func TestRoundIntFloorAtZero(t *testing.T) {
	p := decodePub(t, `{"fps": -3.5, "width": 0.4, "transportMetrics":{"sourceVideoBitrateKbps": -12.7}}`)
	if p.FpsInt() != 0 || p.WidthPx() != 0 {
		t.Fatalf("非正数应归 0，实得 fps=%d width=%d", p.FpsInt(), p.WidthPx())
	}
	if got := p.SourceBitrateKbps(); got != 0 {
		t.Fatalf("负的源码率应回 0，实得 %d", got)
	}
}

func TestCompressionKind(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"板卡ROI", `{"sourceType":"rk_roi"}`, "edgeRoi"},
		{"板卡浏览器ROI", `{"sourceType":"rk_browser_roi"}`, "edgeRoi"},
		{"云软件ROI", `{"sourceType":"browser_whip","cloudSoftwareRoi":true}`, "cloudSoftwareRoi"},
		{"浏览器直发", `{"sourceType":"browser_whip","cloudSoftwareRoi":false}`, "none"},
		// 键缺失 ≠ 没压缩：不能据此断言直传，必须报 unknown 让前端保守处理。
		{"三方没带这个键", `{"mediaKind":"camera"}`, "unknown"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := decodePub(t, c.raw).CompressionKind(); got != c.want {
				t.Fatalf("compressionKind 应为 %q，实得 %q", c.want, got)
			}
		})
	}
}

// 取流协商头必须跟着这一路的实际编码走 —— 这是"边端那格永远还在准备中"的真因。
// 2026-10-09 实测：一条 rk_browser_roi 的路按 h264 取，上游回 425 direct_video_not_ready
// 连挂 45 分钟（后端 195 次），而同一场会里 browser_whip 的路按 h264 是通的。
// 所以既不能一刀切 h264，也不能一刀切 hevc：判据只有 sourceType 这一个真源。
func TestVideoCodecFollowsSourceType(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"板卡直发", `{"sourceType":"rk_roi"}`, "hevc"},
		{"板卡处理浏览器流", `{"sourceType":"rk_browser_roi"}`, "hevc"},
		{"浏览器直发原样透传", `{"sourceType":"browser_whip"}`, "h264"},
		{"云软件ROI 不是板卡编码", `{"sourceType":"browser_whip","cloudSoftwareRoi":true}`, "h264"},
		// 键缺失时保住改判据之前的行为，不许拿"未知"当"换一条腿"的理由。
		{"三方没带这个键", `{"mediaKind":"camera"}`, "h264"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			pub := decodePub(t, c.raw)
			if got := pub.VideoCodec(); got != c.want {
				t.Fatalf("videoCodec 应为 %q，实得 %q", c.want, got)
			}
			accept := AcceptForVideoCodec(pub.VideoCodec())
			wantAccept := AcceptZha1H264
			if c.want == "hevc" {
				wantAccept = AcceptZha1Hevc
			}
			if accept != wantAccept {
				t.Fatalf("%s 应按 %s 取流，实得 %s", c.name, wantAccept, accept)
			}
		})
	}
}

// 回放清单的 hasVideo/hasAudio 必须真的解析进来（2026-09-30）。
// 从前 PlaybackStream 没声明这两个键，json 解码时**静默丢掉**，前端只好按 mediaKind 推断，
// 推错一路就是那一整路被静音（回看页 media.muted 的第三项判据就是 !hasAudio）。
// 夹具形状照逆向文档 §12（三方自己的回放页就是读 data.streams[].hasVideo/hasAudio）。
func TestPlaybackStreamCarriesMediaFlags(t *testing.T) {
	raw := `{
	  "partial": false,
	  "timeline": {"startAt": 1789205686, "durationSeconds": 814.926},
	  "streams": [
	    {"recordingId":"rec_cam","displayName":"甲","mediaKind":"camera","mediaLabel":"画面",
	     "hasVideo":true,"hasAudio":false,"playbackUrl":"/a.m3u8","downloadUrl":"/a","offsetSeconds":0,"durationSeconds":10},
	    {"recordingId":"rec_mic","displayName":"甲","mediaKind":"audio","mediaLabel":"声音",
	     "hasVideo":false,"hasAudio":true,"playbackUrl":"/b.m3u8","downloadUrl":"/b","offsetSeconds":0,"durationSeconds":10},
	    {"recordingId":"rec_both","displayName":"乙","mediaKind":"screen","mediaLabel":"共享屏幕",
	     "hasVideo":true,"hasAudio":true,"playbackUrl":"/c.m3u8","downloadUrl":"/c","offsetSeconds":1,"durationSeconds":9}
	  ]
	}`
	var got PlaybackData
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatalf("playback 解析失败: %v", err)
	}
	if len(got.Streams) != 3 {
		t.Fatalf("streams 应 3 条，实得 %d", len(got.Streams))
	}
	want := []struct{ v, a bool }{{true, false}, {false, true}, {true, true}}
	for i, w := range want {
		if got.Streams[i].HasVideo != w.v || got.Streams[i].HasAudio != w.a {
			t.Fatalf("streams[%d] 的 hasVideo/hasAudio 应为 %v/%v，实得 %v/%v",
				i, w.v, w.a, got.Streams[i].HasVideo, got.Streams[i].HasAudio)
		}
	}
	// 键缺失（旧上游）：两个字段落零值 false —— 这**不是**"没有声音"的证据，
	// 前端只在字段缺失时才允许退回按 mediaKind 推断（见 utils/cloudReplay.ts）。
	var legacy PlaybackData
	if err := json.Unmarshal([]byte(`{"streams":[{"recordingId":"r","mediaKind":"camera"}]}`), &legacy); err != nil {
		t.Fatalf("缺键的旧形状也要能解析: %v", err)
	}
	if legacy.Streams[0].HasVideo || legacy.Streams[0].HasAudio {
		t.Fatalf("缺键时两个标志应为 false，实得 %v/%v", legacy.Streams[0].HasVideo, legacy.Streams[0].HasAudio)
	}
}
