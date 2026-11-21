// 扬声器测试与网络探测的真实实现。
const TONE_HZ = 660
const TONE_MS = 400
/** 登录设置「检测扬声器」用的轻音乐时长（秒） */
export const SPEAKER_MELODY_SEC = 10

let ctx: AudioContext | null = null
let elementSinks: HTMLAudioElement[] = []

type SinkRoute = {
  ctx: AudioContext
  el: HTMLAudioElement | null
  dest: MediaStreamAudioDestinationNode | null
  input: AudioNode
}

async function openSinkRoute(deviceId: string): Promise<
  { ok: true; route: SinkRoute } | { ok: false; reason: string }
> {
  ctx = ctx || new AudioContext()
  if (ctx.state !== 'running') await ctx.resume()

  if (!deviceId) {
    return { ok: true, route: { ctx, el: null, dest: null, input: ctx.destination } }
  }

  const el = document.createElement('audio')
  el.style.display = 'none'
  document.body.appendChild(el)
  elementSinks.push(el)
  const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
  if (typeof withSink.setSinkId !== 'function') {
    el.remove()
    elementSinks = elementSinks.filter((x) => x !== el)
    return { ok: false, reason: '本浏览器不能切输出设备，请在系统声音设置里改' }
  }
  try {
    await withSink.setSinkId(deviceId)
  } catch {
    el.remove()
    elementSinks = elementSinks.filter((x) => x !== el)
    return { ok: false, reason: '该输出设备不可用，已回退系统默认' }
  }
  const dest = ctx.createMediaStreamDestination()
  el.srcObject = dest.stream
  // 关键一步：不显式 play() 就永远不出声（autoplay 对 MediaStream 源无效）。
  await el.play()
  return { ok: true, route: { ctx, el, dest, input: dest } }
}

function closeSinkRoute(route: SinkRoute | null) {
  if (!route) return
  if (route.el) {
    route.el.pause()
    route.el.srcObject = null
    route.el.remove()
    elementSinks = elementSinks.filter((x) => x !== route.el)
  }
  route.dest?.disconnect()
}

// playToneToSink 放一段短测试音。两条出音路径，选哪条取决于用户有没有点名某台输出设备：
//  - 没点名（'系统默认'）：直接连 AudioContext.destination。
//  - 点名了某台设备：必须经 <audio> 元素 setSinkId，因为 AudioContext.destination 只走系统默认。
export async function playToneToSink(deviceId = ''): Promise<{ ok: boolean; reason?: string }> {
  let route: SinkRoute | null = null
  try {
    const opened = await openSinkRoute(deviceId)
    if (!opened.ok) return opened
    route = opened.route
    const { ctx: ac, input } = route

    const osc = ac.createOscillator()
    const gain = ac.createGain()
    osc.type = 'sine'
    osc.frequency.value = TONE_HZ
    // 起停都给 20ms 包络：0.08 的正弦硬切会"啪"一声，听起来像坏了。
    gain.gain.setValueAtTime(0.0001, ac.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.09, ac.currentTime + 0.02)
    gain.gain.setValueAtTime(0.09, ac.currentTime + TONE_MS / 1000 - 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + TONE_MS / 1000)

    osc.connect(gain).connect(input)
    osc.start()
    osc.stop(ac.currentTime + TONE_MS / 1000)
    await new Promise((r) => setTimeout(r, TONE_MS + 60))
    return { ok: true }
  } catch {
    return { ok: false, reason: '当前环境无法播放测试音' }
  } finally {
    closeSinkRoute(route)
  }
}

/**
 * 约 10 秒自生成轻音乐（无曲库版权依赖），用于登录设置扬声器试听。
 * 旋律 + 低音双轨，正弦偏暖，带缓起缓收，听感接近轻柔钢琴小品。
 * onLevel：0–100 的瞬时输出电平，供 UI 音量条跟播。
 */
export async function playMelodyToSink(
  deviceId = '',
  onLevel?: (level: number) => void,
): Promise<{ ok: boolean; reason?: string }> {
  let route: SinkRoute | null = null
  let levelRaf = 0
  try {
    const opened = await openSinkRoute(deviceId)
    if (!opened.ok) return opened
    route = opened.route
    const { ctx: ac, input } = route
    const master = ac.createGain()
    master.gain.value = 0.0001
    const analyser = ac.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.4
    master.connect(analyser)
    analyser.connect(input)

    const t0 = ac.currentTime + 0.03
    const endAt = t0 + SPEAKER_MELODY_SEC
    master.gain.exponentialRampToValueAtTime(0.2, t0 + 0.4)
    master.gain.setValueAtTime(0.2, endAt - 0.8)
    master.gain.exponentialRampToValueAtTime(0.0001, endAt)

    // G 大调：G4 A4 B4 C5 D5 E5 F#5 G5；低八度作铺底
    const melodyHz = [392.0, 440.0, 493.88, 523.25, 587.33, 659.25, 739.99, 783.99]
    // 小节：上行回落 + 小跳进，节奏有呼吸感
    const melody: { deg: number; beat: number; len: number }[] = [
      { deg: 0, beat: 0, len: 0.7 },
      { deg: 2, beat: 0.7, len: 0.55 },
      { deg: 4, beat: 1.3, len: 0.7 },
      { deg: 7, beat: 2.1, len: 0.9 },
      { deg: 5, beat: 3.1, len: 0.55 },
      { deg: 4, beat: 3.7, len: 0.55 },
      { deg: 2, beat: 4.3, len: 0.7 },
      { deg: 0, beat: 5.1, len: 0.85 },
      { deg: 1, beat: 6.05, len: 0.5 },
      { deg: 3, beat: 6.6, len: 0.55 },
      { deg: 5, beat: 7.2, len: 0.7 },
      { deg: 4, beat: 8.0, len: 0.55 },
      { deg: 2, beat: 8.6, len: 0.55 },
      { deg: 0, beat: 9.2, len: 0.75 },
    ]
    const bass: { deg: number; beat: number; len: number }[] = [
      { deg: 0, beat: 0, len: 1.9 },
      { deg: 4, beat: 2.0, len: 1.9 },
      { deg: 5, beat: 4.0, len: 1.9 },
      { deg: 0, beat: 6.0, len: 1.9 },
      { deg: 3, beat: 8.0, len: 1.9 },
    ]

    const schedule = (
      notes: { deg: number; beat: number; len: number }[],
      type: OscillatorType,
      gainPeak: number,
      octaveShift: number,
    ) => {
      for (const n of notes) {
        const start = t0 + n.beat
        if (start >= endAt) break
        const dur = Math.min(n.len, endAt - start)
        if (dur < 0.05) continue
        const osc = ac.createOscillator()
        const gain = ac.createGain()
        osc.type = type
        osc.frequency.value = melodyHz[n.deg] * octaveShift
        gain.gain.setValueAtTime(0.0001, start)
        gain.gain.exponentialRampToValueAtTime(gainPeak, start + 0.05)
        gain.gain.exponentialRampToValueAtTime(gainPeak * 0.55, start + dur * 0.55)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
        osc.connect(gain).connect(master)
        osc.start(start)
        osc.stop(start + dur + 0.03)
      }
    }

    schedule(melody, 'sine', 0.28, 1)
    schedule(bass, 'triangle', 0.12, 0.5)

    if (onLevel) {
      const td = new Float32Array(analyser.fftSize)
      let peak = 0
      const tickLevel = () => {
        analyser.getFloatTimeDomainData(td)
        let sum = 0
        for (let i = 0; i < td.length; i++) sum += td[i] * td[i]
        const rms = Math.sqrt(sum / td.length)
        peak = Math.max(rms, peak * 0.88)
        onLevel(Math.min(100, Math.round(peak * 480)))
        levelRaf = requestAnimationFrame(tickLevel)
      }
      tickLevel()
    }

    await new Promise((r) => setTimeout(r, SPEAKER_MELODY_SEC * 1000 + 160))
    return { ok: true }
  } catch {
    return { ok: false, reason: '当前环境无法播放试听曲' }
  } finally {
    if (levelRaf) cancelAnimationFrame(levelRaf)
    onLevel?.(0)
    closeSinkRoute(route)
  }
}

export function supportsSinkSelection(): boolean {
  if (typeof document === 'undefined') return false
  return typeof (document.createElement('audio') as HTMLAudioElement & { setSinkId?: unknown }).setSinkId === 'function'
}

export interface NetProbe {
  rttMs: number
  jitterMs: number
  samples: number
  ok: boolean
}

// 一次真实往返，返回毫秒；打不通返回 null。
// 破缓存的那一段要按 URL 里有没有问号选连接符：调用方传进来的地址可能已经带查询串
// （RTT 采样用的 `...?probe=N` 就是），再拼 `?_=` 会把 `_=0` 塞进 probe 的值里。
async function rttSample(url: string, i: number): Promise<number | null> {
  const t0 = performance.now()
  try {
    await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${i}`, { cache: 'no-store' })
  } catch {
    return null
  }
  return performance.now() - t0
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function stdev(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length)
}

// probeNetwork 量的是"到本系统后端的真实往返"，不宣称能代表卫星链路质量。
export async function probeNetwork(url = '/api/v1/dicts/meeting_status', rounds = 5): Promise<NetProbe> {
  const samples: number[] = []
  for (let i = 0; i < rounds; i++) {
    const dt = await rttSample(url, i)
    if (dt === null) return { rttMs: 0, jitterMs: 0, samples: samples.length, ok: false }
    samples.push(dt)
  }
  return {
    rttMs: Math.round(median(samples)),
    jitterMs: Math.round(stdev(samples)),
    samples: samples.length,
    ok: true,
  }
}

export function gradeNet(rttMs: number): { label: string; level: 'good' | 'fair' | 'poor' } {
  if (rttMs < 150) return { label: '良好', level: 'good' }
  if (rttMs < 400) return { label: '一般', level: 'fair' }
  return { label: '偏高', level: 'poor' }
}

const DOWN_KIB = 2048
const UP_BYTES = 512 * 1024
// 单轮下载时间预算：到点就停，用已收字节/已用时。
const ROUND_BUDGET_MS = 800
// 整场检测：热身 1 轮丢弃 + 实测 1～2 轮，目标约 1.5s，不再卡满 5 秒。
export const NET_TEST_DURATION_MS = 1500
/** 耗时过短的样本不可信（定时器噪声主导），丢弃。 */
const MIN_SAMPLE_MS = 40

function mbps(bytes: number, ms: number): number {
  if (ms < MIN_SAMPLE_MS || bytes <= 0) return NaN
  return Math.round((bytes * 8 / (ms / 1000)) / 1e6 * 10) / 10
}

function randomPayload(bytes: number): Uint8Array {
  const body = new Uint8Array(bytes)
  // 分块填高熵数据，避免全零被代理 gzip 压扁后解压计字节造成假千兆。
  const chunk = new Uint8Array(65536)
  for (let off = 0; off < bytes; off += chunk.length) {
    crypto.getRandomValues(chunk)
    body.set(chunk.subarray(0, Math.min(chunk.length, bytes - off)), off)
  }
  return body
}

export interface NetQuality {
  downMbps: number | null
  upMbps: number | null
  rttMs: number | null
  jitterMs: number | null
  /** 到三方会议平台的往返（后端代测），更能代表会中链路 */
  upstreamRttMs: number | null
  rounds: number
  level: 'good' | 'fair' | 'poor'
  label: string
}

async function measureDown(headers: Record<string, string>): Promise<number | null> {
  const t0 = performance.now()
  const res = await fetch(`/api/v1/net-probe/down?kb=${DOWN_KIB}&_=${Date.now()}`, {
    headers: { ...headers, 'Accept-Encoding': 'identity' },
    cache: 'no-store',
  })
  const reader = res.body?.getReader()
  let bytes = 0
  if (!reader) {
    const buf = await res.arrayBuffer()
    bytes = buf.byteLength
  } else {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value?.byteLength || 0
      if (performance.now() - t0 > ROUND_BUDGET_MS) {
        reader.cancel().catch(() => {})
        break
      }
    }
  }
  const dt = performance.now() - t0
  if (!res.ok) return null
  const rate = mbps(bytes, dt)
  return Number.isFinite(rate) ? rate : null
}

async function measureUp(headers: Record<string, string>): Promise<number | null> {
  const body = randomPayload(UP_BYTES)
  const t0 = performance.now()
  const res = await fetch('/api/v1/net-probe/up', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/octet-stream' },
    body,
    cache: 'no-store',
  })
  const dt = performance.now() - t0
  if (!res.ok) return null
  const rate = mbps(UP_BYTES, dt)
  return Number.isFinite(rate) ? rate : null
}

async function measureUpstreamRtt(headers: Record<string, string>): Promise<number | null> {
  try {
    const res = await fetch(`/api/v1/net-probe/upstream?_=${Date.now()}`, {
      headers,
      cache: 'no-store',
    })
    if (!res.ok) return null
    const json = await res.json()
    const data = json?.data
    if (!data?.ok || typeof data.rttMs !== 'number') return null
    return Math.round(data.rttMs)
  } catch {
    return null
  }
}

// measureNetwork：真实收发包计速 + 本端 RTT + 三方上行 RTT。热身一轮丢弃，总时长约 1.5s。
export async function measureNetwork(
  url = '/api/v1/dicts/meeting_status',
  onProgress?: (elapsedMs: number) => void,
): Promise<NetQuality> {
  const token = localStorage.getItem('token') || ''
  const headers = { Authorization: `Bearer ${token}` }
  const startedAt = performance.now()
  onProgress?.(0)

  // 热身：建立连接、跳过首次 TLS/代理抖动，结果不计入。
  await Promise.allSettled([measureDown(headers), measureUp(headers)])
  onProgress?.(performance.now() - startedAt)

  const downRates: number[] = []
  const upRates: number[] = []
  const rtts: number[] = []

  // 实测至多两轮，或到时为止。
  for (let round = 0; round < 2; round++) {
    const [down, up] = await Promise.all([
      measureDown(headers).catch(() => null),
      measureUp(headers).catch(() => null),
    ])
    if (down !== null) downRates.push(down)
    if (up !== null) upRates.push(up)

    for (let i = 0; i < 2; i++) {
      const dt = await rttSample(`${url}?probe=${round}`, i)
      if (dt === null) break
      if (dt >= MIN_SAMPLE_MS) rtts.push(dt)
      else if (dt > 0) rtts.push(dt) // RTT 允许短于带宽样本下限
    }

    onProgress?.(performance.now() - startedAt)
    if (performance.now() - startedAt >= NET_TEST_DURATION_MS) break
  }

  const upstreamRttMs = await measureUpstreamRtt(headers)
  onProgress?.(performance.now() - startedAt)

  // 评级优先用三方往返（会中真实路径），没有再退回本端 API 往返。
  const rttMs = rtts.length ? Math.round(median(rtts)) : null
  const gradeBasis = upstreamRttMs ?? rttMs
  const grade = gradeBasis === null ? null : gradeNet(gradeBasis)
  return {
    downMbps: downRates.length ? median(downRates) : null,
    upMbps: upRates.length ? median(upRates) : null,
    rttMs,
    jitterMs: rtts.length > 1 ? Math.round(stdev(rtts)) : null,
    upstreamRttMs,
    rounds: Math.max(downRates.length, upRates.length),
    level: grade?.level ?? 'poor',
    label: grade?.label ?? '不可达',
  }
}
