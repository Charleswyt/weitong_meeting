package session

import "testing"

// 同一路流的音视频是三方侧**两个独立会话**：会话键少了腿别，后绑的那条会把先绑的覆盖掉，
// 换流时还会对它发 DELETE —— 症状是"画面起来之后声音哑了"（或反过来）。
func TestWhepSessionsArePerLeg(t *testing.T) {
	room := &MeetingRoom{}
	room.BindWhep(WhepTarget{UserId: 7, StreamId: "st_1", Kind: "audio", SessionURL: "https://gw/sess-audio"})
	room.BindWhep(WhepTarget{UserId: 7, StreamId: "st_1", Kind: "video", SessionURL: "https://gw/sess-video"})

	a, okA := room.WhepFor(7, "st_1", "audio")
	v, okV := room.WhepFor(7, "st_1", "video")
	if !okA || !okV {
		t.Fatalf("两条腿没能各自查回（audio=%v video=%v）—— 键里没带腿别", okA, okV)
	}
	if a.SessionURL != "https://gw/sess-audio" || v.SessionURL != "https://gw/sess-video" {
		t.Fatalf("两条腿互相串了：audio=%q video=%q", a.SessionURL, v.SessionURL)
	}

	// 只摘视频腿，音频腿必须还在（离会/换流路径按腿拆，不能顺手把另一条拆掉）。
	if _, ok := room.TakeWhep(7, "st_1", "video"); !ok {
		t.Fatal("TakeWhep 没摘到视频腿")
	}
	if _, still := room.WhepFor(7, "st_1", "audio"); !still {
		t.Fatal("摘视频腿把音频腿一起弄丢了")
	}

	room.BindWhep(WhepTarget{UserId: 7, StreamId: "st_1", Kind: "video", SessionURL: "https://gw/sess-video2"})
	all := room.TakeWhepsForStream(7, "st_1")
	if len(all) != 2 {
		t.Fatalf("释放这路流时摘到 %d 条会话，期望 2（音视频各一条）", len(all))
	}
	if _, still := room.WhepFor(7, "st_1", "audio"); still {
		t.Fatal("TakeWhepsForStream 之后音频腿还挂着")
	}
}

// 自证：别的用户/别的流不能被牵连。
func TestWhepTakeDoesNotLeakAcrossOwners(t *testing.T) {
	room := &MeetingRoom{}
	room.BindWhep(WhepTarget{UserId: 7, StreamId: "st_1", Kind: "audio", SessionURL: "s1"})
	room.BindWhep(WhepTarget{UserId: 8, StreamId: "st_1", Kind: "audio", SessionURL: "s2"})
	room.BindWhep(WhepTarget{UserId: 7, StreamId: "st_2", Kind: "audio", SessionURL: "s3"})

	if got := room.TakeWhepsForStream(7, "st_1"); len(got) != 1 || got[0].SessionURL != "s1" {
		t.Fatalf("摘 (7,st_1) 得到 %+v，期望只有 s1", got)
	}
	for _, probe := range []struct {
		userId int64
		stream string
	}{
		{8, "st_1"}, {7, "st_2"},
	} {
		if _, ok := room.WhepFor(probe.userId, probe.stream, "audio"); !ok {
			t.Fatalf("用户 %d 流 %s 的会话被误摘", probe.userId, probe.stream)
		}
	}
}
