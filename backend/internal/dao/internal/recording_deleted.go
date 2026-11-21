// ==========================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// ==========================================================================

package internal

import (
	"context"

	"github.com/gogf/gf/v2/database/gdb"
	"github.com/gogf/gf/v2/frame/g"
)

// RecordingDeletedDao is the data access object for the table recording_deleted.
type RecordingDeletedDao struct {
	table    string                  // table is the underlying table name of the DAO.
	group    string                  // group is the database configuration group name of the current DAO.
	columns  RecordingDeletedColumns // columns contains all the column names of Table for convenient usage.
	handlers []gdb.ModelHandler      // handlers for customized model modification.
}

// RecordingDeletedColumns defines and stores column names for the table recording_deleted.
type RecordingDeletedColumns struct {
	RecordingId  string // 三方 recordings[].recordingId 原样（实测 rec_pub_meeting_…_participant_…_pub_… 达 88 字符，故 128 不是 64）；有行即压制，主键天然去重（本单元不建 UNIQUE 约束的约定对 PK 除外）
	MeetingId    string // 该录制所属三方会议 id，仅作排查线索：删除是整场粒度，同场其它 recordingId 也各写一行；读列表只按 recording_id 判定，不靠它反查会议是否还在
	SuppressedAt string // 本侧登记压制的时刻（不是三方的删除时刻，孤儿行三方从未删成）。刻意不叫 deleted_at：那会被 GoFrame gdb 当逻辑删除列，查询会自动加 WHERE DELETED_AT IS NULL 把压制行全滤掉。恢复某条 = 物理删这一行，当前无恢复入口
}

// recordingDeletedColumns holds the columns for the table recording_deleted.
var recordingDeletedColumns = RecordingDeletedColumns{
	RecordingId:  "RECORDING_ID",
	MeetingId:    "MEETING_ID",
	SuppressedAt: "SUPPRESSED_AT",
}

// NewRecordingDeletedDao creates and returns a new DAO object for table data access.
func NewRecordingDeletedDao(handlers ...gdb.ModelHandler) *RecordingDeletedDao {
	return &RecordingDeletedDao{
		group:    "default",
		table:    "recording_deleted",
		columns:  recordingDeletedColumns,
		handlers: handlers,
	}
}

// DB retrieves and returns the underlying raw database management object of the current DAO.
func (dao *RecordingDeletedDao) DB() gdb.DB {
	return g.DB(dao.group)
}

// Table returns the table name of the current DAO.
func (dao *RecordingDeletedDao) Table() string {
	return dao.table
}

// Columns returns all column names of the current DAO.
func (dao *RecordingDeletedDao) Columns() RecordingDeletedColumns {
	return dao.columns
}

// Group returns the database configuration group name of the current DAO.
func (dao *RecordingDeletedDao) Group() string {
	return dao.group
}

// Ctx creates and returns a Model for the current DAO. It automatically sets the context for the current operation.
func (dao *RecordingDeletedDao) Ctx(ctx context.Context) *gdb.Model {
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
func (dao *RecordingDeletedDao) Transaction(ctx context.Context, f func(ctx context.Context, tx gdb.TX) error) (err error) {
	return dao.Ctx(ctx).Transaction(ctx, f)
}
