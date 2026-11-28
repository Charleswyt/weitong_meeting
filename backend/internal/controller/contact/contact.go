package contact

import (
	"github.com/gogf/gf/v2/net/ghttp"

	"cloud-conference-backend/internal/response"
	"cloud-conference-backend/internal/service"
)

type Controller struct {
	svc *service.ContactService
}

func New(svc *service.ContactService) *Controller {
	return &Controller{svc: svc}
}

type addReq struct {
	UserId int64  `json:"userId" v:"required|min:1"`
	Remark string `json:"remark"`
}

type remarkReq struct {
	Remark string `json:"remark"`
}

type inviteReq struct {
	MeetingId int64   `json:"meetingId" v:"required|min:1"`
	UserIds   []int64 `json:"userIds"`
	JoinUrl   string  `json:"joinUrl"`
}

func (c *Controller) List(r *ghttp.Request) {
	list, err := c.svc.ListContacts(r.Context(), service.GetUserIdFromCtx(r.Context()))
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	response.Ok(r, list)
}

func (c *Controller) Search(r *ghttp.Request) {
	list, err := c.svc.SearchUsers(r.Context(), service.GetUserIdFromCtx(r.Context()), r.Get("keyword").String())
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	response.Ok(r, list)
}

func (c *Controller) Add(r *ghttp.Request) {
	var req addReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	if err := c.svc.AddContact(r.Context(), service.GetUserIdFromCtx(r.Context()), req.UserId, req.Remark); err != nil {
		response.FailSystem(r, "添加好友失败", err)
		return
	}
	response.OkWithMessage(r, "已添加到通讯录")
}

func (c *Controller) Remove(r *ghttp.Request) {
	if err := c.svc.RemoveContact(r.Context(), service.GetUserIdFromCtx(r.Context()), r.Get("userId").Int64()); err != nil {
		response.FailSystem(r, "删除好友失败", err)
		return
	}
	response.OkWithMessage(r, "已从通讯录删除")
}

func (c *Controller) UpdateRemark(r *ghttp.Request) {
	var req remarkReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	if err := c.svc.UpdateRemark(r.Context(), service.GetUserIdFromCtx(r.Context()), r.Get("userId").Int64(), req.Remark); err != nil {
		response.FailSystem(r, "更新备注失败", err)
		return
	}
	response.OkWithMessage(r, "备注已更新")
}

func (c *Controller) Invite(r *ghttp.Request) {
	var req inviteReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	res, err := c.svc.InviteContacts(r.Context(), req.MeetingId, service.GetUserIdFromCtx(r.Context()), req.UserIds, req.JoinUrl)
	if err != nil {
		response.FailSystem(r, "邀请失败", err)
		return
	}
	response.Ok(r, res)
}
