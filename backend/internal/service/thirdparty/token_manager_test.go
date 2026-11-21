package thirdparty

import (
	"testing"
	"time"
)

// PeekCachedToken 的存在的意义就是"别为了结束会话而先制造一个会话"，
// 所以它必须只读缓存，且过期条目当作没有。
func TestPeekCachedTokenOnlyReadsCache(t *testing.T) {
	m := NewTokenManager(New())

	if got := m.PeekCachedToken(1); got != "" {
		t.Fatalf("无缓存时应返回空串，实得 %q", got)
	}

	m.entries[2] = &tokenEntry{token: "live", expireAt: time.Now().Add(time.Hour)}
	if got := m.PeekCachedToken(2); got != "live" {
		t.Fatalf("未过期缓存应原样返回，实得 %q", got)
	}

	// 过期条目：调用方会据此跳过三方登出，绝不能把死令牌交出去再打一次。
	m.entries[3] = &tokenEntry{token: "dead", expireAt: time.Now().Add(-time.Minute)}
	if got := m.PeekCachedToken(3); got != "" {
		t.Fatalf("已过期应视作无缓存，实得 %q", got)
	}

	// 取过之后缓存还在 —— 摘除是 RemoveToken 的职责，peek 不改状态。
	if _, ok := m.entries[2]; !ok {
		t.Fatal("PeekCachedToken 不应删除条目")
	}
	m.RemoveToken(2)
	if got := m.PeekCachedToken(2); got != "" {
		t.Fatalf("RemoveToken 之后应为空，实得 %q", got)
	}
}
