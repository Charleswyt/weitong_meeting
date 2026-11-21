// 船内局域网**音频**车道的地址拼法。
//
// 判据来自三方船端客户端的实测行为：它收音频也走浏览器 PC（`audioReceiver.samplePlayoutTiming`），
// 地址是 `/__ship_lan_whep/{rkReceiverPath}_audio/whep`（视频那条只差一个 `_audio` 后缀）。
// 我方原先只认上游给的 `audioWhepUrl`，船端那条永远拼不出来 ⇒ 音频退到直连流 ⇒ 没有 PC ⇒
// 播放时刻取不到 ⇒ 音画差在边端页永远是 `—`（同会对照三方那一格是有值的）。
package meeting

import (
	"testing"

	"cloud-conference-backend/internal/service/thirdparty"
)

func TestLanWhepAudioURL(t *testing.T) {
	cases := []struct {
		name string
		pub  thirdparty.Publication
		want string
	}{
		{
			// 三方客户端实测的形态：路径 conference/cam1 → conference/cam1_audio/whep
			name: "按接收槽路径拼（多一个 _audio 后缀）",
			pub:  thirdparty.Publication{RkReceiverPath: "conference/cam1"},
			want: "/__ship_lan_whep/conference/cam1_audio/whep",
		},
		{
			// 与视频那条同序：**路径优先**。拼出来的是相对路径，会走本实例配置的船端网关 baseUrl；
			// 而显式地址可能是网关回填的绝对 host，从本机发出去只得到传输层失败（实测 upstream_unreachable）。
			name: "路径优先于显式绝对地址（与视频那条取序一致）",
			pub: thirdparty.Publication{
				RkReceiverAudioWhepUrl: "https://gw/x/audio.whep",
				RkReceiverPath:         "conference/cam2",
			},
			want: "/__ship_lan_whep/conference/cam2_audio/whep",
		},
		{
			name: "没有路径时才用显式地址",
			pub:  thirdparty.Publication{RkReceiverAudioWhepUrl: "https://gw/x/audio.whep"},
			want: "https://gw/x/audio.whep",
		},
		{
			name: "路径多余的斜杠要吃掉（拼出来不能有双斜杠）",
			pub:  thirdparty.Publication{RkReceiverPath: "/conference/cam2/"},
			want: "/__ship_lan_whep/conference/cam2_audio/whep",
		},
		{
			name: "两者都没有 → 空串（调用方据此认为这条车道不存在）",
			pub:  thirdparty.Publication{},
			want: "",
		},
		{
			// 只有视频地址、没有音频那条：不许拿视频地址冒充音频（那会把视频当音频订，SDP 直接对不上）
			name: "只有视频 WHEP 地址时不算有音频车道",
			pub:  thirdparty.Publication{RkReceiverWhepUrl: "https://gw/x/video.whep"},
			want: "",
		},
	}
	for _, c := range cases {
		if got := lanWhepAudioURL(c.pub); got != c.want {
			t.Errorf("%s：得到 %q，期望 %q", c.name, got, c.want)
		}
	}
}

// 自证：拼出来的音频地址与视频地址**只差 `_audio` 后缀**，两者不能互相冒充。
// 这条钉的是"别把视频那条腿的地址顺手复用到音频上"——订错了 SDP 对不上，表现是"声音永远出不来"。
func TestLanWhepAudioURLDiffersFromVideoOnlyBySuffix(t *testing.T) {
	pub := thirdparty.Publication{RkReceiverPath: "conference/cam1"}
	video, audio := lanWhepURL(pub), lanWhepAudioURL(pub)
	if video != "/__ship_lan_whep/conference/cam1/whep" {
		t.Fatalf("视频地址形状变了：%q", video)
	}
	if audio != "/__ship_lan_whep/conference/cam1_audio/whep" {
		t.Fatalf("音频地址形状变了：%q", audio)
	}
	if audio == video {
		t.Fatal("音频与视频地址相同 —— 说明调用方会把视频当音频订")
	}
}
