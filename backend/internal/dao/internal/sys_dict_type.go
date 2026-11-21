// ==========================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// ==========================================================================

package internal

import (
	"context"

	"github.com/gogf/gf/v2/database/gdb"
	"github.com/gogf/gf/v2/frame/g"
)

// SysDictTypeDao is the data access object for the table sys_dict_type.
type SysDictTypeDao struct {
	table    string             // table is the underlying table name of the DAO.
	group    string             // group is the database configuration group name of the current DAO.
	columns  SysDictTypeColumns // columns contains all the column names of Table for convenient usage.
	handlers []gdb.ModelHandler // handlers for customized model modification.
}

// SysDictTypeColumns defines and stores column names for the table sys_dict_type.
type SysDictTypeColumns struct {
	DictType  string // 枚举类别编码（如 position/meeting_status），全仓唯一由应用层保证；业务表以此+dict_value 定位
	DictName  string // 类别显示名
	Status    string // 1 启用 0 停用；停用只隐藏取值不删数据
	Remark    string // 归属与取值域真源出处
	CreatedAt string // 创建时间，GoFrame 自动维护
	UpdatedAt string // 更新时间，GoFrame 自动维护
	DeletedAt string // 软删除时间戳，非空即视为删除
}

// sysDictTypeColumns holds the columns for the table sys_dict_type.
var sysDictTypeColumns = SysDictTypeColumns{
	DictType:  "DICT_TYPE",
	DictName:  "DICT_NAME",
	Status:    "STATUS",
	Remark:    "REMARK",
	CreatedAt: "CREATED_AT",
	UpdatedAt: "UPDATED_AT",
	DeletedAt: "DELETED_AT",
}

// NewSysDictTypeDao creates and returns a new DAO object for table data access.
func NewSysDictTypeDao(handlers ...gdb.ModelHandler) *SysDictTypeDao {
	return &SysDictTypeDao{
		group:    "default",
		table:    "sys_dict_type",
		columns:  sysDictTypeColumns,
		handlers: handlers,
	}
}

// DB retrieves and returns the underlying raw database management object of the current DAO.
func (dao *SysDictTypeDao) DB() gdb.DB {
	return g.DB(dao.group)
}

// Table returns the table name of the current DAO.
func (dao *SysDictTypeDao) Table() string {
	return dao.table
}

// Columns returns all column names of the current DAO.
func (dao *SysDictTypeDao) Columns() SysDictTypeColumns {
	return dao.columns
}

// Group returns the database configuration group name of the current DAO.
func (dao *SysDictTypeDao) Group() string {
	return dao.group
}

// Ctx creates and returns a Model for the current DAO. It automatically sets the context for the current operation.
func (dao *SysDictTypeDao) Ctx(ctx context.Context) *gdb.Model {
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
func (dao *SysDictTypeDao) Transaction(ctx context.Context, f func(ctx context.Context, tx gdb.TX) error) (err error) {
	return dao.Ctx(ctx).Transaction(ctx, f)
}
