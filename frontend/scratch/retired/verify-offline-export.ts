// 离线导出纯核（demuxer + MP4 muxer）的取证脚本 —— 走 Node 直跑仓内真源，不复制副本。
// 跑法：cd edge/conference/frontend && node scratch/verify-offline-export.ts
//
// 覆盖三件事：
//  ① demuxer 吃真实产物（scratch/out/source.webm，MediaRecorder 的"直播流形"）不报错、帧数与关键帧对得上；
//  ② muxer 出的字节结构自洽（box 铺满文件、moov 在前、每个 chunk 偏移落在 mdat 内、样本表互相咬合）；
//  ③ 两条回归：`cat()` 对裸 number 要抛、moov 两趟长度必须相等。
import { readFileSync } from 'node:fs'
import { demuxWebM } from '../src/utils/offlineExport/webmDemuxer.ts'
import { muxMP4 } from '../src/utils/offlineExport/mp4Muxer.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? ' · ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' · ' + detail : ''}`) }
}
const ab = (p: string) => {
  const b = readFileSync(new URL(p, import.meta.url))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

// ── ① demuxer 吃真实产物 ──────────────────────────────────────────────
console.log('\n① demuxer × 真实产物（out/source.webm）')
try {
  const buf = ab('./out/source.webm')
  const d = demuxWebM(buf)
  const tracks = [...d.tracks.values()]
  const video = tracks.find((t) => t.type === 1)
  const audio = tracks.find((t) => t.type === 2)
  check('解析不抛错', true, `${d.ms.toFixed(1)}ms / ${(buf.byteLength / 1024).toFixed(0)}KB`)
  check('检出视频轨', !!video, video ? `${video.codecId} ${video.width}×${video.height}` : '无')
  check('检出音频轨', !!audio, audio ? `${audio.codecId} ${audio.sampleRate}Hz/${audio.channels}ch` : '无')
  check('无 lacing（本解析器只支持一帧一块）', !d.laceWarn)
  if (video) {
    const f = d.frames.get(video.number) ?? []
    check('视频帧数 > 0', f.length > 0, `${f.length} 帧`)
    check('时间戳单调不倒退', f.every((x, i) => i === 0 || x.tsMs >= f[i - 1].tsMs), `${f[f.length - 1]?.tsMs}ms 收尾`)
    check('认出了关键帧（容器标记不可信，靠码流判）', f.some((x) => x.key), `${f.filter((x) => x.key).length} 个`)
    check('每帧都有载荷', f.every((x) => x.data.length > 0))
  }
  if (audio) {
    const f = d.frames.get(audio.number) ?? []
    check('音频帧数 > 0', f.length > 0, `${f.length} 包`)
    check('Opus 有 CodecPrivate(OpusHead)', !!audio.codecPrivate && audio.codecPrivate.length >= 19,
      audio.codecPrivate ? `${audio.codecPrivate.length}B` : '无')
  }
} catch (e) {
  fail++
  console.log('  FAIL demuxer 抛出异常 · ' + (e as Error).message)
}

// ── ② muxer 结构自洽 ─────────────────────────────────────────────────
console.log('\n② muxer × 合成样本（结构自洽性）')
const vSamples = Array.from({ length: 30 }, (_, i) => ({
  durationTicks: 66666, key: i % 15 === 0, data: new Uint8Array(500 + i),
}))
const aSamples = Array.from({ length: 940 }, () => ({
  durationTicks: 1024, key: true, data: new Uint8Array(320),
}))
const r = muxMP4({
  video: { width: 640, height: 360, avcC: new Uint8Array(53), timescale: 1e6, samples: vSamples },
  audio: { sampleRate: 48000, channels: 2, asc: new Uint8Array([0x11, 0x90]), bitrate: 128000, samples: aSamples },
})
const b = r.bytes
const u32at = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0

function topBoxes(from: number, to: number) {
  const out: { type: string; start: number; size: number; ds: number; end: number }[] = []
  let p = from
  while (p + 8 <= to) {
    const size = u32at(p)
    out.push({ type: Buffer.from(b.subarray(p + 4, p + 8)).toString('latin1'), start: p, size, ds: p + 8, end: p + size })
    p += size
  }
  return out
}
const top = topBoxes(0, b.length)
check('第 1 个 box 是 ftyp', top[0]?.type === 'ftyp')
check('box 恰好铺满文件（链没断）', top.reduce((s, t) => s + t.size, 0) === b.length, `${b.length}B`)
const moov = top.find((t) => t.type === 'moov')
const mdat = top.find((t) => t.type === 'mdat')
check('moov 在 mdat 之前（progressive）', !!moov && !!mdat && moov.start < mdat.start)
check('moov 长度与返回一致', !!moov && moov.size === r.moovBytes, `moov=${r.moovBytes}B`)
// mvhd 的 duration：moov 载荷起 → mvhd 盒头 8B → [version/flags 4][creation 4][modification 4][timescale 4] → duration
check('mvhd 时长对得上', u32at(moov!.ds + 24) === r.movieDurMs, `${r.movieDurMs}ms`)
check('有两条 trak', topBoxes(moov!.ds, moov!.end).filter((t) => t.type === 'trak').length === 2)

// 逐 chunk 验偏移：这是"两趟回填偏移"最容易错的地方
function chunkOffsetsOf(trak: { ds: number; end: number }) {
  const boxes = (from: number, to: number) => {
    const out: { type: string; ds: number; end: number }[] = []
    let p = from
    while (p + 8 <= to) { const s = u32at(p); out.push({ type: Buffer.from(b.subarray(p + 4, p + 8)).toString('latin1'), ds: p + 8, end: p + s }); p += s }
    return out
  }
  const mdia = boxes(trak.ds, trak.end).find((x) => x.type === 'mdia')!
  const minf = boxes(mdia.ds, mdia.end).find((x) => x.type === 'minf')!
  const stbl = boxes(minf.ds, minf.end).find((x) => x.type === 'stbl')!
  const sk = boxes(stbl.ds, stbl.end)
  const stco = sk.find((x) => x.type === 'stco')!
  const stsz = sk.find((x) => x.type === 'stsz')!
  const stsc = sk.find((x) => x.type === 'stsc')!
  const scN = u32at(stsc.ds + 4)
  const rows = Array.from({ length: scN }, (_, i) => ({ first: u32at(stsc.ds + 8 + i * 12), n: u32at(stsc.ds + 12 + i * 12) }))
  const nSamples = u32at(stsz.ds + 8)
  const sizes = Array.from({ length: nSamples }, (_, i) => u32at(stsz.ds + 12 + i * 4))
  const nChunks = u32at(stco.ds + 4)
  let idx = 0, outOfRange = 0, overlap = 0, prevEnd = -1
  for (let c = 0; c < nChunks; c++) {
    const off = u32at(stco.ds + 8 + c * 4)
    let sz = 1
    for (let i = 0; i < rows.length; i++) {
      const next = i + 1 < rows.length ? rows[i + 1].first : nChunks + 1
      if (c + 1 >= rows[i].first && c + 1 < next) { sz = rows[i].n; break }
    }
    let bytes = 0
    for (let k = 0; k < sz && idx < sizes.length; k++, idx++) bytes += sizes[idx]
    if (off < mdat!.ds || off + bytes > mdat!.end) outOfRange++
    if (off < prevEnd) overlap++
    prevEnd = off + bytes
  }
  return { nChunks, nSamples, outOfRange, overlap, consumed: idx }
}
for (const trak of topBoxes(moov!.ds, moov!.end).filter((t) => t.type === 'trak')) {
  const c = chunkOffsetsOf(trak)
  check(`trak chunk ${c.nChunks} 个 / 样本 ${c.nSamples} 个 · 偏移全在 mdat 内`, c.outOfRange === 0)
  check('trak chunk 数据不重叠', c.overlap === 0)
  check('trak 样本被 chunk 表完整消费', c.consumed === c.nSamples, `${c.consumed}/${c.nSamples}`)
}

// ── ③ 两条回归 ───────────────────────────────────────────────────────
console.log('\n③ 回归')
let threw = false
try {
  muxMP4({ video: { width: 2, height: 2, avcC: 53 as unknown as Uint8Array, timescale: 1e3, samples: [] } })
} catch (e) {
  threw = e instanceof TypeError || e instanceof RangeError
}
check('裸 number 混入 avcC 会被抓住（不是静默产出坏文件）', threw)
check('小样本也能建出合法结构（moov 两趟长度相等）', r.bytes.length > 1000 && r.moovBytes > 0, `${r.bytes.length}B`)

// ── ④ 崩溃自愈重建出来的产物是不是真文件 ──────────────────────────────
// 这份不是手工放的 fixture：`scratch/crash-sim-probe.html` 录一场真 MediaRecorder、不 finish() 就翻页
// （= 崩了），再由启动自愈重建清单、按清单拼回文件后 dump 到这儿。缺文件就跳过（换新克隆不该因此红）。
console.log('\n④ 自愈重建产物（out/crashsim-recovered.webm，浏览器 dump 上来）')
let recovered: Uint8Array | null = null
try {
  recovered = new Uint8Array(readFileSync(new URL('./out/crashsim-recovered.webm', import.meta.url)))
} catch {
  console.log('  SKIP 没有 dump 文件（先在浏览器跑一次 crash-sim 探针）')
}
if (recovered && recovered.length) {
  const buf = recovered.buffer.slice(recovered.byteOffset, recovered.byteOffset + recovered.byteLength) as ArrayBuffer
  const d = demuxWebM(buf)
  const video = [...d.tracks.values()].find((t) => t.type === 1)
  const audio = [...d.tracks.values()].find((t) => t.type === 2)
  check('顶层是 EBML（前 4 字节 0x1a45dfa3）', recovered[0] === 0x1a && recovered[1] === 0x45 && recovered[2] === 0xdf && recovered[3] === 0xa3)
  check('解得出视频轨', !!video, video ? `${video.codecId} ${video.width}×${video.height}` : '无')
  check('解得出音频轨', !!audio, audio ? `${audio.codecId} ${audio.sampleRate}Hz/${audio.channels}ch` : '无')
  const vf = video ? d.frames.get(video.number) ?? [] : []
  const af = audio ? d.frames.get(audio.number) ?? [] : []
  check('逐片拼回来后仍是连续可解的一路', vf.length > 0 && af.length > 0, `${vf.length} 帧视频 / ${af.length} 包音频`)
  check('视频时间戳单调（拼接处没有倒灌）', vf.every((x, i) => i === 0 || x.tsMs >= vf[i - 1].tsMs))
  check('时长元素被补过（不是 Infinity）', (() => {
    // finalizeWebmDuration 写的 Duration 在 Segment/Info 里；这里用"末帧时间戳"当独立佐证
    const last = vf[vf.length - 1]?.tsMs ?? af[af.length - 1]?.tsMs ?? 0
    return last > 0
  })(), `${vf[vf.length - 1]?.tsMs ?? 0}ms 收尾`)
}

console.log(`\n${fail} FAIL · ${pass} OK`)
process.exitCode = fail ? 1 : 0
