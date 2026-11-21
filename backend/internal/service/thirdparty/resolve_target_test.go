package thirdparty

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

// 形状实测自两个 origin 的同一套三方系统（2026-10-10 对拍）：
//   - 云端 https://47.114.83.151（mode 缺省 = cloud）：whipUrl 是绝对地址
//   - 船端网关 https://10.66.216.73:18680（meta zwt-meeting-mode=ship-local）：
//     whipUrl 是 `/__ship_cloud_media/<base64url(云端绝对地址)>`，只有跟"我方刚调的那个 origin"同源才成立
func TestResolveTarget(t *testing.T) {
	a := New()
	cases := []struct {
		name, env, target, want string
	}{
		{
			"船端网关的裸路径补到网关 origin",
			"https://10.66.216.73:18680",
			"/__ship_cloud_media/aHR0cHM6Ly80Ny4xMTQuODMuMTUxL2NvbmZlcmVuY2UvYnJvd3Nlci9tMS9wdTEvd2hpcA",
			"https://10.66.216.73:18680/__ship_cloud_media/aHR0cHM6Ly80Ny4xMTQuODMuMTUxL2NvbmZlcmVuY2UvYnJvd3Nlci9tMS9wdTEvd2hpcA",
		},
		{
			"云端的绝对地址原样通过",
			"https://47.114.83.151",
			"https://47.114.83.151/conference/browser/m1/pu1/whip?ticket=abc&role=publisher",
			"https://47.114.83.151/conference/browser/m1/pu1/whip?ticket=abc&role=publisher",
		},
		{
			"网关带路径前缀时按 RFC 只取 origin（根路径不吃前缀）",
			"https://10.66.216.73:18680/ship",
			"/__ship_lan_whep/rk1/whep",
			"https://10.66.216.73:18680/__ship_lan_whep/rk1/whep",
		},
		{
			"http 与端口要保住",
			"http://10.66.216.73:18080",
			"/__ship_local_media/pub_1/whip",
			"http://10.66.216.73:18080/__ship_local_media/pub_1/whip",
		},
		{
			"三方不给前导斜杠也不吞",
			"https://10.66.216.73:18680",
			"__ship_cloud_media/abc",
			"https://10.66.216.73:18680/__ship_cloud_media/abc",
		},
		{
			"空串不许编造成 origin 根",
			"https://10.66.216.73:18680",
			"",
			"",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Setenv("THIRDPARTY_CONFERENCE_BASEURL", c.env)
			if got := a.resolveTarget(context.Background(), c.target); got != c.want {
				t.Fatalf("resolveTarget(%q) = %q，期望 %q", c.target, got, c.want)
			}
		})
	}
}

// 坏样本必须真的漏、好样本不许被削：ticket 是三方签发的一次性预授权凭据。
func TestLoggableTarget(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{
			"query 里的 ticket 必须走",
			"https://10.66.216.73:18680/__ship_cloud_media/abc123?ticket=eyJhbGciOi&role=publisher",
			"https://10.66.216.73:18680/__ship_cloud_media/abc123?<ticket 已隐去>",
		},
		{
			"没有 query 的 origin+path 一个字符不许动",
			"https://10.66.216.73:18680/__ship_local_media/pub_1/whip",
			"https://10.66.216.73:18680/__ship_local_media/pub_1/whip",
		},
		{"空串不编造", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := LoggableTarget(c.in); got != c.want {
				t.Fatalf("LoggableTarget(%q) = %q，期望 %q", c.in, got, c.want)
			}
		})
	}
	if strings.Contains(LoggableTarget("https://h/x?ticket=supersecret"), "supersecret") {
		t.Fatal("凭据仍在日志文本里，隐去没生效")
	}
}

// 注意错出在 **client.Do**（transport 层），不在 http.NewRequest：裸路径是能 parse 的，
// NewRequest 一路放行到发出去那一刻才报 unsupported protocol scheme ""。
// 判据自证：坏样本必须真的坏、补全后必须真的落对 origin —— 否则这条守卫等于没写。
// 注意错出在 **client.Do**（transport 层），不在 http.NewRequest：裸路径是能 parse 的，
// NewRequest 一路放行到发出去那一刻才报 unsupported protocol scheme ""。
func TestResolveTargetSelfProof(t *testing.T) {
	const rel = "/__ship_cloud_media/aHR0cHM6Ly80Ny4xMTQuODMuMTUxL3gx"
	t.Setenv("THIRDPARTY_CONFERENCE_BASEURL", "https://10.66.216.73:18680")
	a := New()

	// 坏样本：补全前就是 2026-10-10 边端日志里那条错
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, rel, strings.NewReader("v=0"))
	if err != nil {
		t.Fatalf("裸路径本该能构造请求，判据写错了：%v", err)
	}
	if resp, doErr := a.httpClient.Do(req); doErr == nil ||
		!strings.Contains(doErr.Error(), `unsupported protocol scheme ""`) {
		if resp != nil {
			_ = resp.Body.Close()
		}
		t.Fatalf("坏样本没有命中预期错误，判据是假的：%v", doErr)
	}

	got := a.resolveTarget(context.Background(), rel)
	if !strings.HasPrefix(got, "https://10.66.216.73:18680/") {
		t.Fatalf("补全结果没落在网关 origin：%q", got)
	}
	if _, err := http.NewRequestWithContext(context.Background(), http.MethodPost, got, strings.NewReader("v=0")); err != nil {
		t.Fatalf("补全后仍不能构造请求：%v", err)
	}
}
