package v1

import "github.com/gogf/gf/v2/frame/g"

// UserAvatarRes 头像写入结果。avatar 为我方头像字节端点路径 /api/v1/users/<id>/avatar（不含票参），清空时为 ""。
type UserAvatarRes struct {
	Avatar string `json:"avatar"`
}

// UserAvatarImageReq 头像字节出口。id 必须是正整数：/users/me/avatar 这类同形状路径不该被它接住。
type UserAvatarImageReq struct {
	g.Meta `path:"/users/{id}/avatar" method:"get" tags:"用户"`
	Id     int64 `v:"min:1" json:"id"`
}

// UserDisplayNameReq 改自己的显示名。长度与非空在服务层按"字"再校验一次（gf 的 length 规则按字节算，中文会误伤）。
type UserDisplayNameReq struct {
	g.Meta      `path:"/users/me/display-name" method:"put" tags:"用户"`
	DisplayName string `json:"displayName" v:"required#显示名不能为空"`
}

// UserDisplayNameRes 落库后的显示名，前端拿它更新本地态。
type UserDisplayNameRes struct {
	DisplayName string `json:"displayName"`
}

// UserListReq 人员列表（邀请名单选择用）。sys_contact 已废弃，人员即 sys_user。
type UserListReq struct {
	g.Meta  `path:"/users" method:"get" tags:"用户"`
	Keyword string `json:"keyword"`
}

// UserBriefVo 一行人员：id 即受邀 participantIds 的取值域（sys_user.id）。
type UserBriefVo struct {
	Id           int64  `json:"id"`
	Name         string `json:"name"`
	PositionCode string `json:"positionCode"`
	PositionName string `json:"positionName"`
	// Avatar 是头像字节端点路径（无票参）；<img> 用它时要自己补 ?token=，见契约 §6.9。
	Avatar string `json:"avatar,omitempty"`
}
