package service

// 免登录（2026-10-08 起的临时方案）：不设口令，直接以配置里那一个固定账号签发令牌。
//
// 为什么这件事必须由后端决定而不是前端：**前端产物是 pnpm build 烘死的**，容器运行时传进来的
// 环境变量改不动 JS bundle（仓内也从来没有 VITE_ 通道）。所以"此刻是不是免登录、免的是谁"
// 只有后端知道，前端只向后端要结果。
//
// 为什么配置里只有登录名而没有口令：三方那套账号口令本来就按用户一行存在 sys_user 里
// （种子 seed-credentials.sql，镜像里落成 field-credentials.sql），换个入口要用的是同一行数据。
// 把口令再抄一份进配置文件就是第二个真源，还正好违反根规范"口令不落进模板"。

import (
	"context"
	"strings"

	"github.com/gogf/gf/v2/frame/g"

	"cloud-conference-backend/internal/errs"
)

// AutoLoginEnabled / AutoLoginUsername 由 internal/cmd/config.go 在启动时按
// 环境变量 > 配置文件 的次序写进来（见 ResolveAutoLogin）。默认关：不配就还是原来的口令登录。
var (
	AutoLoginEnabled  = false
	AutoLoginUsername = ""
)

// 免登录失败的机器码。前端按码分支，不比对中文（契约 §5.1）。
const (
	ReasonAutoLoginDisabled        = "auto_login_disabled"
	ReasonAutoLoginUserUnavailable = "auto_login_user_unavailable"
)

// AutoLoginSetting 是一条已经定下来的取值。
type AutoLoginSetting struct {
	Enabled  bool
	Username string
}

// ResolveAutoLogin 算出免登录的最终取值：**环境变量优先于配置文件**。
//
// 两个细节都是故意的：
//   - 环境变量给空串当"这一层没给值"，落回配置文件 —— 否则 compose 里一行写空的
//     AUTH_AUTOLOGIN_USERNAME 会把镜像内置的账号顶没，现场看到的是"免登录突然不生效"。
//   - AUTH_AUTOLOGIN_ENABLED 只认真假两族写法（true/1/on、false/0/off，大小写不敏感），
//     认不出来的值**不猜**：落回配置文件并回一句提醒让人看见。打错一个字母就默默不生效，
//     是这类开关最难查的一种坏。
//
// auth.autoLogin.* 是嵌套键 + camelCase，gf 的 GetEffective 在这条路上读不到 YAML 值，
// 所以这条优先级链只能像 thirdParty.baseUrl 那样自己走（见 thirdparty/adapter.go）。
func ResolveAutoLogin(envEnabled, envUsername string, cfg AutoLoginSetting) (AutoLoginSetting, string) {
	out := AutoLoginSetting{Enabled: cfg.Enabled, Username: strings.TrimSpace(cfg.Username)}
	warn := ""

	if v := strings.TrimSpace(envEnabled); v != "" {
		if on, ok := parseStrictBool(v); ok {
			out.Enabled = on
		} else {
			warn = "AUTH_AUTOLOGIN_ENABLED 取值无法识别，按配置文件走：" + v
		}
	}
	if v := strings.TrimSpace(envUsername); v != "" {
		out.Username = v
	}
	return out, warn
}

// parseStrictBool 只认明示的真假写法；其余返回 ok=false，让调用方去提醒而不是替用户决定。
func parseStrictBool(v string) (on bool, ok bool) {
	switch strings.ToLower(v) {
	case "true", "1", "on", "yes":
		return true, true
	case "false", "0", "off", "no":
		return false, true
	}
	return false, false
}

// AutoLogin 以配置里那个固定账号换令牌，返回形状与口令登录完全一致（同一个 LoginResult），
// 所以 WS 一次性票、?token= 媒体资产、以及按 userId 缓存的链路令牌都照旧复用。
func (s *AuthService) AutoLogin(ctx context.Context) (*LoginResult, error) {
	if err := autoLoginRejection(); err != nil {
		return nil, err
	}

	user, err := s.findUserByUsername(ctx, AutoLoginUsername)
	if err != nil {
		return nil, err
	}
	// 查不到与已停用并一条话：这里没有"猜对了就少露一点信息"的收益，配置写错才是唯一实况。
	if user == nil || user.Status != 1 {
		g.Log().Warningf(ctx, "免登录配置的账号在系统内不可用 username=%s（不存在或已停用）", AutoLoginUsername)
		return nil, errs.BizReason(errs.Bizf("免登录账号不可用，请核对账号清单"), ReasonAutoLoginUserUnavailable)
	}

	// 这一行是留给现场的：免登录不需要人碰凭据，"现在这台是以谁在服务"只能从日志确认。
	g.Log().Infof(ctx, "免登录签发身份 username=%s userId=%d", user.Username, user.Id)
	return s.issueToken(ctx, user)
}

// autoLoginRejection 判"这个实例允不允许免登录"，不碰库（这一段可单测）。
func autoLoginRejection() error {
	if !AutoLoginEnabled {
		return errs.BizReason(errs.Bizf("免登录未开启，请使用账号登录"), ReasonAutoLoginDisabled)
	}
	if strings.TrimSpace(AutoLoginUsername) == "" {
		return errs.BizReason(errs.Bizf("免登录未配置账号，请检查配置"), ReasonAutoLoginDisabled)
	}
	return nil
}
