import { assetUrl, get, getPage, post, put } from '@/utils/request'
import type { components, operations } from '@/types/api.gen'

// 线格式类型取自契约生成物（../contracts/api.openapi.yaml → src/types/api.gen.ts），不手写第二份。
// 域语义备注：thirdPartyMeetingId（UUID 形）回放页用它查录制清单；managed=false 表示这场会只在三方
// 存在（手机/板卡发起），本系统没有预约单，不能改、不能取消；isHost 只有主持人可修改/取消预约。
// 接线时暴露的分叉：旧手写版 creatorName/creatorPositionName 标可选，契约按后端运行时恒出现（外部会议为 ""）。
export type MeetingVo = components['schemas']['MeetingVo'] & {
  /** 会议结束原因：normal 正常结束 / abnormal_exit 开会人退出超 5 分钟自动结束 */
  endReason?: string
  /** 是否设置了入会密码 */
  hasPassword?: boolean
}

export function endReasonLabel(reason?: string): string {
  if (reason === 'normal') return '正常结束'
  if (reason === 'empty_timeout') return '会议室空置超5分钟 · 自动结束'
  if (reason === 'abnormal_exit') return '异常退出 · 超时自动结束'
  return ''
}

export type RecordingStateVo = components['schemas']['RecordingStateVo']

// 这四个类型同时被 REST /state 与 WebSocket 帧消费。此前留手写是因为 WS 形状没进契约，
// 接上等于宣称一名覆盖两通道。**现在 WS 九类帧已进契约**（`Ws*` 那批 schema），
// 且取证确认：`participants`/`invited`/`streams`/`meeting` 四类帧的 payload 与 REST
// 是**同一个 Go 结构、同一个构造器**（`model/meeting_state.go` + `service/meeting_state.go:25-133`），
// 字段级零分叉 —— 分叉只在**包装形状**：WS 的 `participants` 帧多一层
// `{participants, invited}` 匿名对象、`streams` 帧根是裸数组，那些由 `Ws*` 类型单独表达。
export type ParticipantVo = components['schemas']['ParticipantVo']

// 受邀名单里的一条；joined=false 即原型成员面板的「等候入场」。userId 指向 sys_user.id。
export type InvitedVo = components['schemas']['InvitedVo']

export type StreamVo = components['schemas']['StreamVo']

// 会中态整包。〔WS 侧注意〕撤房补发的那一帧只填 meetingId 与三个空数组，
// 其余键是零值 —— 契约标它们全 required，所以**不许按"键在不在"判有没有数据**（见 `WsMeetingData`）。
export type MeetingStateVo = components['schemas']['MeetingStateVo'] & {
  title?: string
  activeStartedAt?: string
}

// 入会初始设备态（预约里设的"入会时静音/关摄像头"，会中只读）。
export type InitialMedia = components['schemas']['InitialMediaVo']

// 接线时暴露的分叉：旧手写版 waiting 标可选，契约按后端运行时 8 键恒出现（等待态 true、真入会 false，
// 判"到底进没进去"只看 waiting，不许按 participantId 空串判）。
export type JoinResult = components['schemas']['JoinData']

export type ScheduleReq = components['schemas']['ScheduleReq'] & {
  password?: string
}

export type MeetingListParams = components['schemas']['MeetingListParams']

export type RoiHintRequest = components['schemas']['RoiHintRequest']

// 人脸框上报只影响编码器取舍：失败不弹窗，也不该拖累已建立的发布。
export function postRoiHint(meetingId: number | string, publicationId: string, body: RoiHintRequest) {
  return post(`/api/v1/meetings/${meetingId}/publications/${publicationId}/roi-hint`, body, {
    timeout: 3000,
    silent: true,
  })
}

export function getMeetingList(params?: MeetingListParams) {
  return getPage<MeetingVo>('/api/v1/meetings/list', { params })
}

export function getTodayMeetings() {
  return get<MeetingVo[]>('/api/v1/meetings/today')
}

export function getMeetingStats() {
  return get<components['schemas']['MeetingStatsData']>('/api/v1/meetings/stats')
}

export function getMeetingDetail(id: number) {
  return get<MeetingVo>(`/api/v1/meetings/${id}`)
}

export function scheduleMeeting(data: ScheduleReq) {
  return post<MeetingVo>('/api/v1/meetings/schedule', data)
}

export function updateMeeting(id: number, data: ScheduleReq) {
  return put<MeetingVo>(`/api/v1/meetings/${id}`, data)
}

export function quickStartMeeting(data: {
  title: string
  durationMinutes?: number
  cloudRecord?: boolean
  launchKind?: 'quick' | 'share' | 'voice'
}) {
  return post<MeetingVo>('/api/v1/meetings/quick-start', data)
}

export function startMeeting(id: number) {
  return post(`/api/v1/meetings/${id}/start`)
}

export function stopMeeting(id: number) {
  return post(`/api/v1/meetings/${id}/stop`)
}

export function joinMeeting(data: { meetingNo: string; displayName?: string; password?: string; recordingConsent?: boolean }) {
  return post<JoinResult>('/api/v1/meetings/join', data)
}

export function muteAllParticipants(meetingId: number) {
  return post(`/api/v1/meetings/${meetingId}/mute-all`)
}

export function kickParticipant(meetingId: number, participantId: string) {
  return post(`/api/v1/meetings/${meetingId}/kick`, { participantId })
}

export function renameMeetingTitle(meetingId: number, title: string) {
  return post<{ applied: boolean; pending: boolean; requestId?: string; title: string }>(
    `/api/v1/meetings/${meetingId}/title`,
    { title },
  )
}

export function decideRenameTitle(meetingId: number, requestId: string, approve: boolean) {
  return post(`/api/v1/meetings/${meetingId}/title-requests/${encodeURIComponent(requestId)}`, { approve })
}

export function renameSelfInMeeting(meetingId: number, displayName: string, scope: 'session' | 'permanent') {
  return post<{ displayName: string; scope: 'session' | 'permanent' }>(
    `/api/v1/meetings/${meetingId}/display-name`,
    { displayName, scope },
  )
}

// 入会前预检（第 27 项）：前端在跳预检页之前先确认三方还能加入，
// 避免用户走完设备预览才发现"会议不存在"。契约硬规则：**只判 joinable，不许按 message 空串判分支**
// （可入会时 message 键整个缺失，不是空串）。
export function precheckMeeting(meetingNo: string) {
  return post<components['schemas']['PrecheckData'] & { requiresPassword?: boolean }>('/api/v1/meetings/precheck', { meetingNo })
}

// silent=true：离会是收尾清理调用，store 无论成败都会继续清本地会话态，失败不打扰用户。
export function leaveMeeting(meetingId: number, silent = false) {
  return post('/api/v1/meetings/leave', { meetingId }, { silent })
}

export function endMeeting(meetingId: number) {
  return post(`/api/v1/meetings/${meetingId}/end`)
}

export function cancelMeeting(id: number) {
  return post(`/api/v1/meetings/${id}/cancel`)
}

// 发布/停止走我方后端；三方 whipUrl 与参会令牌都留在服务端，前端只拿 publicationId 和代理路径。
export type PublicationCreateVo = components['schemas']['PublicationCreateData']

export interface PublicationCreateBody {
  mediaKind: 'camera' | 'screen' | 'audio'
  hasVideo: boolean
  hasAudio: boolean
  width: number
  height: number
  fps: number
  targetBitrateKbps: number
  encodingStrategy?: components['schemas']['VideoDelivery']['encodingStrategy']
  transportMode?: components['schemas']['VideoDelivery']['transportMode']
  mediaLabel: string
}

// 发布/停止走我方后端；三方 whipUrl 与参会令牌都留在服务端，前端只拿 publicationId 和代理路径。
export function setVideoDelivery(id: number, pubId: string, value: components['schemas']['VideoDelivery']) {
  return put<{ revision: number }>(`/api/v1/meetings/${id}/publications/${pubId}/settings`, value, { silent: true })
}

export function createPublication(meetingId: number, body: PublicationCreateBody) {
  return post<PublicationCreateVo>(`/api/v1/meetings/${meetingId}/publications`, body)
}

// silent=true：收尾清理（离会、换设备）里停发布是尽力而为，失败只进日志，不打扰用户。
export function stopPublication(meetingId: number, publicationId: string, silent = false) {
  return post(`/api/v1/meetings/${meetingId}/publications/${publicationId}/stop`, undefined, { silent })
}

export function getMeetingState(id: number, silent = false) {
  return get<MeetingStateVo>(`/api/v1/meetings/${id}/state`, silent ? { silent: true } : undefined)
}

export function focusStream(id: number, streamId: string, silent = false) {
  return post(`/api/v1/meetings/${id}/focus`, { streamId }, silent ? { silent: true } : undefined)
}

export function setRecording(id: number, action: 'start' | 'stop') {
  return post<components['schemas']['RecordingToggleData']>(`/api/v1/meetings/${id}/recording/${action}`)
}

export function issueWsTicket(meetingId: number) {
  return post<{ ticket: string; expiresInSeconds: number }>('/api/v1/meetings/ws-ticket', { meetingId })
}

// 媒体意图 REST 快速通道（对齐三方 heartbeat+media-state 双通道设计）：三方按意图位过滤
// 发布可见性，位没送达时手机端连画面都不渲染，所以不能只押 WS（未连上时消息静默丢）。
export function reportMediaState(id: number, state: { cameraOn: boolean; micOn: boolean; sharing: boolean }) {
  return post(`/api/v1/meetings/${id}/media-state`, state)
}

// 发布端实测码率的上报载荷。类型从生成物取，不手写第二份。
type TelemetryBody = operations['reportTelemetry']['requestBody']['content']['application/json']
export type TelemetryItem = NonNullable<TelemetryBody['items']>[number]

// REST 与 WebSocket 共用逐路浏览器样本。REST 在 WebSocket 重连时也能更新遥测。
// 中卫通公网会议的 compressionRatio 由媒体服务基于云端采样计算。
export function reportTelemetry(id: number, items: TelemetryItem[]) {
  return post(`/api/v1/meetings/${id}/telemetry`, { items })
}

// 媒体流地址带上短期 JWT：<video>/fetch 无法自定义请求头时的兜底（契约 §6.4）。
export function mediaUrl(endpoint: string | undefined): string {
  return assetUrl(endpoint)
}

export type StatsDimension = 'total' | 'month' | 'week' | 'custom'

export interface MeetingOverviewVolume {
  total: number
  hosted: number
  participated: number
  online: number
  offline: number
  hybrid: number
  scheduled?: number
  quick?: number
  voice?: number
  activeDays?: number
}

export interface MeetingOverviewDuration {
  totalSeconds: number
  hostedSeconds: number
  participatedSeconds: number
  averageSeconds: number
  recordingSeconds: number
}

export interface MeetingOverviewRecording {
  count: number
  coverageRate: number
}

export interface MeetingOverviewExtremeItem {
  id: number
  title: string
  hostName?: string
  meetingNo?: string
  startTime: string
  endTime: string
  durationSeconds: number
}

export interface MeetingOverviewExtremes {
  earliest: MeetingOverviewExtremeItem | null
  longest: MeetingOverviewExtremeItem | null
  latest: MeetingOverviewExtremeItem | null
}

export interface MeetingOverviewTagCount {
  key: string
  label: string
  count: number
}

export interface MeetingOverviewTags {
  accessModes: MeetingOverviewTagCount[]
  categories: MeetingOverviewTagCount[]
}

export interface MeetingOverviewDurationByKind {
  meeting: MeetingOverviewDuration
  voice: MeetingOverviewDuration
}

export interface MeetingOverviewStats {
  dimension: StatsDimension
  volume: MeetingOverviewVolume
  duration: MeetingOverviewDuration
  durationByKind?: MeetingOverviewDurationByKind
  recording: MeetingOverviewRecording
  extremes: MeetingOverviewExtremes
  tags: MeetingOverviewTags
}

export function getMeetingOverview(params: {
  dimension: StatsDimension
  startDate?: string
  endDate?: string
}) {
  return get<MeetingOverviewStats>('/api/v1/meetings/overview', { params, silent: true })
}

export interface InterviewCreateReq {
  title: string
  startTime: string
  durationMinutes: number
  candidates: string[]
  maxJoins: number
  expiresAt: string
  cloudRecord?: boolean
}

export interface InterviewAccountVo {
  candidateName: string
  username: string
  password: string
  maxJoins: number
  expiresAt: string
}

export interface InterviewCreateRes {
  meetingId: number
  meetingNo: string
  title: string
  startTime: string
  durationMinutes: number
  syncReason?: string
  accounts: InterviewAccountVo[]
}

export function createInterviewRoom(data: InterviewCreateReq) {
  return post<InterviewCreateRes>('/api/v1/meetings/interview', data)
}
