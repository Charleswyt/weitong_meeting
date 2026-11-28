package v1

import "github.com/gogf/gf/v2/frame/g"

type LoginReq struct {
	g.Meta             `path:"/auth/login" method:"post" tags:"认证"`
	Username           string `v:"required" json:"username"`
	Algorithm          string `json:"algorithm"`
	KeyId              string `json:"keyId"`
	Challenge          string `json:"challenge"`
	CipherMode         string `json:"cipherMode"`
	CiphertextEncoding string `json:"ciphertextEncoding"`
	Ciphertext         string `v:"required" json:"ciphertext"`
}

type LoginRes struct {
	Token string `json:"token"`
	User  UserVo `json:"user"`
	// 会议链路（本域语义）是否已打通；失败原因只给我方中文，外部系统的报文不外泄。
	LinkSynced bool   `json:"linkSynced"`
	LinkReason string `json:"linkReason,omitempty"`
}

type LogoutReq struct {
	g.Meta `path:"/auth/logout" method:"post" tags:"认证"`
}

type LogoutRes struct{}

// AutoLoginReq 免登录（临时方案）：公开端点，不带任何凭据，身份由服务端配置决定。
type AutoLoginReq struct {
	g.Meta `path:"/auth/auto-login" method:"post" tags:"认证"`
}

// AutoLoginRes 与 LoginRes 同形状 —— 前端拿到的是同一条 JWT，WS 票与媒体资产的取用方式不变。
type AutoLoginRes struct {
	Token      string `json:"token"`
	User       UserVo `json:"user"`
	LinkSynced bool   `json:"linkSynced"`
	LinkReason string `json:"linkReason,omitempty"`
}

type MeReq struct {
	g.Meta `path:"/auth/me" method:"get" tags:"认证"`
}

// SmsSendReq 发送短信验证码（公开端点）。purpose=login|reset。
type SmsSendReq struct {
	g.Meta  `path:"/auth/sms/send" method:"post" tags:"认证"`
	Mobile  string `v:"required" json:"mobile"`
	Purpose string `v:"required|in:login,reset" json:"purpose"`
}

type SmsSendRes struct {
	CooldownSeconds int    `json:"cooldownSeconds"`
	Provider       string `json:"provider"`
	// DebugCode 仅 provider=console 时出现，正式短信通道不下发到前端。
	DebugCode string `json:"debugCode,omitempty"`
}

// SmsLoginReq 手机验证码登录（公开端点）。
type SmsLoginReq struct {
	g.Meta `path:"/auth/sms/login" method:"post" tags:"认证"`
	Mobile string `v:"required" json:"mobile"`
	Code   string `v:"required" json:"code"`
}

// SmsResetPasswordReq 验证码找回密码：新口令仍走 SM2 信封（与 /auth/login 同形字段），
// 明文口令不得出现在请求体。username 位填手机号即可（后端只取信封里的 password）。
type SmsResetPasswordReq struct {
	g.Meta             `path:"/auth/sms/reset-password" method:"post" tags:"认证"`
	Mobile             string `v:"required" json:"mobile"`
	Code               string `v:"required" json:"code"`
	Username           string `json:"username"`
	Algorithm          string `json:"algorithm"`
	KeyId              string `json:"keyId"`
	Challenge          string `json:"challenge"`
	CipherMode         string `json:"cipherMode"`
	CiphertextEncoding string `json:"ciphertextEncoding"`
	Ciphertext         string `v:"required" json:"ciphertext"`
}

// EmailSendReq 发送邮箱验证码（公开端点）。purpose=login|reset。
type EmailSendReq struct {
	g.Meta  `path:"/auth/email/send" method:"post" tags:"认证"`
	Email   string `v:"required" json:"email"`
	Purpose string `v:"required|in:login,reset" json:"purpose"`
}

type EmailSendRes struct {
	CooldownSeconds int    `json:"cooldownSeconds"`
	Provider       string `json:"provider"`
	DebugCode      string `json:"debugCode,omitempty"`
}

// EmailLoginReq 邮箱验证码登录（公开端点）。
// RegisterAs=temp：未注册时建「临时用户」（面试场景）；DisplayName 写入展示名。
type EmailLoginReq struct {
	g.Meta      `path:"/auth/email/login" method:"post" tags:"认证"`
	Email       string `v:"required" json:"email"`
	Code        string `v:"required" json:"code"`
	DisplayName string `json:"displayName"`
	// user（默认）| temp（面试临时用户）；空按 user
	RegisterAs string `json:"registerAs"`
}

type UserVo struct {
	Id                int64  `json:"id"`
	Username          string `json:"username"`
	DisplayName       string `json:"displayName"`
	Avatar            string `json:"avatar"`
	AccountType       string `json:"accountType"`
	AccountTypeName   string `json:"accountTypeName"`
	PositionCode      string `json:"positionCode"`
	PositionName      string `json:"positionName"`
	LastLoginAt       string `json:"lastLoginAt,omitempty"`
	LastLoginIp       string `json:"lastLoginIp,omitempty"`
	LastLoginLocation string `json:"lastLoginLocation,omitempty"`
}
