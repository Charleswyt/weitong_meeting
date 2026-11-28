import { get, post } from '@/utils/request'
import type { components } from '@/types/api.gen'

// 线格式类型取自契约生成物（../contracts/api.openapi.yaml → src/types/api.gen.ts），不手写第二份。
// 接线时暴露的真实分叉（DERIVATION §4-A8）：旧手写 REST 类型把侧别字段写成 `senderNodeType`，
// 但 REST 线上的键是 **senderEndpointType**（`senderNodeType` 只存在于 WS 推送，两个名字分属两条通道）。
// 全 src 无一处读 REST 侧该字段，所以改名对消费点零影响 —— WS 侧那份在 useWebSocket.ts 自己的帧类型里，没动。
// 另两处分叉：契约 id/senderName 恒出现（POST 回显 id 恒为 0，**不许拿 data.id 当消息标识**），
// 旧手写版都标了可选。
export type ChatMessageVo = components['schemas']['ChatMessageVo']

export function getChatMessages(params: { meetingId: number; afterId?: number; limit?: number }) {
  return get<ChatMessageVo[]>('/api/v1/chat/messages', { params })
}

// 会中图片先落后端、聊天正文只带回来的短路径：整图 base64 进正文会超出聊天通道的长度上限。
export function uploadChatImage(meetingId: number, file: Blob, filename = 'image.webp') {
  const fd = new FormData()
  fd.append('meetingId', String(meetingId))
  fd.append('file', file, filename)
  return post<{ url: string }>('/api/v1/chat/images', fd)
}

export function sendMessage(data: { meetingId: number; text: string; clientMessageId?: string }) {
  return post<ChatMessageVo>('/api/v1/chat/messages', data)
}
