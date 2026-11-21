// ==========================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// ==========================================================================

package internal

import (
	"context"

	"github.com/gogf/gf/v2/database/gdb"
	"github.com/gogf/gf/v2/frame/g"
)

// MeetingAppointmentDao is the data access object for the table meeting_appointment.
type MeetingAppointmentDao struct {
	table    string                    // table is the underlying table name of the DAO.
	group    string                    // group is the database configuration group name of the current DAO.
	columns  MeetingAppointmentColumns // columns contains all the column names of Table for convenient usage.
	handlers []gdb.ModelHandler        // handlers for customized model modification.
}

// MeetingAppointmentColumns defines and stores column names for the table meeting_appointment.
type MeetingAppointmentColumns struct {
	Id                      string // 自增主键
	Title                   string // 会议主题
	MeetingNumber           string // 〔历史列，不再生成〕曾是本地 6 位会议号；对外唯一入会号只看 ThirdPartyMeetingNumber
	ThirdPartyMeetingId     string // 三方返回的会议 id，回填即代表同步成功
	ThirdPartyMeetingNumber string // 三方生成的 8 位会议号，入会/订阅以它为准
	StartedAt               string // 三方实测开会时刻，会中时长起点
	CreatorId               string // 预约人，逻辑引用 sys_user.id
	HostThirdPartyAccount   string // 主持人三方账号，登录用户映射的 third_party_account 自动填入
	StartTime               string // 开始时间
	DurationMinutes         string // 时长（分钟）
	CloudRecord             string // 本次预约的选择
	MuteOnJoin              string // 预约人入会时默认静音
	CameraOffOnJoin         string // 预约人入会时默认关闭摄像头，与 user_settings.cloud_record_default 是"实值 vs 默认值"的关系
	AllowWaiting            string // 1=允许成员在主持人入会前等待
	LaunchKind              string // quick/scheduled/share/voice
	LocalStatus             string // 字典 local_sync_status：pending/synced/failed，本系统与三方的同步态
	Status                  string // 字典 meeting_status：scheduled/starting/running/ended/failed/cancelled
	CreatedAt               string // 创建时间
	UpdatedAt               string // 更新时间
	DeletedAt               string // 软删除时间戳
}

// meetingAppointmentColumns holds the columns for the table meeting_appointment.
var meetingAppointmentColumns = MeetingAppointmentColumns{
	Id:                      "ID",
	Title:                   "TITLE",
	MeetingNumber:           "MEETING_NUMBER",
	ThirdPartyMeetingId:     "THIRD_PARTY_MEETING_ID",
	ThirdPartyMeetingNumber: "THIRD_PARTY_MEETING_NUMBER",
	StartedAt:               "STARTED_AT",
	CreatorId:               "CREATOR_ID",
	HostThirdPartyAccount:   "HOST_THIRD_PARTY_ACCOUNT",
	StartTime:               "START_TIME",
	DurationMinutes:         "DURATION_MINUTES",
	CloudRecord:             "CLOUD_RECORD",
	MuteOnJoin:              "MUTE_ON_JOIN",
	CameraOffOnJoin:         "CAMERA_OFF_ON_JOIN",
	AllowWaiting:            "ALLOW_WAITING",
	LaunchKind:              "LAUNCH_KIND",
	LocalStatus:             "LOCAL_STATUS",
	Status:                  "STATUS",
	CreatedAt:               "CREATED_AT",
	UpdatedAt:               "UPDATED_AT",
	DeletedAt:               "DELETED_AT",
}

// NewMeetingAppointmentDao creates and returns a new DAO object for table data access.
func NewMeetingAppointmentDao(handlers ...gdb.ModelHandler) *MeetingAppointmentDao {
	return &MeetingAppointmentDao{
		group:    "default",
		table:    "meeting_appointment",
		columns:  meetingAppointmentColumns,
		handlers: handlers,
	}
}

// DB retrieves and returns the underlying raw database management object of the current DAO.
func (dao *MeetingAppointmentDao) DB() gdb.DB {
	return g.DB(dao.group)
}

// Table returns the table name of the current DAO.
func (dao *MeetingAppointmentDao) Table() string {
	return dao.table
}

// Columns returns all column names of the current DAO.
func (dao *MeetingAppointmentDao) Columns() MeetingAppointmentColumns {
	return dao.columns
}

// Group returns the database configuration group name of the current DAO.
func (dao *MeetingAppointmentDao) Group() string {
	return dao.group
}

// Ctx creates and returns a Model for the current DAO. It automatically sets the context for the current operation.
func (dao *MeetingAppointmentDao) Ctx(ctx context.Context) *gdb.Model {
	model := dao.DB().Model(dao.table)
	for _, handler := range dao.handlers {
		model = handler(model)
	}
	return model.Safe().Ctx(ctx)
}

// Transaction wraps the transaction logic using function f.
// It rolls back the transaction and returns the error if function f returns a non-nil error.
// It commits the transaction and returns nil if function f returns nil.
//
// Note: Do not commit or roll back the transaction in function f,
// as it is automatically handled by this function.
func (dao *MeetingAppointmentDao) Transaction(ctx context.Context, f func(ctx context.Context, tx gdb.TX) error) (err error) {
	return dao.Ctx(ctx).Transaction(ctx, f)
}
