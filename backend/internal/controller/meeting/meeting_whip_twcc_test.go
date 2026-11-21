// 船内 TCP 网关那一路的 offer 加工（去掉 TWCC）判据。
//
// 三方 `localTcpWhipOffer` 只在三个条件同时成立时才动 offer：来源是 rk_browser_roi、
// 地址是 `/__ship_local_media/{id}/whip`、offer 里有 m=video。我方把"来源"那一半交给地址判：
// 那个地址本来只给船内发布用，端点是不是 TCP-only 由端点自己决定。所以这里要钉两条边界：
// **云端地址一字不动**、**船内地址只删 TWCC 行**。
package meeting

import (
	"strings"
	"testing"
)

const shipLocalWhip = "https://10.66.216.73:18680/__ship_local_media/pub_abc-1/whip"
const cloudWhip = "https://47.114.83.151:443/__whip/pubs/pub_abc-1"

const sampleOffer = "v=0\r\n" +
	"m=video 9 UDP/TLS/RTP/SAVPF 96 97\r\n" +
	"a=rtcp-fb:96 nack\r\n" +
	"a=rtcp-fb:96 nack pli\r\n" +
	"a=rtcp-fb:96 transport-cc\r\n" +
	"a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01\r\n" +
	"a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid\r\n" +
	"a=extmap:5 urn:ietf:params:rtp-hdrext:transport-wide-cc-02\r\n" +
	"a=sendonly\r\n"

func TestStripTransportCCOnlyOnShipLocalGateway(t *testing.T) {
	// 判据自证：先确认样本里确实有可删的行，否则下面"删掉了"根本无从谈起。
	// 三条分别是：rtcp-fb 的 ` transport-cc`，和两个 URI —— 注意 URI 里是 `transport-wide-cc`，
	// 与反馈那行的字面量不同（这正是"按 transport-cc 数"会数错的地方）。
	if n := strings.Count(sampleOffer, " transport-cc"); n != 1 {
		t.Fatalf("样本里 transport-cc 反馈行 = %d，期望 1", n)
	}
	if n := strings.Count(sampleOffer, "transport-wide-cc"); n != 2 {
		t.Fatalf("样本里 TWCC 的 extmap URI = %d，期望 2", n)
	}

	got := stripTransportCCForLocalTcp(sampleOffer, shipLocalWhip)
	if strings.Contains(got, "transport-cc") {
		t.Fatalf("船内 TCP 网关那一路仍带 TWCC：\n%s", got)
	}
	// 只删 TWCC：NACK/PLI 与 sdes:mid 必须原样保留（那是 TCP 自己的拥塞控制与解复用靠的东西）。
	for _, keep := range []string{"a=rtcp-fb:96 nack\r\n", "a=rtcp-fb:96 nack pli\r\n", "a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid", "m=video 9"} {
		if !strings.Contains(got, keep) {
			t.Fatalf("删多了：%q 不该被去掉\n%s", keep, got)
		}
	}
	// 换行风格必须沿用原样：\r\n 的 SDP 被改成 \n，MediaMTX 那侧会解析出残缺行。
	if strings.Contains(strings.ReplaceAll(got, "\r\n", ""), "\n") {
		t.Fatalf("混入了裸 \\n 换行：\n%q", got)
	}

	if cloud := stripTransportCCForLocalTcp(sampleOffer, cloudWhip); cloud != sampleOffer {
		t.Fatalf("云端地址不该被加工：\n%s", cloud)
	}
	// 只有音频的发布（没有 m=video）不加工 —— 与三方那条 `!m=video` 的提前返回一致。
	audio := "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtcp-fb:111 transport-cc\r\n"
	if got := stripTransportCCForLocalTcp(audio, shipLocalWhip); got != audio {
		t.Fatalf("没有视频 m-line 的 offer 被加工了：\n%s", got)
	}
}
