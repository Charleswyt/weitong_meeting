package v1

import (
	"github.com/gogf/gf/v2/frame/g"

	"cloud-conference-backend/internal/model"
)

// SettingsGetReq GET /api/v1/settings/ 返回扁平对象。
type SettingsGetReq struct {
	g.Meta `path:"/settings/" method:"get" tags:"设置"`
}

type SettingsGetRes struct {
	model.PreferenceVo
}

// SettingsUpdateReq PUT /api/v1/settings/ 请求体就是扁平对象本身（不再包一层 preferences）。
// 前后端契约见 edge/conference/contracts/api-contract.md §6.6。
type SettingsUpdateReq struct {
	g.Meta `path:"/settings/" method:"put" tags:"设置"`
	model.PreferenceVo
}

type SettingsUpdateRes struct{}

// SettingsCapabilitiesRes 是「当前部署支持什么」的只读回答。
// 与偏好分开的理由：PreferenceVo 的 18 键是 PUT 的全量请求体，塞只读键会把全量覆盖弄坏。
type SettingsCapabilitiesRes struct {
	FaceEnhancement CapabilityVo `json:"faceEnhancement"`
}

// CapabilityVo 的 message 是给用户看的整句（不支持时非空），前端照实渲染，
// 不按错误码自己翻译 —— 与页面其它文案同一条口径。
type CapabilityVo struct {
	Supported bool   `json:"supported"`
	Message   string `json:"message"`
}
