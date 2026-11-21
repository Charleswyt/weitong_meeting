// 多路回放的时钟与对齐引擎（第 15 项）。纯 TS、不绑组件：页面只管渲染窗格，
// "什么时候切哪一片、什么时候 seek、哪一格现在是缺口" 全在这里，与三方独立回放页同一套算法
// （逆向记录见 shared/contracts/edge-to-cloud/EXTERNAL_HTTPS_CONFERENCE_API_20260928.md 的回放一节）。
//
// 关键点：
// 1) 只有**一个**全局时钟 time，各路自己找当前片；找不到就是缺口，界面必须说清是哪种缺口，
//    绝不拿上一帧或别的路的画面冒充连续。
// 2) rAF 驱动 + 每 500ms 强制对齐一次：各路元素自己的 currentTime 会漂，浏览器给的时间戳也会跳。
// 3) |media.currentTime - 目标| > 1.5 才 seek：小于这个阈值反复 seek 会让各路一直在缓冲、永远对不齐。
import type { RecordedTrack, TrackSegment } from '@/utils/localRecorder'
import { laneIsDamaged } from '@/utils/offlineCompose/segmentSource'
import { autoCols, type LayoutMode } from '@/utils/composeLayout'

export type RowState = 'idle' | 'buffering' | 'playing' | 'paused' | 'gap' | 'error' | 'blocked'

/**
 * 引擎输入里的一片，比存储清单多一个 `session`：它标明这一片出自**哪一次连续录制**。
 * 同一个人中途退会再入是另一次录制会话，两片即便时间相接也不能拼进同一个可播区
 * —— 容器头只属于自己那次会话（`assembleRuns` 靠这个判断）。
 */
export interface EngineSegment extends TrackSegment {
  session: string
}

/**
 * 引擎输入的一路 = 同一个人同一类通路在整场会议里的**全部片段**（第 17 项）。
 * 云端早就是按「人 × 通路」归组后喂进来的（`cloudReplay.ts`），本机清单必须走同一个口径，
 * 否则 3 个人的会议会在宫格里开出 5 个窗格、同一人两个格各自显示缺口。
 */
export interface EngineTrack extends Omit<RecordedTrack, 'segments'> {
  segments: EngineSegment[]
  /** 这一格里每一次录制的清单原条目，按开始时刻排；界面「下载这一路原始文件」逐个用它 */
  sources: RecordedTrack[]
  /**
   * 仅云端：同一人已有独立音频路，这一格画面件自带的音轨被丢弃（契约 ADR-0068 五之补二）。
   * 丢弃是决定不是事实，界面必须如实说出来，不能让人以为"这路本来就没声音"。
   */
  audioDropped?: boolean
}

export interface EngineRow {
  recordingId: string
  ownerId: string
  ownerName: string
  kind: string
  streamLabel: string
  hasVideo: boolean
  hasAudio: boolean
  startOffsetSec: number
  endOffsetSec: number | null
  closeReason: string
  segments: EngineSegment[]
  /** 这一格背后每一次录制的清单原条目（一个人再入会有多条） */
  sources: RecordedTrack[]
  /**
   * 一个**可播区**：相对全局 t0 的 [start,end) + 构成它的连续分片。
   * 不是一片一格 —— MediaRecorder 的时片只有第一片带 EBML 头，单独喂播放器必挂
   * （实测 `MEDIA_ERR_SRC_NOT_SUPPORTED`），所以连续片要合成一个区来播。
   * `session` 是这个区属于哪一次录制的依据：补容器头只能补**同一次**的头。
   */
  spans: Array<{ start: number; end: number; segments: EngineSegment[]; session: string; url: string }>
  media: HTMLMediaElement | null
  state: RowState
  statusText: string
  muted: boolean
  /** 用户勾选（画面路看勾选、纯音轨路恒 true）。**这是意图**，不是"现在装没装载" */
  visible: boolean
  /**
   * 这一格此刻在不在视口里（页面用 IntersectionObserver 打；引擎自己不认 DOM）。
   * 不在视口的**纯画面路**不占解码器 —— 多路同时解码 VP9 是本机回放卡的直接原因。
   * 注意：带声音的画面路**不因出视口而卸载**（元素一停，声音也没了），见 shouldLoad。
   */
  onScreen: boolean
  /** 正在播的片下标，-1 = 这一路此刻没有片（缺口） */
  index: number
  serial: number
  pending: boolean
  failed: boolean
  blocked: boolean
  /**
   * 这一路的分片里混进了**多于一个容器**（片号回绕或同一片出现两次）：这份文件本身是坏的，
   * 播得出多少、下下来能播多久都没有保证。界面要照实说一句，不能让它看着像正常一路。
   */
  damaged: boolean
  /** 非 src 直给型来源（HLS）的卸载句柄：换片/出画/销毁都要先摘掉它 */
  detach?: (() => void) | null
  /** @internal 缓冲防抖：readyState 掉到 <2 后首次记录的时间戳，持续 ≥800ms 才切 buffering 态 */
  _bufferSince?: number
}

export interface ReplayEngineOptions {
  tracks: EngineTrack[]
  durationSec: number
  /** 会话起点的 epoch 毫秒：挂钟时间 = startAtMs + time */
  startAtMs: number
  /** 可播区怎么变成能播的地址由页面决定（本机是把这一段连续分片拼成 object URL，别的来源可以是 http 地址） */
  resolveUrl: (row: EngineRow, span: EngineRow['spans'][number]) => Promise<string>
  /**
   * 是否把**时间上连续**的分片合成一个可播区。本机录制必须开：
   * MediaRecorder 按时片切出来的 blob 只有第一片带容器头，其余单播会直接报
   * `MEDIA_ERR_SRC_NOT_SUPPORTED`（实测 code=4）。云端一路本来就是完整可播流，保持关。
   */
  assembleRuns?: boolean
  /**
   * 有些来源不能靠 `media.src = url` 直接播（云端录制是 HLS，Chromium 要先经 hls.js 接管）。
   * 给了这个钩子，引擎就不自己设 src，改由页面挂载并返回卸载句柄（返回 null 表示它自己走了 src）。
   */
  attachSource?: (row: EngineRow, url: string, media: HTMLMediaElement) => (() => void) | null
  onChange?: () => void
  /** 时钟每帧回吐一次，页面据此更新进度条与挂钟，不用自己再挂一个 rAF */
  onClock?: (timeSec: number, playing: boolean) => void
}

// 对齐节拍照**三方回放页**（`meeting-replay.html`，逆向见 shared/contracts/edge-to-cloud/
// EXTERNAL_HTTPS_CONFERENCE_API_20260928.md §12）：rAF 驱动、每 150ms 强制对齐一次、偏差 > 0.45s 才 seek。
// 2026-09-30 晚一度被改成 500ms / 1.5s（更"省 seek"），现场就是"一顿一顿"——
// 对齐变稀以后各路更容易漂出去，一漂就 seek 一大步，观感反而更差。别单方面调稀它。
const SEEK_TOLERANCE_SEC = 0.45
/**
 * "往回拽"的门槛（秒）。元素跑在时钟前面**不是漂移**（两者同源、都按墙钟走），
 * 只能是时钟被落了（rAF 被节流/停）。1.5s 这种量级一律不碰；只有偏差大到明显是另一次定位
 * （显式 seek 没生效、时间轴整体挪动）才把画面拉回来。
 */
const HARD_RESYNC_SEC = 5
const FORCE_SYNC_MS = 150

export class ReplayEngine {
  readonly rows: EngineRow[]
  readonly startAtMs: number
  duration: number
  time = 0
  playing = false
  rate = 1
  muted = false
  /** 列数：构造时按有画面的路数算（见 constructor 里那条 `autoCols`），此后只跟用户的手选。
   *  **只有 `grid` 档吃它** —— `top`/`right` 的形状由"一路主画面 + 一圈缩略"决定。 */
  cols: number = 1
  /** 三档排列（口径 §9.1）。这里只存"用户选了哪一档、哪一路是主画面"，几何一律由 `composeLayout` 算 */
  mode: LayoutMode = 'grid'
  /** 主画面那一行的 `recordingId`（行身份）。合成侧要的是 lane id，那一次翻译在页面里做 */
  focusRowId: string | null = null
  destroyed = false

  /** 合成模式：放宽 sync 间隔与 seek 容差，避免引擎的强制对齐打断 canvas 读帧 */
  composeMode = false

  private frame = 0
  /** rAF 之外的心跳定时器（见 `startTickFallback`）：窗口被盖住时 rAF 会停，进度不该停 */
  private tickTimer = 0
  private anchor = 0
  private anchorTime = 0
  private syncAt = 0
  /** 拖动中常规对齐的上次时刻（`scrub` 节流用） */
  private scrubSyncAt = 0
  private readonly opts: ReplayEngineOptions

  constructor(opts: ReplayEngineOptions) {
    this.opts = opts
    this.startAtMs = opts.startAtMs
    this.duration = Math.max(0, opts.durationSec || 0)
    this.rows = opts.tracks.map((t) => {
      const pieces = t.segments
        .filter((s) => s.durationSec > 0)
        // 起点夹到 0 就必须同时安置终点：只夹 start 会留下 end < start 的反向区间
        // （`segmentAt` 永远匹配不上，而倒挂的 end 会污染任何按区间末端算的显示与时长）。
        // 偏移非负时这个写法与 `s.offsetSec + s.durationSec` 恒等，正常数据零行为变化。
        .map((s) => {
          const start = Math.max(0, s.offsetSec)
          return { start, end: start + s.durationSec, segment: s, session: s.session }
        })
        .sort((a, b) => a.start - b.start)
      // **第一片的到达延迟不是"这一路还没开始"**：实测第一条分片的 offsetSec 是 0.001 秒
      // （编码器吐出第一片总要几毫秒），但 `segmentAt(0)` 要 `time >= start` 才命中，
      // 于是每一场本地录制在 t=0 都被判成缺口 —— 回放页第一格写着「这一路尚未开始录制」，
      // 宫格合成的首帧也被画成占位块。只在 ≤0.25 秒内夹到 0，和下面合并可播区同一个容差；
      // 真等了很久才开录的路（比如中途才开摄像头）不会被这条抹平。
      if (pieces.length && pieces[0].start > 0 && pieces[0].start <= 0.25) {
        pieces[0].end += pieces[0].start
        pieces[0].start = 0
      }
      const spans: EngineRow['spans'] = []
      for (const p of pieces) {
        const last = spans[spans.length - 1]
        const lastSeg = last?.segments[last.segments.length - 1]
        // **容器边界也要断区**：同一次会话里片号回绕，说明这份清单混进了第二次录制的字节，
        // 接起来是带多个容器头的坏件（实测解不出时长、一帧都出不来）。这里照实断成两块，
        // 不是修复字节 —— 只是不再把坏件当成"一整块能播的区域"喂给播放器。
        const sameContainer = !lastSeg || p.segment.seq > lastSeg.seq
        // 时间接得上（缝隙 ≤0.25s）的分片并进同一个可播区 —— 合区是为了能播（时片不带容器头），
        // 不是为了把断流抹平：接不上的就是两个区，中间照实显示缺口。
        // **跨录制会话不合区**：再入会那一段的第一片自带容器头，和上一段拼到一起只会得到一份坏文件。
        if (opts.assembleRuns && last && p.session === last.session && sameContainer && p.start - last.end <= 0.25) {
          last.end = Math.max(last.end, p.end)
          last.segments.push(p.segment)
          continue
        }
        spans.push({ start: p.start, end: p.end, segments: [p.segment], session: p.session, url: '' })
      }
      const row: EngineRow = {
        recordingId: t.recordingId,
        ownerId: t.ownerId,
        ownerName: t.ownerName,
        kind: t.kind,
        streamLabel: t.mediaLabel || t.kind,
        hasVideo: t.hasVideo,
        hasAudio: t.hasAudio,
        startOffsetSec: t.startOffsetSec,
        endOffsetSec: t.endOffsetSec,
        closeReason: t.closeReason,
        segments: t.segments,
        sources: t.sources,
        spans,
        media: null,
        state: 'idle',
        statusText: '正在准备…',
        muted: false,
        visible: true,
        // 默认 true：没接视口观察者（或还没量过）时按"要装载"处理，宁可多解码也不能让画面无声无息地不加载。
        onScreen: true,
        index: -1,
        serial: 0,
        pending: false,
        failed: false,
        blocked: false,
        // 这一路的清单里混进了第二次录制的字节（片号回绕 / 同一片两次）：字节接起来是坏件。
        // 引擎不修字节，只把这个事实带上去，界面据此说一句实话（判据与入料层同一处）。
        damaged: laneIsDamaged(t.segments),
      }
      return row
    })
    // 默认列数按**有画面的路数**算（正本 §4：`clamp(⌈√N⌉,1,6)`）。
    // 原来这里等价于写死 2：路一多就把格子摊成一条横带，每格在 16:9 屏上小得读不出字 ——
    // "路多了该加列"是反的，默认接近方形才让每格最大。用户手动选过就一直跟着用户。
    this.cols = autoCols(this.videoRows.length)
    this.renderLayout()
  }

  // —— 视图挂/摘窗格里的媒体元素：引擎不造 DOM，只认页面递进来的元素。
  attachMedia(row: EngineRow, el: HTMLMediaElement | null) {
    if (row.media === el) return
    if (el) {
      el.setAttribute('playsinline', '')
      el.preload = 'metadata'
      row.media = el
      this.syncRow(row, true)
      this.emit()
    }
  }

  get videoRows(): EngineRow[] {
    return this.rows.filter((r) => r.hasVideo)
  }

  get audioRows(): EngineRow[] {
    return this.rows.filter((r) => r.hasAudio)
  }

  wallClockText(locale = 'zh-CN'): string {
    if (!this.startAtMs) return ''
    return new Date(this.startAtMs + this.time * 1000).toLocaleString(locale, { hour12: false })
  }

  setLayout(next: { mode?: LayoutMode; cols?: number }) {
    if (next.cols !== undefined) this.cols = Math.max(1, Math.min(6, next.cols))
    if (next.mode) this.mode = next.mode
    this.renderLayout()
    this.sync(true)
    // 必须发通知：`mode`/`cols`/`focusRowId` 都是普通字段，视图的布局是
    // `computed(() => …void tick.value…)`，只有 `onChange` 会推 tick。漏这一句的表现是
    // **"暂停时点档位/放大完全没反应"**（播放中看着正常，因为 tick 自己在走）。
    this.emit()
  }

  /**
   * "放大这一路" = 把它设成**主画面**（口径 §9.1：这三档要救的是"共享屏幕看不清"，
   * 靠的是主画面那块面积，不是方位）。从前这里把 `cols` 强设成 1，语义是"只剩这一路"，
   * 在 `composeLayout` 头部被标成三档接线前的过渡形态 —— 这一步就是把它换掉。
   * 再点同一格收回宫格档：用户看清之后要的通常是回去。
   */
  focusRow(row: EngineRow) {
    if (this.videoRows.indexOf(row) < 0) return
    if (this.focusRowId === row.recordingId && this.mode !== 'grid') {
      this.mode = 'grid'
      this.focusRowId = null
    } else {
      this.focusRowId = row.recordingId
      // 已经在主画面档时保持方位不变（用户选过"右侧"就别被一次放大拽回"顶部"）
      if (this.mode === 'grid') this.mode = 'top'
    }
    this.renderLayout()
    this.sync(true)
    this.emit()
  }

  toggleTrackMuted(row: EngineRow) {
    row.muted = !row.muted
    if (row.media) row.media.muted = this.muted || row.muted
    this.emit()
  }

  setMuted(v: boolean) {
    this.muted = v
    this.sync()
    this.emit()
  }

  setRate(r: number) {
    this.rate = r
    this.anchorTime = this.time
    this.anchor = performance.now()
    this.sync(true)
    this.emit()
  }

  segmentAt(row: EngineRow): number {
    // 起点用 `max(0, …)` 夹住：首帧的时间戳可能比 0 早几毫秒（见 `updateTime` 的注释），
    // 严格比较会把这几十毫秒判成"这一路此刻没有片"。
    const t = Math.max(0, this.time)
    return row.spans.findIndex((s) => t >= s.start && t < s.end)
  }

  /** 这一路此刻是哪种缺口：四种情况文案不同，界面不能只写"没有画面"。 */
  private gapText(row: EngineRow): string {
    const first = row.spans[0]
    const last = row.spans[row.spans.length - 1]
    if (!first) return row.endOffsetSec === null ? '这一路正在录，还没有已完成的片段' : '这一路没有已完成的片段'
    if (this.time < first.start) return '这一路尚未开始录制'
    if (last && this.time >= last.end) {
      if (row.endOffsetSec !== null && this.time <= row.endOffsetSec) return '这一路此刻没有画面'
      return row.closeReason === 'session_end' || this.time >= this.duration
        ? '这一路录制已结束'
        : '这一路在此刻之前已经停止'
    }
    return '此时段录制中断'
  }

  private setState(row: EngineRow, state: RowState, text: string) {
    // 同状态同文案**不发** onChange：每 500ms 一次的对齐会把每条路的状态重设一遍，
    // 每次都 emit 等于让整个回放页（宫格 + 声音面板 + 文件信息）每秒重渲染几遍，
    // 多路解码时这部分开销是纯浪费。
    if (row.state === state && row.statusText === text) return
    row.state = state
    row.statusText = text
    this.emit()
  }

  /**
   * 这一路此刻该不该持有解码器。判据只有三条，别在别处再造第二套（旧版是把"纯音轨行"无条件卸载，
   * 于是暂停态下切换画面勾选后音轨再也回不来 —— 那正是"本机录制回放没声音"的形态）：
   * - 用户勾选（visible）是**意图**；纯音轨行恒为 true，它的开/关走 muted。
   * - 不在视口的**纯画面路**不装载：多路同时解码 VP9 是本机回放卡的直接原因。
   * - **带声音的画面路不因出视口而卸载**：元素一停，声音也停了（同一条媒体元素没法只放声音）。
   */
  private shouldLoad(row: EngineRow): boolean {
    if (!row.visible) return false
    // 合成期间离屏也要装载：产物要画的是"用户勾选的那些路"，不是"此刻恰好在视口里的那几格"。
    if (this.composeMode) return true
    if (!row.hasVideo) return row.hasAudio
    return row.onScreen || row.hasAudio
  }

  /** 用户勾选某一路（画面/声音）。这是意图，引擎据此装载或卸载。 */
  setRowVisible(row: EngineRow, visible: boolean) {
    if (row.visible === visible) return
    row.visible = visible
    if (this.shouldLoad(row)) this.syncRow(row, true)
    else if (row.index >= 0) this.releaseMedia(row)
    this.emit()
  }

  /** 这一格此刻在不在视口里（页面用 IntersectionObserver 打，引擎自己不认 DOM）。 */
  setRowOnScreen(row: EngineRow, onScreen: boolean) {
    if (row.onScreen === onScreen) return
    row.onScreen = onScreen
    if (this.shouldLoad(row)) this.syncRow(row, true)
    else if (row.index >= 0) this.releaseMedia(row)
    this.emit()
  }

  /** 把这一路的媒体元素倒空（换片/出画都要它）；serial 让还在途的回调认不出自己就不再生效。 */
  private releaseMedia(row: EngineRow) {
    row.serial++
    row.index = -1
    if (row.detach) {
      const off = row.detach
      row.detach = null
      try {
        off()
      } catch (e) {
        console.warn('[replay] 卸载这一路的来源失败', row.recordingId, e)
      }
    }
    const m = row.media
    if (!m) return
    m.pause()
    m.removeAttribute('src')
    m.load()
  }

  private fail(row: EngineRow, serial: number) {
    if (serial !== row.serial || this.destroyed || row.index < 0) return
    row.failed = true
    row.media?.pause()
    this.setState(row, 'error', '这一路暂不能播放，可重试')
  }

  private async loadSegment(row: EngineRow, index: number) {
    this.releaseMedia(row)
    row.index = index
    row.failed = false
    row.blocked = false
    const span = row.spans[index]
    const serial = row.serial
    const media = row.media
    if (!span || !media) {
      this.setState(row, 'buffering', '正在加载这一路…')
      return
    }
    this.setState(row, 'buffering', '正在加载这一路…')
    const onMeta = () => {
      if (serial === row.serial) this.syncRow(row, true)
    }
    // 暂停态的一次 seek 也得把解出来的那一帧显出来：那种状态下没有动画时钟会去清占位。
    const onData = () => {
      if (serial === row.serial) this.syncRow(row)
    }
    media.onloadedmetadata = onMeta
    media.onloadeddata = onData
    media.onseeked = onData
    media.oncanplay = onData
    media.onended = onData
    media.onerror = () => this.fail(row, serial)
    try {
      if (!span.url) span.url = await this.opts.resolveUrl(row, span)
    } catch (e) {
      console.warn('[replay] 可播区取不出地址', span.segments.map((s) => s.blobKey).join(','), e)
      this.fail(row, serial)
      return
    }
    if (serial !== row.serial || this.destroyed) return
    if (this.opts.attachSource) {
      const off = this.opts.attachSource(row, span.url, media)
      if (off) row.detach = off
      return
    }
    media.src = span.url
    media.load()
  }

  /** 来源侧（如 hls.js 的致命错误）报上来的失败：走和 onerror 同一条路，界面口径一致。 */
  markSourceError(row: EngineRow, text: string) {
    if (this.destroyed || row.index < 0) return
    row.serial++
    row.failed = true
    row.media?.pause()
    this.setState(row, 'error', text)
  }

  retry(row: EngineRow) {
    this.releaseMedia(row)
    row.failed = false
    row.blocked = false
    this.syncRow(row, true)
    this.emit()
  }

  private syncRow(row: EngineRow, force = false) {
    const media = row.media
    // 装载判据只有 shouldLoad 一处：纯音轨行**不再**被无条件卸载（旧写法让"切一下布局就永久没声音"）。
    const enabled = this.shouldLoad(row)
    if (!media || !enabled) {
      if (row.index >= 0) this.releaseMedia(row)
      return
    }
    const index = this.segmentAt(row)
    if (index < 0) {
      if (row.index >= 0) this.releaseMedia(row)
      this.setState(row, 'gap', this.gapText(row))
      return
    }
    if (row.index !== index) void this.loadSegment(row, index)
    if (row.failed || row.blocked) return
    const span = row.spans[index]
    const target = Math.max(0, this.time - span.start)
    media.muted = this.muted || row.muted || !row.hasAudio
    media.playbackRate = this.rate
    if (media.readyState >= 1 && Number.isFinite(media.duration) && target >= media.duration) {
      media.pause()
      this.setState(row, 'gap', '这一片段已结束')
      return
    }
    const tolerance = this.composeMode ? 3.0 : SEEK_TOLERANCE_SEC
    // 只纠正**该纠正的**偏差。规则按三条分开写，因为"偏差"有两个方向、代价完全不同：
    //   ① 落后（元素 currentTime < 目标）：多半是解码/缓冲跟不上，**追上去**是对的 —— 找回来才不至于
    //      让这一路永远比别人慢半拍。
    //   ② 领先（元素跑在时钟前面）：**不许往回拽**。元素与时钟同源、都在实时走，领先只能是"时钟落后了"
    //      （rAF 被节流/页面被别的窗口盖住/时钟停摆），此时把画面拽回去等于每 ~1.5 秒重放一次 ——
    //      现场表现就是"一顿一顿"，音频也跟着不断重头播。只有偏差大到明显是另一次定位（`HARD_RESYNC_SEC`）
    //      才回拽。
    //   ③ 元素自己停了（paused：换片、缓冲到停、或还没起播）：按容差对齐，与旧行为一致。
    const drift = media.currentTime - target
    const stalledOrPaused = media.paused || media.readyState < 2
    const shouldSeek =
      force ||
      (media.readyState >= 1 && !media.seeking && (
        stalledOrPaused ? Math.abs(drift) > tolerance : (drift < -tolerance || drift > HARD_RESYNC_SEC)
      ))
    if (shouldSeek) {
      const upper = Number.isFinite(media.duration) ? Math.max(0, media.duration - 0.025) : target
      try {
        media.currentTime = Math.min(target, upper)
      } catch {
        /* 元数据/可播区还没到，下一帧再对齐 */
      }
    }
    if (this.playing && media.paused && !row.pending) {
      row.pending = true
      const serial = row.serial
      const attempt = media.play()
      attempt
        ?.catch((error: Error) => {
          if (serial !== row.serial || !this.playing) return
          if (error.name === 'NotAllowedError') {
            row.blocked = true
            this.setState(row, 'blocked', '浏览器暂停了这一路，请点重试')
          } else if (error.name !== 'AbortError') this.fail(row, serial)
        })
        .finally(() => {
          if (serial === row.serial) row.pending = false
        })
    } else if (!this.playing && !media.paused) media.pause()
    if (!row.failed && !row.blocked) {
      const ready = media.readyState >= 2 && !media.seeking
      if (ready) {
        row._bufferSince = 0
        this.setState(row, this.playing ? 'playing' : 'paused',
          this.playing ? '播放中' : '已暂停')
      } else {
        const now = performance.now()
        if (!row._bufferSince) row._bufferSince = now
        if (now - row._bufferSince >= 800) {
          this.setState(row, 'buffering', '正在缓冲 / 对齐…')
        }
      }
    }
  }

  sync(force = false) {
    for (const row of this.rows) this.syncRow(row, force)
    this.emit()
  }

  private updateTime(now = performance.now()) {
    if (!this.playing) return
    // **时钟不允许为负**：第一帧 rAF 回调带的时间戳可能比 `play()` 里记的锚点还早约 10ms（实测），
    // 算出来是 -0.01s。而 `segmentAt` 要 `time >= span.start`，负数会让每一路在起播那一瞬被判成
    // "此刻没有片"→ 卸载 + 报缺口（现场表现：一进去每格闪一下"尚未开始"、播放被反复打断）。
    // 时间轴 0 之前没有内容，也不存在"倒退"这回事。
    this.time = Math.max(0, Math.min(this.duration, this.anchorTime + ((now - this.anchor) / 1000) * this.rate))
  }

  /**
   * 由**外部定时器**推进一次时钟（合成专用；rAF 那条约 `animate` 照旧跑）。
   *
   * 为什么合成不能只靠 rAF：合成要陪整场实时走一遍，而用户完全可以把浏览器窗口放到后台
   * （被别的应用盖住 / 最小化）。那时 rAF 会停或被节流到 1 次/秒，而"进度"不该跟着停 ——
   * 各路媒体元素自己是**实时在播**的（媒体播放不受 rAF 管），声音也照旧在流。
   * 两条驱动同源（都按锚点 + 墙钟重算 `time`），所以叠加调用也不会双倍推进。
   */
  tick() {
    if (this.destroyed || !this.playing) return
    this.updateTime()
    this.opts.onClock?.(this.time, this.playing)
    if (this.time >= this.duration) this.pause()
  }

  private animate = (now: number) => {
    if (!this.playing || this.destroyed) return
    this.updateTime(now)
    const syncInterval = this.composeMode ? 2000 : FORCE_SYNC_MS
    if (now - this.syncAt >= syncInterval) {
      this.syncAt = now
      this.sync()
    }
    this.opts.onClock?.(this.time, this.playing)
    if (this.time >= this.duration) {
      this.pause()
      return
    }
    this.frame = requestAnimationFrame(this.animate)
  }

  play() {
    if (this.destroyed || !this.duration) return
    if (this.time >= this.duration) this.time = 0
    this.playing = true
    this.anchorTime = this.time
    this.anchor = performance.now()
    for (const r of this.rows) r.blocked = false
    this.sync(true)
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(this.animate)
    this.startTickFallback()
    this.emit()
  }

  /**
   * rAF 之外的兜底心跳：**窗口被别的应用盖住 / 最小化时 rAF 会停或被节流，但"进度"不该跟着停**
   * （各路媒体元素其实还在实时播，声音也照旧在流）。
   *
   * 2026-09-30 实测（真夹具 + 真引擎）：时钟冻在 4.41s 不动、而元素自己播到了 5.19s，此时
   * 旧的"偏差 > 容差就 seek"会把每一路反复拽回那个冻住的时刻 —— 现场就是"一顿一顿"。
   * `tick()` 与 rAF 里的算式同源（都按锚点 + 墙钟重算），叠加调用不会双倍推进；
   * 后台把定时器压到 ~1 次/秒也无所谓，进度每秒跳一格总比冻着好。
   */
  private startTickFallback() {
    if (this.tickTimer || typeof window === 'undefined') return
    this.tickTimer = window.setInterval(() => this.tick(), 250)
  }

  private stopTickFallback() {
    if (!this.tickTimer) return
    window.clearInterval(this.tickTimer)
    this.tickTimer = 0
  }

  pause() {
    this.updateTime()
    this.playing = false
    this.stopTickFallback()
    cancelAnimationFrame(this.frame)
    this.sync()
    this.emit()
  }

  toggle() {
    if (this.playing) this.pause()
    else this.play()
  }

  seek(value: number) {
    this.time = Math.max(0, Math.min(this.duration, value))
    this.anchorTime = this.time
    this.anchor = performance.now()
    this.sync(true)
    this.opts.onClock?.(this.time, this.playing)
  }

  /**
   * 拖动进度条：只搬时钟与锚点，**不逐路强制 seek**。
   * 拖动中每次 pointermove 都对全部路写 `currentTime`，会让没有 Cues 的本机 webm 反复重扫 Cluster，
   * 表现就是"一拖进度条画面就一顿一顿"。这里按 ~10Hz 做常规对齐（偏差超 1.5s 才 seek），
   * 松手时调用方再走一次 `seek()` 落到精确位置。
   */
  scrub(value: number) {
    this.time = Math.max(0, Math.min(this.duration, value))
    this.anchorTime = this.time
    this.anchor = performance.now()
    const now = performance.now()
    if (now - this.scrubSyncAt >= 100) {
      this.scrubSyncAt = now
      this.sync()
    }
    this.opts.onClock?.(this.time, this.playing)
    this.emit()
  }

  rewind() {
    this.updateTime()
    this.seek(this.time - 10)
  }

  forward() {
    this.updateTime()
    this.seek(this.time + 10)
  }

  /** 只有有画面的路进宫格；纯音轨不进格子（它们仍然按同一条时间轴出声）。
   *  去掉分页：所有画面路默认可见，visible 由页面按用户勾选驱动（`setRowVisible`）。
   *  这里只做"该卸的卸"，装载交给 `syncRow` —— 判据只有 `shouldLoad` 一处。 */
  renderLayout() {
    for (const row of this.rows) {
      if (row.index >= 0 && !this.shouldLoad(row)) this.releaseMedia(row)
    }
    this.emit()
  }

  private emit() {
    this.opts.onChange?.()
  }

  destroy() {
    this.destroyed = true
    this.stopTickFallback()
    cancelAnimationFrame(this.frame)
    for (const row of this.rows) this.releaseMedia(row)
  }
}

/** 清单里的一路 → 引擎输入：这条录制清单是唯一依据，不在这里补任何推断出来的片。 */
export function toEngineTracks(tracks: RecordedTrack[]): RecordedTrack[] {
  return tracks.filter((t) => t.segments.length > 0 || t.endOffsetSec === null)
}

/**
 * 本机清单 → 引擎输入，按**「人 × 通路」归组**（第 17 项）。
 *
 * 存储侧一条 RecordedTrack = 一次连续录制会话：同一人中途退会再入，三方会给新的 publicationId，
 * 新的 streamId，于是本机开出**另一条**清单条目。云端同样是这个形状，而 `cloudReplay.ts` 是归组后
 * 才喂引擎 —— 本机不归组的后果是 3 个人的会议在 4 宫格里开出 5 个窗格，同一人两格各自显示缺口，
 * 合成时同一张脸同时占两格。归组后中断落在**同一条 row 的两个可播区之间**，界面照实说"此时段录制中断"。
 *
 * 只做视图侧归组，**不动存储**：清单仍然是一条会话一条，原始文件仍然一次一份可单独下载（见 `sources`）。
 */
export function groupTracksByLane(tracks: RecordedTrack[]): EngineTrack[] {
  const byLane = new Map<string, RecordedTrack[]>()
  for (const t of toEngineTracks(tracks)) {
    if (!t.segments.length) continue
    const key = `${t.ownerId}\u0000${t.kind}`
    const arr = byLane.get(key)
    if (arr) arr.push(t)
    else byLane.set(key, [t])
  }
  const out: EngineTrack[] = []
  for (const arr of byLane.values()) {
    const sources = arr.slice().sort((a, b) => a.startOffsetSec - b.startOffsetSec)
    const first = sources[0]
    const last = sources[sources.length - 1]
    out.push({
      ...first,
      // 归组后的稳定标识：一个窗格背后每一次录制都在里面，界面拿它当 :key，不再拿单条会话的 id
      recordingId: `lane:${sources.map((t) => t.recordingId).join('+')}`,
      ownerId: first.ownerId,
      // 再入会时显示名可能改过，以最近那次为准
      ownerName: last.ownerName || first.ownerName,
      mediaLabel: sources.map((t) => t.mediaLabel).filter(Boolean).pop() || first.mediaLabel,
      startOffsetSec: first.startOffsetSec,
      // 任一次还没收尾（null）→ 整格算"仍在录"，不许用一个已测到的终值冒充终点
      endOffsetSec: sources.some((t) => t.endOffsetSec === null) ? null : last.endOffsetSec,
      closeReason: last.closeReason,
      closedAtMs: last.closedAtMs,
      segments: sources.flatMap((t) => t.segments.map((s) => ({ ...s, session: t.recordingId }))),
      sources,
    })
  }
  return out.sort((a, b) => a.startOffsetSec - b.startOffsetSec)
}

export function formatClock(sec: number): string {
  const n = Math.max(0, Math.floor(sec || 0))
  const h = n >= 3600 ? `${Math.floor(n / 3600)}:` : ''
  return `${h}${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
}
