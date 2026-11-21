/**
 * 分块混音（纯函数，不碰 WebAudio，`node scratch/verify-audiomix.ts` 直接跑真源）。
 *
 * 上一版在这里犯的两个错（正本 §7 第四轮 / 审计缺陷 #4）：
 * - 把每一路**整段**解成 PCM 常驻（16 分钟一路 ≈370 MB，10 路 ≈3.7 GB 必爆）；
 *   这里只处理一个时间窗（调用方按 10–20 秒一块），一块用完就释放。
 * - 各路 `AudioSample` 的采样率不一致时**没人管**，直接按原速率喂进活的 AudioContext，
 *   表现是语速/音高悄悄变了而不报错。这里显式重采样，并把用过的源速率记下来。
 *
 * 混音是"求和后削顶"，不是"除以路数"：后者会把八个人的会议音量整体压低 9 dB，
 * 现场只会听到"合成出来的视频声音很小"。削顶次数如实回报（`clippedSamples`），
 * 由上层决定要不要提示，不许当没发生。
 */

export interface MixInput {
  laneId: string
  /** 这一段音频在整场时间轴上的起点（秒）——来自容器时间码，不是墙钟 */
  startSec: number
  /** 每声道一条 Float32Array，帧主序 */
  channels: Float32Array[]
  sampleRate: number
}

export interface MixChunk {
  /** 定长两条声道（混音输出一律立体声，AAC 那侧按 48k/2ch 编） */
  channels: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>]
  frames: number
  /** 本块里真正贡献了声音的路（勾掉声音/没素材的路不在这里） */
  activeLanes: string[]
  /** 求和后超出 [-1,1] 被削掉的样本数 */
  clippedSamples: number
  /** 本块里被丢弃的输入路（时长对不上、素材为空等），机器码由上层取词 */
  droppedLanes: Array<{ laneId: string; reason: string }>
}

const OUT_RATE = 48000

/**
 * 把一段源样本铺到目标窗 [chunkStart, chunkEnd) 上，返回长度为 frames 的 Float32Array
 * （单声道）。源采样率不等于目标时做线性插值 —— 不用 `playbackRate` 那种"假装一样快"的糊法。
 */
function place(
  src: Float32Array,
  srcRate: number,
  srcStartSec: number,
  chunkStart: number,
  chunkEnd: number,
  frames: number,
): Float32Array {
  const out = new Float32Array(frames)
  const durSec = src.length / srcRate
  const srcEnd = srcStartSec + durSec
  const from = Math.max(chunkStart, srcStartSec)
  const to = Math.min(chunkEnd, srcEnd)
  if (to <= from) return out
  const firstFrame = Math.floor((from - chunkStart) * OUT_RATE)
  const lastFrame = Math.min(frames, Math.ceil((to - chunkStart) * OUT_RATE))
  for (let f = firstFrame; f < lastFrame; f++) {
    const t = chunkStart + f / OUT_RATE
    const pos = (t - srcStartSec) * srcRate
    const i0 = Math.floor(pos)
    const frac = pos - i0
    const s0 = src[i0] ?? 0
    const s1 = src[i0 + 1] ?? s0
    out[f] = s0 + (s1 - s0) * frac
  }
  return out
}

export function mixChunk(
  inputs: MixInput[],
  chunkStart: number,
  chunkEnd: number,
): MixChunk {
  const frames = Math.max(0, Math.round((chunkEnd - chunkStart) * OUT_RATE))
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const activeLanes: string[] = []
  const droppedLanes: Array<{ laneId: string; reason: string }> = []
  let clippedSamples = 0

  for (const input of inputs) {
    if (!input.channels.length) {
      droppedLanes.push({ laneId: input.laneId, reason: 'no_channel_data' })
      continue
    }
    if (input.sampleRate <= 0) {
      droppedLanes.push({ laneId: input.laneId, reason: 'bad_sample_rate' })
      continue
    }
    // 单声道铺到左右；多声道取前两路（三声道以上的录制在本产品里不存在）
    const mono = input.channels.length === 1
    const a = place(input.channels[0]!, input.sampleRate, input.startSec, chunkStart, chunkEnd, frames)
    const b = mono ? a : place(input.channels[1]!, input.sampleRate, input.startSec, chunkStart, chunkEnd, frames)
    let touched = false
    for (let f = 0; f < frames; f++) {
      const av = a[f]!
      const bv = b[f]!
      if (av !== 0 || bv !== 0) touched = true
      const ls = left[f]! + av
      const rs = right[f]! + bv
      // 削顶而不是 wrap：wrap 出来的爆音比削顶难听得多，且会让下游峰值统计失真
      left[f] = ls > 1 ? (clippedSamples++, 1) : ls < -1 ? (clippedSamples++, -1) : ls
      right[f] = rs > 1 ? (clippedSamples++, 1) : rs < -1 ? (clippedSamples++, -1) : rs
    }
    if (touched) activeLanes.push(input.laneId)
  }

  return { channels: [left, right], frames, activeLanes, clippedSamples, droppedLanes }
}

/**
 * 把整段混音切成 AAC 帧（每包 1024 样本）。尾部不足一包时补零 ——
 * 不能因为最后一包不满 1024 就把那零点几秒丢掉，那是内容缺失。
 */
export function splitPackets(
  chunk: Pick<MixChunk, 'channels'>,
  packetSamples = 1024,
): Array<{ channels: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>]; numberOfFrames: number }> {
  const frames = chunk.channels[0].length
  const total = Math.ceil(frames / packetSamples)
  const out: Array<{ channels: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>]; numberOfFrames: number }> = []
  for (let i = 0; i < total; i++) {
    const start = i * packetSamples
    const len = Math.min(packetSamples, frames - start)
    const l = new Float32Array(packetSamples)
    const r = new Float32Array(packetSamples)
    l.set(chunk.channels[0].subarray(start, start + len))
    r.set(chunk.channels[1].subarray(start, start + len))
    out.push({ channels: [l, r], numberOfFrames: packetSamples })
  }
  return out
}

export { OUT_RATE as MIX_OUTPUT_SAMPLE_RATE }

/**
 * 音频分块计划：返回每块的起止**帧数**，并保证除末块外每块都是 1024 的整数倍。
 *
 * 为什么非要在这算：`fastStart:'reserve'` 要求 addAudioTrack 时就把包数报死。
 * 按"秒"切块会踩坑 —— 15 秒 = 720000 帧 = 703.125 包，每块尾包补零 ⇒ 实吐包数
 * 比 `ceil(总时长×48000/1024)` 多出一截，实测 987 秒那场就是这样在 `finalize()` 抛的。
 * 所以包数必须由这份计划算出来，两边共用同一个数，不许各算一次。
 */
export function audioChunkPlan(
  totalFrames: number,
  chunkFramesWanted: number,
  packetSamples = 1024,
): Array<{ startFrame: number; frames: number; packets: number }> {
  const chunk = Math.max(packetSamples, Math.floor(Math.max(1, chunkFramesWanted) / packetSamples) * packetSamples)
  const out: Array<{ startFrame: number; frames: number; packets: number }> = []
  let at = 0
  while (at < totalFrames) {
    const frames = Math.min(chunk, totalFrames - at)
    out.push({ startFrame: at, frames, packets: Math.ceil(frames / packetSamples) })
    at += frames
  }
  return out
}
