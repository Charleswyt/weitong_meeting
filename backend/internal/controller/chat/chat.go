package chat

import (
	"github.com/gogf/gf/v2/net/ghttp"

	v1 "cloud-conference-backend/api/v1"
	"cloud-conference-backend/internal/response"
	"cloud-conference-backend/internal/service"
	"cloud-conference-backend/internal/session"
)

type Controller struct {
	chatSvc  *service.ChatService
	registry *session.Registry
}

func New(chatSvc *service.ChatService, registry *session.Registry) *Controller {
	return &Controller{chatSvc: chatSvc, registry: registry}
}

// tokenFor 从服务端会话映射取参会令牌；三方令牌从不下发前端（契约 §5.2）。
func (c *Controller) tokenFor(r *ghttp.Request, meetingId int64) (string, bool) {
	userId := service.GetUserIdFromCtx(r.Context())
	sess, ok := c.registry.Session(meetingId, userId)
	if !ok {
		return "", false
	}
	return sess.ParticipantToken, true
}

func (c *Controller) ListMessages(r *ghttp.Request) {
	var req v1.ChatListMessagesReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	token, ok := c.tokenFor(r, req.MeetingId)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}

	messages, err := c.chatSvc.ListMessages(r.Context(), token, req.AfterId, req.Limit)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}

	response.Ok(r, messages)
}

func (c *Controller) SendMessage(r *ghttp.Request) {
	var req v1.ChatSendMessageReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	token, ok := c.tokenFor(r, req.MeetingId)
	if !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}

	msg, err := c.chatSvc.SendMessage(r.Context(), token, req.Text)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}

	response.Ok(r, v1.ChatMessageVo{
		Text:   msg.Text,
		SentAt: msg.SentAt,
	})
}
