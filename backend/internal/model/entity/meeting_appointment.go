// =================================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// =================================================================================

package entity

import (
	"github.com/gogf/gf/v2/os/gtime"
)

// MeetingAppointment is the golang structure for table meeting_appointment.
type MeetingAppointment struct {
	Id                      int64       `json:"iD"                    orm:"ID"                       `     // 自增主键
	Title                   string      `json:"tITLE"                 orm:"TITLE"                    `     // 会议主题
	MeetingNumber           string      `json:"mEETINGNUMBER"         orm:"MEETING_NUMBER"           `     // 〔历史列，不再生成〕曾是本地 6 位会议号；对外唯一入会号只看 ThirdPartyMeetingNumber
	ThirdPartyMeetingId     string      `json:"tHIRDPARTYMEETINGID"   orm:"THIRD_PARTY_MEETING_ID"   `     // 三方返回的会议 id，回填即代表同步成功
	ThirdPartyMeetingNumber string      `json:"tHIRDPARTYMEETINGNUMBER" orm:"THIRD_PARTY_MEETING_NUMBER" ` // 三方生成的 8 位会议号，入会/订阅以它为准
	StartedAt               *gtime.Time `json:"sTARTEDAT"             orm:"STARTED_AT"               `     // 三方实测开会时刻，会中时长起点
	CreatorId               int64       `json:"cREATORID"             orm:"CREATOR_ID"               `     // 预约人，逻辑引用 sys_user.id
	HostThirdPartyAccount   string      `json:"hOSTTHIRDPARTYACCOUNT" orm:"HOST_THIRD_PARTY_ACCOUNT" `     // 主持人三方账号，登录用户映射的 third_party_account 自动填入
	StartTime               *gtime.Time `json:"sTARTTIME"             orm:"START_TIME"               `     // 开始时间
	DurationMinutes         int         `json:"dURATIONMINUTES"       orm:"DURATION_MINUTES"         `     // 时长（分钟）
	CloudRecord             int         `json:"cLOUDRECORD"           orm:"CLOUD_RECORD"             `     // 本次预约的选择，与 user_settings.cloud_record_default 是"实值 vs 默认值"的关系
	MuteOnJoin              int         `json:"mUTEONJOIN"            orm:"MUTE_ON_JOIN"             `     // 预约人入会时默认静音
	CameraOffOnJoin         int         `json:"cAMERAOFFONJOIN"     orm:"CAMERA_OFF_ON_JOIN"       `       // 预约人入会时默认关闭摄像头
	AllowWaiting            int         `json:"aLLOWWAITING"        orm:"ALLOW_WAITING"            `       // 1=允许成员在主持人入会前等待（第 10 项，门禁在我方后端，不外传三方）
	LaunchKind              string      `json:"lAUNCHKIND"            orm:"LAUNCH_KIND"              `     // quick/scheduled/share/voice；空则列表侧按预约/快速推断
	LocalStatus             string      `json:"lOCALSTATUS"           orm:"LOCAL_STATUS"             `     // 字典 local_sync_status：pending/synced/failed，本系统与三方的同步态
	Status                  string      `json:"sTATUS"                orm:"STATUS"                   `     // 字典 meeting_status：scheduled/starting/running/ended/failed/cancelled
	CreatedAt               *gtime.Time `json:"cREATEDAT"             orm:"CREATED_AT"               `     // 创建时间
	UpdatedAt               *gtime.Time `json:"uPDATEDAT"             orm:"UPDATED_AT"               `     // 更新时间
	DeletedAt               *gtime.Time `json:"dELETEDAT"             orm:"DELETED_AT"               `     // 软删除时间戳
}
