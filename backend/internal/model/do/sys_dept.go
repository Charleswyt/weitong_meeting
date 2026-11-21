// =================================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// =================================================================================

package do

import (
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/gtime"
)

// SysDept is the golang structure of table sys_dept for DAO operations like Where/Data.
type SysDept struct {
	g.Meta    `orm:"table:sys_dept, do:true"`
	Id        any         // 自增主键
	Name      any         // 部门名称；不同船可能同名，故不加唯一约束
	Sort      any         // 展示顺序
	Status    any         // 1 正常 0 停用
	CreatedAt *gtime.Time // 创建时间
	UpdatedAt *gtime.Time // 更新时间
	DeletedAt *gtime.Time // 软删除时间戳
}
