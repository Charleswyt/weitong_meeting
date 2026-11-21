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
