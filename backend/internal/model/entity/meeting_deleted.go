// =================================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// =================================================================================

package entity

import (
	"github.com/gogf/gf/v2/os/gtime"
)

// MeetingDeleted is the golang structure for table meeting_deleted.
type MeetingDeleted struct {
	MeetingId     string      `json:"mEETINGID"     orm:"MEETING_ID"     `  // 三方 meetings[].meetingId 原样（实测 meeting_1790527565_0xx8arRt 27 字符）；有行即压制，主键天然去重
	MeetingNumber string      `json:"mEETINGNUMBER" orm:"MEETING_NUMBER" `  // 该场的三方会议号，仅作排查线索：读列表不按号判定（号是拨号用的，不保证一场一号）
	AppointmentId int64       `json:"aPPPOINTMENTID" orm:"APPOINTMENT_ID" ` // 本侧被删除的预约单 id，仅作排查线索（预约单是软删，行还在 meeting_appointment 里可回查）
	SuppressedAt  *gtime.Time `json:"sUPPRESSEDAT"  orm:"SUPPRESSED_AT"  `  // 本侧登记压制的时刻。刻意不叫 deleted_at：那会被 GoFrame gdb 当逻辑删除列，查询会自动加 WHERE DELETED_AT IS NULL 把压制行全滤掉。恢复某条 = 物理删这一行，当前无恢复入口
}
