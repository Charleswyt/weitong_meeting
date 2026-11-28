package cmd

import (
	"context"
	"strings"

	"github.com/gogf/gf/v2/frame/g"
)

// ensureUserMobileColumn 给存量 SQLite 补 MOBILE 列与唯一索引。
// 新建库走 sqlite_create.sql 已含该列；这里只兜「旧库起新二进制」那一拍。
func ensureUserMobileColumn(ctx context.Context) {
	ensureUserColumn(ctx, "MOBILE", `ALTER TABLE sys_user ADD COLUMN MOBILE VARCHAR(20)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uk_sys_user_mobile
  ON sys_user(MOBILE) WHERE MOBILE IS NOT NULL AND MOBILE != ''`)
}

// ensureUserEmailColumn 给存量库补 EMAIL 列（邮箱验证码登录）。
func ensureUserEmailColumn(ctx context.Context) {
	ensureUserColumn(ctx, "EMAIL", `ALTER TABLE sys_user ADD COLUMN EMAIL VARCHAR(128)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uk_sys_user_email
  ON sys_user(EMAIL) WHERE EMAIL IS NOT NULL AND EMAIL != ''`)
}

// ensureMeetingLaunchKindColumn 首页入口类型（快速/预约/共享/语音），供近期会议展示。
func ensureMeetingLaunchKindColumn(ctx context.Context) {
	db := g.DB()
	rows, err := db.GetAll(ctx, `PRAGMA table_info(meeting_appointment)`)
	if err != nil {
		g.Log().Warningf(ctx, "读取 meeting_appointment 表结构失败，跳过 LAUNCH_KIND 补列: %v", err)
		return
	}
	for _, r := range rows {
		if strings.EqualFold(r["name"].String(), "LAUNCH_KIND") {
			return
		}
	}
	if _, err := db.Exec(ctx, `ALTER TABLE meeting_appointment ADD COLUMN LAUNCH_KIND VARCHAR(16) DEFAULT ''`); err != nil {
		g.Log().Warningf(ctx, "补 meeting_appointment.LAUNCH_KIND 失败: %v", err)
		return
	}
	g.Log().Infof(ctx, "已为存量库补列 meeting_appointment.LAUNCH_KIND")
}

// ensureMeetingEndReasonColumn 会议结束原因（normal 正常结束 / abnormal_exit 异常退出超时自动结束）。
func ensureMeetingEndReasonColumn(ctx context.Context) {
	db := g.DB()
	rows, err := db.GetAll(ctx, `PRAGMA table_info(meeting_appointment)`)
	if err != nil {
		g.Log().Warningf(ctx, "读取 meeting_appointment 表结构失败，跳过 END_REASON 补列: %v", err)
		return
	}
	for _, r := range rows {
		if strings.EqualFold(r["name"].String(), "END_REASON") {
			return
		}
	}
	if _, err := db.Exec(ctx, `ALTER TABLE meeting_appointment ADD COLUMN END_REASON VARCHAR(32) DEFAULT ''`); err != nil {
		g.Log().Warningf(ctx, "补 meeting_appointment.END_REASON 失败: %v", err)
		return
	}
	g.Log().Infof(ctx, "已为存量库补列 meeting_appointment.END_REASON")
}

// ensureMeetingPasswordColumn 会议入会密码（为空表示无密码）。
func ensureMeetingPasswordColumn(ctx context.Context) {
	db := g.DB()
	rows, err := db.GetAll(ctx, `PRAGMA table_info(meeting_appointment)`)
	if err != nil {
		g.Log().Warningf(ctx, "读取 meeting_appointment 表结构失败，跳过 MEETING_PASSWORD 补列: %v", err)
		return
	}
	for _, r := range rows {
		if strings.EqualFold(r["name"].String(), "MEETING_PASSWORD") {
			return
		}
	}
	if _, err := db.Exec(ctx, `ALTER TABLE meeting_appointment ADD COLUMN MEETING_PASSWORD VARCHAR(32) DEFAULT ''`); err != nil {
		g.Log().Warningf(ctx, "补 meeting_appointment.MEETING_PASSWORD 失败: %v", err)
		return
	}
	g.Log().Infof(ctx, "已为存量库补列 meeting_appointment.MEETING_PASSWORD")
}

// ensureAccountTypeLabels：存量库改「普通参会」→「普通用户」，并补面试用临时用户类型。
func ensureAccountTypeLabels(ctx context.Context) {
	db := g.DB()
	if _, err := db.Exec(ctx, `UPDATE sys_dict_data SET DICT_LABEL='普通用户', REMARK='普通注册用户'
		WHERE DICT_TYPE='account_type' AND DICT_VALUE='meeting_participant'`); err != nil {
		g.Log().Warningf(ctx, "更新 account_type 普通用户标签失败: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT OR IGNORE INTO sys_dict_data
		(ID, DICT_TYPE, DICT_VALUE, DICT_LABEL, SORT, TAG_TYPE, REMARK, STATUS)
		VALUES (30, 'account_type', 'temp_user', '临时用户', 4, 'warning', '面试等场景临时注册', 1)`); err != nil {
		g.Log().Warningf(ctx, "补 account_type.temp_user 失败: %v", err)
	}
}

// ensureInterviewAccountTable 面试工坊临时面试者账号表（记录可开会次数、已用次数与截止有效期）。
func ensureInterviewAccountTable(ctx context.Context) {
	db := g.DB()
	ddl := `CREATE TABLE IF NOT EXISTS interview_account (
		ID INTEGER PRIMARY KEY AUTOINCREMENT,
		APPOINTMENT_ID INTEGER NOT NULL,
		MEETING_NUMBER VARCHAR(32) DEFAULT '',
		USER_ID INTEGER NOT NULL UNIQUE,
		CANDIDATE_NAME VARCHAR(64) NOT NULL,
		USERNAME VARCHAR(64) NOT NULL,
		PASSWORD VARCHAR(255) DEFAULT '',
		MAX_JOINS INTEGER NOT NULL DEFAULT 1,
		USED_JOINS INTEGER NOT NULL DEFAULT 0,
		EXPIRES_AT DATETIME NOT NULL,
		CREATED_BY INTEGER NOT NULL DEFAULT 0,
		CREATED_AT DATETIME DEFAULT CURRENT_TIMESTAMP
	)`
	if _, err := db.Exec(ctx, ddl); err != nil {
		g.Log().Warningf(ctx, "创建 interview_account 表失败: %v", err)
		return
	}
	if _, err := db.Exec(ctx, `CREATE INDEX IF NOT EXISTS idx_interview_account_appt ON interview_account(APPOINTMENT_ID)`); err != nil {
		g.Log().Warningf(ctx, "创建 idx_interview_account_appt 索引失败: %v", err)
	}
	hasPassword := false
	if rows, err := db.GetAll(ctx, `PRAGMA table_info(interview_account)`); err == nil {
		for _, r := range rows {
			if strings.EqualFold(r["name"].String(), "PASSWORD") {
				hasPassword = true
				break
			}
		}
	}
	if !hasPassword {
		if _, err := db.Exec(ctx, `ALTER TABLE interview_account ADD COLUMN PASSWORD VARCHAR(255) DEFAULT ''`); err != nil {
			g.Log().Warningf(ctx, "补 interview_account.PASSWORD 失败: %v", err)
		}
	}
	if _, err := db.Exec(ctx, `CREATE INDEX IF NOT EXISTS idx_interview_account_username ON interview_account(USERNAME)`); err != nil {
		g.Log().Warningf(ctx, "创建 idx_interview_account_username 索引失败: %v", err)
	}
}

// ensureClientPrefTables 个人偏好（原浏览器 localStorage）与产品反馈 / 点赞。
func ensureClientPrefTables(ctx context.Context) {
	ddls := []string{
		`CREATE TABLE IF NOT EXISTS user_client_pref (
			USER_ID INTEGER PRIMARY KEY,
			VIDEO_ENHANCE INTEGER NOT NULL DEFAULT 1,
			SPEAKER_VOLUME INTEGER NOT NULL DEFAULT 80,
			CAPTION_LANGUAGE VARCHAR(16) DEFAULT 'zh',
			CAMERA_DELIVERY TEXT DEFAULT '',
			SCREEN_DELIVERY TEXT DEFAULT '',
			UPDATED_AT VARCHAR(32) DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS app_feedback (
			ID INTEGER PRIMARY KEY AUTOINCREMENT,
			USER_ID INTEGER NOT NULL DEFAULT 0,
			CLIENT_KEY VARCHAR(64) DEFAULT '',
			SCORES TEXT DEFAULT '',
			CONTENT TEXT DEFAULT '',
			CREATED_AT VARCHAR(32) DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS app_like (
			CLIENT_KEY VARCHAR(64) PRIMARY KEY,
			CREATED_AT VARCHAR(32) DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS chat_image (
			ID INTEGER PRIMARY KEY AUTOINCREMENT,
			MEETING_ID INTEGER NOT NULL,
			USER_ID INTEGER NOT NULL,
			MIME VARCHAR(32) NOT NULL,
			DATA BLOB NOT NULL,
			CREATED_AT VARCHAR(32) DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_image_created ON chat_image(CREATED_AT)`,
		`CREATE TABLE IF NOT EXISTS user_contact (
			OWNER_ID INTEGER NOT NULL,
			CONTACT_ID INTEGER NOT NULL,
			REMARK VARCHAR(64) DEFAULT '',
			CREATED_AT VARCHAR(32) DEFAULT '',
			PRIMARY KEY (OWNER_ID, CONTACT_ID)
		)`,
	}
	for _, ddl := range ddls {
		if _, err := g.DB().Exec(ctx, ddl); err != nil {
			g.Log().Warningf(ctx, "创建偏好/反馈表失败: %v", err)
		}
	}
}

// ensureUserLoginAuditTable 记录用户上次登录时间、IP 与位置。
func ensureUserLoginAuditTable(ctx context.Context) {
	ddl := `CREATE TABLE IF NOT EXISTS user_login_audit (
		USER_ID INTEGER PRIMARY KEY,
		LAST_LOGIN_AT VARCHAR(32) DEFAULT '',
		LAST_LOGIN_IP VARCHAR(64) DEFAULT '',
		LAST_LOGIN_LOCATION VARCHAR(128) DEFAULT '',
		PREV_LOGIN_AT VARCHAR(32) DEFAULT '',
		PREV_LOGIN_IP VARCHAR(64) DEFAULT '',
		PREV_LOGIN_LOCATION VARCHAR(128) DEFAULT ''
	)`
	if _, err := g.DB().Exec(ctx, ddl); err != nil {
		g.Log().Warningf(ctx, "创建 user_login_audit 表失败: %v", err)
	}
}

func ensureUserColumn(ctx context.Context, col, alterSQL, indexSQL string) {
	db := g.DB()
	rows, err := db.GetAll(ctx, `PRAGMA table_info(sys_user)`)
	if err != nil {
		g.Log().Warningf(ctx, "读取 sys_user 表结构失败，跳过 %s 补列: %v", col, err)
		return
	}
	has := false
	for _, r := range rows {
		if strings.EqualFold(r["name"].String(), col) {
			has = true
			break
		}
	}
	if !has {
		if _, err := db.Exec(ctx, alterSQL); err != nil {
			g.Log().Warningf(ctx, "补 sys_user.%s 失败: %v", col, err)
			return
		}
		g.Log().Infof(ctx, "已为存量库补列 sys_user.%s", col)
	}
	if _, err := db.Exec(ctx, indexSQL); err != nil {
		g.Log().Warningf(ctx, "创建 sys_user.%s 唯一索引失败: %v", col, err)
	}
}
