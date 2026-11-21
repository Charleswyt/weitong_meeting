// =================================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// =================================================================================

package entity

import (
	"github.com/gogf/gf/v2/os/gtime"
)

// SysDept is the golang structure for table sys_dept.
type SysDept struct {
	Id        int64       `json:"iD"        orm:"ID"         ` // 自增主键
	Name      string      `json:"nAME"      orm:"NAME"       ` // 部门名称；不同船可能同名，故不加唯一约束
	Sort      int         `json:"sORT"      orm:"SORT"       ` // 展示顺序
	Status    int         `json:"sTATUS"    orm:"STATUS"     ` // 1 正常 0 停用
	CreatedAt *gtime.Time `json:"cREATEDAT" orm:"CREATED_AT" ` // 创建时间
	UpdatedAt *gtime.Time `json:"uPDATEDAT" orm:"UPDATED_AT" ` // 更新时间
	DeletedAt *gtime.Time `json:"dELETEDAT" orm:"DELETED_AT" ` // 软删除时间戳
}
