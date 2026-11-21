package service

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gogf/gf/v2/frame/g"

	"cloud-conference-backend/internal/dao"
	"cloud-conference-backend/internal/errs"
	"cloud-conference-backend/internal/model/do"
	"cloud-conference-backend/internal/model/entity"
	"cloud-conference-backend/internal/password"
	"cloud-conference-backend/internal/sms"
)

var mobileRE = regexp.MustCompile(`^1\d{10}$`)

const (
	otpTTL       = 5 * time.Minute
	otpCooldown = 60 * time.Second
	otpMaxTries  = 5
)

type otpEntry struct {
	code      string
	purpose   string
	expiresAt time.Time
	sentAt    time.Time
	tries     int
}

// SmsAuthService 短信验证码登录 / 找回密码。OTP 只活在进程内存里 —— 重启即失效，
// 换 Redis 等共享存储时仍走同一套 Send/Login/Reset 出口。
type SmsAuthService struct {
	auth     *AuthService
	provider sms.Provider
	mu       sync.Mutex
	otps     map[string]*otpEntry // key = purpose + ":" + mobile
}

func NewSmsAuthService(auth *AuthService, provider sms.Provider) *SmsAuthService {
	return &SmsAuthService{
		auth:     auth,
		provider: provider,
		otps:     make(map[string]*otpEntry),
	}
}

func LoadSmsConfig(ctx context.Context) sms.Config {
	return sms.Config{
		Provider:     g.Cfg().MustGet(ctx, "auth.sms.provider", "console").String(),
		Sign:         g.Cfg().MustGet(ctx, "auth.sms.sign", "卫通会议").String(),
		SmsbaoUser:   g.Cfg().MustGet(ctx, "auth.sms.smsbao.user", "").String(),
		SmsbaoApiKey: g.Cfg().MustGet(ctx, "auth.sms.smsbao.apiKey", "").String(),
	}
}

type SmsSendResult struct {
	CooldownSeconds int
	// DebugCode 仅 console 通道回填，方便前端联调；正式通道恒为空。
	DebugCode string
	Provider  string
}

func otpKey(purpose, mobile string) string {
	return purpose + ":" + mobile
}

func normalizeMobile(mobile string) (string, error) {
	m := strings.TrimSpace(mobile)
	if !mobileRE.MatchString(m) {
		return "", errs.Bizf("请输入正确的 11 位手机号")
	}
	return m, nil
}

func (s *SmsAuthService) findUserByMobile(ctx context.Context, mobile string) (*entity.SysUser, error) {
	rec, err := dao.SysUser.Ctx(ctx).
		FieldsEx(avatarBlobColumns()).
		Where(do.SysUser{Mobile: mobile}).
		WhereNull(dao.SysUser.Columns().DeletedAt).
		One()
	if err != nil {
		return nil, fmt.Errorf("查询用户失败: %w", err)
	}
	if rec.IsEmpty() {
		return nil, nil
	}
	var user entity.SysUser
	if err := rec.Struct(&user); err != nil {
		return nil, fmt.Errorf("解析用户失败: %w", err)
	}
	return &user, nil
}

func genCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

func (s *SmsAuthService) Send(ctx context.Context, mobile, purpose string) (*SmsSendResult, error) {
	m, err := normalizeMobile(mobile)
	if err != nil {
		return nil, err
	}
	if purpose != "login" && purpose != "reset" {
		return nil, errs.Bizf("验证码用途无效")
	}
	user, err := s.findUserByMobile(ctx, m)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, errs.Bizf("该手机号未绑定账号，请联系管理员")
	}
	if user.Status != 1 {
		return nil, errs.Bizf("账号已禁用")
	}

	key := otpKey(purpose, m)
	s.mu.Lock()
	if cur := s.otps[key]; cur != nil && time.Since(cur.sentAt) < otpCooldown {
		left := int(otpCooldown.Seconds()) - int(time.Since(cur.sentAt).Seconds())
		if left < 1 {
			left = 1
		}
		s.mu.Unlock()
		return nil, errs.Bizf("发送过于频繁，请 %d 秒后再试", left)
	}
	s.mu.Unlock()

	code, err := genCode()
	if err != nil {
		return nil, fmt.Errorf("生成验证码失败: %w", err)
	}
	if err := s.provider.SendCode(ctx, m, code, purpose); err != nil {
		g.Log().Warningf(ctx, "短信发送失败 provider=%s mobile=%s: %v", s.provider.Name(), m, err)
		return nil, errs.Bizf("验证码发送失败，请稍后再试")
	}

	now := time.Now()
	s.mu.Lock()
	s.otps[key] = &otpEntry{
		code:      code,
		purpose:   purpose,
		expiresAt: now.Add(otpTTL),
		sentAt:    now,
		tries:     0,
	}
	s.mu.Unlock()

	res := &SmsSendResult{
		CooldownSeconds: int(otpCooldown.Seconds()),
		Provider:       s.provider.Name(),
	}
	if s.provider.Name() == "console" {
		res.DebugCode = code
	}
	return res, nil
}

func (s *SmsAuthService) consume(purpose, mobile, code string) error {
	key := otpKey(purpose, mobile)
	s.mu.Lock()
	defer s.mu.Unlock()
	cur := s.otps[key]
	if cur == nil || time.Now().After(cur.expiresAt) {
		delete(s.otps, key)
		return errs.Bizf("验证码无效或已过期")
	}
	cur.tries++
	if cur.tries > otpMaxTries {
		delete(s.otps, key)
		return errs.Bizf("验证码错误次数过多，请重新获取")
	}
	if cur.code != strings.TrimSpace(code) {
		return errs.Bizf("验证码错误")
	}
	delete(s.otps, key)
	return nil
}

func (s *SmsAuthService) Login(ctx context.Context, mobile, code string) (*LoginResult, error) {
	m, err := normalizeMobile(mobile)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(code) == "" {
		return nil, errs.Bizf("请输入验证码")
	}
	user, err := s.findUserByMobile(ctx, m)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, errs.Bizf("该手机号未绑定账号，请联系管理员")
	}
	if user.Status != 1 {
		return nil, errs.Bizf("账号已禁用")
	}
	if err := s.consume("login", m, code); err != nil {
		return nil, err
	}
	return s.auth.issueToken(ctx, user)
}

func (s *SmsAuthService) ResetPassword(ctx context.Context, mobile, code, plainPass string) error {
	m, err := normalizeMobile(mobile)
	if err != nil {
		return err
	}
	if len(plainPass) < 6 {
		return errs.Bizf("新密码至少 6 位")
	}
	user, err := s.findUserByMobile(ctx, m)
	if err != nil {
		return err
	}
	if user == nil {
		return errs.Bizf("该手机号未绑定账号，请联系管理员")
	}
	if user.Status != 1 {
		return errs.Bizf("账号已禁用")
	}
	if err := s.consume("reset", m, code); err != nil {
		return err
	}
	hashed, err := password.Hash(plainPass)
	if err != nil {
		return fmt.Errorf("口令哈希失败: %w", err)
	}
	if _, err := dao.SysUser.Ctx(ctx).Where(do.SysUser{Id: user.Id}).
		Data(do.SysUser{Password: hashed}).Update(); err != nil {
		return fmt.Errorf("更新口令失败: %w", err)
	}
	return nil
}
