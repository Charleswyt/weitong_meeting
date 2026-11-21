package service

import (
	"testing"

	"cloud-conference-backend/internal/service/thirdparty"
)

func cloudRow(id, meeting string) thirdparty.ThirdRecording {
	return thirdparty.ThirdRecording{RecordingId: id, MeetingId: meeting, Mode: "cloud"}
}

// 列表一张卡 = 一场会，所以分页单位必须是"场"而不是"路"：
// 现网实测 104 条录制聚成 9 张卡（每场路数 43/30/10/6/4/4/3/3/1），
// 按路数出来的 total 与屏幕上的卡片数永远对不上（2026-10-09 用户报"统计是错的"）。
func TestGroupBySessionCountsCardsNotLanes(t *testing.T) {
	rows := []thirdparty.ThirdRecording{
		cloudRow("r1", "m_a"), cloudRow("r2", "m_a"), cloudRow("r3", "m_a"),
		cloudRow("r4", "m_b"),
	}
	got := groupBySession(rows)
	if len(got) != 2 {
		t.Fatalf("三路的同一场要算一张卡，实得 %d 组", len(got))
	}
	if len(got[0]) != 3 || len(got[1]) != 1 {
		t.Fatalf("组内路数不对：%d,%d", len(got[0]), len(got[1]))
	}
	// 组的先后 = 该场**最新一路**的位置（行已按开始时间倒序进来），翻完第一页卡片顺序才不乱
	if got[0][0].RecordingId != "r1" || got[1][0].RecordingId != "r4" {
		t.Fatalf("组顺序错：%s 在前应为 r1，第二组应为 r4", got[0][0].RecordingId)
	}
}

// meetingId 为空的孤行**不许**并成一张卡：那是"几场不相干的会挤成一张"的假数据。
func TestGroupBySessionKeepsOrphansApart(t *testing.T) {
	rows := []thirdparty.ThirdRecording{
		cloudRow("r1", ""), cloudRow("r2", ""), cloudRow("r3", "m_a"), cloudRow("r4", "m_a"),
	}
	got := groupBySession(rows)
	if len(got) != 3 {
		t.Fatalf("两条孤行应各自成场 + 一场两会 = 3 组，实得 %d", len(got))
	}
	if len(got[0]) != 1 || len(got[1]) != 1 {
		t.Fatalf("孤行被合并了：前两组应各 1 路，实得 %d,%d", len(got[0]), len(got[1]))
	}
}

// 本机录制即使带着同一个 meetingId 也不与云端那一路合卡 ——
// 这条判据决定了前端"云端场次数 + 本机条数"能不能直接相加（能，才敢在第一页就给页头那个数）。
func TestGroupBySessionLocalNeverMergesWithCloud(t *testing.T) {
	rows := []thirdparty.ThirdRecording{
		cloudRow("r1", "m_a"),
		{RecordingId: "r2", MeetingId: "m_a", LocalPaths: []string{"/x"}},
		cloudRow("r3", "m_a"),
	}
	got := groupBySession(rows)
	if len(got) != 2 {
		t.Fatalf("本机那条要自成一场，应得 2 组，实得 %d", len(got))
	}
	if len(got[0]) != 2 {
		t.Fatalf("云端两路应合为一张卡，实得 %d 路", len(got[0]))
	}
}
