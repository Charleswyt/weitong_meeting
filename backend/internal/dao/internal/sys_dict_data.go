// ==========================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// ==========================================================================

package internal

import (
	"context"

	"github.com/gogf/gf/v2/database/gdb"
	"github.com/gogf/gf/v2/frame/g"
)

// SysDictDataDao is the data access object for the table sys_dict_data.
type SysDictDataDao struct {
	table    string             // table is the underlying table name of the DAO.
	group    string             // group is the database configuration group name of the current DAO.
	columns  SysDictDataColumns // columns contains all the column names of Table for convenient usage.
	handlers []gdb.ModelHandler // handlers for customized model modification.
}

// SysDictDataColumns defines and stores column names for the table sys_dict_data.
type SysDictDataColumns struct {
	Id        string // 自增主键
	DictType  string // 所属枚举类别（逻辑引用 sys_dict_type.dict_type，无 DB 外键）
	DictValue string // 落库的规范值，业务表存这一列；(dict_type,dict_value) 组合唯一由应用层保证
	DictLabel string // 给人看的展示名
	Sort      string // 下拉与展示顺序
	Status    string // 1 可见 0 隐藏（隐藏不等于删除，历史数据仍能反查 label）
	TagType   string // 前端 el-tag 语义色 success/info/warning/danger，替代组件里硬写的 switch
	Remark    string // 取值域真源出处或特殊说明
	CreatedAt string // 创建时间，GoFrame 自动维护
	UpdatedAt string // 更新时间，GoFrame 自动维护
	DeletedAt string // 软删除时间戳
}

// sysDictDataColumns holds the columns for the table sys_dict_data.
var sysDictDataColumns = SysDictDataColumns{
	Id:        "ID",
	DictType:  "DICT_TYPE",
	DictValue: "DICT_VALUE",
	DictLabel: "DICT_LABEL",
	Sort:      "SORT",
	Status:    "STATUS",
	TagType:   "TAG_TYPE",
	Remark:    "REMARK",
	CreatedAt: "CREATED_AT",
	UpdatedAt: "UPDATED_AT",
	DeletedAt: "DELETED_AT",
}

// NewSysDictDataDao creates and returns a new DAO object for table data access.
func NewSysDictDataDao(handlers ...gdb.ModelHandler) *SysDictDataDao {
	return &SysDictDataDao{
		group:    "default",
		table:    "sys_dict_data",
		columns:  sysDictDataColumns,
		handlers: handlers,
	}
}

// DB retrieves and returns the underlying raw database management object of the current DAO.
func (dao *SysDictDataDao) DB() gdb.DB {
	return g.DB(dao.group)
}

// Table returns the table name of the current DAO.
func (dao *SysDictDataDao) Table() string {
	return dao.table
}

// Columns returns all column names of the current DAO.
func (dao *SysDictDataDao) Columns() SysDictDataColumns {
	return dao.columns
}

// Group returns the database configuration group name of the current DAO.
func (dao *SysDictDataDao) Group() string {
	return dao.group
}

// Ctx creates and returns a Model for the current DAO. It automatically sets the context for the current operation.
func (dao *SysDictDataDao) Ctx(ctx context.Context) *gdb.Model {
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
func (dao *SysDictDataDao) Transaction(ctx context.Context, f func(ctx context.Context, tx gdb.TX) error) (err error) {
	return dao.Ctx(ctx).Transaction(ctx, f)
}
