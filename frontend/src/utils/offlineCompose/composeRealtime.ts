/**
 * 实时合成（`composeGrid`）的**薄适配器**：只把它已有的入参/结果翻译成引擎无关的
 * `ComposeSpec`/`ComposeOutcome`，**实现体一行不动**（陪放、1× 不静音、按住-继续那三条口径
 * 都在 `trackRecorder.composeGrid` 里，经现场验证过，动它就是把已知的换成未知的）。
 *
 * 为什么要有这一层：界面只有一个"合成"按钮，引擎由成本模型选，所以两条路必须回同一个形状；
 * 否则视图又要写两套进度/取消/半截件标注 —— 上一轮就是因为"离线"做成第二个入口 + 双份 UI 状态，
 * 回退时只能整块删掉。
 *
 * 两条如实的差异（不许藏）：
 * - 实时**只画宫格**：`composeGrid` 没有主画面/顶部/右侧的概念。三档请求落到实时时按宫格出，
 *   并回一个 `realtime_grid_only` 机器码，由界面取词说一句。
 * - 实时**取消不出文件**（沿用现路径的既有语义：`cancelled` 就 return，不交半截件）；
 *   停摆才给"只到第 N 秒"的那半截。这条与离线侧不同，标注因此也不同。
 */
import { composeGrid, type ComposePane } from '../trackRecorder'
import { remuxFmp4ToProgressive } from '../mp4/remuxFmp4'
import { finalizeWebmDuration } from '../webmDuration'
import { probeBlobDurationSec } from '../localRecorder'
import { autoCols } from '../composeLayout'
import type { ComposeCtl, ComposeOutcome, ComposeSpec } from './engine'

export interface RealtimeDeps {
  /** 画面来源就是页面上那些媒体元素 —— 这一条决定了实时任务离不开那一页（pageBound） */
  panes: ComposePane[]
  /** 全局时钟（秒）：陪放不另起一套时间 */
  getTime: () => number
  /** 页面被切走时调用方把时钟按住；按住的那段既不进步也不占时长 */
  isHolding: () => boolean
}

export async function composeRealtime(
  spec: ComposeSpec,
  ctl: ComposeCtl,
  deps: RealtimeDeps,
): Promise<ComposeOutcome> {
  const fpsOut = spec.fpsOut ?? 15
  const videoPanes = spec.lanes.filter((l) => l.hasVideo)
  const reasons: string[] = []
  const base: ComposeOutcome = {
    engine: 'realtime', kind: 'ok', mime: '', ext: 'mp4', coveredSec: 0, durationSec: spec.durationSec ?? 0,
    droppedAudioLanes: [], placeholderLanes: [], skippedAnomalousLanes: [], unusableVideoLanes: [], reasons,
  }
  if (spec.mode !== 'grid') reasons.push('realtime_grid_only')
  const cells = Math.max(1, Math.min(6, spec.cols ?? autoCols(videoPanes.length)))

  const res = await composeGrid({
    panes: deps.panes,
    cells,
    cellWidth: spec.cellWidth,
    fps: fpsOut,
    getTime: deps.getTime,
    durationSec: spec.durationSec ?? 0,
    onProgress: (ratio, timeSec) => ctl.onProgress({
      phase: 'encode',
      ratio,
      coveredSec: timeSec,
      doneFrames: Math.round(timeSec * fpsOut),
      expectedFrames: Math.round((spec.durationSec ?? 0) * fpsOut),
      placeholderLanes: 0,
    }),
    shouldCancel: () => ctl.isCancelled(),
    isHolding: deps.isHolding,
  })

  if (!res || !res.blob.size) {
    return { ...base, kind: 'failed', failureCode: 'encode_failed', reasons: [...reasons, 'realtime_no_output'] }
  }
  if (res.cancelled) {
    // 现路径的既有语义：取消就不交文件。改成交半截件是另一件事，不在这次顺手改
    return { ...base, kind: 'cancelled', mime: res.mime, ext: res.ext, reasons: [...reasons, 'user_cancelled'] }
  }

  // 收尾（重排容器 + 探时长）这几秒进度已经到顶了，报一个 `wrap` 阶段让界面有话说
  ctl.onProgress({
    phase: 'wrap',
    ratio: 1,
    coveredSec: spec.durationSec ?? 0,
    doneFrames: Math.round((spec.durationSec ?? 0) * fpsOut),
    expectedFrames: Math.round((spec.durationSec ?? 0) * fpsOut),
    placeholderLanes: 0,
  })
  // 分片 MP4 的 moov 样本表是空的，很多播放器读不到时长 ⇒ 重排成渐进 MP4（不改码流）
  let out = res.blob
  let audioSamples: number | null = null
  if (res.ext === 'mp4') {
    const remuxed = await remuxFmp4ToProgressive(res.blob)
    if (remuxed) {
      out = remuxed.blob
      audioSamples = remuxed.audioSamples
    } else {
      reasons.push('remux_failed')
    }
  } else {
    out = await finalizeWebmDuration(res.blob, Math.round((spec.durationSec ?? 0) * 1000))
  }

  // 半截判据用**产物自己的时长**（时长由样本自己决定，骗不了进度文案）
  const madeSec = await probeBlobDurationSec(out)
  const timelineSec = spec.durationSec ?? 0
  const coveredSec = madeSec ?? timelineSec
  const partial = res.stalled || (madeSec != null && madeSec < timelineSec - 2)
  if (partial) reasons.push('partial_output')
  if (audioSamples === 0) reasons.push('no_audio_samples')

  return {
    ...base,
    kind: res.stalled ? 'stalled' : 'ok',
    blob: out,
    mime: res.mime || 'video/mp4',
    ext: res.ext || 'mp4',
    coveredSec,
    durationSec: timelineSec,
    droppedAudioLanes: res.droppedAudioPanes,
    reasons,
  }
}
