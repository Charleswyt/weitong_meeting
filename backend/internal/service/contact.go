package service

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/glog"

	"cloud-conference-backend/internal/email"
	"cloud-conference-backend/internal/errs"
)

const (
	maxContactsPerUser   = 500
	contactSearchLimit   = 20
	inviteMailCooldown   = 10 * time.Minute
	inviteMailConcurrent = 4
)

// ContactVo 通讯录里的一位好友。邮箱/手机只给脱敏值：通讯录是"认识这个人"，不是"拿到他的联系方式"。
type ContactVo struct {
	UserId      int64  `json:"userId"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Avatar      string `json:"avatar"`
	Email       string `json:"email"`
	Mobile      string `json:"mobile"`
	HasEmail    bool   `json:"hasEmail"`
	AccountType string `json:"accountType"`
	Remark      string `json:"remark"`
	AddedAt     string `json:"addedAt"`
	IsContact   bool   `json:"isContact"`
}

type ContactInviteResult struct {
	Invited     int      `json:"invited"`
	EmailQueued int      `json:"emailQueued"`
	NoEmail     []string `json:"noEmail"`
	Skipped     int      `json:"skipped"`
}

type ContactService struct {
	mail     email.Provider
	meetings *MeetingService
}

func NewContactService(mail email.Provider, meetings *MeetingService) *ContactService {
	return &ContactService{mail: mail, meetings: meetings}
}

type contactUserRow struct {
	Id          int64  `orm:"ID"`
	Username    string `orm:"USERNAME"`
	DisplayName string `orm:"DISPLAY_NAME"`
	Avatar      string `orm:"AVATAR"`
	Email       string `orm:"EMAIL"`
	Mobile      string `orm:"MOBILE"`
	AccountType string `orm:"ACCOUNT_TYPE"`
	Remark      string `orm:"REMARK"`
	AddedAt     string `orm:"ADDED_AT"`
}

func (r contactUserRow) toVo(isContact bool) ContactVo {
	name := r.DisplayName
	if name == "" {
		name = r.Username
	}
	return ContactVo{
		UserId:      r.Id,
		Username:    r.Username,
		DisplayName: name,
		Avatar:      r.Avatar,
		Email:       maskEmail(r.Email),
		Mobile:      maskMobile(r.Mobile),
		HasEmail:    strings.TrimSpace(r.Email) != "",
		AccountType: r.AccountType,
		Remark:      r.Remark,
		AddedAt:     r.AddedAt,
		IsContact:   isContact,
	}
}

func maskEmail(addr string) string {
	addr = strings.TrimSpace(addr)
	at := strings.LastIndex(addr, "@")
	if at <= 0 {
		return ""
	}
	local := []rune(addr[:at])
	keep := 2
	if len(local) <= 2 {
		keep = 1
	}
	return string(local[:keep]) + "***" + addr[at:]
}

func maskMobile(m string) string {
	m = strings.TrimSpace(m)
	if len(m) < 7 {
		return ""
	}
	return m[:3] + "****" + m[len(m)-4:]
}

const contactUserFields = "u.ID, u.USERNAME, u.DISPLAY_NAME, u.AVATAR, u.EMAIL, u.MOBILE, u.ACCOUNT_TYPE"

// ListContacts 列出我的通讯录；已注销/停用的账号不再出现。
func (s *ContactService) ListContacts(ctx context.Context, ownerId int64) ([]ContactVo, error) {
	var rows []contactUserRow
	err := g.DB().GetScan(ctx, &rows,
		`SELECT `+contactUserFields+`, c.REMARK, c.CREATED_AT AS ADDED_AT
		   FROM user_contact c JOIN sys_user u ON u.ID = c.CONTACT_ID
		  WHERE c.OWNER_ID = ? AND u.DELETED_AT IS NULL AND u.STATUS = 1
		  ORDER BY COALESCE(NULLIF(c.REMARK, ''), u.DISPLAY_NAME, u.USERNAME)`, ownerId)
	if err != nil {
		return nil, fmt.Errorf("查询通讯录失败: %w", err)
	}
	out := make([]ContactVo, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.toVo(true))
	}
	return out, nil
}

// SearchUsers 按登录名/显示名模糊查，或按完整邮箱/手机号精确查，用于"添加好友"。
func (s *ContactService) SearchUsers(ctx context.Context, ownerId int64, keyword string) ([]ContactVo, error) {
	kw := strings.TrimSpace(keyword)
	if kw == "" {
		return []ContactVo{}, nil
	}
	if len([]rune(kw)) > 64 {
		return nil, errs.Bizf("搜索内容过长")
	}
	like := "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(kw) + "%"
	var rows []contactUserRow
	err := g.DB().GetScan(ctx, &rows,
		`SELECT `+contactUserFields+`, '' AS REMARK, '' AS ADDED_AT
		   FROM sys_user u
		  WHERE u.DELETED_AT IS NULL AND u.STATUS = 1 AND u.ID <> ?
		    AND COALESCE(u.ACCOUNT_TYPE, '') <> 'temp_user'
		    AND (u.USERNAME LIKE ? ESCAPE '\' OR u.DISPLAY_NAME LIKE ? ESCAPE '\'
		         OR LOWER(u.EMAIL) = LOWER(?) OR u.MOBILE = ?)
		  ORDER BY u.ID LIMIT ?`, ownerId, like, like, kw, kw, contactSearchLimit)
	if err != nil {
		return nil, fmt.Errorf("搜索用户失败: %w", err)
	}
	ids := make([]int64, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.Id)
	}
	existing := map[int64]bool{}
	if len(ids) > 0 {
		vals, err := g.DB().Model("user_contact").Ctx(ctx).
			Fields("CONTACT_ID").Where("OWNER_ID", ownerId).WhereIn("CONTACT_ID", ids).Array()
		if err != nil {
			return nil, fmt.Errorf("查询好友关系失败: %w", err)
		}
		for _, v := range vals {
			existing[v.Int64()] = true
		}
	}
	out := make([]ContactVo, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.toVo(existing[r.Id]))
	}
	return out, nil
}

func (s *ContactService) AddContact(ctx context.Context, ownerId, contactId int64, remark string) error {
	if contactId <= 0 || contactId == ownerId {
		return errs.Bizf("不能添加自己为好友")
	}
	remark = strings.TrimSpace(remark)
	if len([]rune(remark)) > 32 {
		return errs.Bizf("备注不能超过 32 个字")
	}
	n, err := g.DB().Model("sys_user").Ctx(ctx).
		Where("ID", contactId).WhereNull("DELETED_AT").Where("STATUS", 1).
		WhereNot("ACCOUNT_TYPE", "temp_user").Count()
	if err != nil {
		return fmt.Errorf("查询用户失败: %w", err)
	}
	if n == 0 {
		return errs.Bizf("该用户不存在或已停用")
	}
	total, err := g.DB().Model("user_contact").Ctx(ctx).Where("OWNER_ID", ownerId).Count()
	if err != nil {
		return fmt.Errorf("查询通讯录失败: %w", err)
	}
	if total >= maxContactsPerUser {
		return errs.Bizf("通讯录最多 %d 人", maxContactsPerUser)
	}
	_, err = g.DB().Exec(ctx,
		`INSERT INTO user_contact (OWNER_ID, CONTACT_ID, REMARK, CREATED_AT) VALUES (?, ?, ?, ?)
		 ON CONFLICT(OWNER_ID, CONTACT_ID) DO UPDATE SET REMARK = excluded.REMARK`,
		ownerId, contactId, remark, time.Now().Format("2006-01-02 15:04:05"))
	if err != nil {
		return fmt.Errorf("添加好友失败: %w", err)
	}
	return nil
}

func (s *ContactService) RemoveContact(ctx context.Context, ownerId, contactId int64) error {
	if _, err := g.DB().Model("user_contact").Ctx(ctx).
		Where("OWNER_ID", ownerId).Where("CONTACT_ID", contactId).Delete(); err != nil {
		return fmt.Errorf("删除好友失败: %w", err)
	}
	return nil
}

func (s *ContactService) UpdateRemark(ctx context.Context, ownerId, contactId int64, remark string) error {
	remark = strings.TrimSpace(remark)
	if len([]rune(remark)) > 32 {
		return errs.Bizf("备注不能超过 32 个字")
	}
	res, err := g.DB().Model("user_contact").Ctx(ctx).
		Where("OWNER_ID", ownerId).Where("CONTACT_ID", contactId).
		Data(g.Map{"REMARK": remark}).Update()
	if err != nil {
		return fmt.Errorf("更新备注失败: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errs.Bizf("对方不在你的通讯录中")
	}
	return nil
}

var inviteMailSent = struct {
	sync.Mutex
	at map[string]time.Time
}{at: map[string]time.Time{}}

// claimInviteMail 同一场会同一个人 10 分钟内只发一封，防止连点把对方邮箱刷屏。
func claimInviteMail(meetingId, userId int64, now time.Time) bool {
	key := fmt.Sprintf("%d:%d", meetingId, userId)
	inviteMailSent.Lock()
	defer inviteMailSent.Unlock()
	for k, t := range inviteMailSent.at {
		if now.Sub(t) > inviteMailCooldown {
			delete(inviteMailSent.at, k)
		}
	}
	if t, ok := inviteMailSent.at[key]; ok && now.Sub(t) < inviteMailCooldown {
		return false
	}
	inviteMailSent.at[key] = now
	return true
}

// InviteContacts 把通讯录好友加进受邀名单；绑定了邮箱的人再发一封邀请邮件。
// 只认我自己通讯录里的人：否则这个接口就成了"给任意注册用户发邮件"的口子。
func (s *ContactService) InviteContacts(ctx context.Context, meetingId, inviterId int64, contactIds []int64, joinUrl string) (*ContactInviteResult, error) {
	if len(contactIds) == 0 {
		return nil, errs.Bizf("请选择要邀请的好友")
	}
	if len(contactIds) > 50 {
		return nil, errs.Bizf("一次最多邀请 50 人")
	}
	m, err := s.meetings.GetDetail(ctx, meetingId)
	if err != nil {
		return nil, err
	}
	if IsTerminalStatus(m.Status) {
		return nil, errs.Bizf("会议已结束或已取消，不能再邀请")
	}
	visible, err := s.meetings.VisibleToUser(ctx, meetingId, inviterId)
	if err != nil {
		return nil, err
	}
	if !visible {
		return nil, errs.Bizf("你不在这场会议中，不能邀请他人")
	}

	var rows []contactUserRow
	if err := g.DB().GetScan(ctx, &rows,
		`SELECT `+contactUserFields+`, c.REMARK, '' AS ADDED_AT
		   FROM user_contact c JOIN sys_user u ON u.ID = c.CONTACT_ID
		  WHERE c.OWNER_ID = ? AND u.DELETED_AT IS NULL AND u.STATUS = 1
		    AND c.CONTACT_ID IN (?)`, inviterId, contactIds); err != nil {
		return nil, fmt.Errorf("查询好友失败: %w", err)
	}
	result := &ContactInviteResult{Skipped: len(contactIds) - len(rows), NoEmail: []string{}}
	if len(rows) == 0 {
		return result, nil
	}
	ids := make([]int64, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.Id)
	}
	if err := PersistInvitees(ctx, meetingId, ids); err != nil {
		return nil, fmt.Errorf("写入受邀名单失败: %w", err)
	}
	result.Invited = len(ids)

	inviterName := ""
	if v, err := g.DB().Model("sys_user").Ctx(ctx).Fields("COALESCE(NULLIF(DISPLAY_NAME,''), USERNAME)").Where("ID", inviterId).Value(); err == nil {
		inviterName = v.String()
	}
	base := email.MeetingInvite{
		InviterName:     inviterName,
		Title:           m.Title,
		MeetingNo:       m.ThirdPartyMeetingNumber,
		DurationMinutes: m.DurationMinutes,
		JoinUrl:         sanitizeJoinUrl(joinUrl, m.ThirdPartyMeetingNumber),
		HasPassword:     m.MeetingPassword != "",
	}
	if m.StartTime != nil {
		base.StartTime = m.StartTime.Time.In(time.FixedZone("CST", 8*3600)).Format("2006-01-02 15:04") + "（北京时间）"
	}

	type job struct {
		to  string
		inv email.MeetingInvite
	}
	jobs := make([]job, 0, len(rows))
	now := time.Now()
	for _, r := range rows {
		addr := strings.TrimSpace(r.Email)
		name := r.Remark
		if name == "" {
			name = r.DisplayName
		}
		if name == "" {
			name = r.Username
		}
		if addr == "" {
			result.NoEmail = append(result.NoEmail, name)
			continue
		}
		if !claimInviteMail(meetingId, r.Id, now) {
			continue
		}
		inv := base
		inv.InviteeName = name
		jobs = append(jobs, job{to: addr, inv: inv})
	}
	result.EmailQueued = len(jobs)

	// SMTP 一封要一两秒，50 人串行会把请求拖到超时；发信放后台，结果进日志。
	if len(jobs) > 0 && s.mail != nil {
		bg := context.WithoutCancel(ctx)
		go func() {
			sem := make(chan struct{}, inviteMailConcurrent)
			var wg sync.WaitGroup
			for _, j := range jobs {
				wg.Add(1)
				sem <- struct{}{}
				go func(j job) {
					defer func() { <-sem; wg.Done() }()
					sendCtx, cancel := context.WithTimeout(bg, 30*time.Second)
					defer cancel()
					if err := s.mail.SendMeetingInvite(sendCtx, j.to, j.inv); err != nil {
						glog.Warningf(bg, "会议邀请邮件发送失败 meeting=%d to=%s: %v", meetingId, maskEmail(j.to), err)
					}
				}(j)
			}
			wg.Wait()
		}()
	}
	return result, nil
}

// sanitizeJoinUrl 链接由前端按可分享地址拼好传来，这里只放行 http(s) 且确实指向这场会的链接，
// 防止被借去往别人邮箱里塞任意网址。
func sanitizeJoinUrl(raw, meetingNo string) string {
	u := strings.TrimSpace(raw)
	if u == "" || len(u) > 300 || meetingNo == "" {
		return ""
	}
	if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
		return ""
	}
	if strings.ContainsAny(u, " \"'<>\r\n") || !strings.Contains(u, meetingNo) {
		return ""
	}
	return u
}
