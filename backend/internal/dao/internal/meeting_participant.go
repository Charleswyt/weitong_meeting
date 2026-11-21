// ==========================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// ==========================================================================

package internal

import (
	"context"

	"github.com/gogf/gf/v2/database/gdb"
	"github.com/gogf/gf/v2/frame/g"
)

// MeetingParticipantDao is the data access object for the table meeting_participant.
type MeetingParticipantDao struct {
	table    string                    // table is the underlying table name of the DAO.
	group    string                    // group is the database configuration group name of the current DAO.
	columns  MeetingParticipantColumns // columns contains all the column names of Table for convenient usage.
	handlers []gdb.ModelHandler        // handlers for customized model modification.
}

// MeetingParticipantColumns defines and stores column names for the table meeting_participant.
type MeetingParticipantColumns struct {
	Id            string // 自增主键
	AppointmentId string // 逻辑引用 meeting_appointment.id；删预约须同事务删本表（无级联外键）
	UserId        string // 逻辑引用 sys_user.id
	CreatedAt     string // 创建时间
	UpdatedAt     string // 更新时间
	DeletedAt     string // 软删除时间戳。(appointment_id, user_id) 组合唯一性由应用层保证
}

// meetingParticipantColumns holds the columns for the table meeting_participant.
var meetingParticipantColumns = MeetingParticipantColumns{
	Id:            "ID",
	AppointmentId: "APPOINTMENT_ID",
	UserId:        "USER_ID",
	CreatedAt:     "CREATED_AT",
	UpdatedAt:     "UPDATED_AT",
	DeletedAt:     "DELETED_AT",
}

// NewMeetingParticipantDao creates and returns a new DAO object for table data access.
func NewMeetingParticipantDao(handlers ...gdb.ModelHandler) *MeetingParticipantDao {
	return &MeetingParticipantDao{
		group:    "default",
		table:    "meeting_participant",
		columns:  meetingParticipantColumns,
		handlers: handlers,
	}
}

// DB retrieves and returns the underlying raw database management object of the current DAO.
func (dao *MeetingParticipantDao) DB() gdb.DB {
	return g.DB(dao.group)
}

// Table returns the table name of the current DAO.
func (dao *MeetingParticipantDao) Table() string {
	return dao.table
}

// Columns returns all column names of the current DAO.
func (dao *MeetingParticipantDao) Columns() MeetingParticipantColumns {
	return dao.columns
}

// Group returns the database configuration group name of the current DAO.
func (dao *MeetingParticipantDao) Group() string {
	return dao.group
}

// Ctx creates and returns a Model for the current DAO. It automatically sets the context for the current operation.
func (dao *MeetingParticipantDao) Ctx(ctx context.Context) *gdb.Model {
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
func (dao *MeetingParticipantDao) Transaction(ctx context.Context, f func(ctx context.Context, tx gdb.TX) error) (err error) {
	return dao.Ctx(ctx).Transaction(ctx, f)
}
