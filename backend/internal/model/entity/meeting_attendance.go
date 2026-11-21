// =================================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// =================================================================================

package entity

import (
	"github.com/gogf/gf/v2/os/gtime"
)

// MeetingAttendance is the golang structure for table meeting_attendance.
type MeetingAttendance struct {
	Id            int64       `json:"iD"             orm:"ID"             ` // 自增主键
	MeetingId     string      `json:"mEETINGID"      orm:"MEETING_ID"     ` // 三方 meetings[].meetingId 原样，一场会的稳定身份（会议号是拨号用的，不保证一场一号）；入会响应里没有它就不写这行
	MeetingNumber string      `json:"mEETINGNUMBER"  orm:"MEETING_NUMBER" ` // 该场的三方会议号，供日程按号对齐本地预约单（与 meeting_deleted 同一口径）
	AppointmentId int64       `json:"aPPPOINTMENTID" orm:"APPOINTMENT_ID" ` // 本库预约单 id，可空：手机/板卡在三方直接发起的会本库没有预约单，只有会话键
	UserId        int64       `json:"uSERID"         orm:"USER_ID"        ` // 逻辑引用 sys_user.id（无级联外键）
	FirstJoinedAt *gtime.Time `json:"fIRSTJOINEDAT"  orm:"FIRST_JOINED_AT" ` // 本账号第一次成功入会的时刻
	LastJoinedAt  *gtime.Time `json:"lASTJOINEDAT"   orm:"LAST_JOINED_AT" `  // 本账号最近一次成功入会的时刻，日程排序与「最近加入」展示用它
	JoinCount     int         `json:"jOINCOUNT"      orm:"JOIN_COUNT"     `  // 成功入会次数（含中途退会再入）。刻意不叫 deleted_at 之类：那会被 GoFrame gdb 当逻辑删除列，查询自动加 WHERE 把行滤掉
}
