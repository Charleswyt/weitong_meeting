// 本地结构校验器：不依赖任何播放器，逐项验 webm 的语义是否自洽。
// 起因：能出字节不等于文件合法，而本机没有 ffprobe、浏览器标签又拿不到前台（<video> 加载不了）。
// 用法：node validate-webm.mjs out/muxed.webm
import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) { console.error('用法: node validate-webm.mjs <file.webm>'); process.exit(2) }
const buf = readFileSync(path)

const vlen = (b) => { for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1; return 0 }
const results = []
const ok = (m) => results.push(['OK  ', m])
const bad = (m) => results.push(['FAIL', m])
const warn = (m) => results.push(['WARN', m])

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
  return { id, size, allOnes, start: pos, dataStart: pos + l + sl }
}
const children = (b, from, to) => {
  const out = []
  let p = from
  while (p < to - 1) {
    const e = readElem(b, p)
    if (!e) { p++; continue }
    const end = e.allOnes ? to : Math.min(to, e.dataStart + e.size)
    out.push({ ...e, end })
    if (allOnes(e)) break
    p = end
  }
  return out
}
const allOnes = (e) => e.allOnes
const str = (b, e) => Buffer.from(b.subarray(e.dataStart, e.end)).toString('latin1')
const uintOf = (b, e) => { let v = 0; for (let i = e.dataStart; i < e.end; i++) v = v * 256 + b[i]; return v }
const f64 = (b, e) => new DataView(b.buffer, b.byteOffset + e.dataStart, 8).getFloat64(0)

// ── 顶层 ──────────────────────────────────────────────────────────────
const top = children(buf, 0, buf.length)
const ebml = top.find((e) => e.id === 0x1A45DFA3)
const seg = top.find((e) => e.id === 0x18538067)
if (!ebml) bad('缺 EBML 头'); else {
  const kids = children(buf, ebml.dataStart, ebml.end)
  const doctype = kids.find((e) => e.id === 0x4282)
  if (!doctype) bad('EBML 缺 DocType')
  else if (str(buf, doctype) === 'webm') ok('EBML DocType = webm')
  else bad('DocType 不是 webm：' + str(buf, doctype))
}
if (!seg) { bad('缺 Segment'); report(); process.exit(0) }
ok(`Segment size=${seg.size}（文件 ${buf.length} B）`)
if (!seg.allOnes && seg.end !== buf.length) bad(`Segment 声明长度与文件不符：end=${seg.end} 文件=${buf.length}`)
else ok('Segment 长度与文件一致')

const segKids = children(buf, seg.dataStart, seg.end)
const info = segKids.find((e) => e.id === 0x1549A966)
const tracksEl = segKids.find((e) => e.id === 0x1654AE6B)
const clusters = segKids.filter((e) => e.id === 0x1F43B675)

if (!info) bad('Segment 内缺 Info'); else {
  const ik = children(buf, info.dataStart, info.end)
  const tsc = ik.find((e) => e.id === 0x2AD7B1)
  if (!tsc) warn('Info 缺 TimecodeScale（默认 1e6，可接受）')
  else if (uintOf(buf, tsc) === 1000000) ok('TimecodeScale = 1000000')
  else warn('TimecodeScale = ' + uintOf(buf, tsc))
  const dur = ik.find((e) => e.id === 0x4489)
  if (dur) ok(`Duration = ${f64(buf, dur)} ms`) ; else warn('Info 缺 Duration（可选）')
}

// ── Tracks ───────────────────────────────────────────────────────────
const tracks = new Map()
if (!tracksEl) bad('缺 Tracks'); else {
  for (const te of children(buf, tracksEl.dataStart, tracksEl.end)) {
    if (te.id !== 0xAE) continue
    const k = children(buf, te.dataStart, te.end)
    const t = {
      number: uintOf(buf, k.find((e) => e.id === 0xD7)),
      type: uintOf(buf, k.find((e) => e.id === 0x83)),
      codecId: str(buf, k.find((e) => e.id === 0x86)),
      codecPrivate: k.find((e) => e.id === 0x63A2),
      defaultDuration: k.find((e) => e.id === 0x23E383),
      video: k.find((e) => e.id === 0xE0), audio: k.find((e) => e.id === 0xE1),
    }
    tracks.set(t.number, t)
    ok(`Track ${t.number}: type=${t.type} codec=${t.codecId}`
      + (t.video ? ` ${uintOf(buf, children(buf, t.video.dataStart, t.video.end).find((e) => e.id === 0xB0))}×`
        + `${uintOf(buf, children(buf, t.video.dataStart, t.video.end).find((e) => e.id === 0xBA))}` : '')
      + (t.audio ? (() => { const ak = children(buf, t.audio.dataStart, t.audio.end)
          const sf = ak.find((e) => e.id === 0xB5), ch = ak.find((e) => e.id === 0x9F)
          const sr = sf ? new DataView(buf.buffer, buf.byteOffset + sf.dataStart, sf.end - sf.dataStart).getFloat64(0) : NaN
          return ` ${sr}Hz/${ch ? uintOf(buf, ch) : '?'}ch` })() : ''))
    if (t.audio) {
      if (!t.codecPrivate) bad(`Track ${t.number} 是音频但缺 CodecPrivate（Opus 必需）`)
      else {
        const head = Buffer.from(buf.subarray(t.codecPrivate.dataStart, t.codecPrivate.dataStart + 8)).toString('latin1')
        if (head === 'OpusHead') ok(`Track ${t.number} CodecPrivate = OpusHead（${t.codecPrivate.size} B）`)
        else bad(`Track ${t.number} CodecPrivate 不是 OpusHead：${JSON.stringify(head)}`)
      }
    }
    if (t.type === 1 && !t.video) bad(`Track ${t.number} 是视频但缺 Video 描述`)
  }
}
const videoTrack = [...tracks.values()].find((t) => t.type === 1)
const audioTrack = [...tracks.values()].find((t) => t.type === 2)
if (!videoTrack) bad('没有视频轨')
if (!audioTrack) warn('没有音频轨')

// ── Clusters / SimpleBlock ───────────────────────────────────────────
let blocks = 0, badTrack = 0, badRel = 0, negativeTs = 0
const lastTs = new Map(), counts = new Map(), keyFrames = new Map()
let maxTs = 0
for (const c of clusters) {
  const ck = children(buf, c.dataStart, c.end)
  const tc = ck.find((e) => e.id === 0xE7)
  if (!tc) { bad('Cluster 缺 Timecode'); continue }
  const base = uintOf(buf, tc)
  for (const sb of ck) {
    if (sb.id !== 0xA3) continue
    const b = buf
    const tl = vlen(b[sb.dataStart])
    let tn = 0
    for (let i = 0; i < tl; i++) tn = tn * 256 + b[sb.dataStart + i]
    tn &= 0xFF >> tl
    const rel = (b[sb.dataStart + tl] << 8 | b[sb.dataStart + tl + 1]) << 16 >> 16
    const flags = b[sb.dataStart + tl + 2]
    blocks++
    if (!tracks.has(tn)) badTrack++
    if (rel < 0 || rel > 32767) badRel++
    const ts = base + rel
    if (ts < 0) negativeTs++
    if (lastTs.has(tn) && ts < lastTs.get(tn)) negativeTs++
    lastTs.set(tn, ts)
    counts.set(tn, (counts.get(tn) || 0) + 1)
    if (flags & 0x80) keyFrames.set(tn, (keyFrames.get(tn) || 0) + 1)
    if (ts > maxTs) maxTs = ts
  }
}
ok(`Cluster ${clusters.length} 个 · SimpleBlock ${blocks} 个`)
if (badTrack) bad(`${badTrack} 个 SimpleBlock 的轨道号不在 Tracks 里`)
else ok('所有 SimpleBlock 的轨道号都在 Tracks 里')
if (badRel) bad(`${badRel} 个相对时间码越界`)
if (negativeTs) bad(`${negativeTs} 处时间戳倒退或为负`)
else ok('每一轨的时间戳单调不倒退')
for (const [tn, n] of counts) ok(`Track ${tn} 块数 ${n}，其中标关键帧 ${keyFrames.get(tn) || 0}`)
if (videoTrack && !(keyFrames.get(videoTrack.number) > 0)) bad('视频轨一个关键帧都没标')
ok(`最大时间戳 ${maxTs} ms`)

// 声道/采样率与编码器配置是否一致（这一条抓的是"能解但参数对不上"）
if (audioTrack && audioTrack.audio) {
  const ak = children(buf, audioTrack.audio.dataStart, audioTrack.audio.end)
  const ch = ak.find((e) => e.id === 0x9F)
  if (ch && uintOf(buf, ch) !== 2) warn(`音频声道数 ${uintOf(buf, ch)}（探针配置的是 2）`)
}

function report() {
  const width = Math.max(...results.map((r) => r[0].length))
  for (const [k, m] of results) console.log(`[${k.padEnd(width)}] ${m}`)
  const fails = results.filter((r) => r[0] === 'FAIL').length
  const warns = results.filter((r) => r[0] === 'WARN').length
  console.log(`\n${fails} FAIL · ${warns} WARN · ${results.length - fails - warns} OK`)
  process.exitCode = fails ? 1 : 0
}
report()
