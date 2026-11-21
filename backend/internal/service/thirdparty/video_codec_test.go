package thirdparty

import "testing"

// 编码判据的取舍：真源优先、真源缺失才回落推断、认不出来的值不猜。
// 钉住这条是因为它同时决定取流的 Accept 头与前端展示，而 sourceType 那个声明位
// 对 rk_browser_roi 靠不住 —— 三方船端客户端恰恰要求浏览器编 H.264 推给 RK。
func TestVideoCodecPrefersThirdPartyField(t *testing.T) {
	cases := []struct {
		name string
		pub  Publication
		want string
	}{
		{"真源 h264 压过 rk_browser_roi 的推断", Publication{SourceType: "rk_browser_roi", DirectVideoCodec: "h264"}, "h264"},
		{"真源大写也认", Publication{SourceType: "browser_whip", DirectVideoCodec: "HEVC"}, "hevc"},
		{"带容器后缀的复合值", Publication{SourceType: "rk_roi", DirectVideoCodec: "zha1+h264"}, "h264"},
		{"真源缺失时回退 directVideoFormat", Publication{SourceType: "rk_roi", DirectVideoFormat: "avc"}, "h264"},
		{"两个真源都缺 → 回落 sourceType", Publication{SourceType: "rk_roi"}, "hevc"},
		{"两个真源都缺 + browser_whip → h264", Publication{SourceType: "browser_whip"}, "h264"},
		{"键存在但值为空串 → 仍算缺失", Publication{SourceType: "rk_roi", DirectVideoCodec: "  "}, "hevc"},
		{"未知编码不猜，落回推断", Publication{SourceType: "rk_roi", DirectVideoCodec: "av1"}, "hevc"},
	}
	for _, c := range cases {
		if got := c.pub.VideoCodec(); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

// 判据坏掉的形状要能被这组用例抓到：真源被忽略时第一条必红。
func TestVideoCodecSelfProves(t *testing.T) {
	probe := Publication{SourceType: "rk_browser_roi", DirectVideoCodec: "h264"}
	if probe.VideoCodec() == "hevc" {
		t.Fatal("真源 directVideoCodec=h264 被 sourceType 推断盖掉了 —— 判据已经退化成推断")
	}
}
