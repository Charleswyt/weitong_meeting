// 在 Node 里直接跑 muxer（纯 JS，不需要浏览器），把"offset is out of bounds"的栈找出来。
import { muxMP4 } from './mini-mp4-muxer.js'
import { writeFileSync } from 'node:fs'

const vSamples = []
for (let i = 0; i < 30; i++) vSamples.push({ durationTicks: 66666, key: i % 15 === 0, data: new Uint8Array(500 + i) })
const aSamples = []
for (let i = 0; i < 940; i++) aSamples.push({ durationTicks: 1024, key: true, data: new Uint8Array(320) })

const r = muxMP4({
  video: { width: 640, height: 360, avcC: new Uint8Array(53), timescale: 1e6, samples: vSamples },
  audio: { sampleRate: 48000, channels: 2, asc: new Uint8Array([0x11, 0x90]), bitrate: 128000, samples: aSamples },
})
console.log('OK bytes=', r.bytes.length, 'chunks=', r.chunkCount, 'moov=', r.moovBytes, 'mdat=', r.mdatBytes)
console.log('头 16 字节:', [...r.bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join(' '))
writeFileSync(new URL('./out/node-test.mp4', import.meta.url), r.bytes)
console.log('已写出 out/node-test.mp4（给 validate-mp4.mjs 当靶子）')
