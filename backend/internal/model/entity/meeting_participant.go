// =================================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// =================================================================================

package entity

import (
	"github.com/gogf/gf/v2/os/gtime"
)

// MeetingParticipant is the golang structure for table meeting_participant.
type MeetingParticipant struct {
	Id            int64       `json:"iD"            orm:"ID"             ` // 自增主键
	AppointmentId int64       `json:"aPPOINTMENTID" orm:"APPOINTMENT_ID" ` // 逻辑引用 meeting_appointment.id；删预约须同事务删本表（无级联外键）
	UserId        int64       `json:"userID"        orm:"USER_ID"        ` // 逻辑引用 sys_user.id
	CreatedAt     *gtime.Time `json:"cREATEDAT"     orm:"CREATED_AT"     ` // 创建时间
	UpdatedAt     *gtime.Time `json:"uPDATEDAT"     orm:"UPDATED_AT"     ` // 更新时间
	DeletedAt     *gtime.Time `json:"dELETEDAT"     orm:"DELETED_AT"     ` // 软删除时间戳。(appointment_id, contact_id) 组合唯一性由应用层保证
}
