package service

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/gctx"
	"github.com/golang-jwt/jwt/v5"

	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/dao"
	"cloud-conference-backend/internal/errs"
	"cloud-conference-backend/internal/model/do"
	"cloud-conference-backend/internal/model/entity"
	"cloud-conference-backend/internal/password"
	"cloud-conference-backend/internal/service/thirdparty"
)

type AuthService struct {
	adapter      *thirdparty.Adapter
	tokenManager *thirdparty.TokenManager
}

func NewAuthService(adapter *thirdparty.Adapter, tokenManager *thirdparty.TokenManager) *AuthService {
	return &AuthService{adapter: adapter, tokenManager: tokenManager}
}

type LoginResult struct {
	Token      string
	User       *entity.SysUser
	LinkSynced bool
	LinkReason string
}

// linkFailureReason 把"会议链路没打通"收敛成我方本域中文：链路的实现方是谁、它回了什么报文，
// 都不属于我们的页面（契约 §2、前端只认后端）。原始错误只进服务端日志。
func linkFailureReason(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "401"), strings.Contains(msg, "403"), strings.Contains(msg, "bad_credentials"):
		return "会议链路账号或口令不正确，录制、会中等功能暂不可用"
	case strings.Contains(msg, "timeout"), strings.Contains(msg, "connection refused"),
		strings.Contains(msg, "no such host"), strings.Contains(msg, "dial "):
		return "暂时连不上会议链路，录制、会中等功能暂不可用"
	}
	return "会议链路未打通，录制、会中等功能暂不可用"
}

// upgradeToHashed 把遗留的明文口令列就地换成哈希。不挡登录成功（这一趟已经验过了），
// 但失败必须留在日志里：那意味着库里还躺着一条明文，得跑 migrate -hash-passwords 收干净。
func (s *AuthService) upgradeToHashed(ctx context.Context, userId int64, plainPass string) {
	hashed, err := password.Hash(plainPass)
	if err != nil {
		g.Log().Warningf(ctx, "口令哈希生成失败 user=%d: %v", userId, err)
		return
	}
	if _, err := dao.SysUser.Ctx(ctx).Where(do.SysUser{Id: userId}).
		Data(do.SysUser{Password: hashed}).Update(); err != nil {
		g.Log().Warningf(ctx, "口令列升级为哈希失败 user=%d: %v", userId, err)
	}
}

func (s *AuthService) Login(ctx context.Context, username, plainPass string) (*LoginResult, error) {
	user, err := s.findUserByUsername(ctx, username)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, errs.Bizf("用户名或密码错误")
	}
	if !password.Verify(user.Password, plainPass) {
		return nil, errs.Bizf("用户名或密码错误")
	}
	if user.Status != 1 {
		return nil, errs.Bizf("账号已禁用")
	}
	if password.NeedsUpgrade(user.Password) {
		s.upgradeToHashed(ctx, user.Id, plainPass)
	}

	return s.issueToken(ctx, user)
}

// findUserByUsername 按登录名取用户，**查不到回 (nil, nil)** 而不是报错。
// 这条不是风格问题：Scan 在零行时返回 sql.ErrNoRows，走 err 分支就被伪装成「系统异常」，
// 用户拼错账号看到的是一句我方坏了（第 34/42 项，见契约 ADR-0028）。
// 口令登录要的是"账号不存在"和"口令不对"给同一句话，免登录要的是能分开判 ——
// 所以这里只把"有没有这一行"如实交出去，两句话由两个调用方各自写。
func (s *AuthService) findUserByUsername(ctx context.Context, username string) (*entity.SysUser, error) {
	rec, err := dao.SysUser.Ctx(ctx).
		FieldsEx(avatarBlobColumns()).
		Where(do.SysUser{Username: username}).
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

// issueToken 是"身份已经成立"之后共同的一段：先打通该账号的三方会话（三方没通不挡登录，
// 但状态必须如实带回 UI），再按三方的回话校正 accountType，最后签我方令牌。
// 口令登录与免登录共用这一个出口，避免两条路各签一套、其中一条悄悄少了令牌或权限回写。
func (s *AuthService) issueToken(ctx context.Context, user *entity.SysUser) (*LoginResult, error) {
	res := &LoginResult{User: user}

	_, thirdAuth, err := s.tokenManager.GetTokenWithAuth(ctx, user.Id, user.ThirdPartyAccount, user.ThirdPartyPassword)
	if err != nil {
		// 本地控制面登录成立，但三方同步失败必须如实上报：
		// 录制、会中等三方数据源页面会因此拿不到数据，UI 要据此提示，绝不伪造。
		res.LinkSynced = false
		res.LinkReason = linkFailureReason(err)
		g.Log().Warningf(ctx, "third-party login failed for user %s: %v", user.Username, err)
	} else {
		res.LinkSynced = true
		if thirdAuth != nil && thirdAuth.AccountType != "" && thirdAuth.AccountType != user.AccountType {
			// 三方账号权限变了就回写；这一步把"权限真源在三方"接进数据流。
			if _, uerr := dao.SysUser.Ctx(ctx).Where(do.SysUser{Id: user.Id}).
				Data(do.SysUser{AccountType: thirdAuth.AccountType}).Update(); uerr != nil {
				g.Log().Warningf(ctx, "回写 account_type 失败 user=%d: %v", user.Id, uerr)
			} else {
				user.AccountType = thirdAuth.AccountType
			}
		}
	}

	jwtToken, err := s.generateJWT(ctx, user)
	if err != nil {
		return nil, fmt.Errorf("生成令牌失败: %w", err)
	}
	res.Token = jwtToken
	return res, nil
}

// Logout 除了废掉我方令牌，还要把三方侧那次登录一起结束掉——否则三方留着
// 一个"已登录但我方不再认识"的会话（契约 20260928 §11 判定唯一还该补的卫生项）。
// 两个约束：① 只在我方确实缓存过三方令牌时才打，不为登出而先产生一个登录；
// ② 异步且限时 —— 船端离线时链路不可达，那不能把用户的登出按钮一起拖死。
func (s *AuthService) Logout(ctx context.Context, userId int64) {
	if tpToken := s.tokenManager.PeekCachedToken(userId); tpToken != "" {
		g.Go(gctx.New(), func(bg context.Context) {
			callCtx, cancel := context.WithTimeout(bg, 5*time.Second)
			defer cancel()
			if err := s.adapter.Logout(callCtx, tpToken); err != nil {
				g.Log().Warningf(callCtx, "三方会话未随登出结束 user=%d: %v", userId, err)
			} else {
				g.Log().Infof(callCtx, "三方会话已随登出结束 user=%d", userId)
			}
		}, nil)
	}
	s.tokenManager.RemoveToken(userId)
}

func (s *AuthService) GetMe(ctx context.Context, userId int64) (*entity.SysUser, error) {
	rec, err := dao.SysUser.Ctx(ctx).
		FieldsEx(avatarBlobColumns()).
		Where(do.SysUser{Id: userId}).
		One()
	if err != nil {
		return nil, fmt.Errorf("查询用户失败: %w", err)
	}
	if rec.IsEmpty() {
		return nil, errs.Bizf("用户不存在")
	}
	var user entity.SysUser
	if err := rec.Struct(&user); err != nil {
		return nil, fmt.Errorf("解析用户失败: %w", err)
	}
	return &user, nil
}

func (s *AuthService) GetThirdPartyToken(ctx context.Context, userId int64) (string, error) {
	var user entity.SysUser
	err := dao.SysUser.Ctx(ctx).
		FieldsEx(avatarBlobColumns()).
		Where(do.SysUser{Id: userId}).
		Scan(&user)
	if err != nil {
		return "", fmt.Errorf("查询用户失败: %w", err)
	}
	return s.tokenManager.GetToken(ctx, userId, user.ThirdPartyAccount, user.ThirdPartyPassword)
}

func (s *AuthService) generateJWT(ctx context.Context, user *entity.SysUser) (string, error) {
	secret := g.Cfg().MustGet(ctx, "jwt.secret").String()
	expiresHours := g.Cfg().MustGet(ctx, "jwt.expiresHours", 24).Int()

	claims := jwt.MapClaims{
		consts.JwtClaimUserId:      user.Id,
		consts.JwtClaimUsername:    user.Username,
		consts.JwtClaimAccountType: user.AccountType,
		"exp":                      time.Now().Add(time.Duration(expiresHours) * time.Hour).Unix(),
		"iat":                      time.Now().Unix(),
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(secret))
}

func GetUserIdFromCtx(ctx context.Context) int64 {
	v := ctx.Value(consts.JwtClaimUserId)
	if v == nil {
		return 0
	}
	if id, ok := v.(int64); ok {
		return id
	}
	return 0
}

func GetUsernameFromCtx(ctx context.Context) string {
	v := ctx.Value(consts.JwtClaimUsername)
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func GetAccountTypeFromCtx(ctx context.Context) string {
	v := ctx.Value(consts.JwtClaimAccountType)
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}
