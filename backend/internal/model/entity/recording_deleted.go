// =================================================================================
// Code generated and maintained by GoFrame CLI tool. DO NOT EDIT.
// =================================================================================

package entity

import (
	"github.com/gogf/gf/v2/os/gtime"
)

// RecordingDeleted is the golang structure for table recording_deleted.
type RecordingDeleted struct {
	RecordingId  string      `json:"rECORDINGID"  orm:"RECORDING_ID"  ` // 三方 recordings[].recordingId 原样（实测 rec_pub_meeting_…_participant_…_pub_… 达 88 字符，故 128 不是 64）；有行即压制，主键天然去重（本单元不建 UNIQUE 约束的约定对 PK 除外）
	MeetingId    string      `json:"mEETINGID"    orm:"MEETING_ID"    ` // 该录制所属三方会议 id，仅作排查线索：删除是整场粒度，同场其它 recordingId 也各写一行；读列表只按 recording_id 判定，不靠它反查会议是否还在
	SuppressedAt *gtime.Time `json:"sUPPRESSEDAT" orm:"SUPPRESSED_AT" ` // 本侧登记压制的时刻（不是三方的删除时刻，孤儿行三方从未删成）。刻意不叫 deleted_at：那会被 GoFrame gdb 当逻辑删除列，查询会自动加 WHERE DELETED_AT IS NULL 把压制行全滤掉。恢复某条 = 物理删这一行，当前无恢复入口
}
