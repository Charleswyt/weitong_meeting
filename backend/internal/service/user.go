package service

import (
	"context"
	"fmt"
	"strings"
	"unicode/utf8"

	"cloud-conference-backend/internal/dao"
	"cloud-conference-backend/internal/errs"
	"cloud-conference-backend/internal/model/do"
	"cloud-conference-backend/internal/model/entity"
)

// UserService 提供"人员"读取——sys_contact 已废弃，人员主数据统一由 sys_user 承载。
type UserService struct{}

func NewUserService() *UserService {
	return &UserService{}
}

// List 返回启用中的全部用户（含无独立登录用途的参会人账号），供邀请名单选择。
func (s *UserService) List(ctx context.Context, keyword string) ([]entity.SysUser, error) {
	m := dao.SysUser.Ctx(ctx).
		FieldsEx(avatarBlobColumns()).
		Where(do.SysUser{Status: 1}).
		WhereNull(dao.SysUser.Columns().DeletedAt)
	if keyword != "" {
		m = m.WhereLike(dao.SysUser.Columns().DisplayName, "%"+keyword+"%")
	}
	var users []entity.SysUser
	if err := m.OrderAsc(dao.SysUser.Columns().Id).Scan(&users); err != nil {
		return nil, fmt.Errorf("查询用户列表失败: %w", err)
	}
	return users, nil
}

// UpdateDisplayName 改自己的显示名 —— 会中成员栏、受邀名单、聊天署名读的都是这一个字段。
// 返回落库后的值，让前端就地更新本地态，不用再发一次 GET。
func (s *UserService) UpdateDisplayName(ctx context.Context, userId int64, name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errs.Bizf("显示名不能为空")
	}
	if utf8.RuneCountInString(name) > 32 {
		return "", errs.Bizf("显示名不超过 32 个字")
	}
	if _, err := dao.SysUser.Ctx(ctx).
		Where(do.SysUser{Id: userId}).
		Data(do.SysUser{DisplayName: name}).
		Update(); err != nil {
		return "", fmt.Errorf("更新显示名失败: %w", err)
	}
	return name, nil
}
