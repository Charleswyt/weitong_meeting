package chat

import (
	"net/http"

	"github.com/gogf/gf/v2/frame/g"
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

// UploadImage 接收 multipart：meetingId + file。只有当前在会的人能往这场会里发图。
func (c *Controller) UploadImage(r *ghttp.Request) {
	meetingId := r.Get("meetingId").Int64()
	if meetingId <= 0 {
		response.Fail(r, "缺少会议编号")
		return
	}
	if _, ok := c.tokenFor(r, meetingId); !ok {
		response.FailNotInMeeting(r, "请先加入会议")
		return
	}
	file := r.GetUploadFile("file")
	if file == nil || file.FileHeader == nil {
		response.Fail(r, "请选择图片文件（表单字段名 file）")
		return
	}
	src, err := file.Open()
	if err != nil {
		response.FailSystem(r, "读取上传文件失败", err)
		return
	}
	defer src.Close()

	url, err := service.SaveChatImage(r.Context(), meetingId, service.GetUserIdFromCtx(r.Context()), src)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	response.Ok(r, g.Map{"url": url})
}

// Image 写出图片字节，消费方是 <img>，失败一律回真状态码。
// 能看的人：上传者本人，或此刻在这场会里的人。
func (c *Controller) Image(r *ghttp.Request) {
	id := r.Get("id").Int64()
	img, err := service.LoadChatImage(r.Context(), id)
	if err != nil {
		g.Log().Errorf(r.Context(), "读取聊天图片失败 id=%d: %v", id, err)
		response.FailStream(r, http.StatusInternalServerError, "系统异常")
		return
	}
	if img == nil {
		response.FailStream(r, http.StatusNotFound, "图片不存在或已过期")
		return
	}
	userId := service.GetUserIdFromCtx(r.Context())
	if img.UserId != userId {
		if _, ok := c.registry.Session(img.MeetingId, userId); !ok {
			response.FailStream(r, http.StatusForbidden, "不在该会议中")
			return
		}
	}
	r.Response.Header().Set("Content-Type", img.Mime)
	r.Response.Header().Set("Cache-Control", "private, max-age=86400, immutable")
	r.Response.Status = http.StatusOK
	r.Response.Write(img.Data)
}
