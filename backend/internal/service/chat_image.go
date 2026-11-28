package service

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/gogf/gf/v2/frame/g"

	"cloud-conference-backend/internal/errs"
)

const (
	// chatImageMaxBytes 前端已缩到 720px 宽并转 WebP/JPEG，正常几十 KB；5 MB 是给原图直传的兜底。
	chatImageMaxBytes = 5 << 20
	// chatImageRetention 会中图片只服务于会中聊天，保留一周足够回看，过期由每日任务清掉。
	chatImageRetention  = 7 * 24 * time.Hour
	chatImagePathFormat = "/api/v1/chat/images/%d"
)

// ChatImage 一张会中聊天图片的字节与归属。
type ChatImage struct {
	MeetingId int64
	UserId    int64
	Mime      string
	Data      []byte
}

// SaveChatImage 落库并返回图片读取路径。聊天正文只带这条短路径：
// 把整张图 base64 塞进正文会撞上聊天通道的长度上限，消息直接发不出去。
func SaveChatImage(ctx context.Context, meetingId, userId int64, content io.Reader) (string, error) {
	data, err := io.ReadAll(io.LimitReader(content, chatImageMaxBytes+1))
	if err != nil {
		return "", fmt.Errorf("读取图片失败: %w", err)
	}
	if len(data) == 0 {
		return "", errs.Bizf("图片文件为空")
	}
	if len(data) > chatImageMaxBytes {
		return "", errs.Bizf("图片超过 %d MB 上限", chatImageMaxBytes>>20)
	}
	mime, ok := detectImageMime(data)
	if !ok {
		return "", errs.Bizf("只支持 PNG / JPEG / WebP 图片")
	}
	id, err := g.DB().Model("chat_image").Ctx(ctx).Data(g.Map{
		"MEETING_ID": meetingId,
		"USER_ID":    userId,
		"MIME":       mime,
		"DATA":       data,
		"CREATED_AT": time.Now().Format("2006-01-02 15:04:05"),
	}).InsertAndGetId()
	if err != nil {
		return "", fmt.Errorf("保存图片失败: %w", err)
	}
	return fmt.Sprintf(chatImagePathFormat, id), nil
}

// LoadChatImage 读一张图；不存在时返回 nil。
func LoadChatImage(ctx context.Context, id int64) (*ChatImage, error) {
	if id <= 0 {
		return nil, nil
	}
	rec, err := g.DB().Model("chat_image").Ctx(ctx).
		Fields("MEETING_ID", "USER_ID", "MIME", "DATA").
		Where("ID", id).One()
	if err != nil {
		return nil, fmt.Errorf("查询图片失败: %w", err)
	}
	if rec.IsEmpty() {
		return nil, nil
	}
	mime, ok := allowedContentType(rec["MIME"].String())
	if !ok {
		return nil, nil
	}
	return &ChatImage{
		MeetingId: rec["MEETING_ID"].Int64(),
		UserId:    rec["USER_ID"].Int64(),
		Mime:      mime,
		Data:      rec["DATA"].Bytes(),
	}, nil
}

// CleanupExpiredChatImages 删除超过保留期的会中图片，返回删除条数。
func CleanupExpiredChatImages(ctx context.Context) (int64, error) {
	cutoff := time.Now().Add(-chatImageRetention).Format("2006-01-02 15:04:05")
	res, err := g.DB().Exec(ctx, `DELETE FROM chat_image WHERE CREATED_AT < ?`, cutoff)
	if err != nil {
		return 0, fmt.Errorf("清理聊天图片失败: %w", err)
	}
	n, _ := res.RowsAffected()
	return n, nil
}
