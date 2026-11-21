// 合成用的混音总线：把正在回放的各路 `<video>` 的声音接进一条音频图，混成一条给 MediaRecorder。
//
// ⚠️ **只服务实时（前台陪放）路径**。离线合成走 `offlineCompose/audioMix.ts` 的分块混音，
// 不碰活的 AudioContext —— 上一版离线实现把每个解码分片 `start(when)` 挂到这条总线上，
// 结果是常驻 PCM ~1.6 GB + 节点爆炸（那是它 OOM 的第四真因）。别把两条路接回一起。
//
// 三条硬约束（都是实测踩出来的，改这里前先读）：
//
// ① **元素的声音一旦被接进音频图，就只能从音频图出来**。所以 `createMediaElementSource` 每条元素只能调一次
//    （第二次直接抛 `InvalidStateError`），且调用方必须把这条通路同时接回扬声器 —— 否则合成期间用户自己听不见。
//
// ② **AudioContext 在用户点过之前是 suspended**，而 suspended 的音频图里
//    `createMediaStreamDestination()` 吐出来的音轨是**静音**：合成产物"没有声音"就是这么来的。
//    `resume()` 必须发生在**点击的同步段**（打开确认弹窗那一步之前），不能等 `await` 之后才想起来 ——
//    那时用户激活已经用完，浏览器不接受 resume，整条音轨录出来是空的。
//
// ③ **收尾时绝不 `close()`**。总线是全页共用的一条，关了它等于把回放页的扬声器永久掐掉
//    （元素已经被接进音频图，声音再也回不到元素自己那条路）。它只创建一次、活到页面卸载。
const elementSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()
const elementGains = new WeakMap<HTMLMediaElement, GainNode>()

export interface AudioBus {
  ac: AudioContext
  dest: MediaStreamAudioDestinationNode
}

let bus: AudioBus | null = null

/**
 * 取（必要时创建）全页共用的混音总线，并在 suspended 时唤醒它。
 * 浏览器不支持 WebAudio 时返回 null，调用方要如实说"这次合成没有声音"。
 */
export function ensureAudioBus(): AudioBus | null {
  const AudioCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioCtor) return null
  if (!bus) {
    try {
      const ac = new AudioCtor()
      bus = { ac, dest: ac.createMediaStreamDestination() }
    } catch (e) {
      console.warn('[audioBus] 混音总线起不来，导出将没有声音', e)
      return null
    }
  }
  if (bus.ac.state === 'suspended') void bus.ac.resume().catch(() => undefined)
  return bus
}

/**
 * 把一路媒体接进总线（幂等：同一条元素重复调用只是取回它的 gain）。
 * 通路是"元素 → gain → 导出(dest)"与"元素 → gain → 扬声器"两支，所以 gain 既控导出音量也控本地监听 ——
 * 被静音的那一路 `gain = 0`，它不进导出也不响，但元素本身不受影响（回放页照旧能单独放开）。
 * 接不走（浏览器不允许）返回 null，调用方要把这一路记成"没声音"，不能装作它有。
 */
export function hookMediaToBus(media: HTMLMediaElement): GainNode | null {
  const target = ensureAudioBus()
  if (!target) return null
  let src = elementSources.get(media)
  if (!src) {
    try {
      src = target.ac.createMediaElementSource(media)
    } catch (e) {
      console.warn('[audioBus] 该元素接不进混音', e)
      return null
    }
    elementSources.set(media, src)
  }
  let gain = elementGains.get(media)
  if (!gain) {
    gain = target.ac.createGain()
    elementGains.set(media, gain)
    src.connect(gain)
    gain.connect(target.dest)
    gain.connect(target.ac.destination)
  }
  return gain
}

/** 当前总线（可能还没创建）。合成收尾时用它判断"这次到底有没有音轨可录"。 */
export function currentAudioBus(): AudioBus | null {
  return bus
}
