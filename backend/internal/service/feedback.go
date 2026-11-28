package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/gogf/gf/v2/frame/g"

	"cloud-conference-backend/internal/errs"
)

type FeedbackScore struct {
	Id    string `json:"id"`
	Label string `json:"label"`
	Score int    `json:"score"`
}

type FeedbackSummary struct {
	LikeCount int  `json:"likeCount"`
	Liked     bool `json:"liked"`
}

// 登录页即可提交，按客户端限频，防止匿名刷库。
const feedbackPerHourLimit = 5

var feedbackLimiter = struct {
	sync.Mutex
	hits map[string][]time.Time
}{hits: map[string][]time.Time{}}

// feedbackClientKey 不落原始 IP，只存摘要：够去重，不留可识别信息。
func feedbackClientKey(clientIP, userAgent string) string {
	sum := sha256.Sum256([]byte(normalizeClientIP(clientIP) + "|" + strings.TrimSpace(userAgent)))
	return hex.EncodeToString(sum[:16])
}

func FeedbackSummaryOf(ctx context.Context, clientIP, userAgent string) (*FeedbackSummary, error) {
	cnt, err := g.DB().Model("app_like").Ctx(ctx).Count()
	if err != nil {
		return nil, fmt.Errorf("查询点赞数失败: %w", err)
	}
	liked, err := g.DB().Model("app_like").Ctx(ctx).
		Where("CLIENT_KEY", feedbackClientKey(clientIP, userAgent)).Count()
	if err != nil {
		return nil, fmt.Errorf("查询点赞状态失败: %w", err)
	}
	return &FeedbackSummary{LikeCount: cnt, Liked: liked > 0}, nil
}

// LikeApp 同一客户端只记一次，重复点赞幂等返回当前总数。
func LikeApp(ctx context.Context, clientIP, userAgent string) (*FeedbackSummary, error) {
	if _, err := g.DB().Exec(ctx,
		`INSERT OR IGNORE INTO app_like (CLIENT_KEY, CREATED_AT) VALUES (?, ?)`,
		feedbackClientKey(clientIP, userAgent), time.Now().Format("2006-01-02 15:04:05"),
	); err != nil {
		return nil, fmt.Errorf("记录点赞失败: %w", err)
	}
	return FeedbackSummaryOf(ctx, clientIP, userAgent)
}

func SubmitFeedback(ctx context.Context, userId int64, clientIP, userAgent string, scores []FeedbackScore, content string) error {
	content = strings.TrimSpace(content)
	if r := []rune(content); len(r) > 300 {
		content = string(r[:300])
	}
	rated := make([]FeedbackScore, 0, len(scores))
	for _, s := range scores {
		if s.Score < 0 || s.Score > 5 || len(s.Id) > 32 || len([]rune(s.Label)) > 32 {
			return errs.Bizf("评分数据不正确")
		}
		rated = append(rated, s)
	}
	if len(rated) > 10 {
		return errs.Bizf("评分项过多")
	}
	hasScore := false
	for _, s := range rated {
		if s.Score > 0 {
			hasScore = true
			break
		}
	}
	if !hasScore && content == "" {
		return errs.Bizf("请至少给一项打分，或填写更多意见")
	}

	key := feedbackClientKey(clientIP, userAgent)
	if !allowFeedback(key, time.Now()) {
		return errs.Bizf("提交过于频繁，请稍后再试")
	}

	raw, _ := json.Marshal(rated)
	_, err := g.DB().Model("app_feedback").Ctx(ctx).Data(g.Map{
		"USER_ID":    userId,
		"CLIENT_KEY": key,
		"SCORES":     string(raw),
		"CONTENT":    content,
		"CREATED_AT": time.Now().Format("2006-01-02 15:04:05"),
	}).Insert()
	if err != nil {
		return fmt.Errorf("保存反馈失败: %w", err)
	}
	return nil
}

func allowFeedback(key string, now time.Time) bool {
	feedbackLimiter.Lock()
	defer feedbackLimiter.Unlock()
	cutoff := now.Add(-time.Hour)
	kept := feedbackLimiter.hits[key][:0]
	for _, t := range feedbackLimiter.hits[key] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= feedbackPerHourLimit {
		feedbackLimiter.hits[key] = kept
		return false
	}
	feedbackLimiter.hits[key] = append(kept, now)
	return true
}
