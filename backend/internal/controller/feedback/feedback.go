package feedback

import (
	"github.com/gogf/gf/v2/net/ghttp"

	"cloud-conference-backend/internal/errs"
	"cloud-conference-backend/internal/response"
	"cloud-conference-backend/internal/service"
)

type Controller struct{}

func New() *Controller {
	return &Controller{}
}

type submitReq struct {
	Scores  []service.FeedbackScore `json:"scores"`
	Content string                  `json:"content" v:"max-length:1200"`
}

func (c *Controller) Summary(r *ghttp.Request) {
	res, err := service.FeedbackSummaryOf(r.Context(), r.GetClientIp(), r.UserAgent())
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	response.Ok(r, res)
}

func (c *Controller) Like(r *ghttp.Request) {
	res, err := service.LikeApp(r.Context(), r.GetClientIp(), r.UserAgent())
	if err != nil {
		response.FailSystem(r, "点赞失败", err)
		return
	}
	response.Ok(r, res)
}

func (c *Controller) Submit(r *ghttp.Request) {
	var req submitReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	if err := service.SubmitFeedback(r.Context(), userId, r.GetClientIp(), r.UserAgent(), req.Scores, req.Content); err != nil {
		if msg := errs.BizMessage(err); msg != "" {
			response.Fail(r, msg)
			return
		}
		response.FailSystem(r, "提交失败", err)
		return
	}
	response.OkWithMessage(r, "已收到您的反馈，谢谢")
}
