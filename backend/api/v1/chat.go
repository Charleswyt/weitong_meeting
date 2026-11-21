package v1

import "github.com/gogf/gf/v2/frame/g"

type ChatListMessagesReq struct {
	g.Meta    `path:"/chat/messages" method:"get" tags:"聊天"`
	MeetingId int64 `v:"required" json:"meetingId"`
	AfterId   int64 `json:"afterId"`
	Limit     int   `json:"limit"`
}

type ChatListMessagesRes struct {
	Messages []ChatMessageVo `json:"messages"`
}

type ChatSendMessageReq struct {
	g.Meta          `path:"/chat/messages" method:"post" tags:"聊天"`
	MeetingId       int64  `v:"required" json:"meetingId"`
	Text            string `v:"required|length:1,1000" json:"text"`
	ClientMessageId string `json:"clientMessageId"`
}

type ChatSendMessageRes struct {
	Message ChatMessageVo `json:"message"`
}

type ChatMessageVo struct {
	Id                 int64  `json:"id"`
	Text               string `json:"text"`
	SenderName         string `json:"senderName"`
	SenderEndpointType string `json:"senderEndpointType"`
	SentAt             string `json:"sentAt"`
}
