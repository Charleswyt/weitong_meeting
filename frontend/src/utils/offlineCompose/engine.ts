/**
 * 合成引擎的唯一对外契约：视图只 import 这个文件，不关心下面跑的是离线还是实时。
 *
 * 为什么要抽这一层（上一轮的教训）：`main` 那版把"离线"做成了第二个入口 + 双份 UI 状态，
 * 回退时只能整块删掉；这次两条路共用同一个 spec/progress/outcome 形状，
 * 换引擎是**实现细节**，界面、进度、取消、半截件标注都不跟着分叉。
 *
 * 三条不许改回去的口径：
 * - 界面只一个"合成"按钮，引擎由 `pickComposeEngine` 按成本模型选（等速也选离线）。
 * - 自动降级/切换**必须如实一句话**，不许静默换实现（口径 §9.3 第 4 条）。
 * - 失败与降级只回**机器码**，中文文案在视图取词；`DOMException`/库名/码流术语不许上桌。
 */
import { buildLayout, type LayoutLane, type LayoutMode } from '../composeLayout.ts'
import { pickEngine, estimateCost, MEASURED_THROUGHPUT, type CostLane, type Engine, type ThroughputConstants } from './costModel.ts'
import type { RunContainer } from './segmentSource.ts'

export type { Engine }

/** 一条参与合成的路。画面与声音是两个独立维度，所以 hasVideo/hasAudio/audioMuted 分开 */
export interface ComposeLane {
  id: string
  label: string
  hasVideo: boolean
  hasAudio: boolean
  /** 用户勾掉这一路的声音（路还在画面里，但不进混音） */
  audioMuted?: boolean
  kind?: 'camera' | 'screen' | 'microphone'
  /**
   * 这一格的容器列表（一个容器 = 一份自包含的媒体文件）。
   * **多个容器是正常形状**：同一个人退了再入会留下两条录制，回放按 `ownerId+kind` 并成一格，
   * 导出照同一格走（内核按时间区间路由到对应容器）。
   * 要防的是**同一个容器内部**片号回绕/同一片两次 —— 那是并写坏件，入料层已经拒掉，不会到这里。
   */
  containers: RunContainer[]
  /** 取一片的字节；本机那路由 localRecorder 注入（测试可给内存 Map）。云端那路不用它，见 `RunContainer.remoteUrl` */
  fetchSlice?: (blobKey: string) => Promise<ArrayBuffer | Uint8Array | null>
  /** 采集侧实测解码参数（清单 D9）。取不到就留 null，不许拿设置页档位充数 */
  width: number | null
  height: number | null
  frameRate: number | null
  sampleRate: number | null
  channelCount: number | null
  mime: string
}

export interface ComposeSpec {
  lanes: ComposeLane[]
  mode: LayoutMode
  cols?: number
  /** 指定主画面；null = 自动（共享屏幕优先） */
  focusId?: string | null
  /** 输出帧率。归档默认 15 —— 抬高它只增加编码量，救不了解码 */
  fpsOut?: number
  /** 单格宽（宫格档）；撞编码器上限时会自动降，见 fitLayout */
  cellWidth?: number
  /** 全场时长（秒）；由调用方按 run 的并集算，缺则取各路最大终点 */
  durationSec?: number
  /** 混音分块宽度（秒）：一块内解码→混→编→释放，绝不整段常驻 */
  audioChunkSec?: number
}

export interface ComposeProgress {
  phase: 'intake' | 'encode' | 'wrap'
  /** 0–1；按**已产出帧**算，第一帧就动，不可能停在 0%（上一轮停在 0% 直到崩） */
  ratio: number
  coveredSec: number
  doneFrames: number
  expectedFrames: number
  /** 已丢弃/占位的路数，界面用来写"有 N 路此刻没有画面" */
  placeholderLanes: number
}

export type ComposeFailureCode =
  | 'no_video_encoder'
  | 'no_lane_selected'
  | 'all_lanes_anomalous'
  | 'intake_failed'
  | 'encode_failed'
  | 'mux_failed'
  | 'out_of_budget'

export interface ComposeOutcome {
  engine: Engine
  kind: 'ok' | 'cancelled' | 'stalled' | 'failed'
  blob?: Blob
  mime: string
  ext: string
  /** 产物实际覆盖到的内容秒数。停摆/取消时这是唯一可信的长度，**不许拿墙钟或时长补尾巴** */
  coveredSec: number
  /** 容器里声明的时长（可能比 coveredSec 长 —— 半截件必须按 coveredSec 标注文件名） */
  durationSec: number
  /** 没接上声音的路（实时侧的老字段 `droppedAudioPanes` 的同位物） */
  droppedAudioLanes: string[]
  /** 某段时间没有画面的路 + 区间，界面/日志用来如实说明 */
  placeholderLanes: Array<{ id: string; fromSec: number; toSec: number }>
  /**
   * 有异常（多容器/片号回绕/同一个键两片）而被跳过的路，装的是**界面名**（`label`）不是内部 id：
   * 这一串要原样进提示，用户看得懂的只有名字。一条都不许静默吞掉 —— 少几路的成品和报错是两件事。
   */
  skippedAnomalousLanes: string[]
  /** 打开了但解不出画面轨的路 —— 它会在成品里凭空消失，必须报出来而不是少一格 */
  unusableVideoLanes: string[]
  failureCode?: ComposeFailureCode
  /** 选引擎的理由（机器码），日志与"为什么这场走了实时"的取词依据 */
  reasons: string[]
}

export interface ComposeCtl {
  onProgress: (p: ComposeProgress) => void
  cancel: () => void
  isCancelled: () => boolean
}

/** 浏览器能力快照。⚠️ 必须 `await` 真探测，上一版的 `supportsCodec` 只判断方法存在 = 假门 */
export interface EngineCapabilities {
  offlineCapable: boolean
  webcodecsPresent: boolean
  avcEncodeSupported: boolean
  aacEncodeSupported: boolean
  /** 编码器能吃下的最大画布面积（由 `canEncodeVideo` 二分试出来），0 = 探不出来 */
  maxCanvasPixels: number
}

const QUALITY_PROBE_BITRATE = 2_000_000

/** 二分找"这个面积还能编"的最大值 —— 口径 §9.2 护栏 (b) 靠它，而不是靠猜一个分辨率 */
async function probeMaxCanvas(fps: number): Promise<number> {
  const mb = await import('mediabunny')
  // 码率同样必须走对象形式，理由见 probeEngineCapabilities 里那条注释
  const quality = new mb.Quality({ bitrate: QUALITY_PROBE_BITRATE, bitrateMode: 'constant' })
  const fits = async (w: number, h: number) => {
    try {
      return await mb.canEncodeVideo('avc', { width: w, height: h, frameRate: fps, quality })
    } catch { return false }
  }
  let lo = 640
  let hi = 4096
  const hOf = (w: number) => Math.round((w * 9) / 16 / 2) * 2
  if (!(await fits(lo, hOf(lo)))) return 0
  for (let i = 0; i < 12; i++) {
    const mid = Math.round((lo + hi) / 2 / 2) * 2
    if (await fits(mid, hOf(mid))) lo = mid
    else hi = mid - 2
  }
  return lo * hOf(lo)
}

export async function probeEngineCapabilities(fpsOut = 15): Promise<EngineCapabilities> {
  const webcodecsPresent = typeof globalThis.VideoEncoder !== 'undefined' && typeof globalThis.VideoDecoder !== 'undefined'
  if (!webcodecsPresent) {
    return { offlineCapable: false, webcodecsPresent: false, avcEncodeSupported: false, aacEncodeSupported: false, maxCanvasPixels: 0 }
  }
  let mb: typeof import('mediabunny')
  try { mb = await import('mediabunny') } catch { 
    return { offlineCapable: false, webcodecsPresent: true, avcEncodeSupported: false, aacEncodeSupported: false, maxCanvasPixels: 0 }
  }
  // ⚠️ 码率必须走 `new Quality({ bitrate, bitrateMode })`。裸数字 `new Quality(2_000_000)`
  // 会被当成 0–1 的**质量档**（官方允许越界值 "for extreme behavior"），
  // 实测产物 480×270 因此跑到 6.6 Mbps —— 客户机磁盘上比原片还大。
  const quality = new mb.Quality({ bitrate: 2_000_000, bitrateMode: 'constant' })
  const avcEncodeSupported = await mb.canEncodeVideo('avc', { width: 1440, height: 810, frameRate: fpsOut, quality }).catch(() => false)
  const aacEncodeSupported = await mb.canEncodeAudio('aac', { sampleRate: 48000, numberOfChannels: 2, bitrate: 128_000 }).catch(() => false)
  const maxCanvasPixels = await probeMaxCanvas(fpsOut)
  return {
    offlineCapable: avcEncodeSupported && aacEncodeSupported,
    webcodecsPresent,
    avcEncodeSupported,
    aacEncodeSupported,
    maxCanvasPixels,
  }
}

/**
 * 选引擎。`reasons` 是机器码，界面据此取词；自动降级**不许静默**。
 */
export function pickComposeEngine(
  spec: ComposeSpec,
  caps: EngineCapabilities,
  tp: ThroughputConstants = MEASURED_THROUGHPUT,
): { engine: Engine; reasons: string[] } {
  const costLanes: CostLane[] = spec.lanes
    .filter((l) => l.hasVideo)
    .map((l) => ({
      id: l.id,
      hasVideo: true,
      width: l.width ?? 1280,
      height: l.height ?? 720,
      // 取不到帧率时按 15 估，但要把这一格标成机器码记进日志 —— 别拿估算当承诺
      frameRate: l.frameRate ?? 15,
    }))
  const durationSec = spec.durationSec ?? defaultDurationOf(spec)
  const canvas = estimateCanvas(spec)
  return pickEngine(
    {
      lanes: costLanes,
      videoLaneIds: costLanes.map((l) => l.id),
      durationSec,
      layout: canvas,
      fpsOut: spec.fpsOut ?? 15,
    },
    tp,
    caps,
  )
}

function defaultDurationOf(spec: ComposeSpec): number {
  const ends = spec.lanes.flatMap((l) => l.containers.map((c) => c.endSec))
  return ends.length ? Math.max(...ends) : 0
}

/**
 * 成本模型要用的画布尺寸。**只许问 `composeLayout`**（口径 §9.1：几何唯一真源）。
 * 从前这里按"grid 的保守形状"自己估一遍 —— 那是第二处几何，代价不是报错而是
 * 判据与实际不符：`top`/`right` 的画布比它估的**大**（一路 1280 主画面 + 缩略条），
 * 于是护栏 (b) 的像素预算和引擎选择都按一个不存在的形状算。
 */
function estimateCanvas(spec: ComposeSpec): { canvasWidth: number; canvasHeight: number } {
  const lanes: LayoutLane[] = spec.lanes
    .filter((l) => l.hasVideo)
    .map((l) => ({
      id: l.id,
      hasVideo: true,
      kind: l.kind,
      durationSec: l.containers.reduce((m, c) => Math.max(m, c.endSec), 0),
    }))
  if (!lanes.length) return { canvasWidth: 0, canvasHeight: 0 }
  const layout = buildLayout({
    lanes,
    mode: spec.mode,
    cols: spec.cols ?? undefined,
    focusId: spec.focusId ?? null,
  })
  return { canvasWidth: layout.canvasWidth, canvasHeight: layout.canvasHeight }
}

export { estimateCost, MEASURED_THROUGHPUT, defaultDurationOf, estimateCanvas }

/**
 * 半截件判据：**只跟内核自己规划的那条时间轴比**（`outcome.durationSec`）。
 *
 * 从前这里比的是 `spec.durationSec`，而回放页把整场跨度（含**没被勾选**的路）填进了那个字段 ——
 * 于是"用户只勾了部分路"会被当成"文件没做完"，完整的成品被命名成"只有前 N 秒"。
 * 实测差 2.07 s 就误报（阈值 2 s），只勾一路画面时会差到 130 s。
 * 分母必须是被合成那一路集合的跨度，别的都不算。
 */
export function partialSeconds(o: { kind: string; coveredSec: number; durationSec: number }): number | null {
  if (o.kind === 'stalled') return Math.max(0, Math.round(o.coveredSec))
  if (o.durationSec > 0 && o.coveredSec < o.durationSec - 2) return Math.max(0, Math.round(o.coveredSec))
  return null
}

/** 被勾选路的时间轴末端（= 内核会规划出的时长）。列表页与回放页共用它，别再各算一套 */
export function lanesTimelineEndSec(lanes: readonly ComposeLane[]): number {
  return Math.max(0, ...lanes.flatMap((l) => l.containers.map((c) => c.endSec)))
}
