package settings

import (
	"github.com/gogf/gf/v2/net/ghttp"

	v1 "cloud-conference-backend/api/v1"
	"cloud-conference-backend/internal/edgeaccess"
	"cloud-conference-backend/internal/errs"
	"cloud-conference-backend/internal/model"
	"cloud-conference-backend/internal/response"
	"cloud-conference-backend/internal/service"
)

type Controller struct {
	settingsSvc *service.SettingsService
}

func New(settingsSvc *service.SettingsService) *Controller {
	return &Controller{settingsSvc: settingsSvc}
}

func (c *Controller) Get(r *ghttp.Request) {
	userId := service.GetUserIdFromCtx(r.Context())
	prefs, err := c.settingsSvc.GetPreferences(r.Context(), userId)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	response.Ok(r, prefs)
}

func (c *Controller) Capabilities(r *ghttp.Request) {
	node, valid := edgeaccess.Verify(r.Request, nil)
	if !valid {
		r.Response.WriteStatus(403)
		return
	}
	side := service.DeploymentSide
	if node != "" {
		side = "edge"
	}
	supported := service.FaceEnhancementSupported()
	message := ""
	if !supported {
		message = service.FaceEnhancementUnsupportedMessage()
	}
	response.Ok(r, v1.SettingsCapabilitiesRes{
		AccessNode:      side,
		FaceEnhancement: v1.CapabilityVo{Supported: supported, Message: message},
	})
}

func (c *Controller) GetClient(r *ghttp.Request) {
	userId := service.GetUserIdFromCtx(r.Context())
	prefs, err := c.settingsSvc.GetClientPrefs(r.Context(), userId)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	response.Ok(r, prefs)
}

func (c *Controller) PatchClient(r *ghttp.Request) {
	var req model.ClientPrefsPatch
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	prefs, err := c.settingsSvc.PatchClientPrefs(r.Context(), userId, &req)
	if err != nil {
		if msg := errs.BizMessage(err); msg != "" {
			response.Fail(r, msg)
			return
		}
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	response.Ok(r, prefs)
}

func (c *Controller) Update(r *ghttp.Request) {
	var req v1.SettingsUpdateReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}

	userId := service.GetUserIdFromCtx(r.Context())
	if err := c.settingsSvc.UpdatePreferences(r.Context(), userId, &req.PreferenceVo); err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	response.OkWithMessage(r, "设置已保存")
}
