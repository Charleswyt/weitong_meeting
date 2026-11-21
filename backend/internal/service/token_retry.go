package service

import (
	"context"
	"errors"
	"strings"

	"github.com/gogf/gf/v2/os/glog"
)

// errNoTokenRefresher 只在 cmd 忘了注入重登函数时出现（那时不重试，只报第一次的错误）。
var errNoTokenRefresher = errors.New("未注入三方令牌重登能力")

// IsLoginRequired 判定"三方把这次调用判成没登录"。
// 船端网关自己回 `{"ok":false,"reason":"login_required"}`、云端转发的同一族错误都算；
// 缓存里那个令牌被作废时就是这么答的（实测：三方 Logout 会真作废令牌）。
func IsLoginRequired(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "login_required")
}

// retryOnLoginRequired 是这条规则的纯逻辑，便于单独验：
// 先用 token 取一个令牌跑 op；命中 login_required 就 refresh 换一个新的**再跑一次**，且只跑一次。
// refresh 失败时返回**第一次**的错误（那才是根因，别用重试的失败把它盖掉）。
func retryOnLoginRequired(token, refresh func() (string, error), op func(string) error) error {
	t, err := token()
	if err != nil {
		return err
	}
	first := op(t)
	if !IsLoginRequired(first) {
		return first
	}
	t2, rerr := refresh()
	if rerr != nil {
		return first
	}
	return op(t2)
}

// RefreshThirdPartyToken 丢掉缓存里的三方令牌并重新登录一次。
// 为什么要显式丢：令牌缓存 2 小时（token_manager.go），三方一侧作废后不丢就会一直用死令牌。
func (s *AuthService) RefreshThirdPartyToken(ctx context.Context, userId int64) (string, error) {
	s.tokenManager.RemoveToken(userId)
	return s.GetThirdPartyToken(ctx, userId)
}

// WithTokenRetry 用当前用户的三方令牌执行 op，令牌失效时自动重登重试一次。
// 调用方（发起/预约/入会这些"用户点一下就该成"的动作）只要把请求装进 op 即可。
func (s *AuthService) WithTokenRetry(ctx context.Context, userId int64, op func(token string) error) error {
	err := retryOnLoginRequired(
		func() (string, error) { return s.GetThirdPartyToken(ctx, userId) },
		func() (string, error) {
			glog.Warningf(ctx, "三方令牌已失效（login_required），重登后重试一次 user=%d", userId)
			return s.RefreshThirdPartyToken(ctx, userId)
		},
		op,
	)
	return err
}

// WithTokenRetry 是 MeetingService 侧的同一条规则：它的令牌解析是 cmd 注入的函数
// （见 meeting.go 的 thirdPartyToken 字段），所以不直接依赖 AuthService。
func (s *MeetingService) WithTokenRetry(ctx context.Context, userId int64, op func(token string) error) error {
	return retryOnLoginRequired(
		func() (string, error) { return s.thirdPartyToken(ctx, userId) },
		func() (string, error) {
			if s.refreshThirdPartyToken == nil {
				return "", errNoTokenRefresher
			}
			glog.Warningf(ctx, "三方令牌已失效（login_required），重登后重试一次 user=%d", userId)
			return s.refreshThirdPartyToken(ctx, userId)
		},
		op,
	)
}
