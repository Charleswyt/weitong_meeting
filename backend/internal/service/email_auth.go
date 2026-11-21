package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gogf/gf/v2/frame/g"

	"cloud-conference-backend/internal/dao"
	"cloud-conference-backend/internal/email"
	"cloud-conference-backend/internal/errs"
	"cloud-conference-backend/internal/model/do"
	"cloud-conference-backend/internal/model/entity"
	"cloud-conference-backend/internal/password"
)

var emailRE = regexp.MustCompile(`^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$`)

// EmailAuthService 邮箱验证码登录。OTP 进程内存，与短信通道彼此独立。
type EmailAuthService struct {
	auth     *AuthService
	provider email.Provider
	mu       sync.Mutex
	otps     map[string]*otpEntry // key = purpose + ":" + email
}

func NewEmailAuthService(auth *AuthService, provider email.Provider) *EmailAuthService {
	return &EmailAuthService{
		auth:     auth,
		provider: provider,
		otps:     make(map[string]*otpEntry),
	}
}

func LoadEmailConfig(ctx context.Context) email.Config {
	return email.Config{
		Provider:     g.Cfg().MustGet(ctx, "auth.email.provider", "console").String(),
		From:         g.Cfg().MustGet(ctx, "auth.email.from", "").String(),
		Subject:      g.Cfg().MustGet(ctx, "auth.email.subject", "卫通会议登录验证码").String(),
		SMTPHost:     g.Cfg().MustGet(ctx, "auth.email.smtp.host", "smtp.126.com").String(),
		SMTPPort:     g.Cfg().MustGet(ctx, "auth.email.smtp.port", 465).Int(),
		SMTPUser:     g.Cfg().MustGet(ctx, "auth.email.smtp.user", "").String(),
		SMTPPassword: g.Cfg().MustGet(ctx, "auth.email.smtp.password", "").String(),
	}
}

type EmailSendResult struct {
	CooldownSeconds int
	DebugCode      string
	Provider       string
}

func normalizeEmail(raw string) (string, error) {
	e := strings.ToLower(strings.TrimSpace(raw))
	if !emailRE.MatchString(e) {
		return "", errs.Bizf("请输入正确的邮箱地址")
	}
	return e, nil
}

func (s *EmailAuthService) findUserByEmail(ctx context.Context, addr string) (*entity.SysUser, error) {
	rec, err := dao.SysUser.Ctx(ctx).
		FieldsEx(avatarBlobColumns()).
		Where(do.SysUser{Email: addr}).
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

func genEmailCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

func (s *EmailAuthService) Send(ctx context.Context, rawEmail, purpose string) (*EmailSendResult, error) {
	addr, err := normalizeEmail(rawEmail)
	if err != nil {
		return nil, err
	}
	if purpose != "login" && purpose != "reset" {
		return nil, errs.Bizf("验证码用途无效")
	}
	user, err := s.findUserByEmail(ctx, addr)
	if err != nil {
		return nil, err
	}
	// login：未注册也可发码，验证通过后自动建号；reset：必须已有账号。
	if purpose == "reset" {
		if user == nil {
			return nil, errs.Bizf("该邮箱未注册账号，请先用验证码登录完成注册")
		}
		if user.Status != 1 {
			return nil, errs.Bizf("账号已禁用")
		}
	} else if user != nil && user.Status != 1 {
		return nil, errs.Bizf("账号已禁用")
	}

	key := otpKey(purpose, addr)
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

	code, err := genEmailCode()
	if err != nil {
		return nil, fmt.Errorf("生成验证码失败: %w", err)
	}
	if err := s.provider.SendCode(ctx, addr, code, purpose); err != nil {
		g.Log().Warningf(ctx, "邮件发送失败 provider=%s to=%s: %v", s.provider.Name(), addr, err)
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

	res := &EmailSendResult{
		CooldownSeconds: int(otpCooldown.Seconds()),
		Provider:       s.provider.Name(),
	}
	if s.provider.Name() == "console" {
		res.DebugCode = code
	}
	return res, nil
}

func (s *EmailAuthService) consume(purpose, addr, code string) error {
	key := otpKey(purpose, addr)
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

// EmailLoginOpts 控制首登建号形态（已有账号时忽略）。
type EmailLoginOpts struct {
	DisplayName string
	RegisterAs  string // user | temp；空=user
}

func (s *EmailAuthService) Login(ctx context.Context, rawEmail, code string, opts EmailLoginOpts) (*LoginResult, error) {
	addr, err := normalizeEmail(rawEmail)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(code) == "" {
		return nil, errs.Bizf("请输入验证码")
	}
	// 先核销验证码再建号：错码不得留下半成品账号。
	if err := s.consume("login", addr, code); err != nil {
		return nil, err
	}
	user, err := s.findUserByEmail(ctx, addr)
	if err != nil {
		return nil, err
	}
	if user == nil {
		user, err = s.registerByEmail(ctx, addr, opts)
		if err != nil {
			return nil, err
		}
	}
	if user.Status != 1 {
		return nil, errs.Bizf("账号已禁用")
	}
	return s.auth.issueToken(ctx, user)
}

// registerByEmail 邮箱验证码首登：本地域账号自助注册。
// 无三方口令 → issueToken 会如实回 linkSynced=false（不挡本地登录）。
func (s *EmailAuthService) registerByEmail(ctx context.Context, addr string, opts EmailLoginOpts) (*entity.SysUser, error) {
	if taken, err := s.auth.findUserByUsername(ctx, addr); err != nil {
		return nil, err
	} else if taken != nil {
		return nil, errs.Bizf("该邮箱对应登录名已被占用，请换一个邮箱或联系管理员")
	}

	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return nil, fmt.Errorf("生成口令失败: %w", err)
	}
	hashed, err := password.Hash(hex.EncodeToString(raw))
	if err != nil {
		return nil, fmt.Errorf("生成口令失败: %w", err)
	}

	display := strings.TrimSpace(opts.DisplayName)
	if display == "" {
		display = addr
		if i := strings.IndexByte(addr, '@'); i > 0 {
			display = addr[:i]
		}
	}
	if len(display) > 64 {
		display = display[:64]
	}

	accountType := "meeting_participant"
	switch strings.TrimSpace(opts.RegisterAs) {
	case "temp":
		accountType = "temp_user"
	case "", "user":
		// 普通用户
	default:
		return nil, errs.Bizf("注册类型无效")
	}
	if accountType == "temp_user" && strings.TrimSpace(opts.DisplayName) == "" {
		return nil, errs.Bizf("请填写面试用显示名")
	}

	id, err := dao.SysUser.Ctx(ctx).Data(do.SysUser{
		Username:           addr,
		Password:           hashed,
		DisplayName:        display,
		ThirdPartyAccount:  "",
		ThirdPartyPassword: "",
		AccountType:        accountType,
		Status:             1,
		Email:              addr,
	}).InsertAndGetId()
	if err != nil {
		// 并发首登：另一路已插入同一邮箱
		if u, e2 := s.findUserByEmail(ctx, addr); e2 == nil && u != nil {
			return u, nil
		}
		return nil, fmt.Errorf("注册账号失败: %w", err)
	}

	user, err := s.findUserByEmail(ctx, addr)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, fmt.Errorf("注册账号失败: 写入后读不到 userId=%d", id)
	}
	g.Log().Infof(ctx, "邮箱自助注册成功 userId=%d email=%s type=%s", user.Id, addr, accountType)
	return user, nil
}
