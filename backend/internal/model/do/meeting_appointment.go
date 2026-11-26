// =================================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// =================================================================================

package do

import (
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/gtime"
)

// MeetingAppointment is the golang structure of table meeting_appointment for DAO operations like Where/Data.
type MeetingAppointment struct {
	g.Meta                  `orm:"table:meeting_appointment, do:true"`
	Id                      any         // 自增主键
	Title                   any         // 会议主题
	MeetingNumber           any         // 〔历史列，不再生成〕曾是本地 6 位会议号；对外唯一入会号只看 ThirdPartyMeetingNumber
	ThirdPartyMeetingId     any         // 三方返回的会议 id，回填即代表同步成功
	ThirdPartyMeetingNumber any         // 三方生成的 8 位会议号，入会/订阅以它为准
	StartedAt               any         // 三方实测开会时刻，会中时长起点
	CreatorId               any         // 预约人，逻辑引用 sys_user.id
	HostThirdPartyAccount   any         // 主持人三方账号，登录用户映射的 third_party_account 自动填入
	StartTime               *gtime.Time // 开始时间
	DurationMinutes         any         // 时长（分钟）
	CloudRecord             any         // 本次预约的选择
	MuteOnJoin              any         // 预约人入会时默认静音
	CameraOffOnJoin         any         // 预约人入会时默认关闭摄像头，与 user_settings.cloud_record_default 是"实值 vs 默认值"的关系
	AllowWaiting            any         // 1=允许成员在主持人入会前等待（第 10 项）：主持人不在场时这个端不真的加入三方
	LaunchKind              any         // quick/scheduled/share/voice
	LocalStatus             any         // 字典 local_sync_status：pending/synced/failed，本系统与三方的同步态
	Status                  any         // 字典 meeting_status：scheduled/starting/running/ended/failed/cancelled
	EndReason               any         // normal 正常结束 / abnormal_exit 异常退出超时自动结束
	MeetingPassword         any         // 入会密码（为空表示无密码）
	CreatedAt               *gtime.Time // 创建时间
	UpdatedAt               *gtime.Time // 更新时间
	DeletedAt               *gtime.Time // 软删除时间戳
}
