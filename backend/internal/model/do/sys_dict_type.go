// =================================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// =================================================================================

package do

import (
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/gtime"
)

// SysDictType is the golang structure of table sys_dict_type for DAO operations like Where/Data.
type SysDictType struct {
	g.Meta    `orm:"table:sys_dict_type, do:true"`
	DictType  any         // 枚举类别编码（如 position/meeting_status），全仓唯一由应用层保证；业务表以此+dict_value 定位
	DictName  any         // 类别显示名
	Status    any         // 1 启用 0 停用；停用只隐藏取值不删数据
	Remark    any         // 归属与取值域真源出处
	CreatedAt *gtime.Time // 创建时间，GoFrame 自动维护
	UpdatedAt *gtime.Time // 更新时间，GoFrame 自动维护
	DeletedAt *gtime.Time // 软删除时间戳，非空即视为删除
}
