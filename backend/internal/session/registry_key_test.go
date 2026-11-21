package session

import "testing"

// 会话键的来源必须靠标记位判出来，而不是靠"数值够不够大"：外部键一旦被判成本地预约单，
// 就会拿它去 UPDATE meeting_appointment 的主键（第 13/38 项排查中确认过的风险形状）。
func TestRoomKeyMarksKeySourceExplicitly(t *testing.T) {
	rg := NewRegistry()

	if got := rg.RoomKey(42, "92323537"); got != 42 {
		t.Fatalf("有预约单就该用主键，得到 %d", got)
	}
	if !IsManaged(42) {
		t.Fatal("预约单主键被判成外部键")
	}

	key := rg.RoomKey(0, "92323537")
	if IsManaged(key) {
		t.Fatalf("外部会议键 %d 被判成本侧预约单主键", key)
	}
	if key&externalKeyMark == 0 {
		t.Fatalf("外部会议键 %d 没带上来源标记位", key)
	}
	if key >= 1<<53 {
		t.Fatalf("外部会议键 %d 超出 JS 安全整数，前端拼 URL 会掉精度", key)
	}
	if again := rg.RoomKey(0, "92323537"); again != key {
		t.Fatalf("同一个会议号两次拿到不同键：%d vs %d", key, again)
	}
	if other := rg.RoomKey(0, "92323538"); other == key {
		t.Fatalf("不同会议号撞在同一个房间键 %d", key)
	}
	if IsManaged(0) {
		t.Fatal("0 号房间不是任何一场会，不能算本侧预约单")
	}
	if got := rg.RoomKey(0, ""); got != 0 {
		t.Fatalf("没有预约单也没有会议号时应回 0，得到 %d", got)
	}
}
