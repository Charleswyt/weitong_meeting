package service

import (
	"context"
	"fmt"

	"cloud-conference-backend/internal/dao"
	"cloud-conference-backend/internal/model"
	"cloud-conference-backend/internal/session"
)

// Invitee 是受邀名单里的一条原始记录（尚未与在线成员比对）。
type Invitee struct {
	UserId  int64
	Name    string
	Account string
	Avatar  string
}

// PersistInvitees 把受邀用户写入 meeting_participant。
// 已存在的 (appointment, user) 组合跳过——预约只建不改，重复调用必须无副作用。
func PersistInvitees(ctx context.Context, appointmentId int64, userIds []int64) error {
	if appointmentId == 0 || len(userIds) == 0 {
		return nil
	}
	// 上限放在这里而不是请求结构体的 v 标签：gf 的 max 规则作用在切片上
	// 校验的是元素值而不是元素个数，写在标签里会把正常名单判成非法。
	if len(userIds) > 50 {
		return fmt.Errorf("单场会议受邀人数不能超过 50，当前 %d", len(userIds))
	}
	var existing []int64
	if err := dao.MeetingParticipant.Ctx(ctx).
		Fields(dao.MeetingParticipant.Columns().UserId).
		Where(dao.MeetingParticipant.Columns().AppointmentId, appointmentId).
		WhereNull(dao.MeetingParticipant.Columns().DeletedAt).
		Scan(&existing); err != nil {
		return err
	}
	seen := make(map[int64]bool, len(existing))
	for _, id := range existing {
		seen[id] = true
	}
	rows := make([]map[string]interface{}, 0, len(userIds))
	for _, uid := range userIds {
		if uid <= 0 || seen[uid] {
			continue
		}
		seen[uid] = true
		rows = append(rows, map[string]interface{}{
			dao.MeetingParticipant.Columns().AppointmentId: appointmentId,
			dao.MeetingParticipant.Columns().UserId:        uid,
		})
	}
	if len(rows) == 0 {
		return nil
	}
	_, err := dao.MeetingParticipant.Ctx(ctx).Data(rows).Insert()
	return err
}

// LoadInvitees 取某场会议的受邀名单，按受邀写入顺序稳定输出。
// 已软删的用户不进名单——人没了还挂着受邀是脏数据，不如不显示。
// 外部会议（只在三方建的会）没有预约单，也就没有受邀名单，其成员全部实时来自三方 state。
func LoadInvitees(ctx context.Context, meetingId int64) ([]Invitee, error) {
	if !session.IsManaged(meetingId) {
		return nil, nil
	}
	type row struct {
		Id      int64  `orm:"ID"`
		Name    string `orm:"DISPLAY_NAME"`
		Account string `orm:"THIRD_PARTY_ACCOUNT"`
		Avatar  string `orm:"AVATAR"`
	}
	var rows []row
	err := dao.SysUser.Ctx(ctx).As("u").
		Fields("u.ID", "u.DISPLAY_NAME", "u.THIRD_PARTY_ACCOUNT", "u.AVATAR").
		InnerJoin(dao.MeetingParticipant.Table()+" mp", "mp.USER_ID = u.ID").
		Where("mp.APPOINTMENT_ID", meetingId).
		WhereNull("mp.DELETED_AT").
		WhereNull("u.DELETED_AT").
		Order("mp.ID ASC").
		Scan(&rows)
	if err != nil {
		return nil, err
	}
	out := make([]Invitee, 0, len(rows))
	for _, r := range rows {
		out = append(out, Invitee{UserId: r.Id, Name: r.Name, Account: r.Account, Avatar: r.Avatar})
	}
	return out, nil
}

// MatchInvited 把受邀名单与在线成员比对，得出「等候入场」视图。
// 匹配优先用三方账号，账号缺失才退回姓名——姓名可重复，账号才是稳定键。
func MatchInvited(invitees []Invitee, participants []model.ParticipantVo) []model.InvitedVo {
	out := make([]model.InvitedVo, 0, len(invitees))
	byAccount := make(map[string]string, len(participants))
	byName := make(map[string]string, len(participants))
	for _, p := range participants {
		if p.Account != "" {
			byAccount[p.Account] = p.Id
		}
		if p.Name != "" {
			byName[p.Name] = p.Id
		}
	}
	for _, iv := range invitees {
		vo := model.InvitedVo{UserId: iv.UserId, Name: iv.Name, Avatar: iv.Avatar}
		if pid, ok := byAccount[iv.Account]; ok && iv.Account != "" {
			vo.Joined, vo.ParticipantId = true, pid
		} else if pid, ok := byName[iv.Name]; ok {
			vo.Joined, vo.ParticipantId = true, pid
		}
		out = append(out, vo)
	}
	return out
}

// LoadAvatarByAccount 供成员列表渲染真实头像：三方账号 → 我方头像路径。
func LoadAvatarByAccount(ctx context.Context) map[string]string {
	type row struct {
		ThirdPartyAccount string `orm:"THIRD_PARTY_ACCOUNT"`
		Avatar            string `orm:"AVATAR"`
	}
	var rows []row
	if err := dao.SysUser.Ctx(ctx).
		Fields(dao.SysUser.Columns().ThirdPartyAccount, dao.SysUser.Columns().Avatar).
		WhereNot(dao.SysUser.Columns().Avatar, "").
		WhereNull(dao.SysUser.Columns().DeletedAt).
		Scan(&rows); err != nil {
		return map[string]string{}
	}
	out := make(map[string]string, len(rows))
	for _, r := range rows {
		if r.ThirdPartyAccount != "" {
			out[r.ThirdPartyAccount] = r.Avatar
		}
	}
	return out
}
