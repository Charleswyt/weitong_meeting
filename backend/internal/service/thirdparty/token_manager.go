package thirdparty

import (
	"context"
	"sync"
	"time"

	"github.com/gogf/gf/v2/frame/g"
)

type tokenEntry struct {
	token       string
	accountType string
	expireAt    time.Time
	account     string
	password    string
}

type TokenManager struct {
	mu      sync.RWMutex
	entries map[int64]*tokenEntry
	adapter *Adapter
}

func NewTokenManager(adapter *Adapter) *TokenManager {
	return &TokenManager{
		entries: make(map[int64]*tokenEntry),
		adapter: adapter,
	}
}

func (m *TokenManager) GetToken(ctx context.Context, userId int64, account, password string) (string, error) {
	token, _, err := m.GetTokenWithAuth(ctx, userId, account, password)
	return token, err
}

// GetTokenWithAuth 返回 token 与三方 AuthResult（含 accountType）；
// 缓存命中时从缓存条目重建 AuthResult。
func (m *TokenManager) GetTokenWithAuth(ctx context.Context, userId int64, account, password string) (string, *AuthResult, error) {
	m.mu.RLock()
	entry, ok := m.entries[userId]
	m.mu.RUnlock()

	if ok && time.Until(entry.expireAt) > 5*time.Minute {
		return entry.token, &AuthResult{Token: entry.token, AccountType: entry.accountType}, nil
	}

	token, err := m.refreshToken(ctx, userId, account, password)
	if err != nil {
		return "", nil, err
	}
	m.mu.RLock()
	e := m.entries[userId]
	m.mu.RUnlock()
	return token, &AuthResult{Token: token, AccountType: e.accountType}, nil
}

func (m *TokenManager) refreshToken(ctx context.Context, userId int64, account, password string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if entry, ok := m.entries[userId]; ok && time.Until(entry.expireAt) > 5*time.Minute {
		return entry.token, nil
	}

	result, err := m.adapter.Login(ctx, account, password)
	if err != nil {
		return "", err
	}

	ttl := 2 * time.Hour
	if m.adapter.IsSinosatV1(ctx) {
		// 公网会议账号令牌文档示例 expiresIn=28800（8h）；缓存略短于上游以免踩过期。
		ttl = 7 * time.Hour
	}
	m.entries[userId] = &tokenEntry{
		token:       result.Token,
		accountType: result.AccountType,
		expireAt:    time.Now().Add(ttl),
		account:     account,
		password:    password,
	}

	g.Log().Infof(ctx, "refreshed third-party token for user %d, accountType=%s", userId, result.AccountType)
	return result.Token, nil
}

// PeekCachedToken 只读缓存里现有的三方令牌，没有就返回空串。
// 与 GetToken 的区别是它绝不触发登录——"要不要结束三方会话"不该反过来产生一个会话。
func (m *TokenManager) PeekCachedToken(userId int64) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	entry, ok := m.entries[userId]
	if !ok || time.Until(entry.expireAt) <= 0 {
		return ""
	}
	return entry.token
}

func (m *TokenManager) RemoveToken(userId int64) {
	m.mu.Lock()
	delete(m.entries, userId)
	m.mu.Unlock()
}
