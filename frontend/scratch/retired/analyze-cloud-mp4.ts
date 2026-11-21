// 用 mp4Demuxer 分析真实云端 MP4，回答三件事：
// 1. ctts 有没有（hasReorder → 决定 B 帧重排那条路要不要做）
// 2. 画面件里有没有 soun 轨（会不会与同人麦克风重复出声）
// 3. stsd 是否靠 avcC 带 SPS（description 是否必须给 VideoDecoder）
import { readFileSync } from 'node:fs'
import { demuxMp4 } from '../src/utils/offlineExport/mp4Demuxer.ts'

function toArrayBuffer(nodeBuf: Buffer): ArrayBuffer {
  // Node Buffer 可能共享底层 ArrayBuffer（池），必须拷出独立的一份给 demuxer
  const ab = new ArrayBuffer(nodeBuf.length)
  new Uint8Array(ab).set(nodeBuf)
  return ab
}

const files = [
  'scratch/out/cloud-fixture-video.mp4',
  'scratch/out/cloud-fixture-audio.mp4',
]

for (const f of files) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`FILE: ${f}`)
  const buf = toArrayBuffer(readFileSync(f))
  const result = demuxMp4(buf)
  console.log(`faststart: ${result.faststart}`)
  console.log(`durationMs: ${result.durationMs}`)
  console.log(`parse time: ${result.ms.toFixed(1)}ms`)
  console.log(`tracks: ${result.tracks.length}`)
  if (result.warnings.length) {
    console.log(`warnings: ${result.warnings.join(', ')}`)
  }
  for (const t of result.tracks) {
    console.log(`\n  --- track ${t.trackId} (${t.handler}) ---`)
    console.log(`  objectEntry: ${t.objectEntry}`)
    console.log(`  codec: ${t.codec}`)
    if (t.width) console.log(`  resolution: ${t.width}x${t.height}`)
    if (t.sampleRate) console.log(`  sampleRate: ${t.sampleRate} channels: ${t.channels}`)
    console.log(`  timescale: ${t.timescale}`)
    console.log(`  durationMs: ${t.durationMs.toFixed(1)}`)
    console.log(`  samples: ${t.samples.length}`)
    console.log(`  hasReorder: ${t.hasReorder}`)
    console.log(`  description: ${t.description ? `${t.description.length} bytes` : 'none'}`)
    if (t.audioSpecificConfig) {
      console.log(`  audioSpecificConfig: ${t.audioSpecificConfig.length} bytes [${[...t.audioSpecificConfig].map(b => b.toString(16).padStart(2, '0')).join(' ')}]`)
    }
    if (t.samples.length) {
      const first3 = t.samples.slice(0, 3)
      for (const s of first3) {
        console.log(`  sample[${s.index}]: dts=${s.dtsMs.toFixed(1)}ms pts=${s.ptsMs.toFixed(1)}ms cts=${s.ctsMs.toFixed(1)}ms dur=${s.durationMs.toFixed(1)}ms key=${s.key} size=${s.byteLength}`)
      }
      const keyCount = t.samples.filter(s => s.key).length
      console.log(`  keyframes: ${keyCount}/${t.samples.length}`)
      const ctsNonZero = t.samples.filter(s => s.ctsMs !== 0).length
      console.log(`  cts!=0: ${ctsNonZero}/${t.samples.length}`)
    }
  }
}
