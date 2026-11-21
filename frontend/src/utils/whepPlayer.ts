import { sitePath } from '@/utils/sitePath'
// WHEP 订阅通道：这条流没有可直连的地址、只有 WHEP 订阅入口时走这里。
// 实测两种形态需要它：岸端手机推的音频只有 WHEP；**船端形态下云端参会者的视频只有
// RK 局域网 WHEP 这一条腿**（网关一条直连地址都不给，2026-10-10 实测）。
//
// SDP 协商经我方后端代理（上游地址与参会令牌都不进浏览器），RTP 由浏览器直连媒体服务。
// 收音频还是视频**不在 URL 上再标一遍**：offer 里的 m-line 才是这件事的真源，后端按它选通道。

import { normalizeEpochMs } from './mediaClock'

// 这一条 PC 的入向实测。走 WHEP 的那一路不经我方容器，帧头里没有采集墙钟、也没有 onTraffic，
// 所以悬浮统计条要的每一项都只能从这里取 —— 少读一个字段，界面上就少一格有值。
export interface WhepStats {
  /** 累计收到的字节，用于自算压缩后速率与节省带宽。 */
  bytesReceived: number
  framesDecoded: number
  /** 解码帧尺寸与实测帧率：这一路没有帧头可问，只能问浏览器。 */
  width: number
  height: number
  fps: number
  /**
   * 播放时刻，两种口径**分开存**、谁也不许冒充谁（对齐三方 `samplePlayoutTiming`）：
   * `estimatedPlayoutEpochMs` = `inbound-rtp.estimatedPlayoutTimestamp`（真的"在出声"）；
   * `trackDeliveryEpochMs` = 同步源的投递时刻（只到"轨道交付"）。
   * 0 = 该口径拿不到。算音画差时两条轨必须用**同一个口径**，一方估算一方交付就直接不报 ——
   * 那差值里混进了两个口径的偏差，看着像个毫秒数，其实什么都不是。
   */
  estimatedPlayoutEpochMs: number
  trackDeliveryEpochMs: number
  /** 正在解码的这一帧的 RTP 时间戳：拿它去帧时刻表里对同一帧，才问得到采集时刻。0 = 没给。 */
  rtpTimestamp: number
  /** 该编码的时钟率（Hz），把 RTP 差换算成毫秒。 */
  clockRate: number
}

/** 视频那条腿的接收元素一定是 `<video>`：首帧那件事只能从它身上问。 */
export interface WhepVideoPlayer extends WhepPlayer {
  element: HTMLVideoElement
}

export interface WhepPlayer {
  stop: () => void
  element: HTMLMediaElement
  stream: MediaStream
  // 出不了画面时要能分清"字节没进来"还是"进来了但解不出来"。
  inbound: () => Promise<{ framesReceived: number; framesDecoded: number; decoder: string }>
  stats: () => Promise<WhepStats>
}

// 订阅失败带上服务的 HTTP 状态与信封 `reason`：调用方按机器值决定"退回别的通路"还是"报错"，
// 不必去比对提示文案（契约 §1）。
export class SubscribeError extends Error {
  constructor(message: string, readonly status: number, readonly reason = '') {
    super(message)
    this.name = 'SubscribeError'
  }
}

async function waitIceComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return
  await new Promise<void>((resolve) => {
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', onChange)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', onChange)
    setTimeout(resolve, 2000)
  })
}

async function subscribeWhep(
  path: string,
  kind: 'audio' | 'video',
  onRate?: (kbps: number) => void,
  onStats?: (s: WhepStats) => void,
): Promise<WhepPlayer> {
  const pc = new RTCPeerConnection()
  pc.addTransceiver(kind, { direction: 'recvonly' })
  const el = document.createElement(kind)
  el.autoplay = true
  el.setAttribute('playsinline', '')
  // 远端画面的声音由音频那条腿单独出，这一格必须静音，否则同一路声音响两遍。
  if (kind === 'video') el.muted = true
  const stream = new MediaStream()
  const attach = (track: MediaStreamTrack) => {
    if (stream.getTracks().includes(track)) return
    stream.addTrack(track)
    el.srcObject = stream
    // play() 被拒（自动播放策略、被新的 srcObject 打断）要留痕：以前这里静默吞掉，
    // 表现就是"帧在解、字节在进，那一格永远黑"。
    void el.play().catch((e) => console.warn('[whep] 元素没能播起来', kind, String(e)))
  }
  // ontrack 必须在 setRemoteDescription **之前**挂好：应用远端应答的那一刻轨道事件就发完了，
  // 事后挂的处理器永远收不到 —— 实测解码 287 帧而元素 readyState=0、paused=true 就是这么来的。
  pc.ontrack = (ev) => attach(ev.track)

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  await waitIceComplete(pc)

  const res = await fetch(sitePath(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sdp',
      Authorization: 'Bearer ' + (localStorage.getItem('weitong.token') || ''),
    },
    body: pc.localDescription?.sdp ?? '',
  })
  if (!res.ok) {
    pc.close()
    const body = await res.json().catch(() => ({}))
    console.warn('[whep] 订阅被拒', res.status, body)
    const env = body as { msg?: string; reason?: string }
    throw new SubscribeError(String(env.msg || '这一路暂时收不到'), res.status, String(env.reason || ''))
  }
  const answer = await res.text()
  try {
    await pc.setRemoteDescription({ type: 'answer', sdp: answer })
  } catch (e) {
    pc.close()
    console.warn('[whep] 远端应答应用失败', e)
    throw new SubscribeError('这一路暂时收不到', 0)
  }

  // 事件可能先于处理器送达（各家实现对"应用应答时已存在的轨"派发时机不同），补一次兜底：
  // 从接收器里把已经存在的轨捞回来，同一事件不会再重复加（attach 里按 track 判重）。
  for (const r of pc.getReceivers()) if (r.track && r.track.kind === kind) attach(r.track)
  document.body.appendChild(el)

  // 下行码率平台不提供端点，只能自己按 getStats 的字节增量算 —— 与直连播放器同一口径，
  // 否则走 WHEP 的那路在页面上永远是"–"，看不出这一路到底有没有进来。
  // 「播放到哪了」只能问**这一轨的接收方**。原先的实现退而取了整条 PC 的 stats 报告里
  // `media-source` 那条的 `timestamp` —— 那个字段是"这次 getStats 跑的时刻"，不是媒体量：
  // 两条轨各减各的采样时刻，等于两个 1 秒定时器相减，得到 ±1000 ms 的采样相位差，
  // 却会显示成一个看起来很合理的"音画差毫秒数"。那种数比空白更坏，所以照三方重做：
  // 播放时刻取 inbound-rtp.estimatedPlayoutTimestamp，轨道交付取同步源，两者分开存、不许混口径。
  const readStats = async (): Promise<WhepStats> => {
    const out: WhepStats = {
      bytesReceived: 0, framesDecoded: 0, width: 0, height: 0, fps: 0,
      estimatedPlayoutEpochMs: 0, trackDeliveryEpochMs: 0, rtpTimestamp: 0, clockRate: 0,
    }
    const receiver = pc.getReceivers().find((r) => r.track.kind === kind && r.track.readyState !== 'ended')
    if (!receiver) return out
    const stats = await receiver.getStats().catch(() => null)
    if (!stats) return out
    let inbound: Record<string, unknown> | null = null
    for (const s of stats.values() as IterableIterator<Record<string, unknown>>) {
      if (s.type !== 'inbound-rtp' || s.isRemote) continue
      // Chromium 有的版本给 `kind`、有的只给 `mediaType`，两个都不认就一条也筛不出来。
      if (String(s.kind ?? s.mediaType ?? '') !== kind) continue
      if (!inbound || Number(s.packetsReceived || 0) > Number(inbound.packetsReceived || 0)) inbound = s
    }
    if (!inbound) return out
    out.bytesReceived = Number(inbound.bytesReceived || 0)
    out.framesDecoded = Number(inbound.framesDecoded || 0)
    out.width = Number(inbound.frameWidth || 0)
    out.height = Number(inbound.frameHeight || 0)
    out.fps = Number(inbound.framesPerSecond || 0)
    out.estimatedPlayoutEpochMs = normalizeEpochMs(Number(inbound.estimatedPlayoutTimestamp || 0))
    const codec = inbound.codecId ? stats.get(String(inbound.codecId)) as unknown as Record<string, unknown> | undefined : undefined
    out.clockRate = Math.max(0, Number(codec?.clockRate) || 0)
    // 同步源给的是"正在交付的这一帧"的媒体时刻与 RTP 时间戳 —— 帧时刻表要按 RTP 对同一帧，
    // 拿采样时刻去对必然对不上。
    const sources = typeof receiver.getSynchronizationSources === 'function'
      ? receiver.getSynchronizationSources() : []
    let newestAt = 0
    for (const s of sources) {
      const at = normalizeEpochMs(Number(s?.timestamp || 0))
      if (at <= newestAt) continue
      newestAt = at
      out.trackDeliveryEpochMs = at
      const rtp = Number(s?.rtpTimestamp)
      out.rtpTimestamp = Number.isFinite(rtp) && rtp >= 0 ? rtp >>> 0 : 0
    }
    return out
  }
  let prev = 0
  let timer = 0
  if (onRate || onStats) {
    timer = window.setInterval(async () => {
      const st = await readStats()
      if (onRate) {
        // 字节回退了说明这不是同一个会话，那一秒就不报数，而不是报一个假的负值。
        // 定时器周期 1000ms，所以 Δbytes*8/1000 就是 SI kbit/s —— 与三方 `samplePeerRates` 同刻度，
        // 别改回 /1024：那会让下行与上行（useWhipPublish 用 /1000）差 2.4%，压缩比就是这两个数相除。
        if (st.bytesReceived >= prev) onRate(Math.round(((st.bytesReceived - prev) * 8) / 1000))
        prev = st.bytesReceived
      }
      onStats?.(st)
    }, 1000)
  }

  return {
    element: el,
    stream,
    stats: readStats,
    inbound: async () => {
      const stats = await pc.getStats().catch(() => null)
      const out = { framesReceived: 0, framesDecoded: 0, decoder: '' }
      stats?.forEach((s) => {
        if (s.type !== 'inbound-rtp' || s.kind !== kind) return
        out.framesReceived = Number(s.framesReceived ?? 0)
        out.framesDecoded = Number(s.framesDecoded ?? 0)
        out.decoder = String(s.decoderImplementation ?? '')
      })
      return out
    },
    stop: () => {
      if (timer) window.clearInterval(timer)
      el.pause()
      el.srcObject = null
      el.remove()
      pc.close()
    },
  }
}

export function subscribeWhepAudio(
  whepPath: string,
  onRate?: (kbps: number) => void,
  onStats?: (s: WhepStats) => void,
): Promise<WhepPlayer> {
  return subscribeWhep(whepPath, 'audio', onRate, onStats)
}

export function subscribeWhepVideo(
  whepPath: string,
  onRate?: (kbps: number) => void,
  onStats?: (s: WhepStats) => void,
): Promise<WhepVideoPlayer> {
  // kind='video' 时上面 createElement 出来的就是 HTMLVideoElement，类型在这里收窄一次
  return subscribeWhep(whepPath, 'video', onRate, onStats) as Promise<WhepVideoPlayer>
}

/**
 * 等这一路真的出第一帧，返回取消函数。
 * 订阅成功不等于有画面：零帧的轨喂给录制只出零字节片，那一路在清单里就是凭空消失。
 * `requestVideoFrameCallback` 是唯一"这一帧确实呈现过"的证据；不支持或后台标签页不发帧时，
 * 退成轮询 `videoWidth`（解出一帧就有尺寸），所以这条另有定时器退出路。
 */
export function observeVideoFirstFrame(el: HTMLVideoElement, onFirstFrame: () => void): () => void {
  let closed = false
  let callbackId = 0
  let poll = 0
  const cancel = () => {
    if (closed) return
    closed = true
    if (poll) window.clearInterval(poll)
    if (callbackId) el.cancelVideoFrameCallback(callbackId)
  }
  const report = () => {
    if (closed) return
    cancel()
    onFirstFrame()
  }
  if (typeof el.requestVideoFrameCallback === 'function') callbackId = el.requestVideoFrameCallback(report)
  poll = window.setInterval(() => {
    if ((el.videoWidth || 0) > 0) report()
  }, 500)
  return cancel
}

/** 一帧的时刻对：源时钟上的位置 + 本地把它画出来的单调时刻。 */
export interface WhepFrameTime {
  sourceMs: number
  observedMs: number
}

/**
 * 持续产出帧时刻，供首帧基准漂移（utils/mediaClock）用。
 * mediaTime 是这一帧在媒体时间线上的秒数（浏览器已替我们展开 32 位回绕），
 * presentedTimestamp 是本地呈现它的单调时刻 —— 两者相对基准帧各差多少，差出来的就是漂移。
 * 这个 API 不在时**不退化成轮询**：轮询拿不到帧级时刻，宁可不报也不报一个假数。
 */
export function observeFrameTimes(el: HTMLVideoElement, onFrame: (t: WhepFrameTime) => void): () => void {
  if (typeof el.requestVideoFrameCallback !== 'function') return () => {}
  let closed = false
  let callbackId = 0
  // 回调第一个参数就是这一帧被呈现的时刻（DOMHighResTimeStamp，与 performance.now() 同纪元），
  // metadata.mediaTime 是这一帧在媒体时间线上的秒数 —— 两者配对就是"源走了多少 vs 本地走了多少"。
  const step: VideoFrameRequestCallback = (now, meta) => {
    if (closed) return
    onFrame({ sourceMs: meta.mediaTime * 1000, observedMs: now })
    callbackId = el.requestVideoFrameCallback(step)
  }
  callbackId = el.requestVideoFrameCallback(step)
  return () => {
    closed = true
    if (callbackId) el.cancelVideoFrameCallback(callbackId)
  }
}

export function whepSubscribePath(meetingId: number, streamId: string): string {
  return `/api/v1/meetings/${meetingId}/streams/${encodeURIComponent(streamId)}/whep`
}
