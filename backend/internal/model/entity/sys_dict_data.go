// =================================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// =================================================================================

package entity

import (
	"github.com/gogf/gf/v2/os/gtime"
)

// SysDictData is the golang structure for table sys_dict_data.
type SysDictData struct {
	Id        int64       `json:"iD"        orm:"ID"         ` // 自增主键
	DictType  string      `json:"dICTTYPE"  orm:"DICT_TYPE"  ` // 所属枚举类别（逻辑引用 sys_dict_type.dict_type，无 DB 外键）
	DictValue string      `json:"dICTVALUE" orm:"DICT_VALUE" ` // 落库的规范值，业务表存这一列；(dict_type,dict_value) 组合唯一由应用层保证
	DictLabel string      `json:"dICTLABEL" orm:"DICT_LABEL" ` // 给人看的展示名
	Sort      int         `json:"sORT"      orm:"SORT"       ` // 下拉与展示顺序
	Status    int         `json:"sTATUS"    orm:"STATUS"     ` // 1 可见 0 隐藏（隐藏不等于删除，历史数据仍能反查 label）
	TagType   string      `json:"tAGTYPE"   orm:"TAG_TYPE"   ` // 前端 el-tag 语义色 success/info/warning/danger，替代组件里硬写的 switch
	Remark    string      `json:"rEMARK"    orm:"REMARK"     ` // 取值域真源出处或特殊说明
	CreatedAt *gtime.Time `json:"cREATEDAT" orm:"CREATED_AT" ` // 创建时间，GoFrame 自动维护
	UpdatedAt *gtime.Time `json:"uPDATEDAT" orm:"UPDATED_AT" ` // 更新时间，GoFrame 自动维护
	DeletedAt *gtime.Time `json:"dELETEDAT" orm:"DELETED_AT" ` // 软删除时间戳
}
