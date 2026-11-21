package session

import "testing"

// WHIP 表原先只按 publicationId 建值、里面没有归属，于是控制层只能校验"调用者在这场会里"——
// 那是**会议级**成员资格，不是**这条发布**的所有权。多用户同场（多个边端 + 多个云端参加同一场会）
// 下这意味着：B 可以往 A 的发布里推 SDP，或者对 A 的发布发 DELETE 把它的流拆掉。
//
// 与 whep_key_test.go（订阅按用户分键）、state_owner_test.go（状态缓存不许跨用户复用）同一条道理：
// 凡是"以会议为粒度共享、但凭据/意图绑在某个参会者身上"的状态，读取时都必须带上归属。
func TestWhipLookupIsScopedToOwner(t *testing.T) {
	room := &MeetingRoom{Sessions: map[int64]*Session{}}
	room.BindWhip("pub_1", WhipTarget{OfferURL: "https://tp/whip/1", UserId: 7})

	if _, ok := room.WhipForUser("pub_1", 7); !ok {
		t.Fatal("本人应当取到自己的发布")
	}
	if _, ok := room.WhipForUser("pub_1", 8); ok {
		t.Error("用户 8 取到了用户 7 的发布 —— 有了它就等于允许往别人的流里推 SDP、或把它拆掉")
	}
	if _, ok := room.WhipForUser("pub_missing", 7); ok {
		t.Error("不存在的发布不该命中")
	}

	// 补写 Location 是另一次整值覆盖，归属不许被冲掉。
	room.SetWhipSession("pub_1", "https://tp/session/1")
	got, ok := room.WhipForUser("pub_1", 7)
	if !ok || got.UserId != 7 || got.SessionURL == "" {
		t.Errorf("补写 Location 后归属或会话地址丢了：%+v", got)
	}
	if _, ok := room.WhipForUser("pub_1", 8); ok {
		t.Error("补写之后仍然越权命中，说明收紧只做在读取那一步")
	}
}
