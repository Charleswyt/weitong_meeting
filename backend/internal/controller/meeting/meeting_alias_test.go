package meeting

import (
	"testing"

	"cloud-conference-backend/internal/service/thirdparty"
)

// 上游在同一路媒体重推时会同时留着新旧两个 publicationId：旧的还 ready、新的刚 publishing。
// 只按前端订到的那条取地址，实测（2026-09-28 会议 90）每轮都是 425 direct_video_not_ready，
// 用户看到的就是"这路媒体还在准备中"挂几分钟不消失，而能播的兄弟别名就在同一份快照里。
func stateWith(pubs ...thirdparty.Publication) *thirdparty.MeetingResponse {
	return &thirdparty.MeetingResponse{Publications: pubs}
}

const (
	readyPub      = "pub_1790603653_R1POlYRTfDs"
	publishingPub = "pub_1790603653_XBfVIxt-G-I"
)

func cameraPubs() []thirdparty.Publication {
	return []thirdparty.Publication{
		{PublicationId: publishingPub, ParticipantId: "participant_b", MediaKind: "camera", Status: "publishing", DirectVideoUrl: "/v/publishing"},
		{PublicationId: readyPub, ParticipantId: "participant_b", MediaKind: "camera", Status: "ready", DirectVideoUrl: "/v/ready"},
	}
}

func TestPickStreamPrefersReadyAlias(t *testing.T) {
	state := stateWith(cameraPubs()...)
	pub, url, _, whyNot := pickStreamURL(state, publishingPub, "video")
	if whyNot != "" {
		t.Fatalf("不该失败：%s", whyNot)
	}
	if url != "/v/ready" || pub.PublicationId != readyPub {
		t.Fatalf("取到了 publishing 别名（url=%s pub=%s），应改用 ready 的兄弟别名", url, pub.PublicationId)
	}
}

// 订到的那条本来就 ready 时不要乱换：换别名等于换关注对象，没好处还可能打断正在收的流。
func TestPickStreamKeepsReadyAliasItAskedFor(t *testing.T) {
	state := stateWith(cameraPubs()...)
	pub, url, _, _ := pickStreamURL(state, readyPub, "video")
	if url != "/v/ready" || pub.PublicationId != readyPub {
		t.Fatalf("订的就是 ready 那条，不该改：url=%s pub=%s", url, pub.PublicationId)
	}
}

// 别人的发布不能被当成"我的兄弟别名"，否则 A 的画面会被接到 B 身上。
func TestPickStreamDoesNotCrossParticipants(t *testing.T) {
	state := stateWith(
		thirdparty.Publication{PublicationId: publishingPub, ParticipantId: "participant_b", MediaKind: "camera", Status: "publishing"},
		thirdparty.Publication{PublicationId: "pub_other", ParticipantId: "participant_c", MediaKind: "camera", Status: "ready", DirectVideoUrl: "/v/other"},
	)
	_, url, _, whyNot := pickStreamURL(state, publishingPub, "video")
	if url != "" {
		t.Fatalf("串到了别人的发布：%s", url)
	}
	if whyNot == "" {
		t.Fatal("没有可播地址时必须给出原因")
	}
}

// stopped/failed 是终态，不能被当成"就绪的兄弟"端出去。
func TestPickStreamIgnoresTerminalAliases(t *testing.T) {
	state := stateWith(
		thirdparty.Publication{PublicationId: publishingPub, ParticipantId: "participant_b", MediaKind: "camera", Status: "publishing", DirectVideoUrl: "/v/publishing"},
		thirdparty.Publication{PublicationId: "pub_dead", ParticipantId: "participant_b", MediaKind: "camera", Status: "stopped", DirectVideoUrl: "/v/dead"},
	)
	_, url, _, _ := pickStreamURL(state, publishingPub, "video")
	if url != "/v/publishing" {
		t.Fatalf("终态别名不该被选中，也不该把唯一可用的那条挤掉：url=%s", url)
	}
}

func TestWhepAudioPrefersReadyAlias(t *testing.T) {
	state := stateWith(
		thirdparty.Publication{PublicationId: publishingPub, ParticipantId: "participant_b", MediaKind: "audio", Status: "publishing", AudioWhepUrl: "/whep/publishing"},
		thirdparty.Publication{PublicationId: readyPub, ParticipantId: "participant_b", MediaKind: "audio", Status: "ready", AudioWhepUrl: "/whep/ready"},
	)
	url, pub, found := whepAudioChannel(state, publishingPub)
	if !found || url != "/whep/ready" || pub.PublicationId != readyPub {
		t.Fatalf("WHEP 也应按 ready 别名订：url=%s pub=%s found=%v", url, pub.PublicationId, found)
	}
}

// 订到的那条没有通道、兄弟别名有：要回"有通道"，而不是 501 让前端误判成"这路没音频"。
func TestWhepAudioFallsBackToSiblingChannel(t *testing.T) {
	state := stateWith(
		thirdparty.Publication{PublicationId: publishingPub, ParticipantId: "participant_b", MediaKind: "audio", Status: "publishing"},
		thirdparty.Publication{PublicationId: readyPub, ParticipantId: "participant_b", MediaKind: "audio", Status: "ready", AudioWhepUrl: "/whep/ready"},
	)
	url, pub, found := whepAudioChannel(state, publishingPub)
	if !found || url != "/whep/ready" || pub.PublicationId != readyPub {
		t.Fatalf("兄弟别名的通道没被用上：url=%s pub=%s found=%v", url, pub.PublicationId, found)
	}
}

func TestWhepAudioUnknownPublication(t *testing.T) {
	_, _, found := whepAudioChannel(stateWith(cameraPubs()...), "pub_missing")
	if found {
		t.Fatal("上游没回报这条发布时必须回 found=false")
	}
}

// 取流协商头按这一路的实际编码走，不是一律 h264。
// 2026-10-09 实测：边端经 RKMPP 处理的路只有 HEVC 这条腿，按 h264 取时上游回
// 425 direct_video_not_ready 且永远不会变就绪（一条路连挂 45 分钟、195 次），
// 同场会里 browser_whip 的路按 h264 是通的 —— 所以两刀切都不行。
func TestPickStreamNegotiatesAcceptPerLane(t *testing.T) {
	state := stateWith(
		thirdparty.Publication{PublicationId: "pub_browser", ParticipantId: "p_a", MediaKind: "camera",
			Status: "ready", SourceType: "browser_whip", DirectVideoUrl: "/v/browser"},
		thirdparty.Publication{PublicationId: "pub_edge", ParticipantId: "p_b", MediaKind: "camera",
			Status: "ready", SourceType: "rk_browser_roi", DirectVideoUrl: "/v/edge"},
	)
	if _, _, accept, whyNot := pickStreamURL(state, "pub_browser", "video"); accept != thirdparty.AcceptZha1H264 || whyNot != "" {
		t.Fatalf("浏览器直发应按 h264 取，实得 %s（%s）", accept, whyNot)
	}
	if _, _, accept, whyNot := pickStreamURL(state, "pub_edge", "video"); accept != thirdparty.AcceptZha1Hevc || whyNot != "" {
		t.Fatalf("边端 ROI 路应按 hevc 取，实得 %s（%s）", accept, whyNot)
	}
	// 音频那条腿与编码无关，不能被视频的规则带跑。
	audio := stateWith(thirdparty.Publication{PublicationId: "pub_a", ParticipantId: "p_a",
		MediaKind: "microphone", Status: "ready", SourceType: "rk_browser_roi", DirectAudioUrl: "/a/1"})
	if _, _, accept, _ := pickStreamURL(audio, "pub_a", "audio"); accept != thirdparty.AcceptZaa1Aac {
		t.Fatalf("音频仍应按 aac 取，实得 %s", accept)
	}
}
