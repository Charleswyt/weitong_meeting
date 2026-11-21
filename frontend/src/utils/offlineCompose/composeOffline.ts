/**
 * 离线合成编排：分片字节 → 解码 → 宫格绘制 → 编码 → 封装成一个渐进 MP4。
 *
 * 这一版是照着上一轮（`main` 分支被删掉的 `offlineExport/composeOffline.ts`）的**十条缺陷**
 * 逐条反着写的，改动前请先读那十条（计划 §一）。最关键的三条：
 *  - 它当年**根本没调 `VideoEncoder`**，仍用 `MediaRecorder` ⇒ 编码 1× 实时，"离线"只是多解一遍码；
 *  - 它把所有解码帧 `push` 进数组留到最后 ⇒ 单路 16 分钟约 20 GB，OOM 就是这么来的；
 *  - 它每路 `arrayBuffer()` 整份读 ⇒ 9 路 1.9 GB。
 * 这里对应的是：`CanvasSource` 走 `VideoEncoder`；帧**取到即画即 close**；
 * 字节走 `createRunSource` 的范围读（实测打开+读元数据只花 128 KB / 211 MB 的 0.1%）。
 *
 * 两条只在真件上才看得见的约束（S2 探针换来）：
 *  - **不许调 `computeDuration()`**：这些 webm 是"直播流形"（无 `Duration`、无 `Cues`），
 *    那一调用会把整个文件扫一遍（实测 120 秒的合成因此拉了 237 MB）。时长一律用我方 run 算。
 *  - **输出节拍 ≠ 源帧率**：必须按 `timeline` 的时间戳列表取帧（`samplesAtTimestamps`，
 *    每个包最多解一次、缺帧给 null）。拿 `samples()` 顺序喂编码器会撑爆 `maximumPacketCount`，
 *    编码器直接拒绝（实测 "has already reached the maximum packet count"）。
 */
import {
  Input, CustomSource, ALL_FORMATS, VideoSampleSink, AudioSampleSink,
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource, Quality,
  UrlSource,
  type Input as InputType, type VideoSample,
} from 'mediabunny'
import { buildLayout, fitLayout, type LayoutCell, type LayoutLane, type LayoutResult } from '../composeLayout.ts'
import { buildTimeline, chunkWindows, AAC_PACKET_SAMPLES, AAC_SAMPLE_RATE } from './timeline.ts'
import { mixChunk, splitPackets, audioChunkPlan, type MixInput } from './audioMix.ts'
import { splitRuns, createRunSource, type RunContainer } from './segmentSource.ts'
import { createDiskTarget } from './diskTarget.ts'
import type { ComposeCtl, ComposeLane, ComposeOutcome, ComposeProgress, ComposeSpec, EngineCapabilities } from './engine.ts'

const DEFAULT_FPS_OUT = 15
const DEFAULT_AUDIO_CHUNK_SEC = 15
/**
 * 停摆预算量的是**距上一次前进过了多久**，不是单个 await 的耗时（上一版挂在 rAF 上，
 * 后台标签页里连取消都失效，所以判据按已产出帧计 —— 那一版改对了，错的是"每个 await 各给 8 秒"）。
 *
 * 这一档的职责是**"别永远卡住"，不是"慢就该报错"**。上游按会话限带宽：同一场 43 容器的会
 * 在 40 分钟内连跑五次，前三次 3.57–8.24 倍速、后两次掉到 3.09 倍速并出现一次
 * "20 秒读不出一帧但流还活着"（停在 1643.2 s，那是容器**中段**不是边界）——
 * 按 20 秒判就是把限速误杀成停摆。真楔住时用户多等两分钟、期间进度条仍在、随时可取消，
 * 这个代价比"整场会只给出一半"小得多。读数见正本 §10：健康链路取帧 gap 的 p95 只有 0.18 s，
 * 而跨容器开料那一下实测最长 7.2 s —— 旧判据"每个 await 各给 8 秒"离一个合法耗时只差 0.8 秒。
 * 两个数仍只有一批样本：**再遇到误杀就往上加，别往下调**。
 */
const STALL_MS_LOCAL = 30000
const STALL_MS_REMOTE = 120000
/**
 * 开一段容器（建 Input + 读容器表）另给一档，**不跟着取帧的前进时钟折算**。
 * 从前入料阶段根本没有超时（楔住就是永远卡住），而把它塞进取帧那档会误杀：
 * 实测同一场 43 容器的会在同一台机器上连跑三次，第一次开料 20 秒内没回来（上游吞吐在变），
 * 按 20 秒判就成了 `no_decodable_video_track` —— 那是我把正常慢判成死，不是它真的坏。
 * 这一档只管"别永远卡住"，宽松是故意的。
 */
const STALL_MS_OPEN = 60000
/**
 * 预读下一段容器**试过了，实测更慢，已撤**（2026-10-09 同一场 3 路 43 容器 1976.5 s）：
 * 全预开 8.24 倍速 / 严格一段一开 3.57 倍速 / 一段 lookahead 1.84 倍速。
 * 上游是按会话限带宽的：多开一条流只是把当下真正要读的那一条饿得更狠 ——
 * 这与本次修的"43 条互相饿死"是同一件事，只是量级小一号。写下这段是为了别再试第二遍。
 */
const VIDEO_BITRATE = 2_000_000
const AUDIO_BITRATE = 128_000
/** 'reserve' 音频预留数的余量：编码器在末包之外还会多吐一包（300 秒那场实测），不给余量就 finalize 抛 */
const AUDIO_PACKET_HEADROOM = 1

/**
 * 一路在**一个容器**上的取帧状态。
 *
 * 为什么一路要有多个容器：同一个人退了再入会新起一条录制（第 17 项），而回放把"同人同通路"
 * 并成**一格**（`replayEngine.groupTracksByLane`）。口径定的是"导出所见 = 回放所见"，
 * 所以导出这一格也必须是一格 —— 代价就是内核得按时间区间把输出时间戳路由到对应容器，
 * 而不是假装一路只有一份文件。容器之间不连续，各自一条迭代器，绝不回退重解。
 */
interface VideoEntry {
  container: RunContainer
  /** 落在这段容器时间区间内的那些输出时间戳（有序） */
  timestamps: number[]
  cursor: number
  /** 在途/已成的开料（预读与前台等同一个 Promise，见 `openVideo`） */
  opening?: Promise<boolean>
  input?: InputType
  iter?: AsyncGenerator<VideoSample | null, void, unknown>
  /** 这一段此后恒为占位（读完了，或压根打不开） */
  exhausted?: boolean
}

interface AudioEntry {
  container: RunContainer
  opening?: Promise<boolean>
  input?: InputType
  sink?: AudioSampleSink
  /** 这一段已经读完并释放（窗口单调前移，此后不会再有重叠） */
  dropped?: boolean
}

interface LaneRuntime {
  lane: ComposeLane
  label: string
  videos: VideoEntry[]
  audios: AudioEntry[]
}

/** 这一路的终点：取所有容器里最晚的那个末端 */
function laneEndSec(l: ComposeLane): number {
  return l.containers.reduce((m, c) => Math.max(m, c.endSec), 0)
}

function toLayoutLane(l: ComposeLane): LayoutLane {
  return { id: l.id, hasVideo: l.hasVideo, kind: l.kind, durationSec: laneEndSec(l) }
}

/** 超时不抛错而是回 `{ok:false}`：卡住的 await 不能把整个任务钉死（实时路径那条看门狗的同位物） */
type PullResult<T> = { ok: true; value: T } | { ok: false }
async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<PullResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<PullResult<T>>((resolve) => {
    timer = setTimeout(() => { onTimeout(); resolve({ ok: false }) }, ms)
  })
  try {
    return await Promise.race([p.then((value) => ({ ok: true, value }) as PullResult<T>), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function composeOffline(
  spec: ComposeSpec,
  ctl: ComposeCtl,
  caps?: Pick<EngineCapabilities, 'maxCanvasPixels'> | null,
): Promise<ComposeOutcome> {
  const fpsOut = spec.fpsOut ?? DEFAULT_FPS_OUT
  const empty = {
    droppedAudioLanes: [] as string[], placeholderLanes: [] as ComposeOutcome['placeholderLanes'],
    skippedAnomalousLanes: [] as string[], reasons: [] as string[], unusableVideoLanes: [] as string[],
  }
  // 有容器才谈得上取料。损坏件在**入料层**（`intake.buildLanesFromRecording`）就已经拒了，
  // 这里不再判第二遍（两处各判一次迟早分叉）。一路带多个容器是**正常形状**：同一个人退了再入会
  // 新起一条录制，回放把同人同通路并成一格，导出也照那一格走 —— 所以按时间区间路由到对应容器。
  const eligible: ComposeLane[] = []
  const skipped: string[] = []
  for (const lane of spec.lanes) {
    if (lane.containers.length) eligible.push(lane)
    // 上桌的是这一路的**界面名**，不是内部 id：调用方直接把这一串拼进提示，id 用户看不懂也不该看
    else skipped.push(lane.label || lane.id)
  }
  const allSkipped = spec.lanes.length > 0 && !eligible.length
  const videoLanes = eligible.filter((l) => l.hasVideo)
  if (!videoLanes.length && !eligible.some((l) => l.hasAudio)) {
    // 全部因异常被拒 vs 一条都没勾，是两件事：前者要让用户知道"东西在，但那份文件是坏的"
    const code = allSkipped ? 'all_lanes_anomalous' : 'no_lane_selected'
    return { engine: 'offline', kind: 'failed', mime: '', ext: 'mp4', coveredSec: 0, durationSec: 0, ...empty, skippedAnomalousLanes: skipped, failureCode: code, reasons: [code] }
  }

  // —— 时间轴与几何（两侧同源的那份纯函数）——
  const timelineLanes = eligible.map((l) => ({
    id: l.id,
    hasVideo: l.hasVideo,
    hasAudio: l.hasAudio && !l.audioMuted,
    // spec.durationSec 是**上限**：不夹就等于"只能整场合成"，也没法只合前若干秒。
    // 可播区取自**这一路的全部容器**（每个容器内部再按缺口拆），顺序不敏感 —— 时间戳随后按区间路由
    runs: l.containers.flatMap((c) => splitRuns(c).map((r) => ({
      startSec: Math.min(r.startSec, spec.durationSec ?? r.startSec),
      endSec: Math.min(r.endSec, spec.durationSec ?? r.endSec),
    })).filter((r) => r.endSec - r.startSec > 1e-6)),
  }))
  const plan = buildTimeline(timelineLanes, fpsOut)
  const layoutInput = {
    lanes: videoLanes.map(toLayoutLane),
    mode: spec.mode,
    cols: spec.cols,
    cellWidth: spec.cellWidth,
    focusId: spec.focusId ?? null,
  }
  // 撞编码器上限时 fitLayout 会降格（先降缩略格、最后降主画面）。降过级必须出声 ——
  // 用户挑的是"顶部/右侧那种大主画面"，悄悄给他一个更小的主画面等于换了个产品
  const fitted = caps?.maxCanvasPixels ? fitLayout(layoutInput, caps.maxCanvasPixels) : null
  const layout: LayoutResult = fitted ? fitted.layout : buildLayout(layoutInput)
  const layoutDegraded = fitted?.degraded === true
  if (!layout.cells.length && videoLanes.length) {
    return { engine: 'offline', kind: 'failed', mime: '', ext: 'mp4', coveredSec: 0, durationSec: 0, ...empty, skippedAnomalousLanes: skipped, failureCode: 'encode_failed', reasons: ['layout_empty'] }
  }

  const runtimes: LaneRuntime[] = []
  const canvas = document.createElement('canvas')
  canvas.width = layout.canvasWidth
  canvas.height = layout.canvasHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return { engine: 'offline', kind: 'failed', mime: '', ext: 'mp4', coveredSec: 0, durationSec: 0, ...empty, skippedAnomalousLanes: skipped, failureCode: 'encode_failed', reasons: ['no_canvas_context'] }
  }
  const cellOf = new Map(layout.cells.map((c) => [c.id, c]))

  // —— 停摆预算的"上一次前进"记在这里：帧投出、窗口读完、容器开开都算流水线还在动 ——
  let lastProgressAt = Date.now()
  let maxGapMs = 0
  let cancelled = false
  // 声明在这里而不是循环里：开料那几步也要能置它（`openVideo` 的看门狗回调引用的是同一个变量）
  let stalled = false
  const touch = () => {
    const now = Date.now()
    if (now - lastProgressAt > maxGapMs) maxGapMs = now - lastProgressAt
    lastProgressAt = now
  }
  /** 预算折算成"还剩多少"：单看一次 await 会把跨容器开料那种正常耗时误判成停摆 */
  const leftMs = (budget: number) => Math.max(0, lastProgressAt + budget - Date.now())
  const budgetFor = (c: RunContainer) => (c.remoteUrl ? STALL_MS_REMOTE : STALL_MS_LOCAL)
  /** 打开中的 Input 先寄在这里：看门狗放走的那次开料晚一步也会建出 Input，收尾要还能看见它 */
  const pendingInputs = new Set<InputType>()
  const closePending = async (input: InputType) => {
    pendingInputs.delete(input)
    await input.dispose?.()
  }

  // —— 每个容器**先只登记、不打开** ——
  // 打开一个远端容器就是占一条 HTTP 连接，而浏览器对同一主机只有 6 条。从前这里一次性为
  // 43 个容器各建一个 Input，43 路顺序流互相饿死、真正要读的那一路排在队尾，
  // 于是每次跨容器边界都被判成停摆 —— 用户盘上那两份半截件分别停在 524.07 s（一段容器的末端）
  // 与下一段起点之后 3.9 s，正是这个形状。现在时间轴走到哪一段才开哪一段，读完立刻释放。
  const lanesByTs = new Map(plan.perLane.map((p) => [p.laneId, p]))
  const reasons: string[] = []
  const reportOnce = (arr: string[], label: string) => { if (!arr.includes(label)) arr.push(label) }
  for (const lane of eligible) {
    const rt: LaneRuntime = { lane, label: lane.label, videos: [], audios: [] }
    const allTs = lanesByTs.get(lane.id)?.timestamps ?? []
    for (const container of lane.containers) {
      // 这一段的输出时间戳：容器之间不连续，所以每条迭代器只喂自己区间内的那些
      const tsFor = allTs.filter((t) => t >= container.startSec - 1e-6 && t < container.endSec - 1e-6)
      if (lane.hasVideo && tsFor.length) rt.videos.push({ container, timestamps: tsFor, cursor: 0 })
      if (lane.hasAudio && !lane.audioMuted) rt.audios.push({ container })
    }
    if (rt.videos.length || rt.audios.length) runtimes.push(rt)
    else if (lane.hasVideo) reportOnce(empty.unusableVideoLanes, lane.label)
    else if (lane.hasAudio && !lane.audioMuted) reportOnce(empty.droppedAudioLanes, lane.label)
  }

  /**
   * 画面：时间轴真走到这一段才开。
   * 在途的开料挂在 `e.opening` 上而不是"开过了就回个布尔"：预读可能正开着同一段，
   * 这时前台必须**等它** —— 把在途当成失败会让整段凭空变成占位（本仓第一版惰性开料就踩了这个）。
   * 打不开、没有画面轨、开料抛错都记进 unusableVideoLanes 并标耗尽，不逐帧重试。
   */
  const openVideo = (lane: ComposeLane, e: VideoEntry): Promise<boolean> => {
    if (e.iter) return Promise.resolve(true)
    if (e.exhausted) return Promise.resolve(false)
    if (e.opening) return e.opening
    const p = (async () => {
      let sawTrack = false
      let abandoned = false
      const got = await withTimeout((async () => {
        let input: InputType | undefined
        try {
          input = new Input({ source: await makeContainerSource(lane, e.container), formats: ALL_FORMATS })
          pendingInputs.add(input)
          const track = (await input.getVideoTracks())[0]
          if (e.exhausted) {
            // 取消/出错时收尾会先跑：这一段被丢弃不是"这一路解不出来"，别报成媒体损失
            abandoned = true
            await closePending(input)
            return
          }
          if (!track) {
            // 解不出画面轨 = 这一路在成品里凭空消失。必须记账，不许静默：
            // 上一轮"443 KB 的合成视频里只有一条声轨"就是没人报这一类损失
            await closePending(input)
            return
          }
          pendingInputs.delete(input)
          e.input = input
          e.iter = new VideoSampleSink(track).samplesAtTimestamps(e.timestamps)[Symbol.asyncIterator]()
          sawTrack = true
        } catch (err) {
          // 异常名必须上桌成机器码：上一版"某一路凭空消失"查不到根，就是因为这里只记账不出声
          if (input) await closePending(input)
          reportOnce(reasons, `video_intake_failed:${errName(err)}`)
        }
      })(), STALL_MS_OPEN, () => { stalled = true })
      if (!got.ok) {
        e.exhausted = true
        reportOnce(empty.unusableVideoLanes, lane.label)
        reportOnce(reasons, 'video_open_stalled')
        return false
      }
      if (!sawTrack && !abandoned) {
        e.exhausted = true
        reportOnce(empty.unusableVideoLanes, lane.label)
      }
      if (!sawTrack) return false
      touch()
      return true
    })().finally(() => { if (e.opening === p) e.opening = undefined })
    e.opening = p
    return p
  }

  /** 读完（或打不开）就把这一段的字节源关掉 —— 连接让给下一段，这是本次改动真正要解决的问题 */
  const dropVideo = async (e: VideoEntry) => {
    e.exhausted = true
    e.cursor = e.timestamps.length
    const input = e.input
    e.input = undefined
    e.iter = undefined
    await input?.dispose?.()
  }

  /** 声音：与画面同一套惰性开料（同一份字节读两遍，代价远小于把整路常驻内存） */
  const openAudio = (lane: ComposeLane, e: AudioEntry): Promise<boolean> => {
    if (e.sink) return Promise.resolve(true)
    if (e.dropped) return Promise.resolve(false)
    if (e.opening) return e.opening
    const p = (async () => {
      let sawTrack = false
      let abandoned = false
      const got = await withTimeout((async () => {
        let input: InputType | undefined
        try {
          input = new Input({ source: await makeContainerSource(lane, e.container), formats: ALL_FORMATS })
          pendingInputs.add(input)
          const track = (await input.getAudioTracks())[0]
          if (e.dropped) {
            abandoned = true
            await closePending(input)
            return
          }
          if (!track) {
            await closePending(input)
            return
          }
          pendingInputs.delete(input)
          e.input = input
          e.sink = new AudioSampleSink(track)
          sawTrack = true
        } catch (err) {
          if (input) await closePending(input)
          reportOnce(reasons, `audio_intake_failed:${errName(err)}`)
        }
      })(), STALL_MS_OPEN, () => { stalled = true })
      if (!got.ok) {
        e.dropped = true
        reportOnce(empty.droppedAudioLanes, lane.label)
        reportOnce(reasons, 'audio_open_stalled')
        return false
      }
      if (!sawTrack && !abandoned) {
        // 音轨解不出来必须进 droppedAudioLanes：否则"合成没声音"又是一次查不到根的锅
        e.dropped = true
        reportOnce(empty.droppedAudioLanes, lane.label)
      }
      if (!sawTrack) return false
      touch()
      return true
    })().finally(() => { if (e.opening === p) e.opening = undefined })
    e.opening = p
    return p
  }

  const dropAudio = async (e: AudioEntry) => {
    e.dropped = true
    const input = e.input
    e.input = undefined
    e.sink = undefined
    await input?.dispose?.()
  }

  const disposeRuntimes = async () => {
    for (const rt of runtimes) {
      for (const e of rt.videos) await dropVideo(e)
      for (const e of rt.audios) await dropAudio(e)
    }
    for (const input of [...pendingInputs]) await closePending(input)
  }

  const audioRuntimes = runtimes.filter((r) => r.audios.length)
  const videoRuntimes = runtimes.filter((r) => r.videos.length)
  // 每路**第一段**在起跑前打开：一是让"整场一路画面都解不出来"仍然在写出任何东西之前就失败
  // （从前是入料阶段判的，什么都不预开就会交出一个纯黑宫格），二是稳态并发本来就等于路数 ——
  // 预开第一段不比"时间轴走到那一段时才开"更占连接。其余段一律按需开、读完即弃。
  let anyVideoOpened = false
  for (const rt of videoRuntimes) {
    if (ctl.isCancelled()) { cancelled = true; break }
    if (await openVideo(rt.lane, rt.videos[0])) anyVideoOpened = true
    if (cancelled || stalled) break
  }
  // 一路画面都没解出来就别往下走了：交出一个纯黑/纯声的文件，比现在报错更难查
  // （实时路径当年那颗"自检有画面也有声音"的门就是为这个立的，同一件事）
  if (videoLanes.length && !anyVideoOpened) {
    await disposeRuntimes()
    return { engine: 'offline', kind: 'failed', mime: '', ext: 'mp4', coveredSec: 0, durationSec: plan.durationSec, ...empty, skippedAnomalousLanes: skipped, placeholderLanes: [], failureCode: 'intake_failed', reasons: ['no_decodable_video_track', ...reasons] }
  }
  const chunkSec = spec.audioChunkSec ?? DEFAULT_AUDIO_CHUNK_SEC
  // 包数与实吐包数必须由同一份计划算出（详见 audioChunkPlan 的注释）：
  // 上一版按秒切块，尾包补零让 987 秒那场在 finalize() 抛掉，用户拿不到任何文件。
  const audioFramesTotal = Math.round(plan.durationSec * AAC_SAMPLE_RATE)
  const audioPlan = audioRuntimes.length
    ? audioChunkPlan(audioFramesTotal, Math.round(chunkSec * AAC_SAMPLE_RATE), AAC_PACKET_SAMPLES)
    : []
  const audioTotalPackets = audioPlan.reduce((s, a) => s + a.packets, 0)
  const audioWindowSec = audioPlan.length ? (audioPlan[audioPlan.length - 1]!.startFrame + audioPlan[audioPlan.length - 1]!.frames) / AAC_SAMPLE_RATE : 0

  // 边合成边落盘：整份产物驻留 JS 堆是 987 秒那场 683 MB 峰值的来源。
  // 这台浏览器给不出可寻址的 OPFS 写入时才退回内存目标 —— 那是能力差异，不是异常。
  const disk = await createDiskTarget(`offline-${Date.now().toString(36)}`)
  const bufferTarget = disk ? null : new BufferTarget()
  const target = disk?.target ?? bufferTarget!
  const output = new Output({
    // ⚠️ 显式设 fastStart：留空会被库按 target 类型自动落到 'in-memory'（= 全部媒体块留内存，
    // 上一轮 OOM 的新马甲）。'reserve' 单趟、moov 在前；不给 maximumPacketCount 它会直接抛。
    // 'reserve' 要回写文件头，靠的是 StreamTarget 的 chunk 带 position（可寻址），不是顺序流。
    format: new Mp4OutputFormat({ fastStart: 'reserve' }),
    target,
  })
  const canvasSource = new CanvasSource(canvas, {
    codec: 'avc',
    // 裸数字 `new Quality(2_000_000)` 会被当成 0–1 的**质量档**（越界值被允许），
    // 实测把 480×270 的输出推到 6.6 Mbps —— 客户机上比原片还大。必须走对象形式。
    bitrate: new Quality({ bitrate: VIDEO_BITRATE, bitrateMode: 'constant' }),
    keyFrameInterval: 2,
  })
  output.addVideoTrack(canvasSource, { frameRate: fpsOut, maximumPacketCount: plan.expectedVideoPackets })
  const audioSource = audioRuntimes.length
    ? new AudioBufferSource({
        codec: 'aac',
        bitrate: new Quality({ bitrate: AUDIO_BITRATE, bitrateMode: 'constant' }),
      })
    : null
  // ⚠️ 这里**不许写 `transform`**：混音出来的 AudioBuffer 本来就是 48k/立体声，
  // 而一旦给了 transform，库就把每个 buffer 过一遍 AudioResampler 重新分帧（bundle:36688），
  // 产出的包数不再等于我方 add 的次数 —— 实测 300 秒那场喂 14063 包、预留 14063，
  // finalize 仍报 "Track #2 has already reached the maximum packet count"（多出一包）。
  // 去掉后实测产出 14063 = 喂入 = 计划，余量仍留 1 包：'reserve' 只要求预留 ≥ 实吐，
  // 多留一包是几个字节，而少留一包的代价是**跑了两分钟后整场拿不到文件**。
  if (audioSource) output.addAudioTrack(audioSource, { maximumPacketCount: audioTotalPackets + AUDIO_PACKET_HEADROOM })

  let emitted = 0
  /** 实际投喂音频包的条数 —— 与 'reserve' 预留数对不上时，这个数是唯一的取证入口 */
  let audioAdded = 0
  const placeholderLanes: ComposeOutcome['placeholderLanes'] = []
  const report = (phase: ComposeProgress['phase'], coveredSec: number) =>
    ctl.onProgress({
      phase,
      ratio: plan.expectedVideoPackets ? Math.min(1, emitted / plan.expectedVideoPackets) : 0,
      coveredSec,
      doneFrames: emitted,
      expectedFrames: plan.expectedVideoPackets,
      placeholderLanes: 0,
    })

  try {
    await output.start()
    // 视频与音频共用同一批窗口：窗口由音频计划决定，才能保住"实吐包数 == 预留包数"
    const windows: Array<[number, number]> = audioPlan.length
      ? audioPlan.map((a) => [a.startFrame / AAC_SAMPLE_RATE, (a.startFrame + a.frames) / AAC_SAMPLE_RATE] as [number, number])
      : chunkWindows(plan.durationSec, chunkSec)
    for (const [c0, c1Raw] of windows) {
      if (cancelled || stalled) break
      if (ctl.isCancelled()) { cancelled = true; break }
      const c1 = Math.min(c1Raw, Math.max(plan.durationSec, audioWindowSec))
      // 进到下一个窗口本身就是前进：音频段可以合法地比单帧久（一次 15 秒窗口的取料与混音），
      // 不把预算按窗口重置就会在长音频段上误判停摆
      touch()

      // —— 视频：按输出时间戳推进，取到即画即 close ——
      const frameEnd = Math.min(c1, plan.durationSec)
      for (let t = c0; t < frameEnd - 1e-6; ) {
        if (cancelled || stalled) break
        if (ctl.isCancelled()) { cancelled = true; break }
        const idx = Math.round(t * fpsOut)
        const cells: Array<{ cell: LayoutCell; sample: VideoSample | null }> = []
        for (const rt of videoRuntimes) {
          const cell = cellOf.get(rt.lane.id)
          if (!cell) continue
          // 这一路可能横跨多个容器（同人再入会）：只有"下一个待取时间戳正好是这一刻"的那一段才出帧。
          // 其余容器在这一刻要么还没轮到、要么已经走完 —— 都画占位，**绝不跨容器回退重解**。
          let sample: VideoSample | null = null
          for (const e of rt.videos) {
            if (e.exhausted) continue
            const want = e.timestamps[e.cursor]
            if (want === undefined) { await dropVideo(e); continue }
            if (Math.abs(want - t) >= 1 / (fpsOut * 2)) continue
            // 时间轴走到这一刻才打开这一段（一个远端容器 = 一条 HTTP 连接）；
            // 开不出来已经记进 unusableVideoLanes 并标耗尽 —— 这一段此后恒为黑，
            // 按**整段**记一条占位，别让它成为"看不见的丢失"（占位清单是用户唯一能看见的口径）
            if (!(await openVideo(rt.lane, e))) {
              placeholderLanes.push({ id: rt.lane.id, fromSec: t, toSec: e.container.endSec })
              break
            }
            const iter = e.iter
            if (!iter) break
            const next = await withTimeout(iter.next(), leftMs(budgetFor(e.container)), () => { stalled = true })
            if (!next.ok) { stalled = true; break }
            const pulled = next.value
            sample = pulled.done ? null : pulled.value
            e.cursor++
            // 耗尽与"这一时刻没帧"是两回事：前者不该每帧再记一条，否则占位清单被刷满重复项
            if (sample === null) placeholderLanes.push({ id: rt.lane.id, fromSec: t, toSec: t + 1 / fpsOut })
            // 这一段读完（或迭代器自己先到头）就释放它的字节源：下一段要开始占那条连接了
            if (pulled.done === true || e.cursor >= e.timestamps.length) await dropVideo(e)
            break
          }
          if (stalled) break
          cells.push({ cell, sample })
        }
        if (stalled) { for (const c of cells) c.sample?.close(); break }   // 停摆也要关掉已解出的帧：未 close 的 VideoSample 会漏原生内存
        drawGrid(ctx, canvas.width, canvas.height, cells)
        for (const c of cells) c.sample?.close()
        if (emitted >= plan.expectedVideoPackets) break   // 实吐包数绝不超过 'reserve' 预留数（差一即抛）
        await canvasSource.add(t, 1 / fpsOut)
        emitted++
        touch()
        t = (idx + 1) / fpsOut
        if (emitted % (fpsOut * 2) === 0) report('encode', emitted / fpsOut)
      }

      // —— 音频排在视频之后：取消/停摆发生在这一块的中间时，整块的音频就不许再喂 ——
      // 先前音频先喂，取消落在视频段里会留下"音频比视频长一整块"的尾巴：
      // 实测 300 秒那场取消后 coveredSec=258.3，而容器时长 269.95 秒 —— 文件名标"只到 258 秒"、
      // 播放器却给到 270 秒，这就是口径要求的"时长说实话"没做到。
      // 现在两条轨都止于同一个位置，容器时长由**视频**决定，与 coveredSec 同源。
      if (!cancelled && !stalled && audioSource && audioRuntimes.length) {
        const inputs: MixInput[] = []
        for (const rt of audioRuntimes) {
          for (const e of rt.audios) {
            if (e.dropped) continue
            // 只取这一块与这个容器**重叠**的那一段：容器之间不连续，跨容器不能当成一整段喂
            const a0 = Math.max(c0, e.container.startSec)
            const a1 = Math.min(c1, e.container.endSec)
            if (a1 - a0 > 1e-6 && (await openAudio(rt.lane, e)) && e.sink) {
              const got = await withTimeout(
                collectLaneAudio(e.sink, rt.lane.id, a0, a1),
                leftMs(budgetFor(e.container)),
                () => { stalled = true },
              )
              if (!got.ok) break
              inputs.push(...got.value)
            }
            // 窗口单调前移：c1 一越过这一段末端，此后就不会再重叠 —— 释放它的连接给下一段
            if (c1 >= e.container.endSec - 1e-6) await dropAudio(e)
          }
          if (stalled) break
        }
        // 没有样本的窗口也必须发静音：AudioSampleSource 只认收到的包序，跳过窗口等于把时间轴
        // 压缩掉 —— 实测云端那场音频轨 297.6 s 而视频轨 386.9 s，缺口 102 s 之后的声音会整体
        // 提前，那是音画错位而不是"少一段声音"。mixChunk 空输入即整窗静音。
        const mixed = mixChunk(inputs, c0, c1)
        for (const p of splitPackets(mixed, AAC_PACKET_SAMPLES)) {
          const buf = new AudioBuffer({ sampleRate: AAC_SAMPLE_RATE, numberOfChannels: 2, length: p.numberOfFrames })
          buf.copyToChannel(p.channels[0], 0)
          buf.copyToChannel(p.channels[1], 1)
          await audioSource.add(buf)
          audioAdded++
        }
      }
    }
  } catch (e) {
    const err = e as Error
    // 错误原文只进控制台；上桌的是按 failureCode 取的一句词（AGENTS 的错误弹窗口径）
    console.error('[composeOffline] 合成中断', err?.name, err?.message, err)
    await disposeRuntimes()
    // 半截的落盘件不许留在客户机上
    await disk?.abort()
    return {
      engine: 'offline', kind: 'failed', mime: '', ext: 'mp4', coveredSec: emitted / fpsOut, durationSec: plan.durationSec,
      ...empty, skippedAnomalousLanes: skipped, placeholderLanes,
      failureCode: 'encode_failed', reasons: [`offline_error:${err?.name ?? 'unknown'}`],
    }
  }

  const coveredSec = emitted / fpsOut
  // 停摆预算的两个数（8 s / 20 s）是"实测没撞到过"的量级而不是标定值 —— 这行留的就是标定素材：
  // 一次跑完的最大取料间隔离预算还有多少余量，看这一条就知道该不该收（计划 P1 的 S2 项）
  console.info('[composeOffline] 取料最大间隔 %d ms（本机预算 %d / 远端预算 %d）',
    maxGapMs, STALL_MS_LOCAL, STALL_MS_REMOTE)
  // 取消/停摆时**不叫 output.cancel()**：cancel 之后那个 'reserve' 预留的 moov 是空的，
  // 交出来的会是个坏文件。停在这里直接 finalize，得到的就是"只到第 N 秒"的合法短文件 ——
  // 与实时路径同一口径（半截件照给，但时长/文件名都得说实话）。
  let finalizeFailed = false
  let finalizeErrName = ''
  try {
    await output.finalize()
  } catch (e) {
    // 上一轮的缺陷里就有"错误路径 resolve(null) ⇒ 报绿不报错"：这里不许再吞一次。
    // 原文只进控制台，上桌的是机器码 + 异常名（`check:copy` 不看 reasons）
    const err = e as Error
    finalizeErrName = err?.name ?? 'unknown'
    console.error('[composeOffline] finalize 失败', err?.name, err?.message, {
      audioAdded, audioReserved: audioTotalPackets, videoEmitted: emitted, videoReserved: plan.expectedVideoPackets,
    })
    finalizeFailed = true
  } finally {
    await disposeRuntimes()
  }
  if (finalizeFailed) {
    await disk?.abort()
    return { engine: 'offline', kind: 'failed', mime: '', ext: 'mp4', coveredSec, durationSec: plan.durationSec, ...empty, skippedAnomalousLanes: skipped, placeholderLanes, failureCode: 'mux_failed', reasons: [`finalize_failed:${finalizeErrName}:a${audioAdded}/${audioTotalPackets}:v${emitted}/${plan.expectedVideoPackets}`] }
  }

  // 落盘那一路：产物是磁盘后备的 File，直接交给下载，不在 JS 侧再复制一份。
  // 内存那一路 finalize 前 buffer 恒为 null（官方注释写明），拿到 null 就是没写出来 ——
  // 这种情况交不出文件，必须报失败，不许拿 null 拼一个 0 字节的"视频"给用户。
  let blob: Blob | null = null
  if (disk) blob = disk.bytesWritten() > 0 ? await disk.finish() : null
  else if (bufferTarget?.buffer) blob = new Blob([bufferTarget.buffer], { type: 'video/mp4' })
  if (!blob) {
    await disk?.abort()
    return { engine: 'offline', kind: 'failed', mime: '', ext: 'mp4', coveredSec, durationSec: plan.durationSec, ...empty, skippedAnomalousLanes: skipped, placeholderLanes, failureCode: 'mux_failed', reasons: ['no_output_bytes'] }
  }
  report('wrap', coveredSec)
  return {
    engine: 'offline',
    kind: cancelled ? 'cancelled' : stalled ? 'stalled' : 'ok',
    blob,
    mime: 'video/mp4',
    ext: 'mp4',
    coveredSec,
    durationSec: plan.durationSec,
    ...empty,
    skippedAnomalousLanes: skipped,
    placeholderLanes,
    reasons: [
      ...(cancelled ? ['user_cancelled'] : stalled ? ['stalled'] : []),
      ...(layoutDegraded ? ['layout_degraded'] : []),
    ],
  }
}

/**
 * 一个容器 → mediabunny 的读源。两条形状：
 * - **本机**：一份文件被分片切成多个字节区间，用 `CustomSource` 按区间取（`fetchSlice` 背后是 IndexedDB）。
 * - **云端**：一条发布就是一个远端文件。后端不支持 Range，所以走 `UrlSource` 的**顺序流读**；
 *   件是 faststart（`moov` 在前，实测 3/3），先读表再顺流取样本正好是单趟前向读。
 *   令牌用请求头而不是 `?token=` —— 票参会进 URL，落进访问日志与浏览器历史。
 */
/** 只取异常名当机器码后缀：原文里可能带 URL 与令牌，绝不上桌也不进日志 */
function errName(e: unknown): string {
  return (e as { name?: string } | null)?.name || 'unknown'
}

async function makeContainerSource(lane: ComposeLane, container: RunContainer): Promise<CustomSource | UrlSource> {
  if (container.remoteUrl) {
    const token = localStorage.getItem('weitong.token') || ''
    return new UrlSource(container.remoteUrl, {
      requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
      maxCacheSize: 8 << 20,
    })
  }
  if (!lane.fetchSlice) throw new Error('intake_missing_fetchSlice')
  const reader = createRunSource({ totalBytes: container.totalBytes, slices: container.slices, fetchSlice: lane.fetchSlice })
  return new CustomSource({
    getSize: () => container.totalBytes,
    read: (start, end) => reader.read(start, end),
    maxCacheSize: 8 << 20,
    prefetchProfile: 'fileSystem',
  })
}

/** 取这一路在 [c0,c1) 内的音频，立刻 copyTo 成 Float32 并 close —— 不留 AudioSample 过夜 */
async function collectLaneAudio(sink: AudioSampleSink, laneId: string, c0: number, c1: number): Promise<MixInput[]> {
  const inputs: MixInput[] = []
  for await (const s of sink.samples(c0, c1)) {
    if (!s) continue
    const startSec = s.timestamp ?? c0
    const channels: Float32Array[] = []
    for (let plane = 0; plane < s.numberOfChannels; plane++) {
      const bytes = s.allocationSize({ planeIndex: plane, format: 'f32-planar' })
      const dest = new Float32Array(bytes / 4)
      s.copyTo(dest, { planeIndex: plane, format: 'f32-planar' })
      channels.push(dest)
    }
    // 一条路的每个解码分片各成一个输入（mixChunk 按绝对时间铺），所以这里的 laneId 带分片时刻
    inputs.push({ laneId: `${laneId}@${startSec.toFixed(3)}`, startSec, channels, sampleRate: s.sampleRate })
    s.close()
  }
  return inputs
}

/** 宫格绘制：空格画暗底 + 首字，**绝不拿上一帧冒充"还在录"**（仓库硬口径） */
function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, cells: Array<{ cell: LayoutCell; sample: VideoSample | null }>): void {
  ctx.fillStyle = '#0b1220'
  ctx.fillRect(0, 0, w, h)
  for (const { cell, sample } of cells) {
    if (!cell) continue
    if (!sample) continue
    const vw = sample.visibleRect?.width || sample.codedWidth || cell.w
    const vh = sample.visibleRect?.height || sample.codedHeight || cell.h
    const scale = Math.min(cell.w / vw, cell.h / vh)
    const dw = Math.round((vw * scale) / 2) * 2
    const dh = Math.round((vh * scale) / 2) * 2
    sample.draw(ctx, cell.x + (cell.w - dw) / 2, cell.y + (cell.h - dh) / 2, dw, dh)
  }
}
