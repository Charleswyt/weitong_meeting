package user

import (
	"context"
	"net/http"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"

	v1 "cloud-conference-backend/api/v1"
	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/model/entity"
	"cloud-conference-backend/internal/response"
	"cloud-conference-backend/internal/service"
)

type Controller struct {
	avatarSvc *service.AvatarService
	userSvc   *service.UserService
	dictSvc   *service.DictService
}

func New(avatarSvc *service.AvatarService, userSvc *service.UserService, dictSvc *service.DictService) *Controller {
	return &Controller{avatarSvc: avatarSvc, userSvc: userSvc, dictSvc: dictSvc}
}

// List 返回人员列表（邀请名单选择用）；positionName 由字典把 position_code 翻成中文标签。
func (c *Controller) List(r *ghttp.Request) {
	var req v1.UserListReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	users, err := c.userSvc.List(r.Context(), req.Keyword)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	list := make([]v1.UserBriefVo, 0, len(users))
	for _, u := range users {
		list = append(list, c.userToVo(r.Context(), u))
	}
	response.Ok(r, list)
}

func (c *Controller) userToVo(ctx context.Context, u entity.SysUser) v1.UserBriefVo {
	return v1.UserBriefVo{
		Id:           u.Id,
		Name:         u.DisplayName,
		PositionCode: u.PositionCode,
		PositionName: c.dictSvc.LabelOf(ctx, consts.DictTypePosition, u.PositionCode),
		Avatar:       u.Avatar,
	}
}

// UploadAvatar 接收 multipart 字段 file，把字节直接写进库，头像路径回给前端。
// 类型与体积在 service 内按文件头判定——这里不信任扩展名，也不信任客户端声明的大小。
func (c *Controller) UploadAvatar(r *ghttp.Request) {
	userId := service.GetUserIdFromCtx(r.Context())
	file := r.GetUploadFile("file")
	if file == nil || file.FileHeader == nil {
		response.Fail(r, "请选择头像文件（表单字段名 file）")
		return
	}
	src, err := file.Open()
	if err != nil {
		response.FailSystem(r, "读取上传文件失败", err)
		return
	}
	defer src.Close()

	url, err := c.avatarSvc.Save(r.Context(), userId, src)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	response.Ok(r, v1.UserAvatarRes{Avatar: url})
}

// UpdateDisplayName 改自己的显示名（第20项）：会中成员栏、聊天署名、受邀名单都读它。
func (c *Controller) UpdateDisplayName(r *ghttp.Request) {
	var req v1.UserDisplayNameReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	name, err := c.userSvc.UpdateDisplayName(r.Context(), service.GetUserIdFromCtx(r.Context()), req.DisplayName)
	if err != nil {
		response.FailSystem(r, "更新显示名失败", err)
		return
	}
	response.Ok(r, v1.UserDisplayNameRes{DisplayName: name})
}

func (c *Controller) ClearAvatar(r *ghttp.Request) {
	userId := service.GetUserIdFromCtx(r.Context())
	if err := c.avatarSvc.Clear(r.Context(), userId); err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	response.Ok(r, v1.UserAvatarRes{Avatar: ""})
}

// Avatar 写出头像字节。消费方是 <img>，所以失败一律回真状态码：
// 沿用 200 + JSON 错误体的话，浏览器只会说"图片解码失败"，把"这人没头像"和"库连不上"混成同一条。
func (c *Controller) Avatar(r *ghttp.Request) {
	var req v1.UserAvatarImageReq
	if err := r.Parse(&req); err != nil {
		response.FailStream(r, http.StatusBadRequest, "用户编号不合法")
		return
	}
	avatar, err := c.avatarSvc.Load(r.Context(), req.Id)
	if err != nil {
		g.Log().Errorf(r.Context(), "读取头像失败 user=%d: %v", req.Id, err)
		response.FailStream(r, http.StatusInternalServerError, "系统异常")
		return
	}
	if !avatar.Exists() {
		response.FailStream(r, http.StatusNotFound, "该用户没有头像")
		return
	}
	r.Response.Header().Set("Content-Type", avatar.ContentType)
	// 路径稳定（不含版本位），只能靠 max-age 折中：取 5 分钟，换头像最坏滞后 5 分钟可见。
	r.Response.Header().Set("Cache-Control", "private, max-age=300")
	r.Response.Status = http.StatusOK
	r.Response.Write(avatar.Data)
}
