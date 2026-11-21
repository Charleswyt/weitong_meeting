package service

import (
	"context"
	"fmt"

	"github.com/gogf/gf/v2/os/gtime"

	"cloud-conference-backend/internal/errs"
	"cloud-conference-backend/internal/service/thirdparty"
)

type ChatService struct {
	adapter *thirdparty.Adapter
}

func NewChatService(adapter *thirdparty.Adapter) *ChatService {
	return &ChatService{adapter: adapter}
}

type ChatMessageVo struct {
	Id                 int64  `json:"id"`
	Text               string `json:"text"`
	SenderName         string `json:"senderName"`
	SenderEndpointType string `json:"senderEndpointType"`
	SentAt             string `json:"sentAt"`
}

func (s *ChatService) ListMessages(ctx context.Context, participantToken string, afterId int64, limit int) ([]ChatMessageVo, error) {
	if participantToken == "" {
		return nil, errs.Bizf("缺少参会令牌")
	}
	if limit <= 0 {
		limit = 500
	}
	messages, _, err := s.adapter.ListMessages(ctx, participantToken, int(afterId), limit)
	if err != nil {
		return nil, fmt.Errorf("查询消息失败: %w", err)
	}

	result := make([]ChatMessageVo, 0, len(messages))
	for _, msg := range messages {
		ts := msg.SentAtMs
		if ts == 0 {
			ts = msg.SentAt * 1000
		}
		result = append(result, ChatMessageVo{
			Id:                 msg.Id,
			Text:               msg.Text,
			SenderName:         msg.SenderName,
			SenderEndpointType: msg.SenderEndpointType,
			SentAt:             gtime.NewFromTimeStamp(ts / 1000).Format("Y-m-d\\TH:i:sP"),
		})
	}
	return result, nil
}

func (s *ChatService) SendMessage(ctx context.Context, participantToken, text string) (*ChatMessageVo, error) {
	if participantToken == "" {
		return nil, errs.Bizf("缺少参会令牌")
	}
	clientMsgId := fmt.Sprintf("msg-%d", gtime.TimestampMilli())
	err := s.adapter.SendChatMessage(ctx, participantToken, text, clientMsgId)
	if err != nil {
		return nil, fmt.Errorf("发送消息失败: %w", err)
	}

	return &ChatMessageVo{
		Text:   text,
		SentAt: gtime.Now().Format("Y-m-d\\TH:i:sP"),
	}, nil
}
