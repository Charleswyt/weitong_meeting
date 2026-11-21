package meeting

import (
	"strings"
	"testing"

	"cloud-conference-backend/internal/service"
	"cloud-conference-backend/internal/service/thirdparty"
)

// offer 里的 m-line 是这条 PC 要收什么的唯一真源（不再另开 kind 参数）。
func TestOfferWantsVideo(t *testing.T) {
	audioOnly := "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n"
	withVideo := "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n"
	for name, tc := range map[string]struct {
		offer string
		want  bool
	}{
		"只有音频":    {audioOnly, false},
		"含视频":     {withVideo, true},
		"空 offer": {"", false},
	} {
		if got := offerWantsVideo(tc.offer); got != tc.want {
			t.Fatalf("%s: = %v，期望 %v", name, got, tc.want)
		}
	}
	// 自证：判据不能是"字符串里有没有 m=" —— 那种写法音频 offer 也会被判成要视频。
	if offerWantsVideo(audioOnly) {
		t.Fatal("纯音频 offer 被判成要视频 —— 判据没落在 m=video 上")
	}
}

// 边端订阅只给了 RK 通道的发布时，必须拿到那条 WHEP 地址；云端一律拿不到。
func TestWhepVideoChannelBySide(t *testing.T) {
	oldSide := service.DeploymentSide
	t.Cleanup(func() { service.DeploymentSide = oldSide })

	state := &thirdparty.MeetingResponse{Publications: []thirdparty.Publication{{
		PublicationId:    "pub_a",
		ParticipantId:    "p1",
		MediaKind:        "camera",
		Status:           "ready",
		RkDeliveryMode:   "raw_hevc_forward",
		RkReceiverLaneId: 3,
		RkReceiverPath:   "/conference/pub_a/mix",
		DirectAudioUrl:   "https://c/direct/a",
	}}}

	service.DeploymentSide = "edge"
	got, pub, found := whepVideoChannel(state, "pub_a")
	if !found || pub.PublicationId != "pub_a" {
		t.Fatalf("边端 found=%v pub=%q，期望命中 pub_a", found, pub.PublicationId)
	}
	if got != "/__ship_lan_whep/conference/pub_a/mix/whep" {
		t.Fatalf("边端拿到的地址 = %q，期望由接收槽路径拼出的那条局域网 WHEP", got)
	}

	service.DeploymentSide = "cloud"
	if got, _, _ := whepVideoChannel(state, "pub_a"); got != "" {
		t.Fatalf("云端拿到了 %q —— 岸端浏览器 ICE 不到船内网，签出去就是永远不亮的瓦片", got)
	}
}

// 取序照三方船端客户端：优先用 rkReceiverPath 拼网关的局域网入口，其次才用它直接给的地址。
//
// 更正（实测 2026-10-12）：这条此前挂着"拿 rkReceiverWhepUrl 去订会 404，因为那地址不是这路发布的
// 接收槽"的理由，那个判断是错的 —— 两个字段指向**同一个**接收槽（`lane=N ↔ conference/camN`
// 逐参会者对应），404 说的是槽里没有流。所以这条守的是"与三方客户端逐字同序"，不再守"避开别人的槽"。
func TestLanWhepURLPrefersReceiverPath(t *testing.T) {
	both := thirdparty.Publication{RkReceiverPath: "/conference/pub_9/mix", RkReceiverWhepUrl: "https://rk/other/whep"}
	if got := lanWhepURL(both); got != "/__ship_lan_whep/conference/pub_9/mix/whep" {
		t.Fatalf("两个字段都在时取了 %q —— 与三方船端客户端的取序不一致了", got)
	}
	onlyURL := thirdparty.Publication{RkReceiverWhepUrl: "https://rk/other/whep"}
	if got := lanWhepURL(onlyURL); got != "https://rk/other/whep" {
		t.Fatalf("只有地址时应原样用它，得到 %q", got)
	}
}

// 视频提示要说清"上游只给了船端局域网通道"，否则排查时看不出这条腿其实是能用的。
func TestVideoChannelsHint(t *testing.T) {
	if h := videoChannelsHint(thirdparty.Publication{RkReceiverWhepUrl: "/x"}); !strings.Contains(h, "WHEP") {
		t.Fatalf("只有 RK 通道时的提示 = %q，期望点名 WHEP 那条腿", h)
	}
	if h := videoChannelsHint(thirdparty.Publication{}); !strings.Contains(h, "任何通道") {
		t.Fatalf("零通道时的提示 = %q", h)
	}
}
