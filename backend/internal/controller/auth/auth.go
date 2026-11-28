package auth

import (
	"context"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"

	v1 "cloud-conference-backend/api/v1"
	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/errs"
	"cloud-conference-backend/internal/model/entity"
	"cloud-conference-backend/internal/response"
	"cloud-conference-backend/internal/service"
)

type Controller struct {
	authSvc   *service.AuthService
	smsSvc    *service.SmsAuthService
	emailSvc  *service.EmailAuthService
	dictSvc   *service.DictService
	sm2Svc    *service.Sm2LoginService
}

func New(
	authSvc *service.AuthService,
	smsSvc *service.SmsAuthService,
	emailSvc *service.EmailAuthService,
	dictSvc *service.DictService,
	sm2Svc *service.Sm2LoginService,
) *Controller {
	return &Controller{authSvc: authSvc, smsSvc: smsSvc, emailSvc: emailSvc, dictSvc: dictSvc, sm2Svc: sm2Svc}
}

func (c *Controller) Sm2PublicKey(r *ghttp.Request) {
	desc, err := c.sm2Svc.Issue(r.Context())
	if err != nil {
		response.FailSystem(r, "获取登录公钥失败", err)
		return
	}
	response.Ok(r, desc)
}

func (c *Controller) Login(r *ghttp.Request) {
	var req v1.LoginReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	if req.Ciphertext == "" {
		response.Fail(r, "登录必须使用 SM2 信封，请勿提交明文口令")
		return
	}

	env, err := c.sm2Svc.Decrypt(r.Context(), req.KeyId, req.Challenge, req.Ciphertext)
	if err != nil {
		// 解密失败的原文（密钥 id、SM2 报错）只进日志，响应体里不带 reason=原文（第 7 项）。
		// 但 reason 本身必须带给前端：它按 key_mismatch / challenge_invalid_or_used 决定
		// "重取公钥再试一次"（契约 §5.1）。此前这里丢掉了 reason，且 WriteStatus 把
		// "Conflict" 拼在 JSON 前面让响应体不成 JSON —— 那条重试路径其实一直是废的。
		reason := err.Error()
		msg := "登录凭证失效，请重试"
		if reason == "envelope_incomplete" {
			// 信封没问题，是用户没填：这句话得说准，否则用户会去刷新页面而不是补上口令。
			msg = "请填写完整的账号和密码"
		}
		g.Log().Warningf(r.Context(), "SM2 信封校验失败 user=%s reason=%s", req.Username, reason)
		response.FailStatus(r, 409, msg, reason)
		return
	}
	if env.Username != req.Username {
		response.Fail(r, "用户名或密码错误")
		return
	}

	result, err := c.authSvc.Login(r.Context(), env.Username, env.Password)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}

	response.Ok(r, c.loginRes(r.Context(), result))
}

// AutoLogin 免登录（临时方案）：身份由配置给定，不接受任何入参 —— 让它带 username 就等于
// 又开了一条"报个名字就能变成任何人"的路，那正是这个开关要关掉的东西。
//
// 开关没开 / 配置的账号不可用时回**真 403 而不是 401**：401 会命中前端拦截器自己的登出分支
// （清令牌→跳登录页），前端只是来问"这台免不免登录"，不该被这一问踢出去（契约 §5.1）。
// 前端对 403 的处理是安静落回登录页，所以这里也不弹一句报错。
func (c *Controller) AutoLogin(r *ghttp.Request) {
	result, err := c.authSvc.AutoLogin(r.Context())
	if err != nil {
		if biz := errs.BizMessage(err); biz != "" {
			response.FailStatus(r, 403, biz, errs.BizReasonOf(err))
			return
		}
		response.FailSystem(r, "免登录处理失败", err)
		return
	}

	response.Ok(r, c.loginRes(r.Context(), result))
}

func (c *Controller) loginRes(ctx context.Context, result *service.LoginResult) v1.LoginRes {
	if result != nil && result.User != nil {
		clientIP := ""
		if req := ghttp.RequestFromCtx(ctx); req != nil {
			clientIP = req.GetClientIp()
		}
		service.RecordLoginAudit(ctx, result.User.Id, clientIP)
	}
	return v1.LoginRes{
		Token:      result.Token,
		User:       c.userVoFromEntity(ctx, result.User),
		LinkSynced: result.LinkSynced,
		LinkReason: result.LinkReason,
	}
}

func (c *Controller) Logout(r *ghttp.Request) {
	userId := service.GetUserIdFromCtx(r.Context())
	c.authSvc.Logout(r.Context(), userId)
	response.OkWithMessage(r, "登出成功")
}

func (c *Controller) Me(r *ghttp.Request) {
	userId := service.GetUserIdFromCtx(r.Context())
	user, err := c.authSvc.GetMe(r.Context(), userId)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	response.Ok(r, c.userVoFromEntity(r.Context(), user))
}

func (c *Controller) SmsSend(r *ghttp.Request) {
	var req v1.SmsSendReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	res, err := c.smsSvc.Send(r.Context(), req.Mobile, req.Purpose)
	if err != nil {
		if biz := errs.BizMessage(err); biz != "" {
			response.Fail(r, biz)
			return
		}
		response.FailSystem(r, "验证码发送失败", err)
		return
	}
	response.Ok(r, v1.SmsSendRes{
		CooldownSeconds: res.CooldownSeconds,
		Provider:       res.Provider,
		DebugCode:      res.DebugCode,
	})
}

func (c *Controller) SmsLogin(r *ghttp.Request) {
	var req v1.SmsLoginReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	result, err := c.smsSvc.Login(r.Context(), req.Mobile, req.Code)
	if err != nil {
		if biz := errs.BizMessage(err); biz != "" {
			response.Fail(r, biz)
			return
		}
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	response.Ok(r, c.loginRes(r.Context(), result))
}

func (c *Controller) SmsResetPassword(r *ghttp.Request) {
	var req v1.SmsResetPasswordReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	if req.Ciphertext == "" {
		response.Fail(r, "新密码必须使用 SM2 信封，请勿提交明文口令")
		return
	}
	env, err := c.sm2Svc.Decrypt(r.Context(), req.KeyId, req.Challenge, req.Ciphertext)
	if err != nil {
		reason := err.Error()
		msg := "登录凭证失效，请重试"
		if reason == "envelope_incomplete" {
			msg = "请填写完整的新密码"
		}
		g.Log().Warningf(r.Context(), "SMS 重置口令信封校验失败 mobile=%s reason=%s", req.Mobile, reason)
		response.FailStatus(r, 409, msg, reason)
		return
	}
	if err := c.smsSvc.ResetPassword(r.Context(), req.Mobile, req.Code, env.Password); err != nil {
		if biz := errs.BizMessage(err); biz != "" {
			response.Fail(r, biz)
			return
		}
		response.FailSystem(r, "重置密码失败", err)
		return
	}
	response.OkWithMessage(r, "密码已重置，请使用新密码登录")
}

func (c *Controller) EmailSend(r *ghttp.Request) {
	var req v1.EmailSendReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	res, err := c.emailSvc.Send(r.Context(), req.Email, req.Purpose)
	if err != nil {
		if biz := errs.BizMessage(err); biz != "" {
			response.Fail(r, biz)
			return
		}
		response.FailSystem(r, "验证码发送失败", err)
		return
	}
	response.Ok(r, v1.EmailSendRes{
		CooldownSeconds: res.CooldownSeconds,
		Provider:       res.Provider,
		DebugCode:      res.DebugCode,
	})
}

func (c *Controller) EmailLogin(r *ghttp.Request) {
	var req v1.EmailLoginReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}
	result, err := c.emailSvc.Login(r.Context(), req.Email, req.Code, service.EmailLoginOpts{
		DisplayName: req.DisplayName,
		RegisterAs:  req.RegisterAs,
	})
	if err != nil {
		if biz := errs.BizMessage(err); biz != "" {
			response.Fail(r, biz)
			return
		}
		response.FailSystem(r, "请求处理失败", err)
		return
	}
	response.Ok(r, c.loginRes(r.Context(), result))
}

func (c *Controller) userVoFromEntity(ctx context.Context, u *entity.SysUser) v1.UserVo {
	audit := service.GetLoginAudit(ctx, u.Id)
	return v1.UserVo{
		Id:                u.Id,
		Username:          u.Username,
		DisplayName:       u.DisplayName,
		Avatar:            u.Avatar,
		AccountType:       u.AccountType,
		AccountTypeName:   c.dictSvc.LabelOf(ctx, consts.DictTypeAccountType, u.AccountType),
		PositionCode:      u.PositionCode,
		PositionName:      c.dictSvc.LabelOf(ctx, consts.DictTypePosition, u.PositionCode),
		LastLoginAt:       audit.LastLoginAt,
		LastLoginIp:       audit.LastLoginIp,
		LastLoginLocation: audit.LastLoginLocation,
	}
}
