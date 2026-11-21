/**
 * 本地录制会话的模块级单例。
 *
 * 录制状态不绑在 InMeetingView 组件生命周期上——用户切到别的页面再回来，
 * 录制应该继续，不被 onBeforeUnmount 停掉。只有「离开会议」和「结束会议」
 * 才真正收尾录制。
 */
import { ref, type Ref } from 'vue'
import { ElMessage } from 'element-plus'
import { LaneAlreadyLiveError, TrackRecorderSession, type TrackSource, type SessionResult } from './trackRecorder'
import { MIN_FREE_BYTES_TO_RECORD, storageHeadroom } from './localRecorder'

export interface DesiredTrack {
  key: string
  src: TrackSource
}

export interface RecordingContext {
  userName: string
  meetingNo: string
  title: string
  /** 本机录制的画质档位与帧率上限（都只作用于本机这份文件，见 utils/recordingTier） */
  recordingQuality?: string
  recordingFps?: number
}

let session: TrackRecorderSession | null = null
let reconcileTimer: number | null = null
let stopping = false
const parkedKeys = new Set<string>()

const remoteAudioStreams = new Map<string, MediaStream>()

let desiredTracksFn: (() => DesiredTrack[]) | null = null
let contextFn: (() => RecordingContext) | null = null

export const isLocalRecording: Ref<boolean> = ref(false)
export const recTrackCount: Ref<number> = ref(0)

/**
 * 开一路的结果。`already_live` 是 `open()` 抛出来的类型化错误：同一个键上已经挂着一条编码器，
 * 再挂一条就是盘上那份坏件（两条编码器并写同一路，分片号回绕、字节互相覆盖）。
 * 这一条**绝不并进 `unavailable`**（"起不来"）—— 那是另一件事，用户听到的说法也不同。
 */
type OpenOutcome = 'opened' | 'unavailable' | 'already_live'

function openLane(s: TrackRecorderSession, key: string, src: TrackSource): OpenOutcome {
  try {
    return s.open(key, src) ? 'opened' : 'unavailable'
  } catch (e) {
    if (e instanceof LaneAlreadyLiveError) return 'already_live'
    throw e
  }
}

/** 把已经开起来的那几条收掉：这一场没开成，不许留下半启动的会话继续写库。 */
function abandon(s: TrackRecorderSession): void {
  session = null
  void s.finish().catch((e) => console.warn('[recordingSession] 半启动的会话收尾没成', e))
}

/**
 * 空间不够就开不了录 —— 这条问在建会话**之前**。
 * 等第一片写失败才说，用户已经对着"正在录制"走过了几分钟。
 * 量不出来（浏览器不给 estimate）时**放行**：不许因为量不到而拦人开会。
 */
export const quotaBlocked: Ref<boolean> = ref(false)

async function headroomOk(): Promise<boolean> {
  const head = await storageHeadroom()
  if (!head) return true
  return head.availableBytes >= MIN_FREE_BYTES_TO_RECORD
}

/** 录到一半写不进去：停录并把这件事说出来 —— 本模块平时让界面说话，但这条没有返回通道（它是异步爆出来的） */
function onQuotaExhausted(): void {
  quotaBlocked.value = true
  void stopLocalRecord()
  ElMessage.error('这台电脑的存储空间已用尽，本地录制已停止；已录下的部分仍在录制列表里')
}

export function registerRecordingProviders(opts: {
  desiredTracks: () => DesiredTrack[]
  context: () => RecordingContext
}) {
  desiredTracksFn = opts.desiredTracks
  contextFn = opts.context
  syncRecordingUI()
}

export function unregisterRecordingProviders() {
  desiredTracksFn = null
  contextFn = null
}

function syncRecordingUI() {
  isLocalRecording.value = session !== null
  recTrackCount.value = session?.tracksSnapshot().length ?? 0
}

export function setRemoteAudioStream(id: string, stream: MediaStream) {
  remoteAudioStreams.set(id, stream)
}

export function removeRemoteAudioStream(id: string) {
  remoteAudioStreams.delete(id)
}

export function cleanupDeadAudioStreams(aliveIds: Set<string>) {
  for (const id of [...remoteAudioStreams.keys()]) {
    if (!aliveIds.has(id)) remoteAudioStreams.delete(id)
  }
}

export function getRemoteAudioStream(id: string): MediaStream | undefined {
  return remoteAudioStreams.get(id)
}

export async function startLocalRecord(): Promise<{ ok: boolean; msg?: string }> {
  if (isLocalRecording.value) return { ok: false }
  if (typeof MediaRecorder === 'undefined') {
    return { ok: false, msg: 'describeRecorderError:NotSupportedError' }
  }
  if (!desiredTracksFn || !contextFn) {
    return { ok: false, msg: 'no_provider' }
  }

  const wanted = desiredTracksFn().filter((d) => !parkedKeys.has(d.key))
  if (!wanted.length) {
    return { ok: false, msg: 'no_tracks' }
  }

  if (!(await headroomOk())) {
    quotaBlocked.value = true
    return { ok: false, msg: 'no_space' }
  }
  quotaBlocked.value = false
  const ctx = contextFn()
  const s = new TrackRecorderSession({
    t0: Date.now(),
    userName: ctx.userName,
    meetingNo: ctx.meetingNo,
    title: ctx.title,
    recordingQuality: ctx.recordingQuality,
    recordingFps: ctx.recordingFps,
    onQuotaExhausted,
  })
  session = s
  let alreadyLive = false
  for (const d of wanted) {
    const r = openLane(s, d.key, d.src)
    if (r === 'unavailable') parkedKeys.add(d.key)
    else if (r === 'already_live') alreadyLive = true
  }
  if (alreadyLive) {
    // 同一个键上已经挂着一条编码器：这一场不能开始（少一路的清单会被当成完整的）。
    // 已经开起来的那几条就地收掉 —— 留下半启动的会话继续写库，比不录更糟。
    abandon(s)
    return { ok: false, msg: 'lane_busy' }
  }
  if (!s.liveKeys().length) {
    abandon(s)
    return { ok: false, msg: 'open_failed' }
  }

  isLocalRecording.value = true
  recTrackCount.value = s.tracksSnapshot().length
  startReconcileTimer()
  return { ok: true }
}

export async function stopLocalRecord(): Promise<SessionResult | null> {
  const s = session
  if (!s || stopping) return null
  stopping = true
  stopReconcileTimer()
  isLocalRecording.value = false
  recTrackCount.value = 0
  parkedKeys.clear()
  session = null
  let result: SessionResult | null = null
  try {
    result = await s.finish()
  } catch (e) {
    throw e
  } finally {
    stopping = false
  }
  return result
}

export async function toggleLocalRecord(): Promise<'started' | 'stopped' | 'no_tracks' | 'not_supported' | 'open_failed' | 'lane_busy' | 'no_space'> {
  if (isLocalRecording.value) {
    await stopLocalRecord()
    return 'stopped'
  }
  if (typeof MediaRecorder === 'undefined') return 'not_supported'
  if (!desiredTracksFn || !contextFn) return 'no_tracks'

  const wanted = desiredTracksFn().filter((d) => !parkedKeys.has(d.key))
  if (!wanted.length) return 'no_tracks'

  if (!(await headroomOk())) {
    quotaBlocked.value = true
    return 'no_space'
  }
  quotaBlocked.value = false
  const ctx = contextFn()
  const s = new TrackRecorderSession({
    t0: Date.now(),
    userName: ctx.userName,
    meetingNo: ctx.meetingNo,
    title: ctx.title,
    recordingQuality: ctx.recordingQuality,
    recordingFps: ctx.recordingFps,
    onQuotaExhausted,
  })
  session = s
  let alreadyLive = false
  for (const d of wanted) {
    const r = openLane(s, d.key, d.src)
    if (r === 'unavailable') parkedKeys.add(d.key)
    else if (r === 'already_live') alreadyLive = true
  }
  if (alreadyLive) {
    abandon(s)
    return 'lane_busy'
  }
  if (!s.liveKeys().length) {
    abandon(s)
    return 'open_failed'
  }

  isLocalRecording.value = true
  recTrackCount.value = s.tracksSnapshot().length
  startReconcileTimer()
  return 'started'
}

function startReconcileTimer() {
  stopReconcileTimer()
  reconcileTimer = window.setInterval(reconcile, 2000)
}

function stopReconcileTimer() {
  if (reconcileTimer !== null) {
    window.clearInterval(reconcileTimer)
    reconcileTimer = null
  }
}

function reconcile() {
  const s = session
  if (!s || !desiredTracksFn) return
  const wanted = new Map(desiredTracksFn().map((d) => [d.key, d.src]))
  for (const key of s.liveKeys()) {
    if (!wanted.has(key)) s.close(key, 'track_disabled')
  }
  for (const [key, src] of wanted) {
    // 键带源形态（登记侧见会中页 desiredTracks）：换了源形态就是另一个键，所以同键命中只可能是"这一路还在录"。
    if (s.liveKeys().includes(key) || parkedKeys.has(key)) continue
    const r = openLane(s, key, src)
    if (r === 'unavailable') parkedKeys.add(key)
    else if (r === 'already_live')
      // 上面刚查过"这一键不在录"，这里还能撞上就是本模块自己的记账坏了。
      // 不许 park（park = 这一路从此再不录，把内部矛盾变成用户的数据损失），只把矛盾打到控制台。
      console.error('[recordingSession] 同一键上已经有一条在录的路，跳过开录', key)
  }
  recTrackCount.value = s.tracksSnapshot().length
}

export function isRecordingActive(): boolean {
  return session !== null
}
