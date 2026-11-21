import { countDecodedFrames, type FrameMeter } from './decodedFrameCounter.ts'

// Rates are sampled on one WebRTC sender. Null is an unavailable measurement.
export interface BrowserVideoSample {
  captureFps: number | null
  publishFps: number | null
  decodedFrameKbps: number | null
  publishKbps: number | null
  at: number
}

type Counter = { id: string; timestamp: number; frames: number }
function counterRate(previous: Counter | undefined, current: Counter): number | null {
  if (previous?.id !== current.id || current.frames < previous.frames || current.timestamp <= previous.timestamp) return null
  return Math.round((current.frames - previous.frames) * 10000 / (current.timestamp - previous.timestamp)) / 10
}

export function videoSampler() {
  let capture: Counter | undefined
  let encoded: Counter | undefined
  let sent: {id: string; bytes: number; timestamp: number} | undefined
  return (report: RTCStatsReport, trackId: string, physicalFrames?: number | null, decodedFrameKbps: number | null = null): BrowserVideoSample => {
    const at = performance.now()
    const rows = [...report.values()]
    const outbound = rows.find(s => s.type === 'outbound-rtp' && s.kind === 'video' &&
      (!s.mediaSourceId || report.get(s.mediaSourceId)?.trackIdentifier === trackId))
    const source = report.get(outbound?.mediaSourceId) ?? rows.find(s =>
      s.type === 'media-source' && s.kind === 'video' && s.trackIdentifier === trackId)
    function sample(id: string, timestamp: number, frames: unknown, fps: unknown, previous?: Counter): [number | null, Counter | undefined] {
      const current = typeof frames === 'number' && Number.isFinite(frames) ? { id, timestamp, frames } : undefined
      const delta = current && counterRate(previous, current)
      const rate = delta ?? (typeof fps === 'number' && Number.isFinite(fps) && fps >= 0 ? fps : null)
      return [rate, current]
    }
    const [captureFps, nextCapture] = physicalFrames !== undefined
      ? sample(trackId, at, physicalFrames, null, capture)
      : sample(source?.id, source?.timestamp, source?.frames, source?.framesPerSecond, capture)
    const [publishFps, nextEncoded] = sample(outbound?.id + trackId, outbound?.timestamp,
      outbound?.framesSent ?? outbound?.framesEncoded, outbound?.framesPerSecond, encoded)
    capture = nextCapture
    encoded = nextEncoded
    const next = outbound && typeof outbound.bytesSent === 'number'
      ? {id: outbound.id + trackId, bytes: outbound.bytesSent, timestamp: outbound.timestamp} : undefined
    const publishKbps = next && sent && next.id === sent.id && next.bytes >= sent.bytes && next.timestamp > sent.timestamp
      ? Math.round((next.bytes - sent.bytes) * 80 / (next.timestamp - sent.timestamp)) / 10 : null
    sent = next
    return { captureFps, publishFps, publishKbps, decodedFrameKbps, at }
  }
}

export function observeDecodedTrack(source: MediaStreamTrack): FrameMeter | null {
  let clone: MediaStreamTrack
  try { clone = source.clone() } catch { return null }
  let worker: Worker | undefined
  try {
    const local = countDecodedFrames(clone)
    if (local) return { read: local.read, stop() { local.stop(); clone.stop() } }
    worker = new Worker(new URL('./decodedFrameWorker.ts', import.meta.url), { type: 'module' })
    let latest: number | null = null, sampledAt = 0
    worker.onmessage = ({data}) => { latest = data; sampledAt = performance.now() }
    worker.onerror = () => { latest = null; worker?.terminate() }
    worker.postMessage(clone, [clone as unknown as Transferable])
    return { read: () => performance.now() - sampledAt < 3000 ? latest : null, stop() { worker?.terminate(); clone.stop() } }
  } catch {
    worker?.terminate()
    clone.stop()
    return null
  }
}
