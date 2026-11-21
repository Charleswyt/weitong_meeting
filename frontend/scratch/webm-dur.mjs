import { readFileSync } from 'node:fs'
const b = readFileSync(process.argv[2])
function v(buf, i, max) {
  let len = 1
  for (; len < max; len++) if ((buf[i] & (0x80 >> (len - 1))) !== 0) break
  let v = buf[i] & (0xff >> len)
  for (let k = 1; k < len; k++) v = v * 256 + buf[i + k]
  return { v, len }
}
const CONT = new Set([0x18538067, 0x1549a966, 0x1c53bb6b, 0x1654ae6b, 0x114d9b74])
let found = null
function walk(start, end, depth) {
  let i = start
  for (let n = 0; n < 400 && i + 2 < end; n++) {
    const id = v(b, i, 5)
    const sz = v(b, i + id.len, 9)
    const body = i + id.len + sz.len
    const hex = id.v.toString(16)
    if (depth < 3) console.log('  '.repeat(depth) + hex + ' size=' + sz.v.toString(16).slice(0, 6) + ' @' + i)
    if (hex === '4489') {
      const dv = new DataView(b.buffer, b.byteOffset + body, sz.v)
      found = sz.v === 8 ? dv.getFloat64(0) : sz.v === 4 ? dv.getFloat32(0) : null
      return true
    }
    if (CONT.has(id.v)) { if (walk(body, Math.min(body + (sz.v >>> 0 || end - body), end), depth + 1)) return true }
    if (sz.v > 0x7fffffff || body + sz.v > b.length) return false
    i = body + sz.v
  }
  return false
}
walk(0, b.length, 0)
console.log(JSON.stringify({ durationMs: found }))
