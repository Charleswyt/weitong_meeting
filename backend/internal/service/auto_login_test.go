package service

import (
	"testing"

	"cloud-conference-backend/internal/errs"
)

// 免登录取值的优先级链：**环境变量 > 配置文件**，且环境变量给空串当"没给值"。
// 后面那条是现场会撞的：compose 里写了一行空值的 AUTH_AUTOLOGIN_USERNAME，
// 若把空串当成一次显式赋值，镜像内置的账号就被顶没，看到的是"免登录突然不生效"。
func TestResolveAutoLogin_EnvOverridesConfig(t *testing.T) {
	cfg := AutoLoginSetting{Enabled: true, Username: "wangqiang"}

	cases := []struct {
		name        string
		envEnabled  string
		envUsername string
		cfg         AutoLoginSetting
		want        AutoLoginSetting
		wantWarn    bool
	}{
		{"两个 env 都不给，全盘按配置文件", "", "", cfg, cfg, false},
		{"env 给空串不算赋值", "  ", "   ", cfg, cfg, false},
		{"env 换账号", "", "zhangming", cfg, AutoLoginSetting{Enabled: true, Username: "zhangming"}, false},
		// 这一条方向要钉死：现场关掉免登录靠 env，不能反过来被配置文件里的 true 顶回来。
		{"env 关掉配置文件开着的开关", "false", "", cfg, AutoLoginSetting{Enabled: false, Username: "wangqiang"}, false},
		{"env 开、配置关", "true", "liwei", AutoLoginSetting{Enabled: false, Username: "wangqiang"}, AutoLoginSetting{Enabled: true, Username: "liwei"}, false},
		{"认 ON/1/TRUE 这几种写法", "ON", "", AutoLoginSetting{}, AutoLoginSetting{Enabled: true}, false},
		{"认 OFF/0/no 这几种写法", "0", "", AutoLoginSetting{Enabled: true, Username: "wangqiang"}, AutoLoginSetting{Enabled: false, Username: "wangqiang"}, false},
		// 打错一个字母就默默不生效，是这类开关最难查的一种坏 —— 必须给出提醒而不是替人决定。
		{"认不出来的取值落回配置并提醒", "ture", "", cfg, cfg, true},
		{"配置里的账号带空格会被 trim", "", "", AutoLoginSetting{Enabled: true, Username: " wangqiang "}, cfg, false},
	}

	for _, c := range cases {
		got, warn := ResolveAutoLogin(c.envEnabled, c.envUsername, c.cfg)
		if got != c.want {
			t.Errorf("%s: 得到 %+v, 期望 %+v", c.name, got, c.want)
		}
		if (warn != "") != c.wantWarn {
			t.Errorf("%s: 提醒=%q, 期望有提醒=%v", c.name, warn, c.wantWarn)
		}
	}
}

// 开关与账号决定"能不能免登录"，且拒绝必须带机器码 —— 前端按 reason 落回登录页，
// 不是拿中文文案做匹配。
func TestAutoLoginRejection(t *testing.T) {
	defer func(enabled bool, username string) {
		AutoLoginEnabled, AutoLoginUsername = enabled, username
	}(AutoLoginEnabled, AutoLoginUsername)

	cases := []struct {
		name       string
		enabled    bool
		username   string
		wantReason string
	}{
		{"开关关着", false, "wangqiang", ReasonAutoLoginDisabled},
		{"开着但没配账号", true, "", ReasonAutoLoginDisabled},
		{"开着但账号是纯空格", true, "   ", ReasonAutoLoginDisabled},
		{"开着且账号齐了，放行", true, "wangqiang", ""},
	}

	for _, c := range cases {
		AutoLoginEnabled, AutoLoginUsername = c.enabled, c.username
		err := autoLoginRejection()
		if c.wantReason == "" {
			if err != nil {
				t.Errorf("%s: 应当放行，却回了 %v", c.name, err)
			}
			continue
		}
		if err == nil {
			t.Fatalf("%s: 应当拒绝，却放行了", c.name)
		}
		if got := errs.BizReasonOf(err); got != c.wantReason {
			t.Errorf("%s: reason=%q, 期望 %q", c.name, got, c.wantReason)
		}
		// 拒绝的话必须是用户/运维能行动的（BizMessage 非空才不会被 response 收敛成「系统异常」）。
		if errs.BizMessage(err) == "" {
			t.Errorf("%s: 拒绝没有业务文案，前端会看到「系统异常」", c.name)
		}
	}
}
