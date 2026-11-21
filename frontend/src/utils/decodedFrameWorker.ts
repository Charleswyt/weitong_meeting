import { countDecodedFrames } from './decodedFrameCounter'
// Some browsers expose MediaStreamTrackProcessor only in a dedicated worker.
self.onmessage = ({ data }: MessageEvent<MediaStreamTrack>) => {
  const meter = countDecodedFrames(data)
  if (!meter) { data.stop(); self.postMessage(null); self.close(); return }
  setInterval(() => self.postMessage(meter.read()), 1000)
}
