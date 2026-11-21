import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  joinMeeting as apiJoin,
  leaveMeeting as apiLeave,
  issueWsTicket,
  getMeetingState,
  type JoinResult,
  type MeetingStateVo,
  type ParticipantVo,
  type InvitedVo,
  type StreamVo,
} from '@/api/meeting'
import { ApiError } from '@/utils/request'
import type { RateBasis } from '@/utils/compression'
import router from '@/router'

// 会议态的唯一真源：入会成功才置位，离会/会议结束/WS 长期断开即清除。
export const useMeetingStore = defineStore('meeting', () => {
  const meetingId = ref<number>(Number(sessionStorage.getItem('meetingId') || 0) || 0)
  const meetingNo = ref(sessionStorage.getItem('meetingNo') || '')
  const title = ref(sessionStorage.getItem('meetingTitle') || '')
  const participantId = ref(sessionStorage.getItem('participantId') || '')
  const wsTicket = ref('')
  const wsTicketExpiresIn = ref(60)
  const state = ref<MeetingStateVo | null>(null)
  const wsConnected = ref(false)
  const initialMedia = ref<{ micOff: boolean; cameraOff: boolean }>({ micOff: false, cameraOff: false })
  /** quick / scheduled / share / voice：决定入会后默认媒体行为 */
  const launchKind = ref(sessionStorage.getItem('conference.launchKind') || '')

  // 会中 UI 偏好：跨页面导航持久化（排列、面板）。
  // 组件 ref 会在 unmount 时丢失，store 不会。
  const uiLayout = ref<'top' | 'grid' | 'right'>('top')
  const uiDock = ref<'none' | 'members' | 'chat' | 'stats'>('none')

  // meetingId 是后端给的会话键，对外部会议（只在三方建的会）是负数，只认"有没有"不认正负。
  const inMeeting = computed(() => meetingId.value !== 0)
  const participants = computed<ParticipantVo[]>(() => state.value?.participants || [])
  const invited = computed<InvitedVo[]>(() => state.value?.invited || [])
  const streams = computed<StreamVo[]>(() => state.value?.streams || [])
  const self = computed(() => participants.value.find((p) => p.id === participantId.value) || null)

  // 侧栏「会议信息卡」的数据源：速率由会中页实测后写入（getStats / 播放器回调），
  // 不在 store 里造默认值 —— 没测出来就是空，卡片显示「—」。
  // focusRawKbps / focusCompressedKbps 是**主画面那一路**的原始/压缩后速率（kbps），
  // 原始速率/压缩比/节省带宽三项由 utils/compression 统一换算（与会中悬浮统计条同一口径），
  // 帧还没到时是 0 —— 消费方必须显示 —，不得当成"速率为 0"。
  // focusRawTitle 是「原始速率这个数从哪来」的一句话说明：只有会中页知道自己聚焦的是本端
  // 还是某一路远端，所以那句话由它写，侧栏照抄 —— 口径说明也只许有一处持有（第 26 项）。
  const mediaStats = ref<{
    upKbps: number
    downKbps: number
    cameraUpKbps: number
    micUpKbps: number
    focusRawKbps: number
    focusCompressedKbps: number
    focusRawTitle: string
    /** 主画面那一路的压缩类型，直接取后端 streams[].compressionKind（口径只有一处判读） */
    focusCompressionKind: string
    /** 三方在该路发布记录里直接上报的压缩倍率（本端两个数凑不出倍率时的退路）；0 = 没给。 */
    focusReportedRatio: number
    /** 上面那个倍率是三方估算而非实测，界面要标出来。 */
    focusReportedEstimate: boolean
    /** 压缩后这个数量在哪条腿，由会中页经 `pickTransmittedKbps` 定，侧栏只照抄。 */
    focusBasis: RateBasis
  } | null>(null)

  function setMediaStats(v: typeof mediaStats.value) {
    mediaStats.value = v
  }

  function persist() {
    sessionStorage.setItem('meetingId', String(meetingId.value || ''))
    sessionStorage.setItem('meetingNo', meetingNo.value)
    sessionStorage.setItem('meetingTitle', title.value)
  }

  async function join(no: string, displayName?: string, recordingConsent = true): Promise<JoinResult> {
    const res = await apiJoin({ meetingNo: no, displayName, recordingConsent })
    const data = res.data!
    // 主持人不在场且该会允许等待：后端只把本端排队，没有真正入会。
    // 不写会话态、不换票，把 waiting 原样交给调用方展示等待态并重试。
    if (data.waiting) return data
    // 新会议 = 新会话，UI 偏好从默认值起算，不带上一场的布局/编码过来
    uiLayout.value = 'top'
    uiDock.value = 'none'
    meetingId.value = data.meetingId
    meetingNo.value = data.meetingNo
    title.value = data.title
    participantId.value = data.participantId
    sessionStorage.setItem('participantId', participantId.value)
    initialMedia.value = data.initialMedia || { micOff: false, cameraOff: false }
    const kind = data.kind || sessionStorage.getItem('conference.launchKind') || ''
    if (kind) {
      launchKind.value = kind
      sessionStorage.setItem('conference.launchKind', kind)
    }
    // 语音/共享：即便库里旧行没写 cameraOff，也按入口意图关摄像。
    if (launchKind.value === 'voice' || launchKind.value === 'share') {
      initialMedia.value = { ...initialMedia.value, cameraOff: true }
    }
    persist()
    await refreshTicket()
    return data
  }

  async function refreshTicket() {
    if (!meetingId.value) return
    const res = await issueWsTicket(meetingId.value)
    wsTicket.value = res.data!.ticket
    wsTicketExpiresIn.value = res.data!.expiresInSeconds
  }

  // enter 是"加入并进入会议页"的唯一入口：三方令牌留在服务端，前端只带会议 id 跳转。
  // 返回完整结果而非 id —— waiting 时没有可跳转的会议。
  async function enter(no: string, displayName?: string, recordingConsent = true): Promise<JoinResult> {
    return join(no, displayName, recordingConsent)
  }

  function applyState(s: MeetingStateVo) {
    state.value = s
    if (s.status === 'ended' || s.status === 'cancelled' || s.status === 'failed') {
      clear()
    }
  }

  function clear() {
    meetingId.value = 0
    meetingNo.value = ''
    title.value = ''
    participantId.value = ''
    launchKind.value = ''
    sessionStorage.removeItem('participantId')
    sessionStorage.removeItem('conference.launchKind')
    wsTicket.value = ''
    state.value = null
    wsConnected.value = false
    sessionStorage.removeItem('meetingId')
    sessionStorage.removeItem('meetingNo')
    sessionStorage.removeItem('meetingTitle')
    // 离会即清空实测速率，侧栏卡片回到「—」，不留着上一场的数字冒充本场。
    mediaStats.value = null
    // 离会时重置 UI 偏好，下次入会用默认值
    uiLayout.value = 'top'
    uiDock.value = 'none'
    exitMeetingPage()
  }

  // 会话没了就必须把人带出会中页：只清 store 不跳路由的话，用户会留在会中页对着一屏
  // 过期数据（后端重启、房间被回收、别处结束会议都是这条），正是第 6 项要治的形态。
  // 放在 clear() 里，三条路径共用一个出口。
  function exitMeetingPage() {
    if (router.currentRoute.value.name !== 'InMeeting') return
    void router.replace({ name: 'MeetingEmpty' }).catch(() => undefined)
  }

  // 会话态是从 sessionStorage 恢复的：后端重启、房间被回收、会议已在别处结束后，
  // 这个 id 已经作废。不校验就会出现"菜单还挂着已入会，点进去却进不去"。
  async function validateRestored() {
    if (!meetingId.value) return
    try {
      const res = await getMeetingState(meetingId.value, true)
      applyState(res.data!)
    } catch (e) {
      if (e instanceof ApiError && e.reason === 'not_in_meeting') clear()
    }
  }

  async function leave() {
    if (!meetingId.value) return
    const id = meetingId.value
    // 先通知后端再清本地：clear() 会触发拆流与路由跳转，原先先 clear 让在途的
    // leave 请求撞在无会话的后端上，正是"入会后立即离会报错"的根因。
    // silent=true 且后端此刻最多回 not_in_meeting（拦截器已不弹）——失败也不阻断收尾。
    try {
      await apiLeave(id, true)
    } catch (e) {
      console.warn('[meeting] 离会请求未成功（本地照常收尾）', e)
    }
    clear()
  }

  return {
    meetingId,
    meetingNo,
    title,
    participantId,
    wsTicket,
    wsTicketExpiresIn,
    state,
    wsConnected,
    initialMedia,
    launchKind,
    inMeeting,
    participants,
    invited,
    streams,
    self,
    mediaStats,
    setMediaStats,
    uiLayout,
    uiDock,
    join,
    enter,
    leave,
    clear,
    applyState,
    validateRestored,
    refreshTicket,
  }
})
