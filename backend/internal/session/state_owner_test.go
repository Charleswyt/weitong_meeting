package session

import (
	"testing"

	"cloud-conference-backend/internal/service/thirdparty"
)

// 房间级状态缓存里那些订阅地址是**带票据**的，票据绑定在"拉这次状态的参会者"身上。
// 所以缓存不能跨用户复用 —— 与 whep_key_test.go 那条"会话按订阅方分键"是同一条道理。
// 这条测试钉的是不变量本身：每个人只读得到自己令牌拉的那份，读不到别人的。
// 实现按用户分键（map），因此"后来者覆盖前一个人"不再是行为 —— 前一个人的那份
// 在他自己名下仍然有效，直到他离会；要防的是串读，不是共存。
func TestStateCacheDoesNotLeakAcrossOwners(t *testing.T) {
	room := &MeetingRoom{Sessions: map[int64]*Session{}}
	own := &thirdparty.MeetingResponse{}
	room.StoreState(own, 7)

	if room.StateFor(7) != own {
		t.Fatal("本人应当读到自己拉的那份缓存")
	}
	if room.StateFor(8) != nil {
		t.Error("用户 8 读到了用户 7 的状态 —— 里面的订阅地址带着 7 的票据，拿去订就是别人的凭证")
	}
	// 无票据信息的调用方（只读会议状态、发布清单）仍走 State()，不受归属限制。
	if room.State() == nil {
		t.Error("State() 是给无票据读法用的，不该跟着一起收紧")
	}

	// 两个人各自有一份时，互不串读。
	theirs := &thirdparty.MeetingResponse{}
	room.StoreState(theirs, 8)
	if got := room.StateFor(7); got != own {
		t.Error("8 写入后 7 读到的不再是 7 自己那份")
	}
	if got := room.StateFor(8); got != theirs {
		t.Error("8 应当读到自己刚拉的那份")
	}
}

// 人走了他那份带票据的缓存必须一起消失：留着就等于把离会者的票据继续供人读取。
func TestStateCacheDroppedOnLeave(t *testing.T) {
	rg := NewRegistry()
	rg.Join(1, "88744106", "meeting_x", &Session{UserId: 7})
	rg.Join(1, "88744106", "meeting_x", &Session{UserId: 8})
	room, ok := rg.Room(1)
	if !ok {
		t.Fatal("Join 后应当有房间")
	}
	room.StoreState(&thirdparty.MeetingResponse{}, 7)
	room.StoreState(&thirdparty.MeetingResponse{}, 8)

	rg.Leave(1, 7)
	if room.StateFor(7) != nil {
		t.Error("7 已离会，仍读得到他那份带票据的缓存")
	}
	if room.StateFor(8) == nil {
		t.Error("7 离会不该带走 8 的那份")
	}
}
