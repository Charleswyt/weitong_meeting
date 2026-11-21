package service

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"

	"cloud-conference-backend/internal/dao"
	"cloud-conference-backend/internal/errs"
	"cloud-conference-backend/internal/model/do"
)

const (
	// avatarMaxBytes 2 MB —— 前端已缩到 256px，超过这个体积就不是头像了。
	avatarMaxBytes = 2 << 20
	// avatarPathFormat 是头像字节出口；sys_user.avatar 存它的取值，
	// 目的是让列表类查询只读这一列就能判断"有没有头像"，不必碰 BLOB。
	avatarPathFormat = "/api/v1/users/%d/avatar"
)

// AvatarService 把头像字节直接存进 sys_user.avatar_data —— 头像小、量小，
// 为它单独维护一块本地盘换来的是"备份漏了它就全员没头像"，而库里的份跟着备份一起走。
type AvatarService struct{}

func NewAvatarService() *AvatarService { return &AvatarService{} }

// Avatar 一个用户的头像字节与其 MIME 类型。
type Avatar struct {
	Data        []byte
	ContentType string
}

// Exists 报告这格头像有没有东西（空 BLOB 与 NULL 同义，都算没有）。
func (a Avatar) Exists() bool { return len(a.Data) > 0 && a.ContentType != "" }

// AvatarPath 给出某用户的头像读取路径（不含票参，凭据不进任何响应字段）。
func AvatarPath(userId int64) string { return fmt.Sprintf(avatarPathFormat, userId) }

// avatarBlobColumns 头像字节列：只为"取几个字段"而查 sys_user 的地方都该把它们排除 ——
// 单行最多 2 MB，人员列表一次就是 N 行，而字节只有头像出口那一处真的需要。
func avatarBlobColumns() []string {
	return []string{dao.SysUser.Columns().AvatarData, dao.SysUser.Columns().AvatarType}
}

// detectImageMime 只认 PNG/JPEG/WebP，且**只按文件头判定**——
// 扩展名和客户端声明的 Content-Type 都是调用方说了算的东西，不能信。
// SVG 明确排除：它能携带脚本，直出去就是一个现成的存储型 XSS 载体。
func detectImageMime(head []byte) (string, bool) {
	switch {
	case len(head) >= 8 && bytes.Equal(head[:8], []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}):
		return "image/png", true
	case len(head) >= 3 && head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF:
		return "image/jpeg", true
	case len(head) >= 12 && string(head[0:4]) == "RIFF" && string(head[8:12]) == "WEBP":
		return "image/webp", true
	default:
		return "", false
	}
}

// allowedContentType 只放行这三个 MIME 出网关。存进去的列是可信的（恒由 detectImageMime 写），
// 但手工改库/半截数据不该让这个端点替谁决定浏览器该怎么解释这段字节。
func allowedContentType(mime string) (string, bool) {
	switch mime {
	case "image/png", "image/jpeg", "image/webp":
		return mime, true
	default:
		return "", false
	}
}

// Save 把头像字节写进库并同步派生路径，一次 UPDATE 落三列 ——
// 换头像要么整体生效要么整体不变，不会出现"路径指向没有的字节"。
func (s *AvatarService) Save(ctx context.Context, userId int64, content io.Reader) (string, error) {
	if userId == 0 {
		return "", errors.New("未登录")
	}
	// 整体读进内存再判体积：多要 1 个字节就能分辨"正好 2MB"和"其实更大"，
	// 不用信客户端声明的 size（那是调用方想写多少就写多少的东西）。
	data, err := io.ReadAll(io.LimitReader(content, avatarMaxBytes+1))
	if err != nil {
		return "", fmt.Errorf("读取头像失败: %w", err)
	}
	if len(data) == 0 {
		return "", errors.New("头像文件为空")
	}
	if len(data) > avatarMaxBytes {
		return "", errs.Bizf("头像文件超过 %d MB 上限", avatarMaxBytes>>20)
	}
	mime, ok := detectImageMime(data)
	if !ok {
		return "", errors.New("只支持 PNG / JPEG / WebP 图片")
	}

	path := AvatarPath(userId)
	if _, err := dao.SysUser.Ctx(ctx).Data(do.SysUser{
		Avatar:     path,
		AvatarData: data,
		AvatarType: mime,
	}).Where(dao.SysUser.Columns().Id, userId).Update(); err != nil {
		return "", fmt.Errorf("写入头像失败: %w", err)
	}
	return path, nil
}

// Clear 清掉头像：字节、类型、派生路径一起归零，留谁都算数据坏。
func (s *AvatarService) Clear(ctx context.Context, userId int64) error {
	if userId == 0 {
		return errors.New("未登录")
	}
	// 空串而不是 nil —— do 结构里的 nil 字段会被当成"这次不改这列"跳过，头像就会赖在库里。
	if _, err := dao.SysUser.Ctx(ctx).Data(do.SysUser{
		Avatar:     "",
		AvatarData: []byte{},
		AvatarType: "",
	}).Where(dao.SysUser.Columns().Id, userId).Update(); err != nil {
		return fmt.Errorf("清除头像失败: %w", err)
	}
	return nil
}

// Load 取头像字节给 HTTP 出口用。只读这两列：顺手 SELECT * 会把三方口令一起拖出来。
// 用户不存在与"没头像"同归 Exists()=false —— 出口都是 404，没必要让端点泄露"这个 id 有没有人"。
func (s *AvatarService) Load(ctx context.Context, userId int64) (Avatar, error) {
	if userId <= 0 {
		return Avatar{}, nil
	}
	var row struct {
		AvatarData []byte `orm:"AVATAR_DATA"`
		AvatarType string `orm:"AVATAR_TYPE"`
	}
	err := dao.SysUser.Ctx(ctx).
		Fields(dao.SysUser.Columns().AvatarData, dao.SysUser.Columns().AvatarType).
		Where(dao.SysUser.Columns().Id, userId).
		WhereNull(dao.SysUser.Columns().DeletedAt).
		Scan(&row)
	if errors.Is(err, sql.ErrNoRows) {
		// 没有这行 = 没有头像。gf 的 Scan 对空结果集是直接报错的，不接住就会把 404 报成 500。
		return Avatar{}, nil
	}
	if err != nil {
		return Avatar{}, fmt.Errorf("查询头像失败: %w", err)
	}
	mime, ok := allowedContentType(row.AvatarType)
	if !ok {
		return Avatar{}, nil
	}
	return Avatar{Data: row.AvatarData, ContentType: mime}, nil
}
