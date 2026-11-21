import { ref, onUnmounted } from 'vue'
import { getMeetingState } from '@/api/meeting'
import type { ParticipantVo, StreamVo, MeetingStateVo, InvitedVo } from '@/api/meeting'
import { ApiError } from '@/utils/request'
import { useMeetingStore } from '@/store/meeting'
import type { ChatMessageVo } from '@/api/chat'

import type { components } from '@/types/api.gen'

/**
 * 下行帧的信封。契约里 `WsEvent` 恒两键（`hub.go:22-25`，均无 omitempty，
 * 所以 `data` 为 nil 时线上是 `"data":null` 而不是缺键）。
 * 这里按 `type` 收成判别联合 —— 以前是 `data: any`，等于把九类帧的形状全交给运行时。
 */
export type WsEvent =
  | { type: 'participants'; data: components['schemas']['WsParticipantsData'] }
  | { type: 'meeting'; data: components['schemas']['WsMeetingData'] }
  | { type: 'streams'; data: components['schemas']['WsStreamsData'] }
  | { type: 'chat'; data: components['schemas']['WsChatData'] }
  | { type: 'time'; data: components['schemas']['WsTimeData'] }
  | { type: 'speaking'; data: components['schemas']['WsSpeakingDown'] }
  // 未知 type 后端静默丢（`hub.go:456-462`），所以这里必须容得下没见过的帧
  | { type: string; data: null }

/**
 * 聊天帧。〔与 REST 的 `ChatMessageVo` **不是一回事**，两处都不同〕
 * 键名这里叫 `senderNodeType`（REST 是 `senderEndpointType`），
 * 且值已过 `NodeTypeOf` 归一成 `edge|cloud`，而 REST 是三方原值透传（`ship`/`shore`/…）。
 * 所以两条通道不能共用一个类型 —— 见契约 `WsChatData` 的说明。
 */
export type ChatEvent = components['schemas']['WsChatData']

/**
 * 聊天列表里的一行。〔这是接线时暴露出来的真分叉，不是类型体操〕
 * 同一个列表装着**两种来源、两种形状**：进会时 `GET /chat/messages` 拉的历史是 `ChatMessageVo`
 * （带 `senderEndpointType`，三方原值），会中 WS 推进来的是 `ChatEvent`（带 `senderNodeType`，已归一）。
 * 原先列表类型写成 `ChatEvent[]`、并在 push 处 `as ChatEvent` 硬掰，所以 REST 历史那条
 * 其实**没有** `senderNodeType` 这件事被静音了 —— 而面板只读 id/senderName/sentAt/text，
 * 那个侧别字段**全仓无人消费**（已 grep 确认）。
 * 所以这里如实收成联合，而不是给某一侧补一个假字段。
 */
export type ChatLine = ChatMessageVo | ChatEvent

const MAX_RECONNECT_DELAY = 15000
// 断开多久才把徽标升成"已断开"：重连退避最长就是 15 秒，链路抖一下立刻挂"连接断开"
// 既吓人也不如实（媒体腿是浏览器直连三方，状态通道断了画面照样在动）。
const DEGRADE_AFTER_MS = 8000

export function useWebSocket() {
  const meetingStore = useMeetingStore()
  const connected = ref(false)
  const degraded = ref(false)
  const participants = ref<ParticipantVo[]>([])
  const invited = ref<InvitedVo[]>([])
  const streams = ref<StreamVo[]>([])
  const messages = ref<ChatLine[]>([])
  const speakingMap = ref<Record<string, boolean>>({})
  const serverTime = ref(0)
  const clockDriftMs = ref(0)

  let ws: WebSocket | null = null
  let reconnectTimer: number | null = null
  let degradeTimer: number | null = null
  let reconnectDelay = 1000
  let closedByUs = false
  let currentMeetingId = 0

  // 状态通道的三种真实形态：连着 / 断了但在重连 / 断了且已经持续一会儿（该说"画面可能不再更新"）。
  function markUp() {
    connected.value = true
    degraded.value = false
    meetingStore.wsConnected = true
    if (degradeTimer !== null) {
      clearTimeout(degradeTimer)
      degradeTimer = null
    }
  }

  function markDown() {
    connected.value = false
    meetingStore.wsConnected = false
    if (degradeTimer !== null) return
    degradeTimer = window.setTimeout(() => {
      degradeTimer = null
      if (!connected.value) degraded.value = true
    }, DEGRADE_AFTER_MS)
  }

  async function connect(meetingId: number) {
    if (!meetingId) return
    // ticket 是一次性的：每次建立连接都必须换一张新票，不能复用已消费的旧票。
    await meetingStore.refreshTicket()
    await open(meetingId)
  }

  async function open(meetingId: number) {
    currentMeetingId = meetingId
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${location.host}/ws/v1/meeting?meetingId=${meetingId}&ticket=${encodeURIComponent(meetingStore.wsTicket)}`
    closedByUs = false
    ws = new WebSocket(url)

    ws.onopen = () => {
      markUp()
      reconnectDelay = 1000
    }

    ws.onmessage = (ev) => {
      let evt: WsEvent
      try {
        evt = JSON.parse(ev.data)
      } catch {
        return
      }
      // 契约说信封恒两键、`data` 无 omitempty —— 所以**服务端可以发来 `"data":null`**
      // （`hub.go:22-25`，Go 侧 `Data interface{}` 为 nil 时就是这个形状）。
      // 这不是防御性代码，是契约允许的一种取值：没有 payload 的帧对本端没有可应用的状态，直接丢。
      if (evt.data == null) return
      switch (evt.type) {
        case 'participants': {
          // 事件体是 {participants, invited}：等候入场靠 invited 与 participants 比对得出。
          const d = (evt.data || {}) as { participants?: ParticipantVo[]; invited?: InvitedVo[] }
          participants.value = d.participants || []
          invited.value = d.invited || []
          break
        }
        case 'meeting': {
          const s = evt.data as MeetingStateVo
          if (s && typeof s === 'object' && 'participants' in s) {
            participants.value = s.participants || []
            invited.value = s.invited || []
            streams.value = s.streams || []
            serverTime.value = s.serverTime
            clockDriftMs.value = s.clockDriftMs
          }
          meetingStore.applyState(s)
          break
        }
        case 'streams':
          streams.value = evt.data as StreamVo[]
          break
        case 'time':
          serverTime.value = evt.data.serverTime
          clockDriftMs.value = evt.data.clockDriftMs || 0
          break
        case 'chat':
          messages.value.push(evt.data)
          break
        case 'speaking':
          speakingMap.value = { ...speakingMap.value, [evt.data.participantId]: !!evt.data.speaking }
          break
      }
    }

    ws.onclose = () => {
      markDown()
      if (!closedByUs) scheduleReconnect()
    }

    ws.onerror = () => {
      markDown()
    }
  }

  async function scheduleReconnect() {
    if (reconnectTimer !== null || !currentMeetingId) return
    // 会话态已清（会议结束/已离会）还重连，就是拿一张空票去敲关掉的门：
    // 后端回「请先加入会议」，前端因此弹错误窗并把页面留在会中。
    if (!meetingStore.inMeeting) {
      disconnect()
      return
    }
    reconnectTimer = window.setTimeout(async () => {
      reconnectTimer = null
      if (!meetingStore.inMeeting) return
      try {
        // 服务端已经没有这场会（后端重启、房间被回收）时，无限重连只会把用户留在会中页
        // 对着"状态通道断开"。按机器码判定；链路抖动拿不到响应时仍继续重连。
        const gone = await getMeetingState(currentMeetingId, true)
          .then(() => false)
          .catch((e) => e instanceof ApiError && e.reason === 'not_in_meeting')
        if (gone) {
          meetingStore.clear()
          disconnect()
          return
        }
        await meetingStore.refreshTicket()
        await open(currentMeetingId)
      } catch {
        // 一次尝试失败（后端正在重启、票据接口报错）绝不能终止整条重连链：
        // 之前这里不 catch，抛一次就再也不会重连，用户永远停在会中页。
      }
      scheduleReconnect()
    }, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
  }

  function send(type: 'media' | 'chat' | 'speaking' | 'telemetry', data: any) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, data }))
    }
  }

  // sendChat 只投递；显示统一走服务端回推的 chat 事件，避免本地乐观副本与回显重复。
  async function sendChat(text: string) {
    const clientMessageId = `c-${Date.now()}-${Math.floor(performance.now())}`
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('连接已断开，无法发送')
    }
    send('chat', { text, clientMessageId })
  }

  function disconnect() {
    closedByUs = true
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (degradeTimer !== null) {
      clearTimeout(degradeTimer)
      degradeTimer = null
    }
    if (ws) {
      ws.onclose = null
      ws.close()
      ws = null
    }
    connected.value = false
    degraded.value = false
    meetingStore.wsConnected = false
  }

  onUnmounted(disconnect)

  return {
    connected,
    degraded,
    participants,
    invited,
    streams,
    messages,
    speakingMap,
    serverTime,
    clockDriftMs,
    connect,
    disconnect,
    send,
    sendChat,
  }
}
