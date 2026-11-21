package cmd

import (
	"context"
	"net/url"
	"os"
	"strconv"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/glog"
	"github.com/gogf/gf/v2/os/gtime"

	"cloud-conference-backend/internal/service"
)

// 配置全部来自 manifest/config/config.yaml。镜像里内置了一份默认（打包 config.yaml.example），
// 所以挂载是可选项；要改现场值就挂自己的文件覆盖它。该文件带 jwt.secret 与 SM2 私钥，
// 仓库里已 gitignore，模板见 config.yaml.example。
//
// 容器形态下"每实例可能变"的键走环境变量覆盖：gf 的 Get/MustGet **只看配置文件**，
// 必须用 GetEffective（优先级：命令行 > 环境变量 > 配置文件），env 名由键名大写、点换下划线得到
// —— gf 不加前缀，所以这些名字别被别的进程顺手设了。当前走 env 的键：
//
//   - SERVER_TIMEZONE              → server.timezone
//   - DEPLOYMENT_SIDE              → deployment.side
//   - LOGGER_LEVEL                 → logger.level
//   - THIRDPARTY_CONFERENCE_BASEURL → thirdParty.conference.baseUrl
//   - AUTH_AUTOLOGIN_ENABLED       → auth.autoLogin.enabled
//   - AUTH_AUTOLOGIN_USERNAME      → auth.autoLogin.username
//
// 后两条是嵌套键，GetEffective 那条路读不到 YAML，由 service.ResolveAutoLogin 自己排优先级
// （环境变量给空串当"没给值"，落回配置文件）。
//
// 监听端口**刻意不设 env 通道**：容器里换对外端口是 `-p <宿主端口>:80` 的事，
// 容器内监听地址不需要动；真要改（例如 network_mode=host）就改挂载的 config.yaml，别留两条真源。
func init() {
	ctx := context.Background()
	// 时区先钉，后面所有日志与落库时间才都按业务时区走 —— 早于这一步打的日志会露出 UTC，
	// 现场对日志排查时会把两种时间戳当成两件事。
	// 落库的时间戳必须按业务时区写，不能跟宿主机时区走：边端宿机若是 UTC，
	// naive 时间会被云端读成 +08，跨时区部署就差出 8 小时。
	tz := g.Cfg().MustGetEffective(ctx, "server.timezone", "Asia/Shanghai").String()
	if err := gtime.SetTimeZone(tz); err != nil {
		g.Log().Fatalf(ctx, "server.timezone 无效（%s）: %v", tz, err)
	}
	// 日志级别。本仓的日志走 glog 的**包级默认 logger**（ghttp 的启动横幅也是），
	// 那条路不经过 gins 的配置注入 —— 所以 `logger.level` 写在文件里不会自动生效，
	// 必须在这里显式设一次（实测：不设时写 error 仍打 INFO 行）。
	// 走 GetEffective 让环境变量 LOGGER_LEVEL 能覆盖配置文件（容器部署时改日志级别
	// 不必挂自己的 config.yaml）。
	if lv := g.Cfg().MustGetEffective(ctx, "logger.level", ""); !lv.IsEmpty() {
		if n, err := strconv.Atoi(lv.String()); err == nil {
			glog.SetLevel(n)
		} else if err = glog.SetLevelStr(lv.String()); err != nil {
			g.Log().Fatalf(ctx, `logger.level 无效（%s）：可用 all/debug/info/notice/warning/error/critical/alert/emergency`, lv.String())
		}
	}
	if g.Cfg().MustGet(ctx, "database.default.link").String() == "" {
		g.Log().Fatalf(ctx, "缺少 database.default.link：请在 manifest/config/config.yaml 里给出 SQLite 库文件连接串")
	}
	// 镜像内置默认里这把签名密钥还是占位串。拿占位串签令牌等于谁都能伪造，
	// 所以响着提醒，不静默上线（演示环境可以先忍着，正式部署必须挂自己的 config）。
	if g.Cfg().MustGet(ctx, "jwt.secret").String() == "<换成随机串>" {
		g.Log().Warningf(ctx, "jwt.secret 仍是镜像内置占位值：任何知道该占位串的人都能伪造令牌，正式部署请挂载自己的 config.yaml 换成随机串")
	}
	// 本实例部署在哪一侧：三方没给出某个参会者的端点类型时用它兜底。
	// 默认边端（本单元是边端应用），只有显式写 cloud 才按云端。
	if g.Cfg().MustGetEffective(ctx, "deployment.side", "edge").String() == "cloud" {
		service.DeploymentSide = "cloud"
	}
	// 免登录（临时方案）：不设口令，直接以配置里那一个固定账号进系统。
	// 侧别与它是两件事 —— deployment.side 只管参会者来源怎么显示，用哪个账号服务由这里定。
	setting, warn := service.ResolveAutoLogin(
		os.Getenv("AUTH_AUTOLOGIN_ENABLED"),
		os.Getenv("AUTH_AUTOLOGIN_USERNAME"),
		service.AutoLoginSetting{
			Enabled:  g.Cfg().MustGet(ctx, "auth.autoLogin.enabled", false).Bool(),
			Username: g.Cfg().MustGet(ctx, "auth.autoLogin.username", "").String(),
		},
	)
	service.AutoLoginEnabled = setting.Enabled
	// 把"这个实例到底是哪一侧、对着哪个上游、以谁的身份服务"一次打进日志。
	// 为什么要单独一行：这几项此前只能靠配置文件名和人的记忆判断，而**文件名不是配置** ——
	// 本机联调时复制出的"云端"副本其实是从已改成边端的配置拷来的，于是按两个身份对拍、
	// 得出的却是同一个身份的两次观测，几条结论事后全部要重测。
	// 只打印 host 与账号，不打印口令与密钥。
	glog.Infof(ctx, "本实例形态 side=%s 上游=%s 免登录账号=%s 设备号=%s",
		service.DeploymentSide,
		func() string {
			u, err := url.Parse(g.Cfg().MustGet(ctx, "thirdParty.conference.baseUrl").String())
			if err != nil || u.Host == "" {
				return "(无法解析)"
			}
			return u.Host
		}(),
		g.Cfg().MustGet(ctx, "auth.autoLogin.username").String(),
		g.Cfg().MustGet(ctx, "thirdParty.conference.deviceId").String(),
	)
	service.AutoLoginUsername = setting.Username
	if warn != "" {
		g.Log().Warningf(ctx, "%s", warn)
	}
	if setting.Enabled {
		if setting.Username == "" {
			// 开着开关却没有账号：现场会看到"登录页没了但谁都进不去"，这句必须显式打出来。
			g.Log().Warningf(ctx, "免登录已开启但没配账号：请给 auth.autoLogin.username 填一个《账号清单》里的登录名")
		} else {
			g.Log().Infof(ctx, "免登录已开启，本机身份=%s", setting.Username)
		}
	}
}
