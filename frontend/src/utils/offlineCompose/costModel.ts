/**
 * 离线合成的成本模型与选引擎判据（纯函数，`node scratch/verify-cost.ts` 跑真源）。
 *
 * 为什么要有这个文件：上一轮把"离线一定更快"当前提写进了方案与界面文案，结果那条前提
 * 在高档位多路场景是**反的**。成本是结构性的：
 *
 *   解码需求 = Σ(每路源帧率) 帧/秒        ← 由**录制档位**决定；帧间依赖 ⇒ 输出降到 15fps
 *                                            也省不掉，源 25fps 就得全解
 *   编码需求 = 输出帧率 帧/秒，单帧代价随画布像素上升
 *   离线墙钟 ≈ max( 总帧数 ÷ 解码聚合吞吐 , 输出帧数 ÷ 编码吞吐 )
 *   实时墙钟 ≡ 时长，但它**同样要解这些帧**，只是摊在时长里 ⇒
 *            Σ源帧率 > 解码聚合吞吐时实时**静默丢内容帧**（产物看着完整、内容缺帧）
 *
 * 〔2026-10-08 S2 实测校正〕形状不是"按像素"而是"按帧"：602×360 那路解码 688 fps，
 * 720p 那几路 676–886 fps —— 几乎与像素无关。而**并发时吞吐是共享池**：
 * 3 路同时解只有聚合 323 fps（每路等效 108）。所以这里的主常数按帧写。
 *
 * 选引擎也不能只看快：离线不占前台、可换页面（用户 2026-10-08 定），所以**等速也该选它**；
 * 反过来，实时一旦喂不过来，它的产物是缺内容的完整文件 —— 那时离线再慢也是唯一正确的选择。
 */

export interface ThroughputConstants {
  /** 单路顺序解码吞吐（帧/秒）。实测 676–886，取保守值 */
  decodeSingleFps: number
  /** 多路并发的**聚合**解码吞吐（帧/秒）。实测 3 路并发 = 323，待 K 扫描修正 */
  decodeAggregateFps: number
  /** 编码的每帧上限（帧/秒）：画布再小也快不过它。实测 480×270 → 177 */
  encodeCapFps: number
  /** 编码的大画布段吞吐（Mpx/秒）：实测 1440×810 → 100fps ≈ 117 Mpx/s */
  encodeMpxPerSec: number
  /**
   * 只有在这些数由**真实源、可见标签页**标定过之后才允许写 true。
   * 现值来自 2026-10-08 一轮 hidden 页的真件测量：链路与形状可信，绝对值偏保守。
   */
  calibrated: boolean
}

export const MEASURED_THROUGHPUT: ThroughputConstants = {
  decodeSingleFps: 676,
  decodeAggregateFps: 320,
  encodeCapFps: 177,
  encodeMpxPerSec: 117,
  calibrated: false,
}

/** 兼容旧名：占位值就是这轮实测值，calibrated 仍是 false */
export const PROVISIONAL_THROUGHPUT = MEASURED_THROUGHPUT

export interface CostLane {
  id: string
  hasVideo: boolean
  /** 源实测像素（清单 D9 的 width/height；取不到不许拿设置页档位充数） */
  width: number
  height: number
  /** 源帧率（清单 D9 的 frameRate） */
  frameRate: number
}

export interface CostInput {
  lanes: CostLane[]
  /** 进画面的路（三档只解这些；只勾声音的路不解视频） */
  videoLaneIds: string[]
  durationSec: number
  layout: { canvasWidth: number; canvasHeight: number }
  fpsOut: number
  /** 等待预算（秒）：超过它且实时可行就不硬跑离线 */
  waitBudgetSec?: number
}

export interface CostEstimate {
  decodeFrames: number
  encodeFrames: number
  /** Σ 每路源帧率 —— 实时必须达到的聚合解码速率（帧/秒） */
  realtimeRequiredDecodeFps: number
  /** 需要的聚合解码吞吐 ÷ 可用聚合吞吐：>1 就是实时喂不过来 */
  decodeLoadRatio: number
  /** 编码单帧代价（帧/秒），随画布像素上升 */
  encodeFps: number
  estDecodeSec: number
  estEncodeSec: number
  estOfflineSec: number
  /** 实时会不会静默丢内容（留 20% 余量，与口径 §9.2 护栏 a 同一条判据） */
  realtimeWouldDropFrames: boolean
  /** 离线预计 / 会议时长，用于日志与判据（>1 就是比实时慢） */
  offlineOverDuration: number
  machineCodes: string[]
}

const MPX = 1e6
/** 实时解码只留 80% 余量：不给编码与主线程留余量的实测会一路掉帧 */
const REALTIME_HEADROOM = 0.8
const DEFAULT_WAIT_BUDGET_SEC = 45 * 60

function mpx(w: number, h: number): number {
  return Math.max(0, w) * Math.max(0, h) / MPX
}

/** 编码吞吐：小画布撞到每帧上限封顶，大画布按像素吞吐掉 */
function encodeFpsFor(canvasWidth: number, canvasHeight: number, tp: ThroughputConstants): number {
  const byPixels = tp.encodeMpxPerSec > 0 ? tp.encodeMpxPerSec / Math.max(0.01, mpx(canvasWidth, canvasHeight)) : 0
  return Math.min(tp.encodeCapFps, byPixels)
}

export function estimateCost(input: CostInput, tp: ThroughputConstants): CostEstimate {
  const byId = new Map(input.lanes.map((l) => [l.id, l]))
  const video = input.videoLaneIds.map((id) => byId.get(id)).filter((l): l is CostLane => !!l && l.hasVideo)
  const durationSec = Math.max(0, input.durationSec)
  const fpsOut = input.fpsOut > 0 ? input.fpsOut : 15

  const decodeFrames = video.reduce((s, l) => s + Math.max(0, l.frameRate) * durationSec, 0)
  const realtimeRequiredDecodeFps = video.reduce((s, l) => s + Math.max(0, l.frameRate), 0)
  const decodeLoadRatio = tp.decodeAggregateFps > 0 ? realtimeRequiredDecodeFps / tp.decodeAggregateFps : Infinity

  const encodeFrames = Math.ceil(durationSec * fpsOut)
  const encodeFps = encodeFpsFor(input.layout.canvasWidth, input.layout.canvasHeight, tp)

  const estDecodeSec = tp.decodeAggregateFps > 0 ? decodeFrames / tp.decodeAggregateFps : Infinity
  const estEncodeSec = encodeFps > 0 ? encodeFrames / encodeFps : Infinity
  // 解码与编码是同一条流水线的两端，墙钟取较大的那一端 —— 路数一多两端会互换
  const estOfflineSec = Math.max(estDecodeSec, estEncodeSec)

  const machineCodes: string[] = []
  if (!video.length) machineCodes.push('no_video_lane')
  if (!tp.calibrated) machineCodes.push('throughput_uncalibrated')
  if (tp.decodeAggregateFps <= 0 || tp.encodeCapFps <= 0) machineCodes.push('throughput_missing')

  return {
    decodeFrames: Math.round(decodeFrames),
    encodeFrames,
    realtimeRequiredDecodeFps: Math.round(realtimeRequiredDecodeFps * 10) / 10,
    decodeLoadRatio: Math.round(decodeLoadRatio * 1000) / 1000,
    encodeFps: Math.round(encodeFps),
    estDecodeSec: Math.round(estDecodeSec),
    estEncodeSec: Math.round(estEncodeSec),
    estOfflineSec: Math.round(estOfflineSec),
    realtimeWouldDropFrames: decodeLoadRatio > REALTIME_HEADROOM,
    offlineOverDuration: durationSec > 0 ? estOfflineSec / durationSec : 0,
    machineCodes,
  }
}

export type Engine = 'offline' | 'realtime'

export interface EngineChoice {
  engine: Engine
  /** 机器码，界面据此取词；不许把这些串直接上桌 */
  reasons: string[]
  estimate: CostEstimate
}

/**
 * 护栏 (d)：合成前问一句"这台电脑还放得下这份产物吗"。
 *
 * ⚠️ **与计划正本 §八之五 (d) 那条公式有意不同**：正本写的是 `Σ原片字节 + 预计产物 ≤ 可用 × 50%`，
 * 但 `navigator.storage.estimate()` 的 `available = quota − usage`，**原片本来就已经在 usage 里了** ——
 * 再加一次等于把同一份字节算两遍。原片通常是产物的 15–60 倍，照那个式子会把明明放得下的任务拒掉，
 * 而"拒绝一个磁盘服务得了的任务"比"少留一点余量"更坏。所以这里只按**产物**比，仍保留 50% 的地板。
 * 这条偏离已回写契约 ADR-0069。
 *
 * 产物大小按编码侧的**恒定码率**算（`bitrateMode: 'constant'`，见 composeOffline），
 * 所以这个上界是实的，不是猜的换算系数。
 */
export function planDiskGuard(input: {
  durationSec: number
  hasVideo: boolean
  hasAudio: boolean
  availableBytes: number
}): { ok: boolean; productBytes: number } {
  const bps = (input.hasVideo ? PRODUCT_VIDEO_BPS : 0) + (input.hasAudio ? PRODUCT_AUDIO_BPS : 0)
  const productBytes = Math.ceil((bps * Math.max(0, input.durationSec)) / 8)
  return { ok: productBytes <= input.availableBytes * 0.5, productBytes }
}

/** 与 composeOffline 的 `VIDEO_BITRATE`/`AUDIO_BITRATE` 同一组数（那边是恒码率，这里照它估产物大小） */
export const PRODUCT_VIDEO_BPS = 2_000_000
export const PRODUCT_AUDIO_BPS = 128_000

/**
 * 选引擎，按顺序短路（口径 §9.3）。
 * 第 2 条的优先级高于"快不快"：实时喂不过来时它的产物是**缺内容的完整文件**，
 * 那是最难查的一类坏件；离线多花的那些分钟买回的是内容完整 + 不用守着页面。
 */
export function pickEngine(
  input: CostInput,
  tp: ThroughputConstants,
  caps: { offlineCapable: boolean },
): EngineChoice {
  const est = estimateCost(input, tp)
  // 所有出口都走这一个函数：机器码不许在某条分支上被漏掉。
  // `throughput_uncalibrated` 漏过一次，症状是"界面和日志都看不出这个预估是猜的"。
  const choose = (engine: Engine, why: string[]): EngineChoice => ({
    engine,
    reasons: [...why, ...est.machineCodes],
    estimate: est,
  })

  if (!caps.offlineCapable) return choose('realtime', ['no_offline_capability'])
  if (!est.decodeFrames) return choose('offline', ['no_video_to_compose'])

  const waitBudget = Math.min(
    input.waitBudgetSec ?? DEFAULT_WAIT_BUDGET_SEC,
    // 等速也算达标（离线不占前台），但不许无上限地慢：预算 = min(2×时长, 45 分钟)
    2 * input.durationSec,
  )

  if (est.realtimeWouldDropFrames) {
    const why = ['realtime_decode_starved']
    // 实时这一刻会丢内容 ⇒ 没有第二条路，超预算也不退
    if (est.estOfflineSec > waitBudget) why.push('offline_over_budget_but_realtime_broken')
    return choose('offline', why)
  }

  if (est.estOfflineSec <= waitBudget) return choose('offline', ['offline_within_budget'])

  // 默认引擎已翻到离线（2026-10-09 用户定的，**明确跳过 §9.3 那道"可见页面标定"门**）：
  // 超预算不再退回实时 —— 实时喂不过来时产的是"缺内容的完整文件"，那是最难查的一类坏件。
  // `throughput_uncalibrated` 这条机器码**保留**：绝对值仍是 hidden 页猜的，界面与日志必须看得出来。
  return choose('offline', ['offline_over_budget'])
}
