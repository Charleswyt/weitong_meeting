import { sitePath } from './sitePath'

export function wav(frames: Float32Array[]) {
  const count = frames.reduce((n, f) => n + f.length, 0)
  const out = new ArrayBuffer(44 + 2 * count)
  const view = new DataView(out)
  const tag = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i))
  }
  tag(0, 'RIFF')
  view.setUint32(4, 36 + count * 2, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16000, true)
  view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, count * 2, true)
  let i = 44
  for (const frame of frames)
    for (const v of frame) {
      view.setInt16(i, Math.round(Math.max(-1, Math.min(1, v)) * (v < 0 ? 32768 : 32767)), true)
      i += 2
    }
  return new Blob([out], { type: 'audio/wav' })
}

export async function listen(track: MediaStreamTrack, frame: (data: Float32Array) => void) {
  if (!track.enabled || track.readyState !== 'live') throw new Error('请先开启会议麦克风')
  const audio = new AudioContext({ sampleRate: 16000 })
  try {
    await audio.audioWorklet.addModule(sitePath('/meeting-pcm.js'))
    const source = audio.createMediaStreamSource(new MediaStream([track]))
    const node = new AudioWorkletNode(audio, 'meeting-pcm')
    const mute = audio.createGain()
    mute.gain.value = 0
    source.connect(node)
    node.connect(mute)
    mute.connect(audio.destination)
    node.port.onmessage = (e) => {
      if (track.enabled && track.readyState === 'live') frame(e.data as Float32Array)
    }
    await audio.resume()
    return () => {
      node.port.onmessage = null
      source.disconnect()
      node.disconnect()
      mute.disconnect()
      void audio.close()
    }
  } catch (e) {
    await audio.close()
    throw e
  }
}
