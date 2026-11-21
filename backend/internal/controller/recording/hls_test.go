package recording

import "testing"

// 回放能否出声，全看清单里的 URI 有没有被改写到我方代理路径上：
// 上游既可能给相对名，也可能给带自签证书主机的绝对 URL，两种都要收。
func TestRewriteHlsRewritesBothUriForms(t *testing.T) {
	const id = "rec_pub_meeting_1_a_participant_1_b_pub_1_c"
	upstream := "#EXTM3U\n" +
		"#EXT-X-KEY:METHOD=AES-128,URI=\"https://47.114.83.151/keys/priv.key\"\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=1280x720\n" +
		"720p.m3u8\n" +
		"https://47.114.83.151/api/frontend/conference-management/recordings/" + id + "/seg-1.ts?sig=x\n" +
		"seg-2.ts\n"

	got := rewriteHls(upstream, id)
	want := map[string]bool{
		"/api/v1/recordings/" + id + "/hls/720p.m3u8":           false,
		"/api/v1/recordings/" + id + "/hls/seg-1.ts":            false,
		"/api/v1/recordings/" + id + "/hls/seg-2.ts":            false,
		`URI="/api/v1/recordings/` + id + `/hls/keys/priv.key"`: false,
	}
	for w := range want {
		want[w] = contains(got, w)
	}
	for w, ok := range want {
		if !ok {
			t.Errorf("改写后的清单缺少 %q，实际：\n%s", w, got)
		}
	}
	// 密钥 URI 是绝对地址且不在录制目录下，不该被当成录制资产拼进 /hls/ 前缀
	if contains(got, "/hls/https://") {
		t.Errorf("绝对 URL 被错误嵌套：%s", got)
	}
}

func TestSafeAssetRelRejectsEscapePaths(t *testing.T) {
	for _, bad := range []string{"", "/abs.ts", "../etc/passwd", "a/../../b", "http://x/y", "a b.ts", "?x=1"} {
		if safeAssetRel(bad) {
			t.Errorf("safeAssetRel(%q) 应为 false", bad)
		}
	}
	for _, ok := range []string{"seg-1.ts", "720p/seg.ts", "a-b_c.1.ts"} {
		if !safeAssetRel(ok) {
			t.Errorf("safeAssetRel(%q) 应为 true", ok)
		}
	}
}

func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
