// =================================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// =================================================================================

package do

import (
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/gtime"
)

// MeetingAttendance is the golang structure of table meeting_attendance for DAO operations like Where/Data.
type MeetingAttendance struct {
	g.Meta        `orm:"table:meeting_attendance, do:true"`
	Id            any         // 自增主键
	MeetingId     any         // 三方 meetings[].meetingId 原样，一场会的稳定身份（会议号是拨号用的，不保证一场一号）；入会响应里没有它就不写这行
	MeetingNumber any         // 该场的三方会议号，供日程按号对齐本地预约单（与 meeting_deleted 同一口径）
	AppointmentId any         // 本库预约单 id，可空：手机/板卡在三方直接发起的会本库没有预约单，只有会话键
	UserId        any         // 逻辑引用 sys_user.id（无级联外键）
	FirstJoinedAt *gtime.Time // 本账号第一次成功入会的时刻
	LastJoinedAt  *gtime.Time // 本账号最近一次成功入会的时刻，日程排序与「最近加入」展示用它
	JoinCount     any         // 成功入会次数（含中途退会再入）
}
