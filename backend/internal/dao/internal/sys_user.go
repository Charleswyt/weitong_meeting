// ==========================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// ==========================================================================

package internal

import (
	"context"

	"github.com/gogf/gf/v2/database/gdb"
	"github.com/gogf/gf/v2/frame/g"
)

// SysUserDao is the data access object for the table sys_user.
type SysUserDao struct {
	table    string             // table is the underlying table name of the DAO.
	group    string             // group is the database configuration group name of the current DAO.
	columns  SysUserColumns     // columns contains all the column names of Table for convenient usage.
	handlers []gdb.ModelHandler // handlers for customized model modification.
}

// SysUserColumns defines and stores column names for the table sys_user.
type SysUserColumns struct {
	Id                 string // 自增主键
	Username           string // 登录名；唯一性在应用层校验，无 DB 约束（本单元约定）。一旦加"新建用户"入口必须补查重
	Password           string // 本地口令，当前明文过渡，SM2 适配层接入后改哈希
	DisplayName        string // 入会与界面展示名，唯一真源（user_settings 不再存 displayName）
	Avatar             string // 头像 API 路径 /api/v1/users/{id}/avatar（派生值，字节在 AVATAR_DATA、类型在 AVATAR_TYPE）；无头像为 NULL
	ThirdPartyAccount  string // 映射到三方平台的账号名
	ThirdPartyPassword string // 三方口令，当前明文存储为已知待办（凭据只走 .env 的例外：这里按用户一行、需要后台可查）
	AccountType        string // 字典 account_type：meeting_participant/device_admin/super_admin；登录时用三方 AuthResult.AccountType 回写
	PositionCode       string // 字典 position；人员主数据，当前在本仓字典表是有主的权宜，定义权待 cloud/device-registry 建成后上收
	Status             string // 1 启用 0 禁用
	Mobile             string // 绑定手机号；空=未绑，短信登录/找回靠这一列
	Email              string // 绑定邮箱；空=未绑，邮箱验证码登录靠这一列
	CreatedAt          string // 创建时间
	UpdatedAt          string // 更新时间
	DeletedAt          string // 软删除时间戳
	AvatarData         string // 头像二进制字节（PNG/JPEG/WebP），自 2026-09-28 起这里是头像唯一真源，不再落本地文件盘
	AvatarType         string // 头像 MIME 类型（image/png、image/jpeg、image/webp），由服务端按文件头判定，不取客户端声明
}

// sysUserColumns holds the columns for the table sys_user.
var sysUserColumns = SysUserColumns{
	Id:                 "ID",
	Username:           "USERNAME",
	Password:           "PASSWORD",
	DisplayName:        "DISPLAY_NAME",
	Avatar:             "AVATAR",
	ThirdPartyAccount:  "THIRD_PARTY_ACCOUNT",
	ThirdPartyPassword: "THIRD_PARTY_PASSWORD",
	AccountType:        "ACCOUNT_TYPE",
	PositionCode:       "POSITION_CODE",
	Status:             "STATUS",
	Mobile:             "MOBILE",
	Email:              "EMAIL",
	CreatedAt:          "CREATED_AT",
	UpdatedAt:          "UPDATED_AT",
	DeletedAt:          "DELETED_AT",
	AvatarData:         "AVATAR_DATA",
	AvatarType:         "AVATAR_TYPE",
}

// NewSysUserDao creates and returns a new DAO object for table data access.
func NewSysUserDao(handlers ...gdb.ModelHandler) *SysUserDao {
	return &SysUserDao{
		group:    "default",
		table:    "sys_user",
		columns:  sysUserColumns,
		handlers: handlers,
	}
}

// DB retrieves and returns the underlying raw database management object of the current DAO.
func (dao *SysUserDao) DB() gdb.DB {
	return g.DB(dao.group)
}

// Table returns the table name of the current DAO.
func (dao *SysUserDao) Table() string {
	return dao.table
}

// Columns returns all column names of the current DAO.
func (dao *SysUserDao) Columns() SysUserColumns {
	return dao.columns
}

// Group returns the database configuration group name of the current DAO.
func (dao *SysUserDao) Group() string {
	return dao.group
}

// Ctx creates and returns a Model for the current DAO. It automatically sets the context for the current operation.
func (dao *SysUserDao) Ctx(ctx context.Context) *gdb.Model {
	model := dao.DB().Model(dao.table)
	for _, handler := range dao.handlers {
		model = handler(model)
	}
	return model.Safe().Ctx(ctx)
}

// Transaction wraps the transaction logic using function f.
// It rolls back the transaction and returns the error if function f returns a non-nil error.
// It commits the transaction and returns nil if function f returns nil.
//
// Note: Do not commit or roll back the transaction in function f,
// as it is automatically handled by this function.
func (dao *SysUserDao) Transaction(ctx context.Context, f func(ctx context.Context, tx gdb.TX) error) (err error) {
	return dao.Ctx(ctx).Transaction(ctx, f)
}
