/**
 * 离线合成的时间轴规划（纯函数，`node scratch/verify-timeline.ts` 直接跑真源）。
 *
 * 它解决两件上一轮没解决的事：
 *
 * 1. **缺口不去解码**。上一版把所有路的所有帧全解出来堆在内存里（`composeOffline.ts:251` 那个
 *    `frames.push(...)` 是 OOM 的主因）。这里按输出时刻逐路判"这一刻有没有可播区覆盖"，
 *    没有就**不给它生成取帧请求**，只画占位 —— 断流的那一路因此不会白解几千帧，
 *    而"此刻没有画面"由 `absent` 明说，不许拿重复末帧填平（AGENTS 的硬口径）。
 *
 * 2. **包数先于编码确定**。`fastStart: 'reserve'` 要求在 `addVideoTrack/addAudioTrack` 的
 *    metadata 里给 `maximumPacketCount`（mediabunny JSDoc：requires knowledge about the expected
 *    length beforehand，且**所有轨**都要给）。所以这个数必须在这里由时长×帧率与 AAC 的
 *    1024 样本节拍算死，不能等编完再算。
 *
 * 时间基准只认**容器自己的时间码**（正本 §7 第六轮的结论：清单 offset 来自墙钟，与编码器时钟的
 * 漂移从未测出有效数）。这里的 `runs` 用哪个源由调用方决定，本文件不猜也不校准 ——
 * 校准是探针出数之后的事（S2 门禁 #1）。
 */

/** 半开区间 [startSec, endSec)：一路录制里的一个可播区（连续分片拼成的一段能播的字节） */
export interface TimelineRun {
  startSec: number
  endSec: number
}

export interface TimelineLane {
  id: string
  hasVideo: boolean
  hasAudio: boolean
  /** 用户勾掉这一路的声音（有音频但不进混音） */
  audioMuted?: boolean
  runs: TimelineRun[]
}

/**
 * 占位的三种成因，与回放页那三个标签一一对应（AGENTS：尚未开始 / 录制中断 / 此路录制已结束）。
 * 机器码不是文案：界面按码取词，别把这三个字符串直接上桌。
 */
export type AbsentKind = 'not_started' | 'gap' | 'ended'

export interface AbsentInterval {
  kind: AbsentKind
  fromSec: number
  toSec: number
}

export interface LaneVideoPlan {
  laneId: string
  /** 这一刻该路要取帧（单调递增，喂 `VideoSampleSink.samplesAtTimestamps`） */
  timestamps: number[]
  absent: AbsentInterval[]
}

export interface TimelinePlan {
  fps: number
  /** 选中路的最大跨度终点；全场时间轴就到这儿 */
  durationSec: number
  /** 全局输出时间戳（宫格合成走的就是这一条，所有路共用） */
  frameTimestamps: number[]
  perLane: LaneVideoPlan[]
  /** 进度分母：所有路需要取的帧数之和（不是"格子数×帧数"，缺口不计） */
  expectedSampleFetches: number
  /** 视频轨的 composite 帧数 = 输出时间戳条数 */
  expectedVideoPackets: number
  /** 音频轨包数（AAC 每包 1024 样本 @48k） */
  expectedAudioPackets: number
  audioSampleRate: number
  audioPacketSamples: number
  warnings: string[]
}

/** 浮点边界容差：一片的 endSec 与下一片的 startSec 实测会差出 1e-9 量级 */
const EPS = 1e-6

export const AAC_SAMPLE_RATE = 48000
export const AAC_PACKET_SAMPLES = 1024

function clampSec(v: number): number {
  return Math.max(0, v)
}

/** 取整到微秒，避免 `i/fps` 的浮点尾数让同一路在两处算出不同时刻 */
function quantize(t: number): number {
  return Math.round(t * 1e6) / 1e6
}

function normalizeRuns(runs: TimelineRun[]): TimelineRun[] {
  return runs
    .filter((r) => r.endSec - r.startSec > EPS)
    .map((r) => ({ startSec: clampSec(r.startSec), endSec: clampSec(r.endSec) }))
    .sort((a, b) => a.startSec - b.startSec)
    .reduce<TimelineRun[]>((acc, r) => {
      const last = acc[acc.length - 1]
      // 相邻/重叠的合成一段：分片本来就是首尾相接的，留着会把每一片都当成"一次覆盖"
      if (last && r.startSec <= last.endSec + EPS) {
        last.endSec = Math.max(last.endSec, r.endSec)
        return acc
      }
      acc.push(r)
      return acc
    }, [])
}

function coveredBy(runs: TimelineRun[], t: number): boolean {
  return runs.some((r) => t >= r.startSec - EPS && t < r.endSec - EPS)
}

/**
 * 一路在 [0, durationSec) 里"没有画面"的三段成因。
 * 起点不齐**不算**不完整（那是中途入会，本来就从那一刻才有画面），所以 not_started 是如实呈现，
 * 不是缺陷标记 —— 两者别混。
 */
function absentIntervals(runs: TimelineRun[], durationSec: number): AbsentInterval[] {
  if (!runs.length) return [{ kind: 'gap', fromSec: 0, toSec: durationSec }]
  const out: AbsentInterval[] = []
  const first = runs[0]!
  if (first.startSec > EPS) out.push({ kind: 'not_started', fromSec: 0, toSec: quantize(first.startSec) })
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1]!
    const cur = runs[i]!
    if (cur.startSec - prev.endSec > EPS) {
      out.push({ kind: 'gap', fromSec: quantize(prev.endSec), toSec: quantize(cur.startSec) })
    }
  }
  const last = runs[runs.length - 1]!
  if (durationSec - last.endSec > EPS) {
    out.push({ kind: 'ended', fromSec: quantize(last.endSec), toSec: quantize(durationSec) })
  }
  return out
}

export function buildTimeline(lanes: TimelineLane[], fps: number): TimelinePlan {
  const warnings: string[] = []
  const active = lanes.filter((l) => l.hasVideo || l.hasAudio)
  const safeFps = fps > 0 ? fps : 15
  if (!active.length) warnings.push('no_lane_selected')

  const per = active.map((l) => ({ laneId: l.id, runs: normalizeRuns(l.runs) }))
  const ends = per.flatMap((p) => p.runs.map((r) => r.endSec))
  const durationSec = ends.length ? quantize(Math.max(...ends)) : 0
  if (durationSec <= 0) warnings.push('zero_duration')

  const frameCount = Math.ceil(durationSec * safeFps)
  const frameTimestamps: number[] = []
  for (let i = 0; i < frameCount; i++) frameTimestamps.push(quantize(i / safeFps))

  const perLane: LaneVideoPlan[] = per.map((p) => {
    const lane = active.find((l) => l.id === p.laneId)!
    const timestamps = lane.hasVideo ? frameTimestamps.filter((t) => coveredBy(p.runs, t)) : []
    return { laneId: p.laneId, timestamps, absent: lane.hasVideo ? absentIntervals(p.runs, durationSec) : [] }
  })

  const expectedSampleFetches = perLane.reduce((s, p) => s + p.timestamps.length, 0)
  const audioPackets = Math.ceil((durationSec * AAC_SAMPLE_RATE) / AAC_PACKET_SAMPLES)

  return {
    fps: safeFps,
    durationSec,
    frameTimestamps,
    perLane,
    expectedSampleFetches,
    expectedVideoPackets: frameTimestamps.length,
    expectedAudioPackets: audioPackets,
    audioSampleRate: AAC_SAMPLE_RATE,
    audioPacketSamples: AAC_PACKET_SAMPLES,
    warnings,
  }
}

/** 音频分块窗口：混音按 10–20 秒一块推进，一块之内解码→混→编→释放（正本 §7 第四轮的流式要求） */
export function chunkWindows(durationSec: number, chunkSec: number): Array<[number, number]> {
  const size = chunkSec > 0 ? chunkSec : 15
  const out: Array<[number, number]> = []
  for (let start = 0; start < durationSec; start += size) {
    out.push([quantize(start), quantize(Math.min(start + size, durationSec))])
  }
  return out
}
