package service

import (
	"testing"

	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/service/thirdparty"
)

// rkReady 按三方船端客户端的门禁形状造一条"接收槽齐备"的发布：
// 投递模式 + 接收槽号 + 路径，三者缺一不可（meeting.js 的 useRkReceiver，两侧文件同哈希）。
func rkReady() thirdparty.Publication {
	return thirdparty.Publication{
		RkDeliveryMode: "raw_hevc_forward", RkReceiverLaneId: 3,
		RkReceiverPath: "/conference/pub_9/mix",
	}
}

// 视频腿按部署侧别选通道：边端可以接船端局域网 WHEP，云端接不通它（ICE 到不了船内网）。
// 两侧都给同一条齐备的发布，判据必须给出不同答案 —— 写死任一侧都过不了这条。
func TestVideoLegChannel(t *testing.T) {
	oldSide := DeploymentSide
	t.Cleanup(func() { DeploymentSide = oldSide })

	directAndRk := rkReady()
	directAndRk.DirectVideoUrl = "https://c/direct/v"

	DeploymentSide = "edge"
	for name, tc := range map[string]struct {
		pub  thirdparty.Publication
		want string
	}{
		"有直连优先走直连":        {directAndRk, consts.VideoChannelDirect},
		"RK三件套齐备时边端走WHEP": {rkReady(), consts.VideoChannelLanWhep},
		"只有直连":            {thirdparty.Publication{DirectVideoUrl: "https://c/direct/v"}, consts.VideoChannelDirect},
		"一条通道都没有":         {thirdparty.Publication{Status: "publishing"}, ""},
	} {
		if got := VideoLegChannel(tc.pub); got != tc.want {
			t.Fatalf("%s: 边端 = %q，期望 %q", name, got, tc.want)
		}
	}

	DeploymentSide = "cloud"
	if got := VideoLegChannel(rkReady()); got != "" {
		t.Fatalf("云端拿到齐备的 RK 通道 = %q，期望空 —— 岸端浏览器 ICE 不到船内网，签出去就是一条永远不亮的瓦片", got)
	}
	if got := VideoLegChannel(directAndRk); got != consts.VideoChannelDirect {
		t.Fatalf("云端有直连时 = %q，期望 direct", got)
	}
}

// 三件套少任何一件都不能签：这条判据与三方船端客户端的 `useRkReceiver` 逐字一致
// （投递模式 + 接收槽号 + 路径/地址）。缺 `rkReceiverLaneId` 就是三方还没给这条发布分配接收槽，
// 签出去只会换出一条永远不亮的瓦片。
//
// 更正（实测 2026-10-12）：本例此前的理由是"`conference/cam1` 是网关回填的本机 RK 输入槽名、
// 只看路径会订到别人的槽"—— 那是误判。`lane=N ↔ path=conference/camN` 逐参会者对应，
// 它就是这条发布自己的槽；订它回 404 说的是**槽里没流**，不是订错了地方。
// 判据本身不变（与三方一致这件事不随我们的结论变），变的是理由。
func TestVideoLegChannelRequiresWholeGate(t *testing.T) {
	oldSide := DeploymentSide
	t.Cleanup(func() { DeploymentSide = oldSide })
	DeploymentSide = "edge"

	full := rkReady()
	noMode := rkReady()
	noMode.RkDeliveryMode = ""
	wrongMode := rkReady()
	wrongMode.RkDeliveryMode = "audio_direct_forward"
	noLane := rkReady()
	noLane.RkReceiverLaneId = 0
	noPath := rkReady()
	noPath.RkReceiverPath = ""

	for name, pub := range map[string]thirdparty.Publication{
		"缺投递模式":          noMode,
		"投递模式不是RK转发":     wrongMode,
		"没有接收槽号(三方还没分配)": noLane,
		"槽号有但路径地址都空":     noPath,
	} {
		if got := VideoLegChannel(pub); got != "" {
			t.Fatalf("%s: = %q，期望空 —— 三件套不齐就签出去，订到的是一条没分配的槽", name, got)
		}
	}
	// 反向钉住：不许把判据写成"一律不签"来蒙过上面四条。
	if got := VideoLegChannel(full); got != consts.VideoChannelLanWhep {
		t.Fatalf("三件套齐备时 = %q，期望 lanWhep", got)
	}
}

// 自证：侧别门控一旦被删（两侧同判据），这条必须失败。
func TestVideoLegChannelSelfProof(t *testing.T) {
	oldSide := DeploymentSide
	t.Cleanup(func() { DeploymentSide = oldSide })

	DeploymentSide = "edge"
	edge := VideoLegChannel(rkReady())
	DeploymentSide = "cloud"
	cloud := VideoLegChannel(rkReady())
	if edge == cloud {
		t.Fatalf("侧别不再影响判据（两侧都是 %q）—— 门控被写坏了", edge)
	}
}
