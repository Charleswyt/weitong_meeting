// 把两份 webm 的 Tracks/TrackEntry 逐元素摊开对比 —— 用来定位"mux 产物有画面无声音"。
// 源（MediaRecorder 正品）的声音是好的，拿它当参照物，缺什么一眼能看出。
// 用法：node cmp-tracks.mjs out/source.webm out/muxed.webm
import { readFileSync } from 'node:fs'

const NAMES = {
  0xAE: 'TrackEntry', 0xE0: 'Video', 0xE1: 'Audio',
  0xD7: 'TrackNumber', 0x73C5: 'TrackUID', 0x83: 'TrackType', 0x86: 'CodecID',
  0x63A2: 'CodecPrivate', 0x23E383: 'DefaultDuration', 0x9C: 'FlagLacing',
  0x88: 'FlagDefault', 0xB9: 'FlagEnabled', 0x55AA: 'FlagForced',
  0xB0: 'PixelWidth', 0xBA: 'PixelHeight', 0x54B0: 'DisplayWidth', 0x54BA: 'DisplayHeight',
  0x9A: 'FlagInterlaced', 0x53B8: 'StereoMode', 0x55B0: 'Colour', 0x2EB524: 'ColourSpace',
  0x536E: 'Name', 0x22B59C: 'Language', 0x22B59D: 'LanguageIETF',
  0xB5: 'SamplingFrequency', 0x78B5: 'OutputSamplingFrequency', 0x9F: 'Channels',
  0x6264: 'BitDepth', 0x56AA: 'CodecDelay', 0x56BB: 'SeekPreRoll',
  0x1654AE6B: 'Tracks', 0x18538067: 'Segment', 0x1549A966: 'Info',
}
const isFloat = new Set([0x4489, 0xB5, 0x78B5])
const isStr = new Set([0x86, 0x536E, 0x22B59C, 0x22B59D, 0x4282])

function vlen(b) { for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1; return 0 }
function readElem(b, pos) {
  const l = vlen(b[pos]); if (l < 1 || l > 4) return null
  let id = 0
  for (let i = 0; i < l; i++) id = id * 256 + b[pos + i]
  const sl = vlen(b[pos + l]); if (sl < 1 || sl > 8) return null
  let size = 0, allOnes = true
  for (let i = 0; i < sl; i++) {
    const x = b[pos + l + i]
    const data = i === 0 ? (x & (0xFF >> sl)) : x
    if (i === 0) { if ((x & (0xFF >> sl)) !== (0xFF >> sl)) allOnes = false } else if (x !== 0xFF) allOnes = false
    size = size * 256 + data
  }
  return { id, size, allOnes, dataStart: pos + l + sl, end: pos + l + sl + size }
}
function kids(b, e) {
  const out = []
  let p = e.dataStart
  const lim = e.allOnes ? b.length : e.end
  while (p < lim - 1) {
    const c = readElem(b, p)
    if (!c) { p++; continue }
    out.push(c)
    p = c.end
  }
  return out
}
function val(b, e) {
  const n = e.end - e.dataStart
  if (isStr.has(e.id)) return JSON.stringify(Buffer.from(b.subarray(e.dataStart, e.end)).toString('latin1'))
  if (isFloat.has(e.id)) {
    const dv = new DataView(b.buffer, b.byteOffset + e.dataStart, n)
    return n === 8 ? String(dv.getFloat64(0)) : n === 4 ? String(dv.getFloat32(0)) : '(len=' + n + ')'
  }
  if (e.id === 0x63A2) {
    const s = Buffer.from(b.subarray(e.dataStart, e.end))
    return n === 19 ? 'OpusHead(' + s.readUInt8(9) + 'ch, preSkip=' + s.readUInt16LE(10) + ', rate=' + s.readUInt32LE(12) + ', family=' + s.readUInt8(18) + ')' : 'raw(' + n + 'B) ' + s.toString('hex')
  }
  let v = 0
  for (let i = e.dataStart; i < e.end; i++) v = v * 256 + b[i]
  return String(v)
}
function dumpTracks(path) {
  const b = readFileSync(path)
  console.log(`\n===== ${path} =====`)
  const seg = readElem(b, 0) // EBML 头
  const segEl = readElem(b, seg.end)
  for (const c of kids(b, segEl)) {
    if (c.id !== 0x1654AE6B) continue
    for (const te of kids(b, c)) {
      if (te.id !== 0xAE) continue
      console.log('  TrackEntry')
      for (const k of kids(b, te)) {
        const nm = NAMES[k.id] || ('0x' + k.id.toString(16))
        if (k.id === 0xE0 || k.id === 0xE1) {
          console.log(`    ${nm}`)
          for (const kk of kids(b, k)) {
            console.log(`      ${NAMES[kk.id] || ('0x' + kk.id.toString(16))} = ${val(b, kk)}`)
          }
        } else if (k.id === 0x55B0) {
          console.log(`    ${nm} (size=${k.size})`)
        } else {
          console.log(`    ${nm} = ${val(b, k)}`)
        }
      }
    }
  }
}
for (const p of process.argv.slice(2)) dumpTracks(p)
