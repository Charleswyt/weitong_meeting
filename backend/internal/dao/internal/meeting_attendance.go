// ==========================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// ==========================================================================

package internal

import (
	"context"

	"github.com/gogf/gf/v2/database/gdb"
	"github.com/gogf/gf/v2/frame/g"
)

// MeetingAttendanceDao is the data access object for the table meeting_attendance.
type MeetingAttendanceDao struct {
	table    string                    // table is the underlying table name of the DAO.
	group    string                    // group is the database configuration group name of the current DAO.
	columns  MeetingAttendanceColumns // columns contains all the column names of Table for convenient usage.
	handlers []gdb.ModelHandler        // handlers for customized model modification.
}

// MeetingAttendanceColumns defines and stores column names for the table meeting_attendance.
type MeetingAttendanceColumns struct {
	Id            string // 自增主键
	MeetingId     string // 三方 meetings[].meetingId 原样
	MeetingNumber string // 该场的三方会议号
	AppointmentId string // 本库预约单 id，可空
	UserId        string // 逻辑引用 sys_user.id
	FirstJoinedAt string // 第一次成功入会的时刻
	LastJoinedAt  string // 最近一次成功入会的时刻
	JoinCount     string // 成功入会次数
}

// meetingAttendanceColumns holds the columns for the table meeting_attendance.
var meetingAttendanceColumns = MeetingAttendanceColumns{
	Id:            "ID",
	MeetingId:     "MEETING_ID",
	MeetingNumber: "MEETING_NUMBER",
	AppointmentId: "APPOINTMENT_ID",
	UserId:        "USER_ID",
	FirstJoinedAt: "FIRST_JOINED_AT",
	LastJoinedAt:  "LAST_JOINED_AT",
	JoinCount:     "JOIN_COUNT",
}

// NewMeetingAttendanceDao creates and returns a new DAO object for table data access.
func NewMeetingAttendanceDao(handlers ...gdb.ModelHandler) *MeetingAttendanceDao {
	return &MeetingAttendanceDao{
		group:    "default",
		table:    "meeting_attendance",
		columns:  meetingAttendanceColumns,
		handlers: handlers,
	}
}

// DB retrieves and returns the underlying raw database management object of the current DAO.
func (dao *MeetingAttendanceDao) DB() gdb.DB {
	return g.DB(dao.group)
}

// Table returns the table name of the current DAO.
func (dao *MeetingAttendanceDao) Table() string {
	return dao.table
}

// Columns returns all column names of the current DAO.
func (dao *MeetingAttendanceDao) Columns() MeetingAttendanceColumns {
	return dao.columns
}

// Group returns the database configuration group name of the current DAO.
func (dao *MeetingAttendanceDao) Group() string {
	return dao.group
}

// Ctx creates and returns a Model for the current DAO. It automatically sets the context for the current operation.
func (dao *MeetingAttendanceDao) Ctx(ctx context.Context) *gdb.Model {
	model := dao.DB().Model(dao.table)
	for _, handler := range dao.handlers {
		model = handler(model)
	}
	return model.Safe().Ctx(ctx)
}

// Transaction wraps the transaction logic using function f.
func (dao *MeetingAttendanceDao) Transaction(ctx context.Context, f func(ctx context.Context, tx gdb.TX) error) (err error) {
	return dao.Ctx(ctx).Transaction(ctx, f)
}
