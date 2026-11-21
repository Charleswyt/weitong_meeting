// =================================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// =================================================================================

package do

import (
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/gtime"
)

// SysUser is the golang structure of table sys_user for DAO operations like Where/Data.
type SysUser struct {
	g.Meta             `orm:"table:sys_user, do:true"`
	Id                 any         // 自增主键
	Username           any         // 登录名；唯一性在应用层校验，无 DB 约束（本单元约定）。一旦加"新建用户"入口必须补查重
	Password           any         // 本地口令，当前明文过渡，SM2 适配层接入后改哈希
	DisplayName        any         // 入会与界面展示名，唯一真源（user_settings 不再存 displayName）
	Avatar             any         // 头像 API 路径 /api/v1/users/{id}/avatar（派生值，字节在 AVATAR_DATA、类型在 AVATAR_TYPE）；无头像为 NULL
	ThirdPartyAccount  any         // 映射到三方平台的账号名
	ThirdPartyPassword any         // 三方口令，当前明文存储为已知待办（凭据只走 .env 的例外：这里按用户一行、需要后台可查）
	AccountType        any         // 字典 account_type：meeting_participant/device_admin/super_admin；登录时用三方 AuthResult.AccountType 回写
	PositionCode       any         // 字典 position；人员主数据，当前在本仓字典表是有主的权宜，定义权待 cloud/device-registry 建成后上收
	Status             any         // 1 启用 0 禁用
	Mobile             any         // 绑定手机号；空=未绑，短信登录/找回靠这一列
	Email              any         // 绑定邮箱；空=未绑，邮箱验证码登录靠这一列
	CreatedAt          *gtime.Time // 创建时间
	UpdatedAt          *gtime.Time // 更新时间
	DeletedAt          *gtime.Time // 软删除时间戳
	AvatarData         []byte      // 头像二进制字节（PNG/JPEG/WebP），自 2026-09-28 起这里是头像唯一真源，不再落本地文件盘
	AvatarType         any         // 头像 MIME 类型（image/png、image/jpeg、image/webp），由服务端按文件头判定，不取客户端声明
}
