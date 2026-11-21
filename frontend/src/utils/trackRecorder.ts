// 原始轨道分片录制（第 15 项）。
//
// 与旧的"一条混合流"的区别是根本性的：
//   旧：canvas 合成舞台 + WebAudio 混一条轨 → 一条 MediaRecorder → 停止时拼成单个 Blob。
//       整场只有一份像素，谁被静音、谁后来入会都不在文件里，崩了全丢。
//   新：每路媒体（每个参会者的摄像头/屏幕/麦克风，以及本端自己的一条）单独一个 MediaRecorder，
//       每 2 秒出一个片，**片一到手就写进本机存储**，清单里逐路记录 ownerId/kind/startOffsetSec 与 segments。
//
// 时间轴只有一个真源：会话开始的 epoch 毫秒 t0，所有 offset 都相对它 ——
// 与三方回放清单的 `timeline.startAt` + 每路 `offsetSeconds/durationSeconds` 同构，
// 所以本地条目和云端条目可以用同一套对齐算法（见 replayEngine.ts）。
//
// offset/duration 一律来自**实测的墙钟到达时刻**，不是"timeslice 应该是 2 秒"的推算值：
// 标签页被冻结、编码器排队都会让片与片之间实际错位，界面上要看得见。
import {
  addLocalRecording,
  containerOf,
  downloadBlob,
  ensureRecordingDirAccess,
  getSegmentBlob,
  getTrackBlob,
  isQuotaError,
  makeLocalRecordingId,
  putSegmentWithRecord,
  putSession,
  recordingRelParts,
  sanitizePathPart,
  SESSION_HEARTBEAT_MIN_MS,
  writeRecordingAt,
  type LocalRecording,
  type RecordedTrack,
  type RecordedTrackKind,
  type RecordingSession,
  type SegmentRecord,
  type TrackCloseReason,
  type TrackSegment,
} from '@/utils/localRecorder'
import { finalizeWebmDuration } from '@/utils/webmDuration'
import { ensureAudioBus, hookMediaToBus } from '@/utils/audioBus'
import { laneAnomalies, laneIsDamaged } from '@/utils/offlineCompose/segmentSource'
import { loginAccount } from '@/utils/recordingAccount'
import { canvasFpsFor, recordingTier } from '@/utils/recordingTier'

/**
 * 同一路键上已经挂着一条在录的编码器。
 *
 * 这是盘上那份坏件唯一的入口：两条编码器往同一路写，分片号会回绕、`blobKey` 会撞，
 * 拼出来的文件带两个容器头 —— 解不出时长也解不出帧（实测 `computeDuration()` 回 0）。
 * 所以这里**必须响亮地失败**让调用方处置，绝不静默返回 null（静默 = 第二个写者照样在跑）。
 */
export class LaneAlreadyLiveError extends Error {
  readonly laneKey: string
  constructor(laneKey: string) {
    super(`lane_already_live:${laneKey}`)
    this.name = 'LaneAlreadyLiveError'
    this.laneKey = laneKey
  }
}

/** 每 2 秒一片：一片丢了只丢 2 秒，不是整场。 */
export const SEGMENT_TIMESLICE_MS = 2000

/**
 * 目录层里那一段"用户名"取**登录账号**（第 37 项）：姓名会重名、带空格、带 `/` 等非法字符，
 * 账号才是稳定可寻址的那一个。取不到（未登录/存储还没水合）时由调用方回退到显示名。
 *
 * 实现已收进 `utils/recordingAccount.loginAccount()` —— 这里只是旧名字的出口，
 * 不要再往回复制一份（`localRecorder` 那份就是这么漂出来的）。
 */
export const loginAccountForDir = loginAccount

export interface TrackVideoSource {
  /** 直接可录的原始视频轨：本端摄像头、本端屏幕共享 */
  track?: MediaStreamTrack | null
  /**
   * 需要按帧取回画面的来源：远端那一路。
   * 远端视频是播放器解到**这一路自己的 canvas** 上的，浏览器不给这条流一个 MediaStream，
   * 所以只能从画布重取一次像素 —— 这是一路一路单独取，不是把多方混进同一张画布。
   */
  canvas?: (() => HTMLCanvasElement | null) | null
  /** 取帧速率：默认跟这一路实测的推流帧率对齐，取不到就 15 */
  fps?: number
}

export interface TrackSource {
  ownerId: string
  ownerName: string
  kind: RecordedTrackKind
  /** 通路说明，来自真实轨道 label 或本路的发布类型，不写就空着 */
  mediaLabel: string
  video?: TrackVideoSource
  audioTracks?: MediaStreamTrack[]
}

export interface SessionOptions {
  /** 会话起点；不传就用此刻。同一场录制里所有路共用它 */
  t0?: number
  /** 落盘层级用的登录用户显示名（第 14 项） */
  userName: string
  meetingNo: string
  title: string
  /**
   * 本机录制的画质档位（`recordingTier` 的唯一映射决定它改什么）。
   * 不传 = 按 medium，绝不等于"不设上限" —— 后者就是"体积由 Chromium 心情决定"那个老状态。
   */
  recordingQuality?: string
  /** 本机录制每秒画几帧（与采集无关；源不足时不补帧）*/
  recordingFps?: number
  /**
   * 配额耗尽时回调一次（口径 契约 ADR-0069 ⑤：不许静默丢片）。
   * 写不进去不是"这一片丢了"—— 后面每一片都会失败，调用方要**停录**并说出来，
   * 否则用户以为整场都录上了，实际只有一半。
   */
  onQuotaExhausted?: () => void
}

export interface TrackArtifact {
  track: RecordedTrack
  blob: Blob
}

export interface SessionResult {
  recordingId: string
  dirPath: string | null
  /** 真的写进授权目录了没有；false 时产物只在浏览器里，界面要这么说 */
  dirWritten: boolean
  tracks: RecordedTrack[]
  totalBytes: number
  durationSec: number
  partial: boolean
}

function pickVideoMime(withAudio: boolean): string {
  const vp9 = withAudio ? 'video/webm;codecs=vp9,opus' : 'video/webm;codecs=vp9'
  const vp8 = withAudio ? 'video/webm;codecs=vp8,opus' : 'video/webm;codecs=vp8'
  return [vp9, vp8, 'video/webm'].find((c) => MediaRecorder.isTypeSupported(c)) || ''
}

function pickAudioMime(): string {
  return ['audio/webm;codecs=opus', 'audio/webm'].find((c) => MediaRecorder.isTypeSupported(c)) || ''
}

/** captureStream(0) 的画布要先有内容才出得了第一帧：播一帧黑，尺寸随后按真实来源改。 */
function ctxSeed(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#0b1220'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
}

interface LiveTrack {
  key: string
  desc: RecordedTrack
  rec: MediaRecorder
  /** 上一片落定的时刻（相对 t0 的毫秒）；本片 offset 从它起算 */
  cursorMs: number
  seq: number
  painted: number
  hasVideo: boolean
  canvasSource: (() => HTMLCanvasElement | null) | null
  canvasFps: number
  lastFrameAtMs: number
  recorderCanvas: HTMLCanvasElement | null
  captureTrack: MediaStreamTrack | null
  closing: boolean
  /** 清单终态已经定过（`finalizeClosed` 跑过了）：此后再来的分片一律不收 */
  descFinalized: boolean
  writes: Promise<void>
  /** 清单终态（末片 offset/duration 与关闭原因）在编码器 onstop 之后才成立，收尾要等它 */
  finalized: Promise<void>
  settle: () => void
}

export class TrackRecorderSession {
  readonly t0: number
  private readonly opts: SessionOptions
  private readonly byKey = new Map<string, LiveTrack>()
  /**
   * 会话头：构造那一刻就写进 `sessions`，每片刷新心跳，`finish()` 成功才置 `open=false`。
   * 它是"这场录制存在过"唯一能在崩溃之后查到的证据（重建那条路见 `recordingRecovery.ts`）。
   */
  private readonly session: RecordingSession
  /** 上一次把心跳写进库的时刻（毫秒），用于 `SESSION_HEARTBEAT_MIN_MS` 那个节流 */
  private lastBeatAt = 0
  /** 已经关过的路（清单里的终态），值供最后汇总 */
  private readonly closed: RecordedTrack[] = []
  /** 关过的路的收尾句柄：末片入库 + onstop 都算完才敢拼原文件 */
  private readonly finalizing: LiveTrack[] = []
  /**
   * 本场里开过的路的序号。**blobKey 与落盘文件名都带它**：
   * 同一个人退了再入会在同一毫秒重开时，`Date.now().toString(36)` 会撞，
   * 撞了就是两条路的分片写进同一个键空间、两个路名写进同一个文件 —— 后者会静默覆盖前者。
   */
  private laneToken = 0
  /** 配额耗尽只播报一次：每条路都失败一次的话，提示会刷成一片噪音 */
  private quotaReported = false
  private raf = 0
  private finished = false

  constructor(opts: SessionOptions) {
    this.opts = opts
    this.t0 = opts.t0 && opts.t0 > 0 ? opts.t0 : Date.now()
    this.lastBeatAt = Date.now()
    this.session = {
      // 这个 id 就是将来那条录制条目的 id：自愈重建用它、删除时按它连带清会话头，两处必须同值
      id: makeLocalRecordingId(this.t0),
      t0: this.t0,
      meetingNo: opts.meetingNo,
      title: opts.title,
      open: true,
      heartbeatAt: this.lastBeatAt,
      tracks: {},
      // 归属只能在这一刻记：会话头是这场录制**唯一**在"谁按了开始"当场写下的东西，
      // 事后从清单或目录反推都拿不到这份证据（没落盘的场次连目录都没有）
      recorderAccount: loginAccount(),
    }
    this.persistSession()
    this.startBeating()
    this.loop()
  }

  /**
   * 会话头落库（先拷贝再写：调用之后 tracks 还会继续变）。所有写入串成一条链 ——
   * 并行落库时"最后一次写"不由调用顺序决定，在途的那次晚到会翻掉收尾的 `open=false`。
   * 写失败只进控制台：库里连元数据都落不下去时，同一次失败的分片也不存在，自愈不会因此"以为有"。
   */
  private sessionWrites: Promise<void> = Promise.resolve()
  private persistSession(): Promise<void> {
    const snapshot = { ...this.session, tracks: { ...this.session.tracks } }
    this.sessionWrites = this.sessionWrites.then(() => putSession(snapshot)).catch((e) => {
      console.warn('[trackRecorder] 会话头写入失败', e)
    })
    return this.sessionWrites
  }

  /** 落一片之后调：按 `SESSION_HEARTBEAT_MIN_MS` 节流刷新心跳，别每片都重写会话头。 */
  private beat(): void {
    const now = Date.now()
    if (now - this.lastBeatAt < SESSION_HEARTBEAT_MIN_MS) return
    this.lastBeatAt = now
    this.session.heartbeatAt = now
    this.persistSession()
  }

  /**
   * 心跳**不能只挂在分片上**：画面靠 `captureStream(0)` 手动出帧，页面一进后台就一帧不发、
   * 也就一片都不落库，会话头会跟着变陈旧 —— 那时另一个标签页启动自愈就会把**还在录的这场**
   * 重建成一条重复条目。所以另开一条定时器自己跳：定时器在后台标签页只是被压到 ~1 次/秒，
   * 对 5 秒一次的心跳足够。
   */
  private beatTimer = 0
  private startBeating(): void {
    if (this.beatTimer || typeof window === 'undefined') return
    this.beatTimer = window.setInterval(() => {
      if (this.finished) return this.stopBeating()
      this.beat()
    }, SESSION_HEARTBEAT_MIN_MS)
  }

  private stopBeating(): void {
    if (!this.beatTimer) return
    window.clearInterval(this.beatTimer)
    this.beatTimer = 0
  }

  /**
   * 把这一路的**清单头**（不含 segments）挂到会话上。开一路与一路收尾各写一次，次数极少，不节流。
   * 自愈只认这份白名单，所以中途入会/退会的新路必须在这儿被登记到，不能被猜出来。
   */
  private noteTrack(desc: RecordedTrack): void {
    const { segments: _segments, ...head } = desc
    this.session.tracks[desc.recordingId] = head
    this.persistSession()
  }

  nowOffsetSec(): number {
    return Math.max(0, (Date.now() - this.t0) / 1000)
  }

  /**
   * 这场录制登记进清单时用的 id（开录那一刻就定了）。收尾前也要能读到它：
   * 崩溃模拟、以及任何"还没 finish 就要对账"的调用方都靠这一个出口，不许在外面再拼一次 id。
   */
  get recordingId(): string {
    return this.session.id
  }

  liveKeys(): string[] {
    return [...this.byKey.keys()]
  }

  /** 当前所有路（在录的 + 已留缺口的），按开始时刻排；界面直接读它显示缺口。 */
  tracksSnapshot(): RecordedTrack[] {
    const live = [...this.byKey.values()].map((t) => ({ ...t.desc, segments: t.desc.segments.slice() }))
    return [...this.closed, ...live].sort((a, b) => a.startOffsetSec - b.startOffsetSec)
  }

  open(key: string, src: TrackSource): RecordedTrack | null {
    // 已在录的键**不许再挂一条编码器**：静默返回 null 会让调用方以为"没开起来"，
    // 而旧的那条还在往同一个 blobKey 空间里写 —— 那正是盘上坏件的形状。
    if (this.byKey.has(key)) throw new LaneAlreadyLiveError(key)
    if (this.finished) return null
    const live = this.buildLive(key, src)
    if (!live) return null
    this.byKey.set(key, live)
    // 开一路就把它登记进会话头：自愈只认这份白名单，漏记的路崩溃后重建不出来
    this.noteTrack(live.desc)
    return live.desc
  }

  close(key: string, reason: TrackCloseReason): void {
    const t = this.byKey.get(key)
    if (!t) return
    this.byKey.delete(key)
    this.shutdown(t, reason)
  }

  private buildLive(key: string, src: TrackSource): LiveTrack | null {
    if (typeof MediaRecorder === 'undefined') return null
    const videoTrack = src.video?.track && src.video.track.readyState === 'live' ? src.video.track : null
    const canvasSource = src.video?.canvas ?? null
    const audio = liveTracksFrom(src.audioTracks)
    const hasVideo = !!videoTrack || !!canvasSource
    const hasAudio = audio.length > 0
    if (!hasVideo && !hasAudio) return null

    let recorderCanvas: HTMLCanvasElement | null = null
    let captureTrack: MediaStreamTrack | null = null
    const tracks: MediaStreamTrack[] = []
    if (canvasSource && !videoTrack) {
      // 画布重取这一路的像素。captureStream(0) = **手动出帧**：只有真的画到东西才 requestFrame()，
      // 这一格没被渲染出来的那段时间编码器就收不到帧，清单里自然是一段没有片的缺口 ——
      // 比按固定帧率取（会一直重复最后一帧、把断流录成"画面卡住但在录"）诚实。
      const canvas = document.createElement('canvas')
      canvas.width = 64
      canvas.height = 64
      ctxSeed(canvas)
      const cs = canvas.captureStream(0)
      captureTrack = cs.getVideoTracks()[0] || null
      if (captureTrack) tracks.push(captureTrack)
      recorderCanvas = canvas
    } else if (videoTrack) {
      tracks.push(videoTrack)
    }
    tracks.push(...audio)
    if (!tracks.length) return null

    const stream = new MediaStream(tracks)
    // 视频路优先 vp9+opus（有音轨时）；纯音轨走 audio/webm;codecs=opus。
    // `videoBitsPerSecond` 由 `recordingTier` 一处决定：此前刻意不传，理由是"档位承诺的是分辨率、
    // 重编码只能压码率"—— 那是对的（钉码率却宣称分辨率变了就是假档位）。现在档位已改成
    // **只承诺码率与体积**（`utils/recordingTier.ts`），所以这一句可以传了；不传就等于没有上限。
    const tier = recordingTier(this.opts.recordingQuality)
    const mime = hasVideo ? pickVideoMime(hasAudio) : pickAudioMime()
    let rec: MediaRecorder
    try {
      rec = new MediaRecorder(
        stream,
        { ...(mime ? { mimeType: mime } : {}), ...(hasVideo ? { videoBitsPerSecond: tier.videoBitsPerSecond } : {}) },
      )
    } catch (e) {
      console.warn('[trackRecorder] 该路编码器起不来', key, e)
      captureTrack?.stop()
      return null
    }

    const ext = (mime || (hasVideo ? 'video/webm' : 'audio/webm')).includes('mp4') ? 'mp4' : 'webm'
    // 一路一个 recordingId：同一个人再入会走 open() 一次新的，就是**新的一条路**（第 17 项）。
    // 尾巴带本场路号：只用毫秒时间戳时，同一毫秒重开的两条路会撞键（blobKey 同名 = 互相覆盖，
    // 落盘同名 = 后一份盖掉前一份），坏件就是这么静默出来的。
    const laneStamp = `${Date.now().toString(36)}-${(this.laneToken++).toString(36)}`
    const desc: RecordedTrack = {
      recordingId: `${sanitizePathPart(key, 'track')}-${laneStamp}`,
      ownerId: src.ownerId,
      ownerName: src.ownerName,
      kind: src.kind,
      mediaLabel: src.mediaLabel,
      hasVideo,
      hasAudio,
      startOffsetSec: round3(this.nowOffsetSec()),
      endOffsetSec: null,
      closedAtMs: null,
      closeReason: '',
      mime: mime || (hasVideo ? 'video/webm' : 'audio/webm'),
      fileName: trackFileName(src.ownerName, src.kind, ext, laneStamp),
      // 解码参数（D9）：只写**真取到的**那部分。画布那一路此刻还是 64×64 的种子尺寸，
      // 真实像素要等第一次把源画上去再回填（见 loop 里那条），所以这里不给它写 width/height。
      ...(videoTrack ? videoSettingsOf(videoTrack) : {}),
      ...(hasVideo && canvasSource ? { frameRate: canvasFpsFor(this.opts.recordingFps, src.video?.fps) } : {}),
      ...(audio.length ? audioSettingsOf(audio[0]) : {}),
      segments: [],
    }

    const live: LiveTrack = {
      key,
      desc,
      rec,
      cursorMs: Math.round(this.nowOffsetSec() * 1000),
      seq: 0,
      painted: 0,
      hasVideo,
      canvasSource,
      canvasFps: canvasFpsFor(this.opts.recordingFps, src.video?.fps),
      lastFrameAtMs: 0,
      recorderCanvas,
      captureTrack,
      closing: false,
      descFinalized: false,
      writes: Promise.resolve(),
      finalized: Promise.resolve(),
      settle: () => {},
    }

    rec.ondataavailable = (e) => this.onChunk(live, e.data)
    rec.onerror = () => this.close(key, 'recorder_error')
    rec.onstop = () => this.finalizeClosed(live)
    live.finalized = new Promise<void>((resolve) => {
      live.settle = resolve
    })
    // 原始轨被对端关掉（离会/停推/设备拔出）时浏览器抛 ended：这一路录到这儿为止，留缺口。
    for (const t of [...tracks]) {
      t.addEventListener('ended', () => this.close(key, 'publisher_left'))
      t.addEventListener('mute', () => {
        // 视频轨被浏览器判 mute = 上游不再送帧，继续挂着只是让清单谎报"这一路还在录"。
        // 画布来源的那一路本来就靠这一格被渲染才有帧，交给 firstFrameTimer 与对账判定。
        if (t.kind === 'video' && !live.canvasSource) this.close(key, 'track_disabled')
      })
    }
    // 画面路没有"永远黑着就自己关掉"的定时器：要不要开这一路，由调用方在**这一格真的被
    // 渲染出来时**才 open()（见会中页的对账）。开不了的那段时间在清单里就是缺口，
    // 而不是挂着一条从来没见过像素的假录制。

    try {
      rec.start(SEGMENT_TIMESLICE_MS)
    } catch (e) {
      console.warn('[trackRecorder] 该路启动失败', key, e)
      captureTrack?.stop()
      return null
    }
    return live
  }

  /** 一片到手立刻入库：等整场结束再写的话，崩了就什么都不剩。 */
  private onChunk(live: LiveTrack, data: Blob) {
    // 清单终态已定的那一路不许再收片：编码器在被判定关闭之后又回调一次（异常收尾、重启那条路），
    // 收下就是往一份已定稿的清单里追加片 —— 两个写者共写一路的形态正是这样攒出来的。
    if (live.descFinalized) {
      console.error('[trackRecorder] 该路清单已定稿却还在出片，这一片丢弃', live.desc.recordingId, data.size)
      return
    }
    const nowMs = Math.round(this.nowOffsetSec() * 1000)
    if (!data.size) {
      // 编码器这一片没吐出任何字节（画面被冻结/这一路只有静音轨）。
      // 推进游标 = 这一段在清单里就是**没有片的缺口**，不写一条 0 字节的假片。
      live.cursorMs = nowMs
      return
    }
    const offsetMs = live.cursorMs
    const durationMs = Math.max(0, nowMs - offsetMs)
    live.cursorMs = nowMs
    const seq = live.seq++
    const blobKey = `${live.desc.recordingId}#${seq}`
    const segment: TrackSegment = {
      seq,
      offsetSec: round3(offsetMs / 1000),
      durationSec: round3(durationMs / 1000),
      sizeBytes: data.size,
      blobKey,
      mime: data.type || live.desc.mime,
    }
    live.desc.segments.push(segment)
    const rec: SegmentRecord = {
      blobKey,
      trackId: live.desc.recordingId,
      seq,
      offsetSec: segment.offsetSec,
      durationSec: segment.durationSec,
      sizeBytes: segment.sizeBytes,
      mime: segment.mime,
    }
    // 字节与清单记录同一事务落库（`putSegmentWithRecord`）：分开写会造出"有记录没字节"的坏清单，
    // 自愈按它重建出来的那一路就会永久卡在「正在加载此路」。
    live.writes = live.writes
      .then(() => putSegmentWithRecord(rec, data))
      .then(() => this.beat())
      .catch((e) => {
        // 写失败的那片从清单里摘掉：清单里有片而库里没有，回放就会停在"正在加载此路…"出不来。
        console.warn('[trackRecorder] 分片入库失败，已摘除该片', blobKey, e)
        const i = live.desc.segments.findIndex((s) => s.blobKey === blobKey)
        if (i >= 0) live.desc.segments.splice(i, 1)
        // 配额耗尽要单独走一条道：它不是一片的问题，是这一场从此写不进去
        if (isQuotaError(e) && !this.quotaReported) {
          this.quotaReported = true
          console.error('[trackRecorder] 这台电脑的存储空间已用尽，后续分片都会失败')
          try {
            this.opts.onQuotaExhausted?.()
          } catch (err) {
            console.warn('[trackRecorder] 配额耗尽的回调没走成', err)
          }
        }
      })
  }

  private shutdown(live: LiveTrack, reason: TrackCloseReason) {
    if (live.closing) return
    live.closing = true
    live.desc.closeReason = reason
    this.finalizing.push(live)
    // 编码器已经定稿并从这一路上摘掉（浏览器自己停掉那条编码器时 onstop 就定稿了）：
    // 这里只补关闭原因，不再 stop、也不再定第二次。
    if (!live.rec) {
      live.captureTrack?.stop()
      // 关闭原因是后来才补上的（浏览器自己停掉时定稿在前）：会话头跟着改一次，
      // 否则崩溃自愈重建出来的那一路只能看到空原因
      this.noteTrack(live.desc)
      return
    }
    try {
      // 编码器已经在异常态（stop() 会再抛一次）：终态直接按清单里已有的最后一片定，
      // 而不是拿"此刻"冒充录到了这一刻。
      if (live.rec.state !== 'inactive') live.rec.stop()
      else this.finalizeClosed(live)
    } catch (e) {
      console.warn('[trackRecorder] 停止该路时编码器报错', live.desc.recordingId, e)
      this.finalizeClosed(live)
    }
    live.captureTrack?.stop()
  }

  /**
   * 一路的清单终态。末片是 stop() 里才吐出来的，它排在这一路的写入队尾，
   * 所以终值必须等 writes 全部落库之后再定 —— 早一步就会拼出缺尾的文件。
   */
  private finalizeClosed(live: LiveTrack) {
    // 幂等，而且**同步置位**：`shutdown()` 在编码器已是 inactive 时直接定稿，而浏览器自己把这条
    // 编码器停掉时 onstop 也已经定过一次 —— 不幂等就会把**同一个 desc 推进 `closed` 两次**。
    // 盘上那份坏件（`hxt/chenfang/20260930185052`，两路各 60/59 片、前 10 片是逐对同字节的副本）
    // 就是这么来的：一条路的清单在同一场里被登记了两遍，拼出来的文件带三个容器头，解不出时长也解不出帧。
    if (live.descFinalized) return
    live.descFinalized = true
    const stale = live.rec
    live.rec = null as unknown as MediaRecorder
    try {
      // 摘掉回调：定稿之后这条编码器不许再往这一路的清单里写任何东西
      stale.ondataavailable = null
      stale.onerror = null
      stale.onstop = null
    } catch { /* 回调不可写时忽略：置位与摘引用已经拦住了写入 */ }
    void live.writes.then(() => {
      const last = live.desc.segments.at(-1)
      live.desc.endOffsetSec = last ? round3(last.offsetSec + last.durationSec) : live.desc.startOffsetSec
      live.desc.closedAtMs = Date.now()
      this.closed.push(live.desc)
      // 把终态同步进会话头：这一路之后整场崩溃时，自愈重建出的它就是"已关"而不是谎报"还在录"
      this.noteTrack(live.desc)
      live.settle()
    })
  }

  /** 一路一路地重绘：只画这一路自己的像素，别人关了摄像头不影响这一格。 */
  private loop = () => {
    if (this.finished) return
    for (const live of this.byKey.values()) {
      const canvas = live.recorderCanvas
      const getSource = live.canvasSource
      if (!canvas || !getSource) continue
      const src = getSource()
      if (!src || !src.width || !src.height) continue
      if (canvas.width !== src.width || canvas.height !== src.height) {
        canvas.width = src.width
        canvas.height = src.height
      }
      // 画布那一路的真实像素在这里才成立（建 recorder 时还是 64×64 的种子），
      // 所以解码参数在**第一次画上真尺寸**时回填一次；尺寸中途变了就再回填一次。
      if (live.desc.width !== canvas.width || live.desc.height !== canvas.height) {
        live.desc.width = canvas.width
        live.desc.height = canvas.height
        this.noteTrack(live.desc)
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) continue
      try {
        ctx.drawImage(src, 0, 0, canvas.width, canvas.height)
        live.painted++
        // 手动出帧：这一路每 canvasFps 帧给一帧，其余 rAF 只攒着不推 —— 
        // 不推的时候编码器就收不到这一路的画面，缺的就是缺的。
        const now = Date.now()
        if (now - live.lastFrameAtMs >= 1000 / live.canvasFps) {
          live.lastFrameAtMs = now
          ;(live.captureTrack as CanvasCaptureMediaStreamTrack | undefined)?.requestFrame?.()
        }
      } catch (e) {
        console.warn('[trackRecorder] 该路画面取不到帧', live.desc.recordingId, e)
      }
    }
    this.raf = requestAnimationFrame(this.loop)
  }

  /**
   * 结束会话：停掉所有在录的路 → **先登记清单**（列表可见性只由分片决定）→
   * 按分片拼出每一路的原文件 → 按 hxt 层级并行落盘 → 回填"写到了哪一层"。
   * 拼不出来的路（一片都没有）不进产物，也不在清单里冒充一条录制。
   */
  async finish(): Promise<SessionResult | null> {
    this.finished = true
    // 心跳要先停：停之前它是"这场还在录"的唯一证据，停了还不置 open=false 就会被自愈误当成崩溃场次重建
    this.stopBeating()
    cancelAnimationFrame(this.raf)
    for (const [key, live] of [...this.byKey.entries()]) {
      this.byKey.delete(key)
      this.shutdown(live, 'session_end')
    }
    // 编码器一停就去把目录权限要到手：调用方是"停止录制/离开会议"那次点击，浏览器只认这次手势
    // （第 36 项）。它必须排在下面等 onstop 之前 —— 用户手势只活几秒，等完就没了。
    // D2：这里原先是裸 await，一次权限异常就会把整场带走（连清单都不登记）。
    try {
      await ensureRecordingDirAccess()
    } catch (e) {
      console.warn('[trackRecorder] 目录授权这一步没走成，落盘按"未写入"处理', e)
    }
    // 每一路的终态要等它的编码器 onstop + 末片落库（finalized），少等一步就会拼出缺尾的文件
    await Promise.all(this.finalizing.map((l) => l.finalized))
    // 会话头的在途写入也要排干：它们排在 `open=false` 之前，晚到就会把终态翻回"还在录"
    await this.sessionWrites
    // 一路一份原片，**绝不把两条路的分片并成一条**（这里以前叫"去重"）：
    // 同一个人退了再入会是两条路各有自己的容器头，把两段的片拼进一个文件就得到带多个容器头的坏件
    // —— 实测那种文件 `computeDuration()` 回 0、一帧都解不出来。"一个人一路"是**视图侧**的归组
    // （`replayEngine.groupTracksByLane`），列表卡上的分路明细也按那个口径数，不在存储侧并。
    const withSegments = closedLanes(this.closed)
    if (!withSegments.length) {
      // 一片都没有 = 没有可恢复的东西，把会话头关掉，别留给自愈一条空场次
      this.session.open = false
      await this.persistSession()
      return null
    }

    const parts = recordingDirParts(this.t0, loginAccountForDir() || this.opts.userName, this.opts.meetingNo)
    const dirPath = parts.join('/')
    const stamp = dirStampOf(this.t0)
    const maxEnd = Math.max(...withSegments.flatMap((t) => t.segments.map((s) => s.offsetSec + s.durationSec)))
    const minStart = Math.min(...withSegments.map((t) => t.startOffsetSec))
    const spanSec = round3(maxEnd - minStart)
    const partial = isPartialSession(withSegments)
    const totalBytes = withSegments.reduce((a, t) => a + t.segments.reduce((x, s) => x + s.sizeBytes, 0), 0)
    const fallbackName = `recording-${this.opts.meetingNo || 'meeting'}-${stamp}`

    // —— 磁盘为真源（schema 3 存储重构）————————————————————————————————
    //
    // 先写磁盘，再登记 IndexedDB。列表页从磁盘扫描 manifest.json 决定可见性，
    // 所以"manifest.json 在盘上"="列表里看得见"。并行写（各路 .webm + manifest.json 同时发），
    // 全部成功才算"已写入目录"。
    //
    // 磁盘写失败 → 降级到 IndexedDB（分片还在 blobs store 里），列表页仍能通过缓存看到，
    // 但会标"只在浏览器里"。登记失败 → 留给启动自愈或下次磁盘扫描重建。
    //
    // id 用会话头那个（`makeLocalRecordingId(t0)` 在开录时就定了）：删除要按同一个键连带清会话头。

    const recordingId = this.session.id

    // 1. 组装各路产物（从 IndexedDB 读分片拼成整路 .webm）
    const artifacts: TrackArtifact[] = []
    for (const track of withSegments) {
      const blobs: Blob[] = []
      // 时长按**真读到的那些片**之和累加（有片读不到时不能把它的时长也算进去，
      // 否则补出来的 Duration 会比文件里的内容长 —— 进度条走到头还有一段空白）。
      let mediaMs = 0
      for (const seg of track.segments) {
        const b = await getSegmentBlob(seg.blobKey)
        if (b) {
          blobs.push(b)
          mediaMs += seg.durationSec * 1000
        } else console.warn('[trackRecorder] 清单里的分片读不到，这一路按缺口处理', seg.blobKey)
      }
      if (!blobs.length) continue
      // 写盘这一份也要带 Duration：MediaRecorder 产的 webm 头里没有它，播放器读到 `duration=Infinity`
      // → 进度条拖不动、倍速也失效。mp4 不许过（自带 mvhd，补 EBML 会把合法文件改坏）。
      const raw = new Blob(blobs, { type: track.mime })
      const blob = mediaMs > 0 && !track.mime.includes('mp4')
        ? await finalizeWebmDuration(raw, Math.round(mediaMs))
        : raw
      artifacts.push({ track, blob })
    }
    if (!artifacts.length) {
      this.session.open = false
      await this.persistSession()
      return null
    }

    // 2. 写磁盘：各路 .webm + manifest.json 并行
    let dirWritten = false
    let wroteAll = false
    try {
      const manifestBlob = new Blob([buildManifestJson(this.t0, this.opts, withSegments)], { type: 'application/json' })
      const oks = await Promise.all([
        ...artifacts.map((a) => writeRecordingAt(parts, a.track.fileName, a.blob)),
        writeRecordingAt(parts, 'manifest.json', manifestBlob),
      ])
      dirWritten = oks.slice(0, artifacts.length).some(Boolean)
      wroteAll = oks.every(Boolean)
    } catch (e) {
      console.warn('[trackRecorder] 写目录异常，降级到 IndexedDB', e)
    }

    // 3. 登记 IndexedDB（磁盘写成功时带 dirPath/dirHandle，失败时降级）
    try {
      await addLocalRecording({
        id: recordingId,
        title: this.opts.title,
        meetingNo: this.opts.meetingNo,
        fileName: fallbackName,
        startedAt: this.t0,
        durationSec: Math.max(1, Math.round(spanSec)),
        sizeBytes: totalBytes,
        schema: 2 as const,
        tracks: withSegments,
        dirPath: dirWritten ? dirPath : null,
        dirHandle: dirWritten && wroteAll,
        partial,
      })
    } catch (e) {
      console.warn('[trackRecorder] 清单登记失败，下次列表页会从磁盘扫描重建', e)
    }

    // 4. 关闭会话头（不管登记成功与否都关，避免自愈重复重建）
    this.session.open = false
    await this.persistSession()

    return { recordingId, dirPath: dirWritten ? dirPath : null, dirWritten: dirWritten && wroteAll, tracks: withSegments, totalBytes, durationSec: Math.max(1, Math.round(spanSec)), partial }
  }

}

/**
 * 把一路的分片按清单顺序拼回原文件（单路下载用；清单里没有的片不补）。
 *
 * 先问"这一路还是不是一个容器"：片号回绕或同一个键出现两次，意味着这些字节出自**两台编码器**，
 * 接起来就是一份带多个容器头的坏件（时长解不出、帧也解不出）。这里不修字节，只拒绝交出它 ——
 * 交出一句"下载好了"但只有前十几秒能播，比什么都不给更难查。判据与入料层同一处（`laneAnomalies`）。
 */
export async function assembleTrackBlob(track: RecordedTrack): Promise<Blob | null> {
  if (trackIsDamaged(track)) return null
  const blobs: Blob[] = []
  let mediaMs = 0
  for (const seg of track.segments) {
    const b = await getSegmentBlob(seg.blobKey)
    if (b) {
      blobs.push(b)
      mediaMs += seg.durationSec * 1000
    }
  }
  if (!blobs.length) return null
  // 分片是**接起来**的，所以这一路文件的时长是各片之和（≠ 这一路在整场里的跨度 —— 缺口不在文件里）。
  return finalizeWebmDuration(new Blob(blobs, { type: track.mime }), Math.round(mediaMs))
}

/**
 * 这一路的字节还能不能作为一份文件交出。判据只有分片序列本身：片号回绕（同一份清单里
 * 开始了第二次录制）或同一个 `blobKey` 出现两次（两台编码器并写）。
 * `seq_gap`（中间少一片）不算损坏 —— 那是缺口，回放在那儿本来就断成两块可播区。
 */
export function trackIsDamaged(track: Pick<RecordedTrack, 'segments'>): boolean {
  return laneIsDamaged(track.segments || [])
}

/**
 * 「下载这一场」（D3）：本机一条录制是**若干路原片**，所以逐路各下一个文件。
 * 这里不产"整场一个文件" —— 那是回放页合成那条路（`composeGrid`，以及后面的离线合成）干的事，
 * 在这一行按钮上冒充整场产物会让人以为拿到的是合成件。
 * 返回成功/读不到字节/**已损坏**三个路数，调用方据此说真话：坏件不能算成"读不到字节"，
 * 那是另一件事，用户该听到的说法也不同（分片被回收过见 D7）。
 */
export async function downloadLocalRecordingTracks(meta: LocalRecording): Promise<{ ok: number; failed: number; damaged: number }> {
  let ok = 0
  let failed = 0
  let damaged = 0
  for (const track of (meta.tracks || []).filter((t) => t.segments.length > 0)) {
    if (trackIsDamaged(track)) {
      damaged++
      continue
    }
    const blob = await getTrackBlob(meta, track, assembleTrackBlob)
    if (!blob) {
      failed++
      continue
    }
    downloadBlob(track.fileName || `${track.recordingId}.webm`, blob)
    ok++
  }
  return { ok, failed, damaged }
}

/**
 * 「下载这一场」之后那一句实话。两种损失各有各的说法，不许都算成"读不到"：
 * 分片被浏览器回收（缺字节）与文件本身是坏的（并写过）—— 用户接下来该做的事不一样。
 * 两个下载入口共用这一处取词，别再在页面里第二次拼（列表页与回放页说同一句话才算同一件事）。
 */
export function describeTrackDownload(r: { ok: number; failed: number; damaged: number }): { tone: 'error' | 'warning' | 'info'; text: string } {
  if (!r.ok) {
    return r.damaged
      ? { tone: 'error', text: '这几路的原片是坏的，下下来也播不出内容' }
      : { tone: 'error', text: '本机录制已不可读取' }
  }
  const notes: string[] = []
  if (r.damaged) notes.push(`${r.damaged} 路的原片是坏的`)
  if (r.failed) notes.push(`${r.failed} 路的分片已不可读取`)
  if (notes.length) return { tone: 'warning', text: `这次没下：${notes.join('，')}` }
  // 一路且路路都好：不弹（下载本身浏览器就会问一遍，再叠一句是噪声）
  if (r.ok > 1) return { tone: 'info', text: `这一场有 ${r.ok} 路，逐路保存，浏览器会挨个询问` }
  return { tone: 'info', text: '' }
}

function liveTracksFrom(tracks?: MediaStreamTrack[]): MediaStreamTrack[] {
  return (tracks || []).filter((t) => t.kind === 'audio' && t.readyState === 'live')
}

/**
 * 视频轨的实测采集参数（D9）。`getSettings()` 给的是这条轨**实际拿到的**像素与帧率，
 * 不是设置页档位承诺的值；取不到（返回 0）就不写该字段，宁可让导出侧现读容器头。
 */
function videoSettingsOf(t: MediaStreamTrack): Partial<RecordedTrack> {
  const s = t.getSettings()
  const out: Partial<RecordedTrack> = {}
  if (s.width) out.width = Math.round(s.width)
  if (s.height) out.height = Math.round(s.height)
  if (s.frameRate) out.frameRate = round3(s.frameRate)
  return out
}

/** 音频轨的实测参数：`AudioDecoder.configure` 要的 sampleRate 就是这个数（同样取不到就不写）。 */
function audioSettingsOf(t: MediaStreamTrack): Partial<RecordedTrack> {
  const s = t.getSettings()
  const out: Partial<RecordedTrack> = {}
  if (s.sampleRate) out.sampleRate = Math.round(s.sampleRate)
  if (s.channelCount) out.channelCount = Math.round(s.channelCount)
  return out
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** 路名用与 `recordingId` 同一个令牌：同毫秒重开的两条路不会撞成同一个文件（后写覆盖前写）。 */
function trackFileName(ownerName: string, kind: RecordedTrackKind, ext: string, stamp: string): string {
  const who = sanitizePathPart(ownerName || 'unknown', 'unknown')
  return `${who}-${kind}-${stamp}.${ext}`
}

export function segmentsHaveGap(track: RecordedTrack): boolean {
  const segs = track.segments
  for (let i = 1; i < segs.length; i++) {
    const prev = segs[i - 1]
    if (segs[i].offsetSec - (prev.offsetSec + prev.durationSec) > 1) return true
  }
  return false
}

/**
 * 这一场录制不完整没有（D4）。两种真形：**某一路路内有断流**，或**某一路比全场最晚结束早收场**
 * （早退、编码器挂掉、没点停止就被关掉）。
 * 单独抽出来是因为旧写法拿**绝对** `endOffsetSec` 与**跨度** `spanSec` 比 —— 只要有人不是从 0 秒开始录
 * （中途入会，`minStart>0`）这个式子就整体失真，而失真方向看不出来。判据必须能拿真形状单测。
 * 各路起点不齐**不是**不完整：那一路本来就从那一刻才有画面。
 */
export function isPartialSession(tracks: RecordedTrack[]): boolean {
  const withSegments = tracks.filter((t) => t.segments.length > 0)
  if (!withSegments.length) return false
  const maxEnd = Math.max(...withSegments.flatMap((t) => t.segments.map((s) => s.offsetSec + s.durationSec)))
  return withSegments.some((t) => segmentsHaveGap(t) || maxEnd - (t.endOffsetSec ?? maxEnd) > 1)
}

/** 与界面同一个口径的"这一路真的录到东西了没有"，供清单/落盘判缺省态。 */
export function trackHasMedia(track: RecordedTrack): boolean {
  return track.segments.reduce((a, s) => a + s.sizeBytes, 0) > 0
}

/**
 * 第 14 项要求的目录层：`hxt/{登录账号}/{yyyyMMddHHmmss}/{会议编号}`。
 * 单独抽出来是因为落盘和界面/校验要用同一个口径 —— 浏览器只能往用户授权的目录**里面**逐层建，
 * 拿不到绝对路径，所以这里返回的是相对授权目录的每一段。
 *
 * 第二段用**登录账号**而不是中文姓名（第 37 项）：姓名会重名、带空格与非法字符，
 * 账号才是稳定、可脚本化寻址的那一个。
 * 账号在前、时刻在后：同一台机器上不同用户的录制各自聚拢到一个目录，找某人的全部录制
 * 只需打开一层，不用在每个时间戳目录下逐个翻。
 */
export function recordingDirParts(t0: number, userName: string, meetingNo: string): string[] {
  return recordingRelParts(
    sanitizePathPart(userName, 'unknown'),
    dirStampOf(t0),
    sanitizePathPart(meetingNo, 'unknown-meeting'),
  )
}

function dirStampOf(t0: number): string {
  // 业务时区的墙上时间，和界面上显示的时刻同一口径（见 utils/time.ts）
  const d = new Date(t0)
  const p = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d)
  const g = (t: string) => p.find((x) => x.type === t)?.value || '00'
  return `${g('year')}${g('month')}${g('day')}${g('hour')}${g('minute')}${g('second')}`
}

/**
 * 收尾时要产出的路。两件事，都不含"合并"：
 * 1. 只留有分片的路；
 * 2. **同一条清单条目只产一次** —— 定稿不幂等时同一个 desc 会被推进 `closed` 两遍，
 *    按对象身份去重是把这层依赖显式化：真的出现第二条副本时响亮报警，而不是拼出一份
 *    每片都重复一遍的坏文件。
 *
 * 一条路自己的分片必须仍是**单一容器**（片号单调、无重复键）。不是的话说明开录侧的护栏漏了，
 * 这份文件交出去就是解不出内容的坏件 —— 报警并跳过，绝不"先拼了再说"。
 */
function closedLanes(closed: RecordedTrack[]): RecordedTrack[] {
  const seen = new Set<RecordedTrack>()
  const out: RecordedTrack[] = []
  for (const t of closed) {
    if (!t.segments.length) continue
    if (seen.has(t)) {
      console.error('[trackRecorder] 同一条路被登记了两次，跳过副本', t.recordingId, t.segments.length)
      continue
    }
    seen.add(t)
    const anomalies = laneAnomalies(t.segments)
    if (anomalies.length) {
      console.error('[trackRecorder] 该路分片跨容器，不作为一份文件交出', t.recordingId, anomalies.join(','))
      continue
    }
    out.push(t)
  }
  return out
}

function buildManifestJson(t0: number, opts: SessionOptions, tracks: RecordedTrack[]): string {
  return JSON.stringify(
    {
      schema: 2,
      // 与三方回放清单同构的字段名，桌面端/别的播放器可以照同一套算法对齐时间轴
      meeting: { meetingNo: opts.meetingNo, title: opts.title },
      timeline: { startAt: Math.floor(t0 / 1000), startAtMs: t0 },
      // 桌面端拿这份 manifest 自己合轨时要知道上哪个解复用器；容器由各路真 mime 判出，
      // 不是另一个存在库里的事实（顶层那个伪串 `application/x-multi-track` 已被 D9 删掉）。
      container: containerOf(tracks),
      streams: tracks.map((t) => ({
        recordingId: t.recordingId,
        ownerId: t.ownerId,
        ownerName: t.ownerName,
        kind: t.kind,
        streamLabel: t.mediaLabel,
        hasVideo: t.hasVideo,
        hasAudio: t.hasAudio,
        fileName: t.fileName,
        mime: t.mime,
        // 解码参数（D9）：实测值，没取到的就不写这个键（桌面端据此决定要不要现读容器头）
        width: t.width,
        height: t.height,
        frameRate: t.frameRate,
        sampleRate: t.sampleRate,
        channelCount: t.channelCount,
        offsetSeconds: t.startOffsetSec,
        closeReason: t.closeReason,
        segments: t.segments.map((s) => ({
          offsetSeconds: s.offsetSec,
          durationSeconds: s.durationSec,
          bytes: s.sizeBytes,
          file: `${t.fileName}#segment=${s.seq}`,
          mime: s.mime,
        })),
      })),
    },
    null,
    2,
  )
}

// —— 合成下载（第 16 项）————————————————————————————————

export interface ComposePane {
  id: string
  label: string
  hasVideo: boolean
  hasAudio: boolean
  muted: boolean
  media: HTMLMediaElement
}

export interface ComposeOptions {
  panes: ComposePane[]
  /** 列数（1–6）：和回放用同一套排列，导出才不会跟看到的不一致 */
  cells: number
  cellWidth?: number
  fps?: number
    /** 全局时钟（秒）与总时长：合成就是"陪着回放放一遍"，不另起一套时间 */
  getTime: () => number
  durationSec: number
  onProgress?: (ratio: number, timeSec: number) => void
  shouldCancel?: () => boolean
  /**
   * 第 16/41 项：页面被切走时调用方会把全局时钟**按住**（暂停、回前台再原位继续）。
   * 这里每 200ms 读一次：为真就把编码器一起 `pause()`（不吐冻帧、不占时长），
   * 并且**不判停摆** —— 切走从此不再是"整条产物作废"的理由，
   * 因为按住的这段时间既不推进时钟也不进文件，回前台接着录，出来的仍是整场。
   */
  isHolding?: () => boolean
}

export interface ComposeResult {
  blob: Blob
  mime: string
  ext: string
  cancelled: boolean
  /** 时钟停摆且**不是**页面切走（切走走 isHolding 那条按住-继续的路）：这条产物是半截的，调用方要照实标记 */
  stalled: boolean
  droppedAudioPanes: string[]
}

/** 全局时钟多久不前进就判定"出帧已经停了"：给一次 seek/加载的余量，又不能让人对着进度条干等。 */
const CLOCK_STALL_MS = 4000

/**
 * 挑一个真被浏览器支持的容器。第 16 项原话要 mp4，"或其他主流格式"是退路。
 *
 * 2026-09-30 重测（本机 Edge，6 次非整点时长 0.9/1.7/2.3/3.1/4.7/5.9 秒，画布轨+混音轨）：
 * 6/6 出合法 mp4（顶层 `ftyp,moov,moof,mdat,mfra`，`moov` 在 `mdat` 之前，播放器友好），`onerror` 零次。
 * 09-29 那句"mp4 在非整点时长上偶发不可播放"查无实据 —— 真相是**浏览器读不到直译时长**：
 * 6/6 都是 `v.duration` 直读拿不到有限值、必须"seek 到极远"才逼得出来（`probeBlobDurationSec` 已带这条兜底）。
 * 新读法若绕开这条兜底，就会把能播的文件误判成坏文件 —— 这条是当年判 mp4 不可用的成因，别再犯。
 *
 * mp4 仍**不能按片拼接**（一片不是自包含容器），所以单路原片照旧走 webm，见 composeGrid 的调用方。
 * mp4 的 mvhd 时长会比录制窗口多 0.03–0.6 秒（音频尾巴），因此"整场有没有跑完"只按
 * "产物比时间轴**短** 2 秒以上"判，不看偏长的那侧。
 */
export function pickComposeMime(preferMp4 = false): string {
  const mp4 = 'video/mp4;codecs=avc1.42001E,mp4a.40.2'
  const webm = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
  const order = preferMp4 ? [mp4, ...webm] : [...webm, mp4]
  if (typeof MediaRecorder === 'undefined') return ''
  return order.find((c) => MediaRecorder.isTypeSupported(c)) || ''
}

export function composeSupported(): boolean {
  return typeof MediaRecorder !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function'
    && pickComposeMime() !== ''
}

// 混音总线（全页共用一条、resume 必须落在点击的同步段、"收尾绝不 close"这三条硬约束）见
// `utils/audioBus.ts`：合成（`composeGrid`）与回放页的「合成整场」用同一份实现，别再各写一套。

/**
 * 宫格合成导出：离屏 canvas 按当前排列把各路在**全局时间轴的同一时刻**画进各自的格子，
 * 音轨经 WebAudio 混成一条（被静音的路 gain=0），再交给一条 MediaRecorder 编成一个文件。
 *
 * 诚实的前提：这是"陪着回放放一遍"，所以 1× 实时才能保住真实语速 ——
 * 提高 playbackRate 只是把同样的内容压成快放视频，不是"更快的导出"。
 * 某一路在这一刻没有画面（缺口/未加载完）时，那一格画暗色占位，不拿上一帧冒充还在动。
 */
export async function composeGrid(opts: ComposeOptions): Promise<ComposeResult | null> {
  const cols = Math.max(1, Math.min(opts.cells, 6))
  const videoPanes = opts.panes.filter((p) => p.hasVideo)
  const rows = Math.max(1, Math.ceil(videoPanes.length / cols))
  const cellW = Math.max(96, Math.round((opts.cellWidth || 480) / 2) * 2)
  const cellH = Math.round((cellW * 9) / 16 / 2) * 2
  const canvas = document.createElement('canvas')
  canvas.width = cellW * cols
  canvas.height = cellH * rows
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const panes = videoPanes.slice(0, cols * rows)

  const bus = ensureAudioBus()
  const droppedAudioPanes: string[] = []
  if (bus) {
    for (const p of opts.panes) {
      if (!p.hasAudio) continue
      // 接不走这一路的音频（浏览器不允许）时返回 null：这一路在导出里就是没声音，如实记下。
      const gain = hookMediaToBus(p.media)
      if (!gain) {
        droppedAudioPanes.push(p.label)
        continue
      }
      // 静音的那一路 gain=0：它不进导出音量，但元素本身不受影响，回放页照旧能单独放开
      gain.gain.value = p.muted ? 0 : 1
    }
  }

  const capture = canvas.captureStream(opts.fps || 15)
  const outTracks: MediaStreamTrack[] = [...capture.getVideoTracks(), ...(bus ? bus.dest.stream.getAudioTracks() : [])]
  if (!outTracks.length) return null
  // 第 16 项要 mp4：本机实测原生可封（含混音轨），不支持的浏览器自动退 webm（契约 ADR-0053）。
  const mime = pickComposeMime(true)
  let rec: MediaRecorder
  try {
    rec = new MediaRecorder(new MediaStream(outTracks), mime ? { mimeType: mime } : undefined)
  } catch (e) {
    console.warn('[compose] 编码器起不来', e)
    for (const t of capture.getVideoTracks()) t.stop()
    return null
  }
  const chunks: BlobPart[] = []
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }
  const done = new Promise<void>((resolve) => {
    rec.onstop = () => resolve()
  })

  let raf = 0
  let cancelled = false
  let stalled = false
  /** 编码器当前是否因"页面被切走"而暂停着（用来控制 rec.pause/resume 的边沿检测） */
  let encoderHeld = false
  const draw = () => {
    if (cancelled) return
    ctx.fillStyle = '#0b1220'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    panes.forEach((p, i) => {
      const x = (i % cols) * cellW
      const y = Math.floor(i / cols) * cellH
      const m = p.media
      const hasPicture = m.readyState >= 2 && (m as HTMLVideoElement).videoWidth > 0 && !m.seeking
      ctx.fillStyle = hasPicture ? '#000' : '#141c2e'
      ctx.fillRect(x, y, cellW, cellH)
      if (hasPicture) {
        // contain 贴合：不等比拉伸，画面本来什么样就多大。
        const vw = (m as HTMLVideoElement).videoWidth
        const vh = (m as HTMLVideoElement).videoHeight
        const scale = Math.min(cellW / vw, cellH / vh)
        const w = vw * scale
        const h = vh * scale
        try {
          ctx.drawImage(m as HTMLVideoElement, x + (cellW - w) / 2, y + (cellH - h) / 2, w, h)
        } catch {
          ctx.fillStyle = '#141c2e'
          ctx.fillRect(x, y, cellW, cellH)
        }
      } else {
        // 缺口态：这一格此刻没有画面，就画一块暗底 + 这一路的标识首字，不伪造上一帧还在动。
        ctx.fillStyle = 'rgba(148,163,184,0.9)'
        ctx.font = `${Math.round(cellW / 6)}px sans-serif`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText((p.label || '?').slice(0, 1), x + cellW / 2, y + cellH / 2)
      }
      ctx.strokeStyle = 'rgba(148,163,184,0.25)'
      ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1)
    })
    const t = opts.getTime()
    opts.onProgress?.(opts.durationSec ? Math.min(1, t / opts.durationSec) : 0, t)
    if (opts.shouldCancel?.()) {
      cancelled = true
      return
    }
    if (opts.durationSec && t >= opts.durationSec - 0.05) return
    raf = requestAnimationFrame(draw)
  }

  rec.start(1000)
  draw()
  // 等到全局时钟走到头（用户取消 / 时钟停摆 为止）。
  // 注意出帧用的是 requestAnimationFrame：页面一进后台，draw 就不再跑，
  // 于是 cancelled 与"走到头"两个条件都永远不成立 —— 只等它们会把合成挂死，
  // 并且等回来的是一个画面冻结、进度却像跑完过的坏文件。所以这条看门狗必须走定时器。
  await new Promise<void>((resolve) => {
    let lastT = opts.getTime()
    let advancedAt = Date.now()
    // 编码器跟着"按住"状态起停：切走时暂停它，回前台再续 —— 这样按住的这段时间
    // 既不进文件也不占时长，产物仍然是从头到尾整场（第 16 项）。
    const setHeld = (held: boolean) => {
      if (held === encoderHeld) return
      encoderHeld = held
      try {
        if (held && rec.state === 'recording') rec.pause()
        else if (!held && rec.state === 'paused') rec.resume()
      } catch (e) {
        console.warn('[compose] 编码器暂停/继续没成，这一段照旧录着', e)
      }
    }
    // Chrome 把后台标签页的 setTimeout 节流到 ~1 次/分钟，看门狗在后台根本跑不动，
    // advancedAt 会冻住；回前台那一刻 holding 变 false 但 eng.time 还没推进（rAF 还没跑），
    // 看门狗一判 Date.now()-advancedAt > 4s 就直接判停摆 → 产物只有前几秒。
    // 所以这里自己监听 visibilitychange：回前台立刻续期 advancedAt + 重踢 draw() 的 rAF，
    // 不等被节流的 setTimeout。
    const onVis = () => {
      if (document.hidden) return
      advancedAt = Date.now()
      if (!cancelled && !stalled) {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(draw)
      }
    }
    document.addEventListener('visibilitychange', onVis)
    const check = () => {
      if (cancelled || stalled) {
        document.removeEventListener('visibilitychange', onVis)
        return resolve()
      }
      if (opts.shouldCancel?.()) {
        cancelled = true
        document.removeEventListener('visibilitychange', onVis)
        return resolve()
      }
      const holding = !!opts.isHolding?.() || document.hidden
      setHeld(holding)
      const t = opts.getTime()
      if (t > lastT) {
        lastT = t
        advancedAt = Date.now()
      } else if (holding) {
        advancedAt = Date.now()
      } else if (Date.now() - advancedAt > CLOCK_STALL_MS) {
        stalled = true
        console.warn('[compose] 时钟停摆，中止合成。页面是否处于后台', document.hidden, 't=', t)
        document.removeEventListener('visibilitychange', onVis)
        return resolve()
      }
      if (opts.durationSec && t >= opts.durationSec - 0.05) {
        document.removeEventListener('visibilitychange', onVis)
        return resolve()
      }
      window.setTimeout(check, 200)
    }
    window.setTimeout(check, 200)
  })
  cancelAnimationFrame(raf)
  try {
    // 收尾时编码器还按住的（用户在切走的状态下按了取消、或刚好在隐藏那一刻放到尽头）：
    // 先 resume 再 stop —— `paused` 状态下直接 stop 会把最后一段留在缓冲里不吐出来。
    if (rec.state === 'paused') rec.resume()
    if (rec.state !== 'inactive') rec.stop()
  } catch (e) {
    console.warn('[compose] 收尾编码报错', e)
  }
  await done
  for (const t of capture.getVideoTracks()) t.stop()

  // 容器以编码器协商出来的为准：Chromium 会改写请求的 profile/level（实测 42001E→42001f）。
  const outMime = rec.mimeType || mime || 'video/webm'
  const isMp4 = outMime.includes('mp4')
  const rawBlob = new Blob(chunks, { type: outMime })
  const ext = isMp4 ? 'mp4' : 'webm'
  // 时长补丁只给 webm（mp4 自带 mvhd，补 EBML 会把合法文件改坏）；且按住/停摆的半截产物一律不盖，
  // 否则调用方用 probeBlobDurationSec 量到的就是我们自己写的数（契约 ADR-0050、ADR-0053）。
  // encoderHeld 只表示编码器曾被暂停/恢复（切后台再切回），内容仍覆盖完整时间线，不应跳过补丁——
  // 跳过会导致 webm 缺 Duration，播放器 duration=Infinity，进度条拖不动、调速也失效。
  const blob = isMp4 || cancelled || stalled || !opts.durationSec
    ? rawBlob
    : await finalizeWebmDuration(rawBlob, Math.round(opts.durationSec * 1000))
  return { blob, mime: outMime, ext, cancelled, stalled, droppedAudioPanes }
}
