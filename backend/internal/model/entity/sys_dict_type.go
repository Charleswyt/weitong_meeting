// =================================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// =================================================================================

package entity

import (
	"github.com/gogf/gf/v2/os/gtime"
)

// SysDictType is the golang structure for table sys_dict_type.
type SysDictType struct {
	DictType  string      `json:"dICTTYPE"  orm:"DICT_TYPE"  ` // 枚举类别编码（如 position/meeting_status），全仓唯一由应用层保证；业务表以此+dict_value 定位
	DictName  string      `json:"dICTNAME"  orm:"DICT_NAME"  ` // 类别显示名
	Status    int         `json:"sTATUS"    orm:"STATUS"     ` // 1 启用 0 停用；停用只隐藏取值不删数据
	Remark    string      `json:"rEMARK"    orm:"REMARK"     ` // 归属与取值域真源出处
	CreatedAt *gtime.Time `json:"cREATEDAT" orm:"CREATED_AT" ` // 创建时间，GoFrame 自动维护
	UpdatedAt *gtime.Time `json:"uPDATEDAT" orm:"UPDATED_AT" ` // 更新时间，GoFrame 自动维护
	DeletedAt *gtime.Time `json:"dELETEDAT" orm:"DELETED_AT" ` // 软删除时间戳，非空即视为删除
}
