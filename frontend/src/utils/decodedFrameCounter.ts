// Count the packed bytes of each visible decoded frame. No pixel buffer is copied.
export interface FrameMeter { read: () => number | null; stop: () => void }
interface Processor {
  readable: ReadableStream<VideoFrame>
  discardedFrames?: number
}
const ProcessorClass = (globalThis as typeof globalThis & {
  MediaStreamTrackProcessor?: new (arg: { track: MediaStreamTrack; maxBufferSize: number }) => Processor
}).MediaStreamTrackProcessor

export function countDecodedFrames(track: MediaStreamTrack): FrameMeter | null {
  if (!ProcessorClass) return null
  const processor = new ProcessorClass({ track, maxBufferSize: 2 })
  const reader = processor.readable.getReader()
  let bytes = 0, frames = 0, invalid = 0, ended = false
  let previous: { at: number; bytes: number; invalid: number; dropped: number } | null = null
  void (async () => {
    try {
      while (!ended) {
        const { done, value } = await reader.read()
        if (done) break
        try {
          const size = value.allocationSize()
          if (size > 0) { bytes += size; frames++ } else invalid++
        } catch { invalid++ }
        finally { value.close() }
      }
    } catch { /* A disconnected device ends its measurement. */ }
    finally { ended = true; reader.releaseLock() }
  })()
  return {
    read() {
      if (ended || !frames) return null
      const next = { at: performance.now(), bytes, invalid, dropped: processor.discardedFrames ?? 0 }
      const old = previous
      previous = next
      if (!old || next.at <= old.at || old.invalid !== invalid || old.dropped !== next.dropped) return null
      return Math.round((bytes - old.bytes) * 80 / (next.at - old.at)) / 10
    },
    stop() {
      if (!ended) { ended = true; void reader.cancel().catch(() => undefined) }
    },
  }
}
