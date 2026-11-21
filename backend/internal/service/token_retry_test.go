package service

import (
	"errors"
	"strings"
	"testing"
)

func TestIsLoginRequired(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"网关族 401", errors.New(`third-party API POST /x returned 401: {"ok":false,"reason":"login_required"}`), true},
		{"大小写不敏感", errors.New("Login_Required"), true},
		{"其它 reason 不算", errors.New(`returned 400: {"ok":false,"reason":"meeting_not_found"}`), false},
		{"无错误", nil, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := IsLoginRequired(c.err); got != c.want {
				t.Fatalf("IsLoginRequired(%v) = %v，期望 %v", c.err, got, c.want)
			}
		})
	}
}

// 判据自证：坏样本（login_required）必须触发**恰好一次**重登重试；其余错误一次都不许多试。
func TestRetryOnLoginRequired(t *testing.T) {
	loginErr := errors.New(`returned 401: {"ok":false,"reason":"login_required"}`)

	t.Run("命中 login_required 就重登再跑一次", func(t *testing.T) {
		calls, refreshes := 0, 0
		err := retryOnLoginRequired(
			func() (string, error) { return "dead", nil },
			func() (string, error) { refreshes++; return "fresh", nil },
			func(tok string) error {
				calls++
				if tok == "fresh" {
					return nil
				}
				return loginErr
			},
		)
		if err != nil || calls != 2 || refreshes != 1 {
			t.Fatalf("期望成功且 calls=2/refreshes=1，实际 err=%v calls=%d refreshes=%d", err, calls, refreshes)
		}
	})

	t.Run("非登录错误不许重试", func(t *testing.T) {
		calls, refreshes := 0, 0
		bizErr := errors.New("meeting_not_found")
		err := retryOnLoginRequired(
			func() (string, error) { return "t", nil },
			func() (string, error) { refreshes++; return "t2", nil },
			func(string) error { calls++; return bizErr },
		)
		if !errors.Is(err, bizErr) || calls != 1 || refreshes != 0 {
			t.Fatalf("期望原错误且不重试，实际 err=%v calls=%d refreshes=%d", err, calls, refreshes)
		}
	})

	t.Run("重登失败时报第一次的错误（别让重试的失败盖住根因）", func(t *testing.T) {
		err := retryOnLoginRequired(
			func() (string, error) { return "dead", nil },
			func() (string, error) { return "", errors.New("login 挂了") },
			func(string) error { return loginErr },
		)
		if !strings.Contains(err.Error(), "login_required") {
			t.Fatalf("期望回第一次的错误，实际 %v", err)
		}
	})

	t.Run("重登后仍失败也返回第二次的错误", func(t *testing.T) {
		calls := 0
		err := retryOnLoginRequired(
			func() (string, error) { return "dead", nil },
			func() (string, error) { return "fresh", nil },
			func(string) error { calls++; return loginErr },
		)
		if calls != 2 || !IsLoginRequired(err) {
			t.Fatalf("期望重试两次仍报该错，实际 calls=%d err=%v", calls, err)
		}
	})
}
