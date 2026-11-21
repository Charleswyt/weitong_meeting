// ==========================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// ==========================================================================

package internal

import (
	"context"

	"github.com/gogf/gf/v2/database/gdb"
	"github.com/gogf/gf/v2/frame/g"
)

// MeetingDeletedDao is the data access object for the table meeting_deleted.
type MeetingDeletedDao struct {
	table    string                // table is the underlying table name of the DAO.
	group    string                // group is the database configuration group name of the current DAO.
	columns  MeetingDeletedColumns // columns contains all the column names of Table for convenient usage.
	handlers []gdb.ModelHandler    // handlers for customized model modification.
}

// MeetingDeletedColumns defines and stores column names for the table meeting_deleted.
type MeetingDeletedColumns struct {
	MeetingId     string // 三方 meetings[].meetingId 原样（实测 meeting_1790527565_0xx8arRt 27 字符）；有行即压制，主键天然去重
	MeetingNumber string // 该场的三方会议号，仅作排查线索：读列表不按号判定（号是拨号用的，不保证一场一号）
	AppointmentId string // 本侧被删除的预约单 id，仅作排查线索（预约单是软删，行还在 meeting_appointment 里可回查）
	SuppressedAt  string // 本侧登记压制的时刻。刻意不叫 deleted_at：那会被 GoFrame gdb 当逻辑删除列，查询会自动加 WHERE DELETED_AT IS NULL 把压制行全滤掉。恢复某条 = 物理删这一行，当前无恢复入口
}

// meetingDeletedColumns holds the columns for the table meeting_deleted.
var meetingDeletedColumns = MeetingDeletedColumns{
	MeetingId:     "MEETING_ID",
	MeetingNumber: "MEETING_NUMBER",
	AppointmentId: "APPOINTMENT_ID",
	SuppressedAt:  "SUPPRESSED_AT",
}

// NewMeetingDeletedDao creates and returns a new DAO object for table data access.
func NewMeetingDeletedDao(handlers ...gdb.ModelHandler) *MeetingDeletedDao {
	return &MeetingDeletedDao{
		group:    "default",
		table:    "meeting_deleted",
		columns:  meetingDeletedColumns,
		handlers: handlers,
	}
}

// DB retrieves and returns the underlying raw database management object of the current DAO.
func (dao *MeetingDeletedDao) DB() gdb.DB {
	return g.DB(dao.group)
}

// Table returns the table name of the current DAO.
func (dao *MeetingDeletedDao) Table() string {
	return dao.table
}

// Columns returns all column names of the current DAO.
func (dao *MeetingDeletedDao) Columns() MeetingDeletedColumns {
	return dao.columns
}

// Group returns the database configuration group name of the current DAO.
func (dao *MeetingDeletedDao) Group() string {
	return dao.group
}

// Ctx creates and returns a Model for the current DAO. It automatically sets the context for the current operation.
func (dao *MeetingDeletedDao) Ctx(ctx context.Context) *gdb.Model {
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
func (dao *MeetingDeletedDao) Transaction(ctx context.Context, f func(ctx context.Context, tx gdb.TX) error) (err error) {
	return dao.Ctx(ctx).Transaction(ctx, f)
}
