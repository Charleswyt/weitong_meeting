// 直接对 dump 出来的 webm 做 EBML 结构走查，用来判"mux 产物到底坏在哪"。
// 用法：node inspect-webm.mjs out/source.webm out/muxed.webm
import { readFileSync } from 'node:fs'

const NAMES = {
  0x1A45DFA3: 'EBML', 0x18538067: 'Segment', 0x1549A966: 'Info', 0x1654AE6B: 'Tracks',
  0xAE: 'TrackEntry', 0xE0: 'Video', 0xE1: 'Audio', 0x1F43B675: 'Cluster',
  0x2AD7B1: 'TimecodeScale', 0x4489: 'Duration', 0x4D80: 'MuxingApp', 0x5741: 'WritingApp',
  0x4286: 'EBMLVersion', 0x42F7: 'EBMLReadVersion', 0x42F2: 'EBMLMaxIDLength', 0x42F3: 'EBMLMaxSizeLength',
  0x4282: 'DocType', 0x4287: 'DocTypeVersion', 0x4285: 'DocTypeReadVersion',
  0xD7: 'TrackNumber', 0x73C5: 'TrackUID', 0x83: 'TrackType', 0x86: 'CodecID', 0x63A2: 'CodecPrivate',
  0x23E383: 'DefaultDuration', 0x9C: 'FlagLacing', 0xB0: 'PixelWidth', 0xBA: 'PixelHeight',
  0xB5: 'SamplingFrequency', 0x9F: 'Channels', 0xE7: 'Timecode', 0xA3: 'SimpleBlock', 0xA1: 'Block', 0xA0: 'BlockGroup',
}
const MASTER = new Set([0x1A45DFA3, 0x18538067, 0x1549A966, 0x1654AE6B, 0xAE, 0xE0, 0xE1, 0x1F43B675, 0xA0])

function vlen(b) { for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1; return 0 }

function walk(buf, pos, end, depth, maxDepth, hist) {
  while (pos < end - 1) {
    const l = vlen(buf[pos]); if (l < 1 || l > 4) { pos++; continue }
    let id = 0
    for (let i = 0; i < l; i++) id = id * 256 + buf[pos + i]
    const sl = vlen(buf[pos + l]); if (sl < 1 || sl > 8) { pos++; continue }
    let size = 0, allOnes = true
    for (let i = 0; i < sl; i++) {
      const b = buf[pos + l + i]
      const data = i === 0 ? (b & (0xFF >> sl)) : b
      if (i === 0) { if ((b & (0xFF >> sl)) !== (0xFF >> sl)) allOnes = false } else if (b !== 0xFF) allOnes = false
      size = size * 256 + data
    }
    const ds = pos + l + sl
    const de = allOnes ? end : Math.min(end, ds + size)
    const name = NAMES[id] || ('0x' + id.toString(16))
    hist[name] = (hist[name] || 0) + 1
    if (depth <= maxDepth) {
      const extra = name === 'SimpleBlock' || name === 'Block'
        ? (() => {
          const tl = vlen(buf[ds]); let tn = 0
          for (let i = 0; i < tl; i++) tn = tn * 256 + buf[ds + i]
          tn &= 0xFF >> tl
          const rel = (buf[ds + tl] << 8 | buf[ds + tl + 1]) << 16 >> 16
          const fl = buf[ds + tl + 2]
          return ` track=${tn} rel=${rel} flags=0x${fl.toString(16).padStart(2, '0')} key=${(fl & 0x80) ? 1 : 0}`
        })()
        : ''
      console.log('  '.repeat(depth) + `${name} size=${allOnes ? '不定长' : size}${extra}`)
    }
    if (MASTER.has(id) && (allOnes || size > 0)) {
      // Cluster 数量多，只深入看头两个
      const limit = id === 0x1F43B675 ? (hist['Cluster'] <= 2 ? depth + 1 : depth + 1) : depth + 1
      walk(buf, ds, de, limit, maxDepth, hist)
    }
    if (allOnes) return
    pos = de
  }
}

for (const path of process.argv.slice(2)) {
  const buf = readFileSync(path)
  console.log(`\n===== ${path} (${buf.length} B) =====`)
  const hist = {}
  walk(buf, 0, buf.length, 0, 2, hist)
  console.log('-- 元素计数（全文件） --')
  console.log(Object.entries(hist).map(([k, v]) => `${k}:${v}`).join('  '))
}
