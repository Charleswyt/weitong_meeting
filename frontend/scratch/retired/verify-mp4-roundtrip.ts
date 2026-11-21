// MP4 写出去再读回来 —— muxer 与 demuxer 的往返断言（云端入料的前置）。
// 跑法：cd edge/conference/frontend && node scratch/verify-mp4-roundtrip.ts
//
// 为什么要有这一份：demuxer 的字段偏移只能按 ISO/IEC 14496-12 算，而"我们自己的产物能不能被规范读法读对"
// 是另一件事，两边一往返就能把任一侧的偏移错配抓出来。
// 本轮真实经过：先按"pre_defined 后只有 4 字节"把 demuxer 写成 width@+12/children@+64，
// 往返一片红，差点去把**本来写对了的 muxer** 改坏 —— 实测 avc1 入口 147B、avcC 落在 +78，
// 与规范的 predefined[3](12) 完全一致。教训：**能播不能证明合规范，但"读不通"也不能证明写的人错**。
import { register } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
register('./ts-alias-hooks.mjs', import.meta.url)

const { muxMP4 } = await import('../src/utils/offlineExport/mp4Muxer.ts')
const { demuxMp4 } = await import('../src/utils/offlineExport/mp4Demuxer.ts')

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? ' · ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' · ' + detail : ''}`) }
}
const eqBytes = (a?: Uint8Array, b?: Uint8Array) =>
  !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i])

// ── 造一份已知内容的两轨 MP4 ────────────────────────────────────────────
const W = 640
const H = 360
const RATE = 48000
const CH = 2
// 假 avcC 记录（demuxer 只按盒子取字节 + 读 profile/compat/level 三个字节）
const avcCRecord = new Uint8Array([0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x02, 0x67, 0x42])
const avcCBox = (() => {
  const head = new Uint8Array(8)
  const dv = new DataView(head.buffer)
  dv.setUint32(0, 8 + avcCRecord.length)
  for (let i = 0; i < 4; i++) head[4 + i] = 'avcC'.charCodeAt(i)
  return new Uint8Array([...head, ...avcCRecord])
})()
const asc = new Uint8Array([0x11, 0x90]) // AAC-LC 48k 双声道
const vSamples = Array.from({ length: 40 }, (_, i) => ({
  durationTicks: 3333, key: i % 13 === 0, data: new Uint8Array(200 + i * 7).fill(i & 0xff),
}))
const aSamples = Array.from({ length: 120 }, (_, i) => ({
  durationTicks: 1024, key: true, data: new Uint8Array(160 + (i % 5)).fill((i + 1) & 0xff),
}))
const muxed = muxMP4({
  // 注意：muxMP4 吃的是 **avcC 记录本体**（它自己补盒子头），demuxer 吐的是**整个盒子**
  video: { width: W, height: H, avcC: avcCRecord, timescale: 90000, samples: vSamples },
  audio: { sampleRate: RATE, channels: CH, asc, timescale: RATE, samples: aSamples },
})
const buf = muxed.bytes.slice().buffer as ArrayBuffer
const d = demuxMp4(buf)

console.log('\n① 结构与表')
check('无 warning（有就说明哪一段没按规范读懂）', d.warnings.length === 0, d.warnings.join(' | '))
check('moov 在 mdat 前（faststart）', d.faststart === true)
check('解出两条轨', d.tracks.length === 2, d.tracks.map((t) => `${t.handler}:${t.codec}`).join(' '))
const vid = d.tracks.find((t) => t.type === 1)
const aud = d.tracks.find((t) => t.type === 2)

console.log('\n② 画面轨的解码配置项')
check('objectEntry=avc1', vid?.objectEntry === 'avc1')
check('codec 串带 profile/level', vid?.codec === 'avc1.64001f', vid?.codec)
check(`宽高超给的值（stsd 按规范 +24/+26 读到 ${vid?.width}×${vid?.height}）`, vid?.width === W && vid?.height === H)
check('description 是整个 avcC 盒子（含 8 字节头）', eqBytes(vid?.description, avcCBox),
  `${vid?.description?.length ?? 0}B vs ${avcCBox.length}B`)
check('description 前 4 字节是长度、+4 起是 avcC', (() => {
  const x = vid?.description
  if (!x) return false
  const dv = new DataView(x.buffer, x.byteOffset, x.byteLength)
  return dv.getUint32(0) === x.length && String.fromCharCode(x[4], x[5], x[6], x[7]) === 'avcC'
})())
check('样本数与写入一致', vid?.samples.length === vSamples.length, `${vid?.samples.length} / ${vSamples.length}`)
check('关键帧位与 stss 一致', (vid?.samples || []).every((s, i) => s.key === (i % 13 === 0)),
  `${(vid?.samples || []).filter((s) => s.key).length} 个关键帧`)
check('每样本字节都非空', (vid?.samples || []).every((s) => s.data.length === s.byteLength && s.byteLength > 0))
check('载荷逐字节回得上（没有读错偏移）', (vid?.samples || []).every((s, i) => eqBytes(s.data, vSamples[i].data)))

console.log('\n③ 声音轨')
check('objectEntry=mp4a', aud?.objectEntry === 'mp4a')
check('codec 由 ASC 的 profile 推', aud?.codec === 'mp4a.40.2', aud?.codec)
check(`采样率/声道数对得上（+22 声道、+30 采样率）`, aud?.sampleRate === RATE && aud?.channels === CH,
  `${aud?.sampleRate}Hz/${aud?.channels}ch`)
check('AudioSpecificConfig 从 esds 里抠回来了', eqBytes(aud?.audioSpecificConfig, asc),
  `${(aud?.audioSpecificConfig || []).join(' ')}`)
check('音频样本数一致', aud?.samples.length === aSamples.length, `${aud?.samples.length}`)
check('音频载荷逐字节回得上', (aud?.samples || []).every((s, i) => eqBytes(s.data, aSamples[i].data)))

console.log('\n④ 时间轴算术')
const vsum = (vid?.samples || []).reduce((a, s) => a + s.durationMs, 0)
check('时长累加=样本数×每帧时长', Math.abs(vsum - vSamples.length * (3333 / 90000) * 1000) < 1, `${vsum.toFixed(1)}ms`)
check('dts 单调', (vid?.samples || []).every((s, i) => i === 0 || s.dtsMs >= (vid!.samples[i - 1].dtsMs)))
check('无 ctts 时 hasReorder=false 且 pts=dts', !vid?.hasReorder && vid!.samples.every((s) => s.ptsMs === s.dtsMs))
check('轨时长与 mvhd 同量级', Math.abs((vid?.durationMs || 0) - d.durationMs) < 1500,
  `轨 ${(vid?.durationMs || 0).toFixed(0)}ms / 片 ${d.durationMs.toFixed(0)}ms`)

console.log('\n⑤ 字节区间：两轨合起来必须正好铺满 mdat 且不重叠')
const mdatStart = (() => {
  const dv = new DataView(buf)
  const b = new Uint8Array(buf)
  let p = 0
  while (p + 8 <= b.length) {
    const size = dv.getUint32(p)
    const t = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7])
    if (t === 'mdat') return p + 8
    if (size < 8) break
    p += size
  }
  return -1
})()
const all = d.tracks.flatMap((t) => t.samples).sort((a, b) => a.byteOffset - b.byteOffset)
check('找到 mdat', mdatStart > 0, `@${mdatStart}`)
let overlap = 0
let gapBytes = 0
let cur = mdatStart
for (const s of all) {
  if (s.byteOffset < cur) overlap++
  else gapBytes += s.byteOffset - cur
  cur = Math.max(cur, s.byteOffset + s.byteLength)
}
check('样本区间互不重叠', overlap === 0, `${overlap} 处重叠`)
check('区间之间没有空隙（chunk 表没算错）', gapBytes === 0, `${gapBytes}B 空隙`)
check('全部落在 mdat 内', all.every((s) => s.byteOffset >= mdatStart && s.byteOffset + s.byteLength <= buf.byteLength))

console.log('\n⑥ 真件回读（有的话）')
for (const f of ['./out/muxed.mp4', './out/node-test.mp4']) {
  const p = new URL(f, import.meta.url)
  if (!existsSync(p)) { console.log(`  SKIP ${f} 不在盘上`); continue }
  const node = readFileSync(p)
  const r = demuxMp4(node.buffer.slice(node.byteOffset, node.byteOffset + node.byteLength) as ArrayBuffer)
  const v = r.tracks.find((t) => t.type === 1)
  console.log(`  INFO ${f}: ${(node.length / 1024).toFixed(0)}KB faststart=${r.faststart} `
    + `轨=[${r.tracks.map((t) => `${t.handler}:${t.codec} ${t.samples.length}片`).join(' ')}] `
    + `画面=${v?.width}×${v?.height} warning=${r.warnings.length ? r.warnings.join('|') : '无'}`)
  check(`${f} 无 warning`, r.warnings.length === 0, r.warnings.join(' | '))
  check(`${f} 有画面轨且有 avcC description`, !!v?.description && v.samples.length > 0,
    `${v?.samples.length ?? 0} 帧`)
}

console.log(`\n${fail} FAIL · ${pass} OK`)
process.exitCode = fail ? 1 : 0
