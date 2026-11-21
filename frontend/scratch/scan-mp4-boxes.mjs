// MP4 box 树递归扫描：回答"某个盒在不在、里面是什么"。validate-mp4.mjs 只查它关心的那几个，
// 而 ctts / sdtp 这类"有没有 B 帧重排"的证据它不报 —— 云端入料要逐件确认形状，得有独立出口。
// 用法：node scan-mp4-boxes.mjs <file.mp4> [要展开详读的盒名，如 ctts]
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const detail = process.argv.slice(3)
if (!file) {
  console.error('用法: node scan-mp4-boxes.mjs <file.mp4> [box...]')
  process.exit(2)
}
const b = readFileSync(file)
const u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
const i32 = (o) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'mvex', 'udta', 'moof', 'traf', 'mdrf'])

function walk(from, to, depth, path) {
  let p = from
  while (p + 8 <= to) {
    let size = u32(p)
    const type = b.subarray(p + 4, p + 8).toString('latin1')
    let ds = p + 8
    if (size === 1) {
      size = Number(new DataView(b.buffer, b.byteOffset + p + 8, 8).getBigUint64(0))
      ds = p + 16
    } else if (size === 0) size = to - p
    if (!Number.isFinite(size) || size < 8 || p + size > to) {
      console.log(`${'  '.repeat(depth)}!! 盒长非法 @${p} type=${type} size=${size}`)
      return
    }
    const here = `${path}/${type}`
    console.log(`${'  '.repeat(depth)}${type}  ${size} B  @${p}..${p + size}`)
    if (CONTAINERS.has(type)) {
      // 容器里若有版本/标志（如 stbl 没有、edts 没有），直接递归；FullBox 型容器不在此列
      walk(ds, p + size, depth + 1, here)
    } else if (detail.includes(type)) {
      dump(type, ds, p + size)
    }
    p += size
  }
}

function dump(type, ds, end) {
  const version = b[ds]
  if (type === 'ctts') {
    const n = u32(ds + 4)
    const rows = []
    for (let i = 0; i < Math.min(n, 4); i++) {
      const o = ds + 8 + i * 8
      rows.push(`count=${u32(o)} offset=${i32(o + 4)}`)
    }
    console.log(`      └─ version=${version} 条目=${n} ${rows.join(' | ')}`)
    let maxOff = 0
    for (let i = 0; i < n; i++) {
      const o = ds + 8 + i * 8
      maxOff = Math.max(maxOff, Math.abs(i32(o + 4)))
    }
    console.log(`      └─ |offset| 最大 ${maxOff}（v0 语义要求 ≤ 255，超了就是非规范写法）`)
  } else if (type === 'stss') {
    const n = u32(ds + 4)
    console.log(`      └─ version=${version} 同步样本数=${n}`)
  } else if (type === 'sdtp') {
    const n = end - (ds + 4)
    const lead = []
    for (let i = 0; i < Math.min(n, 6); i++) {
      const byte = b[ds + 4 + i]
      lead.push(`${(byte >> 6) & 3},${(byte >> 4) & 3},${byte & 3}`)
    }
    console.log(`      └─ ${n} 样本 [depends,depended,copied] ${lead.join(' ')}`)
  } else {
    console.log(`      └─ version=${version} 载荷 ${end - ds} B`)
  }
}

console.log(`=== ${file} ===`)
walk(0, b.length, 0, '')
