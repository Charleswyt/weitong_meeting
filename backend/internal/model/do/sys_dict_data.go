// =================================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// =================================================================================

package do

import (
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/gtime"
)

// SysDictData is the golang structure of table sys_dict_data for DAO operations like Where/Data.
type SysDictData struct {
	g.Meta    `orm:"table:sys_dict_data, do:true"`
	Id        any         // 自增主键
	DictType  any         // 所属枚举类别（逻辑引用 sys_dict_type.dict_type，无 DB 外键）
	DictValue any         // 落库的规范值，业务表存这一列；(dict_type,dict_value) 组合唯一由应用层保证
	DictLabel any         // 给人看的展示名
	Sort      any         // 下拉与展示顺序
	Status    any         // 1 可见 0 隐藏（隐藏不等于删除，历史数据仍能反查 label）
	TagType   any         // 前端 el-tag 语义色 success/info/warning/danger，替代组件里硬写的 switch
	Remark    any         // 取值域真源出处或特殊说明
	CreatedAt *gtime.Time // 创建时间，GoFrame 自动维护
	UpdatedAt *gtime.Time // 更新时间，GoFrame 自动维护
	DeletedAt *gtime.Time // 软删除时间戳
}
