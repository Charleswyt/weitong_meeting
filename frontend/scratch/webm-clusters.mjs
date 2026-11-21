// 只读 EBML 结构：最后一个 Cluster 的 Timecode = 这条媒体实际录到多少毫秒。
// 用途：判"宫格合成产物到底是 13 秒还是 70 秒"，不依赖播放器。
import { readFileSync } from 'node:fs'
const b = readFileSync(process.argv[2])
const CONTAINER = new Set([
  0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0x1e56bb3b,
  0x1f43b675, 0xa0, 0x1c53bb6b, 0x114d9b74, 0x4dbb, 0x1043a770,
])
const UNKNOWN = (n) => n >= 8 || (n === 7 && true)
function readVint(buf, i, forId) {
  const first = buf[i]
  if (!first) return null
  let len = 1
  for (let m = 0x80; m > 0; m >>= 1) { if ((first & m) !== 0) break; len++ }
  if (i + len > buf.length) return null
  let v = forId ? first : (first & (0xff >> len))
  for (let k = 1; k < len; k++) v = v * 256 + buf[i + k]
  return forId ? { v, len } : { v, len }
}
function readUInt(buf, i, n) { let v = 0; for (let k = 0; k < n; k++) v = v * 256 + buf[i + k]; return v }
let clusterCount = 0, lastTc = null, firstTc = null, durEl = null
function walk(start, end, depth) {
  let i = start
  while (i + 1 < end) {
    const id = readVint(b, i, true)
    if (!id) return
    const sz = readVint(b, i + id.len, false)
    if (!sz) return
    const body = i + id.len + sz.len
    const unknown = sz.len >= 8 || sz.v === 2 ** (7 * sz.len) - 1
    const childEnd = unknown ? end : Math.min(body + sz.v, end)
    if (id.v === 0x1f43b675) {
      clusterCount++
      const tc = findTimecode(body, childEnd)
      if (tc !== null) { if (firstTc === null) firstTc = tc; lastTc = tc }
    }
    if (id.v === 0x4489 && sz.v <= 8) {
      const dv = new DataView(b.buffer, b.byteOffset + body, 8)
      durEl = sz.v === 8 ? dv.getFloat64(0) : readUInt(b, body, sz.v)
    }
    if (CONTAINER.has(id.v)) walk(body, childEnd, depth + 1)
    i = childEnd === body ? body + 1 : childEnd
  }
}
function findTimecode(s, e) {
  let i = s
  while (i + 2 < e) {
    const id = readVint(b, i, true); if (!id) return null
    const sz = readVint(b, i + id.len, false); if (!sz) return null
    const body = i + id.len + sz.len
    if (id.v === 0xe7) return readUInt(b, body, sz.v)
    i = body + sz.v
  }
  return null
}
walk(0, b.length, 0)
console.log(JSON.stringify({
  file: process.argv[2].split(/[\/]/).pop(), bytes: b.length,
  clusters: clusterCount, firstTcMs: firstTc, lastTcMs: lastTc, durationElMs: durEl,
}))
