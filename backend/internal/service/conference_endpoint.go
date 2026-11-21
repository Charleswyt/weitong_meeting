package service

import (
	"context"
	"os"
	"strings"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/glog"
)

// EndpointTypeForSide 把本实例的部署侧别换成三方要的端别词：边端 = `ship`、云端 = `shore`。
//
// 为什么必须有这个函数：三方 `participants[].endpointType` 是"参会者所在端"的真源（见三方契约 §8 校正 3），
// 而这个值**是我方 join 时自己申报的** —— 一直写死 `shore`，于是边端实例在会里被三方记成岸端，
// 界面跟着 `NodeTypeOf("shore")` 显示「云」（2026-10-10 实测）。侧别的唯一来源是 `deployment.side`。
func EndpointTypeForSide(side string) string {
	if strings.EqualFold(strings.TrimSpace(side), "cloud") {
		return "shore"
	}
	return "ship"
}

// ConferenceDeviceID 是 ship 入会必填的设备号（三方契约 §8：`endpointType=ship` 时 `deviceId` 必填）。
// 每台边端设备不同 → 属现场事实，进配置；`thirdParty.conference.*` 是嵌套键 + camelCase，
// gf 的 GetEffective 读不到 YAML，所以这条优先级链像 baseUrl 一样自己走（env 优先、空串视为没给）。
func ConferenceDeviceID(ctx context.Context) string {
	if v := strings.TrimSpace(os.Getenv("THIRDPARTY_CONFERENCE_DEVICE_ID")); v != "" {
		return v
	}
	return strings.TrimSpace(g.Cfg().MustGet(ctx, "thirdParty.conference.deviceId", "").String())
}

var deviceIDWarned bool

// JoinEndpoint 给 join 用的端别与设备号。没有设备号时**回落岸端**而不是硬发 ship：
// 缺一项配置不该让入会直接失败（三方那侧的行为未实测），但要在日志里点名该配哪一项 —— 否则
// 现场只会看到"自己显示成云"，查不到原因。设备号只在 ship 时才发（契约只在那种情况下要它）。
func JoinEndpoint(ctx context.Context) (endpointType, deviceID string) {
	if EndpointTypeForSide(DeploymentSide) != "ship" {
		return "shore", ""
	}
	deviceID = ConferenceDeviceID(ctx)
	if deviceID == "" {
		if !deviceIDWarned {
			deviceIDWarned = true
			glog.Warning(ctx, "边端入会未配置 deviceId，本场按岸端申报：三方会把本端记成岸端（界面显示「云」）。"+
				"请在配置里设 thirdParty.conference.deviceId（或用环境变量 THIRDPARTY_CONFERENCE_DEVICE_ID），值取现场设备的 zwt-device-id")
		}
		return "shore", ""
	}
	return "ship", deviceID
}
