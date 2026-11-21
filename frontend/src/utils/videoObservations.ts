// Rates are sampled on one WebRTC sender. Null is an unavailable measurement.
export interface BrowserVideoSample {
  captureFps: number | null
  publishFps: number | null
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
  return (report: RTCStatsReport, trackId: string, physicalFrames?: number | null): BrowserVideoSample => {
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
    return { captureFps, publishFps, at }
  }
}
