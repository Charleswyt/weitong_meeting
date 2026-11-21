// =================================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// =================================================================================

package do

import (
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/gtime"
)

// MeetingParticipant is the golang structure of table meeting_participant for DAO operations like Where/Data.
type MeetingParticipant struct {
	g.Meta        `orm:"table:meeting_participant, do:true"`
	Id            any         // 自增主键
	AppointmentId any         // 逻辑引用 meeting_appointment.id；删预约须同事务删本表（无级联外键）
	UserId        any         // 逻辑引用 sys_user.id
	CreatedAt     *gtime.Time // 创建时间
	UpdatedAt     *gtime.Time // 更新时间
	DeletedAt     *gtime.Time // 软删除时间戳。(appointment_id, contact_id) 组合唯一性由应用层保证
}
