// 本地 MP4 结构校验器：不依赖播放器，逐项验 box 树与样本表的自洽性。
// 重点是 **stco 的每个 chunk 偏移必须落在 mdat 载荷范围内** —— 那是"两趟回填偏移"最容易错的地方。
// 用法：node validate-mp4.mjs out/muxed.mp4
import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (!path) { console.error('用法: node validate-mp4.mjs <file.mp4>'); process.exit(2) }
const b = readFileSync(path)

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'mvex', 'udta', 'moof', 'traf'])
const results = []
const ok = (m) => results.push(['OK  ', m])
const bad = (m) => results.push(['FAIL', m])
const warn = (m) => results.push(['WARN', m])
const u32at = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
const u16at = (o) => (b[o] << 8) | b[o + 1]
const u64at = (o) => Number(new DataView(b.buffer, b.byteOffset + o, 8).getBigUint64(0))

function boxes(from, to) {
  const out = []
  let p = from
  while (p + 8 <= to) {
    let size = u32at(p)
    const type = b.subarray(p + 4, p + 8).toString('latin1')
    let ds = p + 8
    if (size === 1) { size = u64at(p + 8); ds = p + 16 }
    else if (size === 0) size = to - p
    out.push({ type, start: p, size, ds, end: p + size })
    p += size
  }
  return out
}

// ISO/IEC 14496-1 §8.3.3：tag(1) + 长度(1~4 字节，每字节低 7 位有效、最高位是续位)。
// 只往 ES_Descriptor(0x03) 与 DecoderConfigDescriptor(0x04) 里下钻，其余按不透明载荷跳过。
function derLen(at, end) {
  let len = 0
  let p = at
  for (let k = 0; k < 4 && p < end; k++, p++) {
    const byte = b[p]
    len = ((len << 7) | (byte & 0x7f)) >>> 0
    if (!(byte & 0x80)) return { len, next: p + 1 }
  }
  return null
}

function findDecoderSpecificInfo(from, end) {
  let p = from
  while (p < end) {
    const tag = b[p]
    const l = derLen(p + 1, end)
    if (!l) return null
    const body = l.next
    const stop = Math.min(body + l.len, end)
    if (tag === 0x05) return { start: body, end: stop }
    if (tag === 0x03) {
      const nested = findDecoderSpecificInfo(body + 3, stop)
      if (nested) return nested
    } else if (tag === 0x04) {
      const nested = findDecoderSpecificInfo(body + 13, stop)
      if (nested) return nested
    }
    p = stop
  }
  return null
}

const top = boxes(0, b.length)
const tree = top.map((t) => t.type)
if (top[0] && top[0].type === 'ftyp') ok('第 1 个 box 是 ftyp') ; else bad('第 1 个 box 不是 ftyp：' + (top[0] && top[0].type))
const ftyp = top.find((t) => t.type === 'ftyp')
if (ftyp) {
  const brand = b.subarray(ftyp.ds, ftyp.ds + 4).toString('latin1')
  const compat = []
  for (let o = ftyp.ds + 8; o + 4 <= ftyp.end; o += 4) compat.push(b.subarray(o, o + 4).toString('latin1'))
  ok(`ftyp major=${brand} compatible=[${compat.join(',')}]`)
}
const moov = top.find((t) => t.type === 'moov')
const mdat = top.find((t) => t.type === 'mdat')
if (!moov) bad('缺 moov')
if (!mdat) bad('缺 mdat')
if (moov && mdat) {
  if (moov.start < mdat.start) ok('moov 在 mdat 之前（progressive，对老播放器友好）')
  else warn('moov 在 mdat 之后（仍可播，但流式播放器要先读完整个文件）')
  ok(`moov ${moov.size} B · mdat ${mdat.size} B · 文件 ${b.length} B`)
  if (mdat.size !== b.length - mdat.start) bad('mdat 长度与文件尾部不符')
  if (top.reduce((s, t) => s + t.size, 0) !== b.length) bad('顶层 box 长度之和 != 文件长度（box 链断了）')
  else ok('顶层 box 互不重叠且恰好铺满文件')
}

if (moov) {
  const mk = boxes(moov.ds, moov.end)
  // tkhd 的时长单位是 **mvhd 的 timescale**，不是毫秒 —— 早先这里按 1000 除，
  // 对 timescale=57600 的产物会恒报"tkhd 与 mdhd 时长差超 0.5s"的假 WARN（差点让人以为产物坏了）。
  let movieTs = 0
  const mvhd = mk.find((t) => t.type === 'mvhd')
  if (!mvhd) bad('moov 缺 mvhd')
  else {
    const ts = u32at(mvhd.ds + 12)
    movieTs = ts
    const dur = u32at(mvhd.ds + 16)
    ok(`mvhd timescale=${ts} duration=${dur} (${(dur / ts).toFixed(2)}s) nextTrackID=${u32at(mvhd.ds + 96)}`)
  }
  const traks = mk.filter((t) => t.type === 'trak')
  // "影音双轨"是**合成产物**的判据，不是所有 mp4 的。云端录制是"一条 recording 一路发布"，
  // 单轨才是对的 —— 以前无条件报 FAIL，等于对每个云端件都挂一条已知假失败，
  // 看久了人就无视 FAIL 了。要验双轨传 `--expect-muxed`。
  if (traks.length === 0) bad('一条 trak 都没有')
  else if (process.argv.includes('--expect-muxed') && traks.length !== 2) {
    bad(`--expect-muxed：trak 数量是 ${traks.length}，期望 2（视频+音频）`)
  } else ok(`trak 数量 ${traks.length}`)

  for (const trak of traks) {
    const tk = boxes(trak.ds, trak.end)
    const tkhd = tk.find((t) => t.type === 'tkhd')
    const mdia = tk.find((t) => t.type === 'mdia')
    if (!tkhd || !mdia) { bad('trak 缺 tkhd/mdia'); continue }
    const trackId = u32at(tkhd.ds + 12)
    const tkhdDur = u32at(tkhd.ds + 20)
    const w = u32at(tkhd.ds + 76) / 65536, h = u32at(tkhd.ds + 80) / 65536
    const mdk = boxes(mdia.ds, mdia.end)
    const mdhd = mdk.find((t) => t.type === 'mdhd')
    const hdlr = mdk.find((t) => t.type === 'hdlr')
    const minf = mdk.find((t) => t.type === 'minf')
    const handler = hdlr ? b.subarray(hdlr.ds + 8, hdlr.ds + 12).toString('latin1') : '?'
    const mts = u32at(mdhd.ds + 12), mdur = u32at(mdhd.ds + 16)
    ok(`trak id=${trackId} handler=${handler} timescale=${mts} duration=${mdur} (${(mdur / mts).toFixed(2)}s)`
      + (handler === 'vide' ? ` 显示尺寸 ${w}×${h}` : '') + ` tkhd时长=${tkhdDur}`)
    if (mdhd && movieTs && Math.abs(mdur / mts - tkhdDur / movieTs) > 0.5) warn(`tkhd(${(tkhdDur / movieTs).toFixed(2)}s) 与 mdhd(${(mdur / mts).toFixed(2)}s) 时长差超 0.5s`)

    const stbl = boxes(minf.ds, minf.end).find((t) => t.type === 'stbl')
    if (!stbl) { bad('minf 缺 stbl'); continue }
    const sk = boxes(stbl.ds, stbl.end)
    const get = (t) => sk.find((x) => x.type === t)
    const stsd = get('stsd'), stts = get('stts'), stsc = get('stsc'), stsz = get('stsz'), stco = get('stco'), stss = get('stss')

    if (stsd) {
      const entry = boxes(stsd.ds + 8, stsd.end)[0]
      ok(`stsd 采样格式 = ${entry ? entry.type : '?'}`)
      if (entry && entry.type === 'avc1') {
        const avcC = boxes(entry.ds + 78, entry.end).find((t) => t.type === 'avcC')
        ok(avcC ? `avc1 内含 avcC（${avcC.size - 8} B，profile=0x${b[avcC.ds + 1].toString(16)} level=0x${b[avcC.ds + 3].toString(16)}）` : '')
        if (!avcC) bad('avc1 缺 avcC')
      }
      if (entry && entry.type === 'mp4a') {
        const esds = boxes(entry.ds + 28, entry.end).find((t) => t.type === 'esds')
        if (esds) {
          // DecoderSpecificInfo(0x05) 的载荷就是 AudioSpecificConfig。**必须按描述符边界逐个走**：
          // 早先这里写的是 `indexOf(0x05)` + 取后一个字节当长度，两处都会咬人 ——
          // ① 0x05 可能出现在长度/别的字节里被当成 tag；② 长度是 DER 展开式（每字节 7 位、最高位=续位，
          // 最多 4 字节），直接取首字节会把 `80 80 80 25`（真长度 37）读成 128，
          // 于是把续位字节当成 ASC 开头报出"128 B（8080…）"。云端音频件就是这么被读错的。
          const asc = findDecoderSpecificInfo(esds.ds + 4, esds.end)
          if (asc) {
            const hex = Buffer.from(b.subarray(asc.start, asc.end)).toString('hex')
            ok(`mp4a 内含 esds，AudioSpecificConfig ${asc.end - asc.start} B（${hex}）`)
          } else {
            bad('mp4a 的 esds 里没找到 DecoderSpecificInfo')
          }
        } else bad('mp4a 缺 esds')
      }
    } else bad('stbl 缺 stsd')

    let sampleCount = 0, totalBytes = 0
    if (stsz) { sampleCount = u32at(stsz.ds + 8); ok(`stsz 样本数 ${sampleCount}`) }
    if (stts) {
      const n = u32at(stts.ds + 4)
      let cnt = 0, ticks = 0
      for (let i = 0; i < n; i++) { const c = u32at(stts.ds + 8 + i * 8), d = u32at(stts.ds + 12 + i * 8); cnt += c; ticks += c * d }
      ok(`stts ${n} 段 · 合计 ${cnt} 样本 · ${ticks} ticks`)
      if (cnt !== sampleCount) bad(`stts 样本数 ${cnt} != stsz ${sampleCount}`)
    }
    if (stss) ok(`stss 关键帧 ${u32at(stss.ds + 4)} 个`)
    else warn('没有 stss（视作全部样本都是同步样本）')

    if (stsc && stsz && stco) {
      const scN = u32at(stsc.ds + 4)
      const rows = []
      for (let i = 0; i < scN; i++) rows.push({ first: u32at(stsc.ds + 8 + i * 12), n: u32at(stsc.ds + 12 + i * 12) })
      const chunkN = u32at(stco.ds + 4)
      let expanded = 0
      for (let i = 0; i < rows.length; i++) {
        const next = i + 1 < rows.length ? rows[i + 1].first : chunkN + 1
        expanded += (next - rows[i].first) * rows[i].n
      }
      ok(`stco chunk ${chunkN} 个 · stsc 展开 ${expanded} 样本`)
      if (expanded !== sampleCount) bad(`stsc 展开 ${expanded} != stsz ${sampleCount}`)
      // 逐 chunk 验偏移是否落在 mdat 载荷内
      const sizes = []
      for (let i = 0; i < sampleCount; i++) sizes.push(u32at(stsz.ds + 12 + i * 4))
      totalBytes = sizes.reduce((s, v) => s + v, 0)
      let idx = 0, outOfRange = 0, overlap = 0
      let prevEnd = -1
      const offsets = []
      for (let c = 0; c < chunkN; c++) {
        const off = u32at(stco.ds + 8 + c * 4)
        offsets.push(off)
        let sz = 0
        for (let i = 0; i < rows.length; i++) {
          const next = i + 1 < rows.length ? rows[i + 1].first : chunkN + 1
          if (c + 1 >= rows[i].first && c + 1 < next) { sz = rows[i].n; break }
        }
        let bytes = 0
        for (let k = 0; k < sz && idx < sizes.length; k++, idx++) bytes += sizes[idx]
        if (!mdat || off < mdat.ds || off + bytes > mdat.end) outOfRange++
        if (off < prevEnd) overlap++
        prevEnd = off + bytes
      }
      if (outOfRange) bad(`${outOfRange} 个 chunk 偏移越出 mdat 载荷范围`)
      else ok('所有 chunk 偏移都落在 mdat 载荷范围内')
      if (overlap) bad(`${overlap} 处 chunk 数据重叠`)
      else ok('chunk 之间不重叠')
      ok(`样本数据合计 ${totalBytes} B（占 mdat 载荷 ${mdat ? mdat.size - 8 : '?'} B）`)
    }
  }
}

const width = Math.max(...results.map((r) => r[0].length))
for (const [k, m] of results) console.log(`[${k.padEnd(width)}] ${m}`)
const fails = results.filter((r) => r[0] === 'FAIL').length
const warns = results.filter((r) => r[0] === 'WARN').length
console.log(`\n${fails} FAIL · ${warns} WARN · ${results.length - fails - warns} OK`)
process.exitCode = fails ? 1 : 0
