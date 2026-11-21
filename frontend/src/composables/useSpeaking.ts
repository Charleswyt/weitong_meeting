import { ref } from 'vue'

// 讲话检测：本地 AudioContext + AnalyserNode 的能量阈值判定（与三方会议页同路子），
// 结果经我方 WS 广播给同会议的其他页面。
const RMS_THRESHOLD = 0.018
const FFT_SIZE = 512

export function useSpeaking(onToggle?: (speaking: boolean) => void) {
  const speakingSelf = ref(false)
  let ctx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let buf: Uint8Array | null = null
  let raf = 0
  let quietSince = 0

  function start(stream: MediaStream | null) {
    const track = stream?.getAudioTracks()?.[0]
    if (!track || !stream) return
    stop()
    try {
      ctx = new AudioContext()
      source = ctx.createMediaStreamSource(stream)
      analyser = ctx.createAnalyser()
      analyser.fftSize = FFT_SIZE
      analyser.smoothingTimeConstant = 0.7
      buf = new Uint8Array(analyser.frequencyBinCount)
      source.connect(analyser)
      loop()
    } catch {
      ctx = null
      analyser = null
    }
  }

  function loop() {
    if (!analyser || !buf || !ctx) return
    raf = requestAnimationFrame(loop)
    analyser.getByteTimeDomainData(buf as Uint8Array<ArrayBuffer>)
    let sum = 0
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / buf.length)
    const now = performance.now()
    if (rms > RMS_THRESHOLD) {
      quietSince = now
      if (!speakingSelf.value) {
        speakingSelf.value = true
        onToggle?.(true)
      }
    } else if (speakingSelf.value && now - quietSince > 600) {
      speakingSelf.value = false
      onToggle?.(false)
    }
  }

  function stop() {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    source?.disconnect()
    analyser?.disconnect()
    ctx?.close().catch(() => undefined)
    source = null
    analyser = null
    ctx = null
    speakingSelf.value = false
  }

  return { speakingSelf, start, stop }
}
