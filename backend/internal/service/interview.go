package service

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"strings"
	"time"
	"unicode"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/glog"
	"github.com/gogf/gf/v2/os/gtime"
	"github.com/mozillazg/go-pinyin"

	v1 "cloud-conference-backend/api/v1"
	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/dao"
	"cloud-conference-backend/internal/errs"
	"cloud-conference-backend/internal/model/do"
	"cloud-conference-backend/internal/model/entity"
	"cloud-conference-backend/internal/password"
)

const (
	maxConcurrentInterviewCandidates = 1
	maxInterviewCandidatesPerRoom    = 50

	// interviewUserIdBase 面试账号身份不落 sys_user，用这一段保留 id 签发令牌、写受邀名单，
	// 与 sys_user 自增主键永不相交。
	interviewUserIdBase int64 = 9_000_000_000_000
)

type interviewAccountRow struct {
	Id            int64       `orm:"ID"`
	AppointmentId int64       `orm:"APPOINTMENT_ID"`
	MeetingNumber string      `orm:"MEETING_NUMBER"`
	UserId        int64       `orm:"USER_ID"`
	CandidateName string      `orm:"CANDIDATE_NAME"`
	Username      string      `orm:"USERNAME"`
	Password      string      `orm:"PASSWORD"`
	MaxJoins      int         `orm:"MAX_JOINS"`
	UsedJoins     int         `orm:"USED_JOINS"`
	ExpiresAt     *gtime.Time `orm:"EXPIRES_AT"`
}

// IsInterviewUserId 判断令牌里的 userId 是否属于面试账号身份段。
func IsInterviewUserId(id int64) bool {
	return id >= interviewUserIdBase
}

// CreateInterviewRoom 创建会议，并为每位面试者在 interview_account 中生成独立的临时登录账号与口令。
func (s *MeetingService) CreateInterviewRoom(
	ctx context.Context,
	creatorId int64,
	hostAccount string,
	req *v1.InterviewCreateReq,
) (*v1.InterviewCreateRes, error) {
	candidates := cleanCandidateNames(req.Candidates)
	if len(candidates) == 0 {
		return nil, errs.Bizf("请至少填写一位面试者姓名")
	}
	if len(candidates) > maxInterviewCandidatesPerRoom {
		return nil, errs.Bizf("单次最多创建 %d 位面试者账号", maxInterviewCandidatesPerRoom)
	}

	expiresGT, err := gtime.StrToTime(strings.TrimSpace(req.ExpiresAt))
	if err != nil || expiresGT == nil {
		return nil, errs.Bizf("账号有效期格式不正确")
	}
	if !expiresGT.Time.After(time.Now()) {
		return nil, errs.Bizf("账号有效期必须晚于当前时间")
	}

	maxJoins := req.MaxJoins
	if maxJoins <= 0 {
		maxJoins = 1
	}

	m, syncReason, err := s.Schedule(ctx, creatorId, &ScheduleInput{
		Title:           strings.TrimSpace(req.Title),
		StartTime:       strings.TrimSpace(req.StartTime),
		DurationMinutes: req.DurationMinutes,
		CloudRecord:     req.CloudRecord,
		AllowWaiting:    true,
		HostAccount:     hostAccount,
		LaunchKind:      "scheduled",
	})
	if err != nil {
		return nil, err
	}

	accounts := make([]v1.InterviewAccountVo, 0, len(candidates))
	participantIds := make([]int64, 0, len(candidates))
	reserved := make(map[string]bool, len(candidates))

	for i, name := range candidates {
		username, err := generateUniqueInterviewUsername(ctx, name, reserved)
		if err != nil {
			return nil, fmt.Errorf("生成面试者账号失败: %w", err)
		}
		reserved[username] = true
		plainPass := readableInterviewPassword()
		hashed, err := password.Hash(plainPass)
		if err != nil {
			return nil, fmt.Errorf("加密面试者密码失败: %w", err)
		}

		// USER_ID 列唯一，先写一个不会冲突的负数占位，拿到自增 ID 后再换成身份段 id。
		rowId, err := g.DB().Model("interview_account").Ctx(ctx).Data(g.Map{
			"APPOINTMENT_ID": m.Id,
			"MEETING_NUMBER": m.ThirdPartyMeetingNumber,
			"USER_ID":        -(time.Now().UnixNano() + int64(i)),
			"CANDIDATE_NAME": name,
			"USERNAME":       username,
			"PASSWORD":       hashed,
			"MAX_JOINS":      maxJoins,
			"USED_JOINS":     0,
			"EXPIRES_AT":     expiresGT.Format("Y-m-d H:i:s"),
			"CREATED_BY":     creatorId,
		}).InsertAndGetId()
		if err != nil {
			return nil, fmt.Errorf("写入面试账号失败: %w", err)
		}
		userId := interviewUserIdBase + rowId
		if _, err := g.DB().Model("interview_account").Ctx(ctx).
			Where("ID", rowId).Data(g.Map{"USER_ID": userId}).Update(); err != nil {
			return nil, fmt.Errorf("写入面试账号身份失败: %w", err)
		}

		participantIds = append(participantIds, userId)
		accounts = append(accounts, v1.InterviewAccountVo{
			CandidateName: name,
			Username:      username,
			Password:      plainPass,
			MaxJoins:      maxJoins,
			ExpiresAt:     expiresGT.Format("Y-m-d H:i"),
		})
	}

	if len(participantIds) > 0 {
		if err := PersistInvitees(ctx, m.Id, participantIds); err != nil {
			glog.Warningf(ctx, "面试工坊 %d 写入受邀名单失败: %v", m.Id, err)
		}
		clearScheduleCache()
	}

	startStr := req.StartTime
	if m.StartTime != nil {
		startStr = m.StartTime.Format("Y-m-d H:i")
	}

	return &v1.InterviewCreateRes{
		MeetingId:       m.Id,
		MeetingNo:       m.ThirdPartyMeetingNumber,
		Title:           m.Title,
		StartTime:       startStr,
		DurationMinutes: m.DurationMinutes,
		SyncReason:      syncReason,
		Accounts:        accounts,
	}, nil
}

// loginInterviewAccount 口令登录在 sys_user 查无此人时的第二站：只认 interview_account。
// 返回 (nil, nil) 表示也不是面试账号，由调用方统一回「用户名或密码错误」。
func loginInterviewAccount(ctx context.Context, username, plainPass string) (*entity.SysUser, error) {
	row, err := findInterviewAccount(ctx, "USERNAME", username)
	if err != nil || row == nil || row.Password == "" {
		return nil, err
	}
	if !password.Verify(row.Password, plainPass) {
		return nil, nil
	}
	if isInterviewAccountExpired(row, time.Now()) {
		return nil, errs.Bizf("当前账户已经过期")
	}
	return interviewRowToUser(row), nil
}

// loadInterviewUser 按身份段 id 取面试账号，并按 SysUser 形状交给 GetMe / 三方令牌等调用方。
func loadInterviewUser(ctx context.Context, userId int64) (*entity.SysUser, error) {
	row, err := findInterviewAccount(ctx, "USER_ID", userId)
	if err != nil {
		return nil, fmt.Errorf("查询面试账号失败: %w", err)
	}
	if row == nil {
		return nil, errs.Bizf("当前账户已经过期")
	}
	return interviewRowToUser(row), nil
}

func interviewRowToUser(row *interviewAccountRow) *entity.SysUser {
	return &entity.SysUser{
		Id:          row.UserId,
		Username:    row.Username,
		DisplayName: row.CandidateName,
		AccountType: consts.AccountTypeTempUser,
		Status:      1,
	}
}

// loadInterviewInvitees 面试者不在 sys_user，受邀名单要从 interview_account 补齐。
func loadInterviewInvitees(ctx context.Context, appointmentId int64) []Invitee {
	var rows []interviewAccountRow
	if err := g.DB().Model("interview_account").Ctx(ctx).
		Where("APPOINTMENT_ID", appointmentId).
		WhereGTE("USER_ID", interviewUserIdBase).
		OrderAsc("ID").
		Scan(&rows); err != nil {
		glog.Warningf(ctx, "查询面试工坊 %d 受邀面试者失败: %v", appointmentId, err)
		return nil
	}
	out := make([]Invitee, 0, len(rows))
	for _, r := range rows {
		out = append(out, Invitee{UserId: r.UserId, Name: r.CandidateName})
	}
	return out
}

// CheckInterviewAccountLogin 登录时校验旧版（落在 sys_user 的）面试临时账号是否已超期或超过可开会次数。
func CheckInterviewAccountLogin(ctx context.Context, userId int64) error {
	row, err := findInterviewAccount(ctx, "USER_ID", userId)
	if err != nil || row == nil {
		return nil
	}
	if isInterviewAccountExpired(row, time.Now()) {
		return errs.Bizf("当前账户已经过期")
	}
	return nil
}

// CheckInterviewJoinGuard 入会时校验：
// 1. 面试者账号是否已过期或超出可开会次数；
// 2. 同一场面试中，同时在线的面试者不能超过 maxConcurrentInterviewCandidates。
func CheckInterviewJoinGuard(ctx context.Context, userId, appointmentId int64, onlineUserIds []int64) error {
	row, err := findInterviewAccount(ctx, "USER_ID", userId)
	if err != nil || row == nil {
		return nil
	}
	if isInterviewAccountExpired(row, time.Now()) {
		return errs.Bizf("当前账户已经过期")
	}

	targetApptId := row.AppointmentId
	if appointmentId > 0 && row.AppointmentId > 0 && appointmentId == row.AppointmentId {
		targetApptId = appointmentId
	}
	if targetApptId <= 0 {
		return nil
	}

	var peers []interviewAccountRow
	if err := g.DB().Model("interview_account").Ctx(ctx).
		Fields("USER_ID").
		Where("APPOINTMENT_ID", targetApptId).
		Scan(&peers); err != nil {
		glog.Warningf(ctx, "查询面试工坊 %d 同场账号失败: %v", targetApptId, err)
		return nil
	}

	peerSet := make(map[int64]bool, len(peers))
	for _, p := range peers {
		peerSet[p.UserId] = true
	}

	activeOtherCandidates := make(map[int64]bool)
	for _, uid := range onlineUserIds {
		if uid == userId {
			continue
		}
		if peerSet[uid] {
			activeOtherCandidates[uid] = true
		}
	}
	if len(activeOtherCandidates) >= maxConcurrentInterviewCandidates {
		return errs.Bizf("当前面试工坊同时进入的面试者不能超过 %d 人，请稍后再试", maxConcurrentInterviewCandidates)
	}
	return nil
}

// RecordInterviewJoinUsage 面试者首次进入房间成功后累计一次已开会次数。
func RecordInterviewJoinUsage(ctx context.Context, userId int64) {
	if userId <= 0 {
		return
	}
	_, err := g.DB().Exec(ctx,
		`UPDATE interview_account SET USED_JOINS = USED_JOINS + 1 WHERE USER_ID = ?`,
		userId,
	)
	if err != nil {
		glog.Warningf(ctx, "更新面试账号 %d 已开会次数失败: %v", userId, err)
	}
}

// CleanupExpiredInterviewAccounts 删除已过截止有效期的面试账号；
// 旧版落在 sys_user 的面试临时用户一并软删，避免过期账号长期残留。
func CleanupExpiredInterviewAccounts(ctx context.Context) int {
	now := time.Now().Format("2006-01-02 15:04:05")
	var rows []interviewAccountRow
	if err := g.DB().Model("interview_account").Ctx(ctx).
		Fields("ID", "USER_ID").
		WhereLT("EXPIRES_AT", now).
		Scan(&rows); err != nil {
		glog.Warningf(ctx, "查询过期面试账号失败: %v", err)
		return 0
	}
	if len(rows) == 0 {
		return 0
	}
	ids := make([]int64, 0, len(rows))
	legacyUserIds := make([]int64, 0)
	for _, r := range rows {
		ids = append(ids, r.Id)
		if r.UserId > 0 && !IsInterviewUserId(r.UserId) {
			legacyUserIds = append(legacyUserIds, r.UserId)
		}
	}
	if len(legacyUserIds) > 0 {
		if _, err := dao.SysUser.Ctx(ctx).
			WhereIn(dao.SysUser.Columns().Id, legacyUserIds).
			Where(dao.SysUser.Columns().AccountType, consts.AccountTypeTempUser).
			Data(do.SysUser{DeletedAt: gtime.Now()}).
			Update(); err != nil {
			glog.Warningf(ctx, "软删旧版面试临时用户失败: %v", err)
		}
	}
	if _, err := g.DB().Model("interview_account").Ctx(ctx).WhereIn("ID", ids).Delete(); err != nil {
		glog.Warningf(ctx, "删除过期面试账号失败: %v", err)
		return 0
	}
	return len(ids)
}

func findInterviewAccount(ctx context.Context, column string, value interface{}) (*interviewAccountRow, error) {
	if s, ok := value.(string); ok && strings.TrimSpace(s) == "" {
		return nil, nil
	}
	if n, ok := value.(int64); ok && n <= 0 {
		return nil, nil
	}
	rec, err := g.DB().Model("interview_account").Ctx(ctx).Where(column, value).One()
	if err != nil || rec.IsEmpty() {
		return nil, err
	}
	var row interviewAccountRow
	if err := rec.Struct(&row); err != nil {
		return nil, err
	}
	return &row, nil
}

func isInterviewAccountExpired(row *interviewAccountRow, now time.Time) bool {
	if row == nil {
		return false
	}
	if row.MaxJoins > 0 && row.UsedJoins >= row.MaxJoins {
		return true
	}
	if row.ExpiresAt != nil && now.After(row.ExpiresAt.Time) {
		return true
	}
	return false
}

func cleanCandidateNames(raw []string) []string {
	out := make([]string, 0, len(raw))
	for _, s := range raw {
		name := strings.TrimSpace(s)
		if name == "" {
			continue
		}
		if r := []rune(name); len(r) > 32 {
			name = string(r[:32])
		}
		out = append(out, name)
	}
	return out
}

// interviewUsernameBase 中文按全拼小写连写（张三 → zhangsan），英文与数字原样保留。
func interviewUsernameBase(name string) string {
	args := pinyin.NewArgs()
	args.Style = pinyin.Normal
	var b strings.Builder
	for _, r := range name {
		switch {
		case r < unicode.MaxASCII && (unicode.IsLetter(r) || unicode.IsDigit(r)):
			b.WriteRune(unicode.ToLower(r))
		case unicode.Is(unicode.Han, r):
			if py := pinyin.SinglePinyin(r, args); len(py) > 0 {
				b.WriteString(py[0])
			}
		}
	}
	base := b.String()
	if base == "" {
		base = "mianshi"
	}
	if len(base) > 24 {
		base = base[:24]
	}
	return base
}

// generateUniqueInterviewUsername 拼音重名时依次追加 2、3…；同时避开 sys_user 与 interview_account 已有登录名。
func generateUniqueInterviewUsername(ctx context.Context, name string, reserved map[string]bool) (string, error) {
	base := interviewUsernameBase(name)
	for i := 1; i <= 200; i++ {
		candidate := base
		if i > 1 {
			candidate = fmt.Sprintf("%s%d", base, i)
		}
		if reserved[candidate] {
			continue
		}
		taken, err := interviewUsernameTaken(ctx, candidate)
		if err != nil {
			return "", err
		}
		if !taken {
			return candidate, nil
		}
	}
	return fmt.Sprintf("%s%d", base, time.Now().UnixNano()%100000), nil
}

func interviewUsernameTaken(ctx context.Context, username string) (bool, error) {
	cnt, err := dao.SysUser.Ctx(ctx).Where(do.SysUser{Username: username}).Count()
	if err != nil || cnt > 0 {
		return cnt > 0, err
	}
	cnt, err = g.DB().Model("interview_account").Ctx(ctx).Where("USERNAME", username).Count()
	return cnt > 0, err
}

// readableInterviewPassword 生成易读口令：首字母大写的拼读音节 + 4 位数字，如 Bamuko4827。
// 剔除易混淆的 l/o/0/1，便于面试者照抄输入。
func readableInterviewPassword() string {
	const consonants = "bcdfghjkmnprstwz"
	const vowels = "aeiu"
	var b strings.Builder
	for i := 0; i < 3; i++ {
		c := consonants[randIndex(len(consonants))]
		if i == 0 {
			c = byte(unicode.ToUpper(rune(c)))
		}
		b.WriteByte(c)
		b.WriteByte(vowels[randIndex(len(vowels))])
	}
	const digits = "23456789"
	for i := 0; i < 4; i++ {
		b.WriteByte(digits[randIndex(len(digits))])
	}
	return b.String()
}

func randIndex(n int) int {
	v, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		return int(time.Now().UnixNano() % int64(n))
	}
	return int(v.Int64())
}
