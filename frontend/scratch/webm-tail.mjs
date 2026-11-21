// 判 .crdownload 到底是"写断在半截"还是"字节全了只等确认"：
// 走一遍 EBML，若某个元素声明的长度超过剩余字节 = 被截断；若最后一个元素正好在 EOF 收尾 = 完整。
import { readFileSync } from 'node:fs'
const b = readFileSync(process.argv[2])
function vint(buf, i, forId) {
  const first = buf[i]
  if (!first) return null
  let len = 1
  for (let m = 0x80; m > 0; m >>= 1) { if ((first & m) !== 0) break; len++ }
  if (i + len > buf.length) return null
  let v = forId ? first : (first & (0xff >> len))
  for (let k = 1; k < len; k++) v = v * 256 + buf[i + k]
  return { v, len }
}
const CONTAINER = new Set([0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b, 0x1e56bb3b, 0x1f43b675, 0xa0, 0x1c53bb6b, 0x114d9b74, 0x4dbb, 0x1043a770])
let truncatedAt = null
let deepestEnd = 0
function walk(start, end, depth) {
  let i = start
  while (i + 1 < end) {
    const id = vint(b, i, true)
    if (!id) { truncatedAt = { i, why: 'id' }; return }
    const sz = vint(b, i + id.len, false)
    if (!sz) { truncatedAt = { i, why: 'size' }; return }
    const body = i + id.len + sz.len
    const unknown = sz.len >= 8 || sz.v === 2 ** (7 * sz.len) - 1
    const childEnd = unknown ? end : body + sz.v
    if (!unknown && childEnd > b.length) { truncatedAt = { i, id: id.v, need: childEnd - b.length }; return }
    deepestEnd = Math.max(deepestEnd, Math.min(childEnd, b.length))
    if (CONTAINER.has(id.v)) walk(body, Math.min(childEnd, end), depth + 1)
    else if (id.v === 0x1f43b675) walk(body, Math.min(childEnd, end), depth + 1)
    i = childEnd
    if (i > end) return
  }
}
walk(0, b.length, 0)
console.log(JSON.stringify({
  file: process.argv[2].split(/[\\/]/).pop(),
  bytes: b.length,
  truncatedAt,
  deepestEnd,
  endsAtEof: deepestEnd === b.length,
  slackBytes: b.length - deepestEnd,
}))
