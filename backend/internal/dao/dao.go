package dao

import (
	"cloud-conference-backend/internal/dao/internal"
)

type internalSysUserDao = *internal.SysUserDao

type sysUserDao struct {
	internalSysUserDao
}

var SysUser = sysUserDao{internal.NewSysUserDao()}

type internalSysDeptDao = *internal.SysDeptDao

type sysDeptDao struct {
	internalSysDeptDao
}

var SysDept = sysDeptDao{internal.NewSysDeptDao()}

type internalMeetingAppointmentDao = *internal.MeetingAppointmentDao

type meetingAppointmentDao struct {
	internalMeetingAppointmentDao
}

var MeetingAppointment = meetingAppointmentDao{internal.NewMeetingAppointmentDao()}

type internalMeetingParticipantDao = *internal.MeetingParticipantDao

type meetingParticipantDao struct {
	internalMeetingParticipantDao
}

var MeetingParticipant = meetingParticipantDao{internal.NewMeetingParticipantDao()}

type internalUserSettingsDao = *internal.UserSettingsDao

type userSettingsDao struct {
	internalUserSettingsDao
}

var UserSettings = userSettingsDao{internal.NewUserSettingsDao()}

type internalSysDictTypeDao = *internal.SysDictTypeDao

type sysDictTypeDao struct {
	internalSysDictTypeDao
}

var SysDictType = sysDictTypeDao{internal.NewSysDictTypeDao()}

type internalSysDictDataDao = *internal.SysDictDataDao

type sysDictDataDao struct {
	internalSysDictDataDao
}

var SysDictData = sysDictDataDao{internal.NewSysDictDataDao()}

// RecordingDeleted 录制压制表（本侧的账）：用户删过的 recordingId 在此留一行，
// 列表/回放出口据此剔条目 —— 三方 recordings[] 有删不掉的孤儿行，只靠上游清理做不到"删了就不再出现"。
type internalRecordingDeletedDao = *internal.RecordingDeletedDao

type recordingDeletedDao struct {
	internalRecordingDeletedDao
}

var RecordingDeleted = recordingDeletedDao{internal.NewRecordingDeletedDao()}

// MeetingDeleted 会议压制表（本侧的账）：删过的会按三方 meetingId 留一行，
// 日程合并时据此剔掉上游仍报着的那一场 —— 三方停会只把它变成 ended 留在列表里，删不掉。
type internalMeetingDeletedDao = *internal.MeetingDeletedDao

type meetingDeletedDao struct {
	internalMeetingDeletedDao
}

var MeetingDeleted = meetingDeletedDao{internal.NewMeetingDeletedDao()}

// MeetingAttendance 参会历史：这个账号真的进过哪场会（第 5 项）。
// 三方列表按主持人过滤看不见别人主持的会，受邀名单又不等于实际参加过，
// 所以"加入过的会议仍要出现在会议列表"只能由这张表兑现。
type internalMeetingAttendanceDao = *internal.MeetingAttendanceDao

type meetingAttendanceDao struct {
	internalMeetingAttendanceDao
}

var MeetingAttendance = meetingAttendanceDao{internal.NewMeetingAttendanceDao()}
