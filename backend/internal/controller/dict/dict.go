package dict

import (
	"github.com/gogf/gf/v2/net/ghttp"

	v1 "cloud-conference-backend/api/v1"
	"cloud-conference-backend/internal/response"
	"cloud-conference-backend/internal/service"
)

type Controller struct {
	dictSvc *service.DictService
}

func New(dictSvc *service.DictService) *Controller {
	return &Controller{dictSvc: dictSvc}
}

func (c *Controller) List(r *ghttp.Request) {
	var req v1.DictListReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	items, err := c.dictSvc.ListByType(r.Context(), req.Type)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	out := make([]v1.DictItemVo, 0, len(items))
	for _, it := range items {
		out = append(out, v1.DictItemVo{Value: it.Value, Label: it.Label, TagType: it.TagType, Sort: it.Sort})
	}
	response.Ok(r, out)
}
