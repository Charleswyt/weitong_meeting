/**
 * 用**真实产物**验证 `src/utils/mp4/remuxFmp4.ts`：跑一遍真分片 MP4，再用
 * **独立第二遍解析**（本文件自己写的小 box 遍历，不复用被测模块的任何内部逻辑）回读产物逐项断言。
 *
 * 跑法（在 edge/conference/frontend 下，Node 24 默认开类型擦除，import 源码必须带 .ts）：
 *   node scratch/verify-remux.ts                       # 默认用下面这份真分片 MP4
 *   node scratch/verify-remux.ts <另一个分片 mp4 路径>  # 换一份产物复验（多 moof 的文件走同一套断言）
 *
 * 纪律：源数据的样本数/时长/字节数一律从**源文件自己**数一遍（moof/trun），
 * 不是从被测函数的返回值抄 —— 那样只是拿实现验实现。
 */
import fs from 'node:fs'
import path from 'node:path'
import { remuxFmp4ToProgressive } from '../src/utils/mp4/remuxFmp4.ts'

const DEFAULT_SRC = 'C:/Users/zhengqi/Downloads/合成-2列-20260930173920-只有前7秒.mp4'
const SRC = process.argv[2] ?? DEFAULT_SRC
const OUT_DIR = path.join(import.meta.dirname, 'out')
// 默认那份固定落在 out/remuxed.mp4；显式传了别的源文件时另起名字，免得覆盖默认产物
const OUT = process.argv[2]
  ? path.join(OUT_DIR, path.basename(SRC).replace(/\.mp4$/i, '') + '.remuxed.mp4')
  : path.join(OUT_DIR, 'remuxed.mp4')

/* ------------------------- 独立 box 遍历 ------------------------- */

interface B {
  type: string
  start: number
  size: number
  /** 净荷起点（跳过 size/type/可选 largesize） */
  body: number
  end: number
}

function boxes(buf: Buffer, start: number, end: number): B[] {
  const out: B[] = []
  let p = start
  while (p < end) {
    if (p + 8 > end) throw new Error(`box 头越界 @${p}`)
    let size = buf.readUInt32BE(p)
    const type = buf.toString('latin1', p + 4, p + 8)
    let body = p + 8
    if (size === 1) {
      if (p + 16 > end) throw new Error(`largesize 越界 @${p}`)
      if (buf.readUInt32BE(p + 8) !== 0) throw new Error('文件超过 4GB，本验证脚本不处理')
      size = buf.readUInt32BE(p + 12)
      body = p + 16
    } else if (size === 0) {
      size = end - p
    }
    if (size < body - p || p + size > end) throw new Error(`${type} size=${size} 越界 @${p}`)
    out.push({ type, start: p, size, body, end: p + size })
    p += size
  }
  if (p !== end) throw new Error(`box 序列长度对不上：走到 ${p}，区间末尾 ${end}`)
  return out
}

const find = (bs: B[], t: string): B | null => bs.find((b) => b.type === t) ?? null
const kids = (buf: Buffer, b: B): B[] => boxes(buf, b.body, b.end)

function fullBox(buf: Buffer, b: B): { version: number; flags: number } {
  const v = buf.readUInt32BE(b.body)
  return { version: v >>> 24, flags: v & 0xffffff }
}

/* ------------------------- 源文件侧（真值来源） ------------------------- */

interface SrcTrack {
  id: number
  handler: string
  timescale: number
  count: number
  bytes: number
  endTicks: number
  /** 每个样本在源文件里的 [偏移, 大小]，用于最后做字节级比对 */
  ranges: { offset: number; size: number }[]
}

function analyzeSource(buf: Buffer): { top: B[]; tracks: SrcTrack[]; moofCount: number } {
  const top = boxes(buf, 0, buf.length)
  const moov = find(top, 'moov')
  if (!moov) throw new Error('源文件没有 moov')

  const trex = new Map<number, { dur: number; size: number; flags: number }>()
  const mvex = find(kids(buf, moov), 'mvex')
  if (mvex) {
    for (const b of kids(buf, mvex)) {
      if (b.type !== 'trex') continue
      trex.set(buf.readUInt32BE(b.body + 4), {
        dur: buf.readUInt32BE(b.body + 12),
        size: buf.readUInt32BE(b.body + 16),
        flags: buf.readUInt32BE(b.body + 20),
      })
    }
  }

  const tracks: SrcTrack[] = []
  const byId = new Map<number, SrcTrack>()
  for (const trak of kids(buf, moov)) {
    if (trak.type !== 'trak') continue
    const tkhd = find(kids(buf, trak), 'tkhd')
    const mdia = find(kids(buf, trak), 'mdia')
    if (!tkhd || !mdia) throw new Error('trak 缺 tkhd/mdia')
    const tver = buf.readUInt8(tkhd.body)
    const id = buf.readUInt32BE(tkhd.body + 12 + (tver === 1 ? 8 : 0))
    const inner = kids(buf, mdia)
    const hdlr = find(inner, 'hdlr')
    const mdhd = find(inner, 'mdhd')
    if (!hdlr || !mdhd) throw new Error('mdia 缺 hdlr/mdhd')
    const mver = buf.readUInt8(mdhd.body)
    const t: SrcTrack = {
      id,
      handler: buf.toString('latin1', hdlr.body + 8, hdlr.body + 12),
      timescale: buf.readUInt32BE(mdhd.body + 12 + (mver === 1 ? 8 : 0)),
      count: 0,
      bytes: 0,
      endTicks: 0,
      ranges: [],
    }
    tracks.push(t)
    byId.set(id, t)
  }

  const moofs = top.filter((b) => b.type === 'moof')
  for (const moof of moofs) {
    let prevTrafEnd = 0
    let firstTraf = true
    for (const traf of kids(buf, moof)) {
      if (traf.type !== 'traf') continue
      const inner = kids(buf, traf)
      const tfhd = find(inner, 'tfhd')
      if (!tfhd) throw new Error('traf 缺 tfhd')
      const tfFlags = fullBox(buf, tfhd).flags
      let p = tfhd.body + 4
      const id = buf.readUInt32BE(p)
      p += 4
      const track = byId.get(id)
      if (!track) throw new Error(`源 moof 里出现未知 trackId=${id}`)
      let base: number | null = null
      if (tfFlags & 0x000001) {
        base = Number(buf.readBigUInt64BE(p))
        p += 8
      }
      if (tfFlags & 0x000002) p += 4
      let defDur: number | null = null
      let defSize: number | null = null
      let defFlags: number | null = null
      if (tfFlags & 0x000008) {
        defDur = buf.readUInt32BE(p)
        p += 4
      }
      if (tfFlags & 0x000010) {
        defSize = buf.readUInt32BE(p)
        p += 4
      }
      if (tfFlags & 0x000020) {
        defFlags = buf.readUInt32BE(p)
        p += 4
      }
      const trexDef = trex.get(id)
      if (defDur === null) defDur = trexDef ? trexDef.dur : null
      if (defSize === null) defSize = trexDef ? trexDef.size : null
      if (defFlags === null) defFlags = trexDef ? trexDef.flags : 0

      const root = base ?? (tfFlags & 0x020000 || firstTraf ? moof.start : prevTrafEnd)
      const tfdt = find(inner, 'tfdt')
      let dts = track.endTicks
      if (tfdt) {
        dts = buf.readUInt8(tfdt.body) === 1 ? Number(buf.readBigUInt64BE(tfdt.body + 4)) : buf.readUInt32BE(tfdt.body + 4)
      }
      let cursor = root
      for (const trun of inner) {
        if (trun.type !== 'trun') continue
        const flags = fullBox(buf, trun).flags
        let q = trun.body + 4
        const count = buf.readUInt32BE(q)
        q += 4
        if (flags & 0x000001) {
          cursor = root + buf.readInt32BE(q)
          q += 4
        }
        let running = defFlags ?? 0
        if (flags & 0x000004) {
          running = buf.readUInt32BE(q)
          q += 4
        }
        for (let i = 0; i < count; i++) {
          let dur = defDur
          let size = defSize
          if (flags & 0x000100) {
            dur = buf.readUInt32BE(q)
            q += 4
          }
          if (flags & 0x000200) {
            size = buf.readUInt32BE(q)
            q += 4
          }
          if (flags & 0x000400) {
            running = buf.readUInt32BE(q)
            q += 4
          }
          if (flags & 0x000800) q += 4
          if (dur === null || size === null) throw new Error('源样本缺 duration/size')
          track.count++
          track.bytes += size
          track.endTicks = Math.max(track.endTicks, dts + dur)
          track.ranges.push({ offset: cursor, size })
          dts += dur
          cursor += size
          void running
        }
      }
      track.endTicks = Math.max(track.endTicks, dts)
      prevTrafEnd = Math.max(prevTrafEnd, cursor)
      firstTraf = false
    }
  }
  return { top, tracks, moofCount: moofs.length }
}

/* ------------------------- 产物侧 ------------------------- */

interface OutTrack {
  id: number
  handler: string
  timescale: number
  sampleCount: number
  sizes: number[]
  stco: number[]
  stsc: { firstChunk: number; samplesPerChunk: number; descIndex: number }[]
  stsdEntryCount: number
  hasCtts: boolean
  hasStss: boolean
}

function analyzeOutput(buf: Buffer): {
  top: B[]
  mvhdTimescale: number
  mvhdDuration: number
  tracks: OutTrack[]
  mdatPayload: number
} {
  const top = boxes(buf, 0, buf.length)
  const moov = find(top, 'moov')
  const mdat = find(top, 'mdat')
  if (!moov || !mdat) throw new Error('产物缺 moov/mdat')
  const inner = kids(buf, moov)
  const mvhd = find(inner, 'mvhd')
  if (!mvhd) throw new Error('产物缺 mvhd')
  const mver = buf.readUInt8(mvhd.body)
  const mvhdTimescale = buf.readUInt32BE(mvhd.body + 12 + (mver === 1 ? 8 : 0))
  const mvhdDuration =
    mver === 1 ? Number(buf.readBigUInt64BE(mvhd.body + 16)) : buf.readUInt32BE(mvhd.body + 16)

  const tracks: OutTrack[] = []
  for (const trak of inner) {
    if (trak.type !== 'trak') continue
    const tk = kids(buf, trak)
    const tkhd = find(tk, 'tkhd')
    const mdia = find(tk, 'mdia')
    if (!tkhd || !mdia) throw new Error('产物 trak 缺 tkhd/mdia')
    const tver = buf.readUInt8(tkhd.body)
    const id = buf.readUInt32BE(tkhd.body + 12 + (tver === 1 ? 8 : 0))
    const mi = kids(buf, mdia)
    const hdlr = find(mi, 'hdlr')
    const mdhd = find(mi, 'mdhd')
    const minf = find(mi, 'minf')
    if (!hdlr || !mdhd || !minf) throw new Error('产物 mdia 缺字段')
    const dver = buf.readUInt8(mdhd.body)
    const stbl = find(kids(buf, minf), 'stbl')
    if (!stbl) throw new Error('产物缺 stbl')
    const st = kids(buf, stbl)
    const stsd = find(st, 'stsd')
    const stsz = find(st, 'stsz')
    const stco = find(st, 'stco')
    const stsc = find(st, 'stsc')
    if (!stsd || !stsz || !stco || !stsc) throw new Error('产物 stbl 缺 stsd/stsz/stco/stsc')
    const count = buf.readUInt32BE(stsz.body + 8)
    const sizes: number[] = []
    const fixedSize = buf.readUInt32BE(stsz.body + 4)
    for (let i = 0; i < count; i++) {
      sizes.push(fixedSize === 0 ? buf.readUInt32BE(stsz.body + 12 + i * 4) : fixedSize)
    }
    const chunkCount = buf.readUInt32BE(stco.body + 4)
    const stcoArr: number[] = []
    for (let i = 0; i < chunkCount; i++) stcoArr.push(buf.readUInt32BE(stco.body + 8 + i * 4))
    const stscCount = buf.readUInt32BE(stsc.body + 4)
    const stscArr: { firstChunk: number; samplesPerChunk: number; descIndex: number }[] = []
    for (let i = 0; i < stscCount; i++) {
      stscArr.push({
        firstChunk: buf.readUInt32BE(stsc.body + 8 + i * 12),
        samplesPerChunk: buf.readUInt32BE(stsc.body + 12 + i * 12),
        descIndex: buf.readUInt32BE(stsc.body + 16 + i * 12),
      })
    }
    tracks.push({
      id,
      handler: buf.toString('latin1', hdlr.body + 8, hdlr.body + 12),
      timescale: buf.readUInt32BE(mdhd.body + 12 + (dver === 1 ? 8 : 0)),
      sampleCount: count,
      sizes,
      stco: stcoArr,
      stsc: stscArr,
      stsdEntryCount: buf.readUInt32BE(stsd.body + 4),
      hasCtts: !!find(st, 'ctts'),
      hasStss: !!find(st, 'stss'),
    })
  }
  return { top, mvhdTimescale, mvhdDuration, tracks, mdatPayload: mdat.size - 8 }
}

/* ------------------------- 断言脚手架 ------------------------- */

let failed = 0
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) failed++
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

/* ------------------------- 主流程 ------------------------- */

async function main(): Promise<void> {
  console.log('=== 源文件 ===')
  const srcBuf = fs.readFileSync(SRC)
  const src = analyzeSource(srcBuf)
  console.log(`文件：${SRC}`)
  console.log(`大小：${srcBuf.length} 字节；顶层 box：${src.top.map((b) => b.type).join(' → ')}`)
  console.log(`moof 段数：${src.moofCount}`)
  for (const t of src.tracks) {
    console.log(
      `  轨 trackId=${t.id} handler=${t.handler} timescale=${t.timescale} 样本=${t.count} 字节=${t.bytes} 末样本结束=${(t.endTicks / t.timescale).toFixed(3)}s`,
    )
  }
  const srcEndSec = Math.max(...src.tracks.map((t) => t.endTicks / t.timescale))

  console.log('\n=== 调 remuxFmp4ToProgressive ===')
  const res = await remuxFmp4ToProgressive(new Blob([srcBuf]))
  if (!res) {
    console.log('❌ remux 返回 null（结构没兜住），后续断言无法进行')
    process.exit(1)
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outBuf = Buffer.from(await res.blob.arrayBuffer())
  fs.writeFileSync(OUT, outBuf)
  console.log(`产物：${OUT}`)
  console.log(
    `返回：videoSamples=${res.videoSamples} audioSamples=${res.audioSamples} durationMs=${res.durationMs} blobType=${res.blob.type} 字节=${res.blob.size}`,
  )

  console.log('\n=== 产物回读（独立解析）===')
  const out = analyzeOutput(outBuf)
  const outTypes = out.top.map((b) => b.type)
  console.log(`顶层 box：${outTypes.join(' → ')}`)
  console.log(`mvhd：timescale=${out.mvhdTimescale} duration=${out.mvhdDuration}（${(out.mvhdDuration / out.mvhdTimescale).toFixed(3)}s）`)
  for (const t of out.tracks) {
    console.log(
      `  轨 trackId=${t.id} handler=${t.handler} timescale=${t.timescale} 样本=${t.sampleCount} 字节=${t.sizes.reduce((a, b) => a + b, 0)} 块=${t.stco.length} ctts=${t.hasCtts} stss=${t.hasStss}`,
    )
  }

  console.log('\n=== 断言 ===')
  // 1) 形态：没有 moof/mfra，且恰好是 ftyp → moov → mdat
  check(
    '顶部没有 moof/mfra，形态是 ftyp → moov → mdat',
    !outTypes.includes('moof') && !outTypes.includes('mfra') && outTypes.join(',') === 'ftyp,moov,mdat',
    outTypes.join(' → '),
  )

  // 2) 两条 trak 且 handler 齐全，样本数都 > 0
  const outVideo = out.tracks.find((t) => t.handler === 'vide') ?? null
  const outAudio = out.tracks.find((t) => t.handler === 'soun') ?? null
  check(
    'moov 里有 vide/soun 两条 trak，两条 stsz 样本数都 > 0',
    out.tracks.length === 2 && !!outVideo && !!outAudio && outVideo.sampleCount > 0 && outAudio.sampleCount > 0,
    `trak=${out.tracks.length} vide=${outVideo?.sampleCount ?? '无'} soun=${outAudio?.sampleCount ?? '无'}`,
  )

  // 3) 样本数逐轨 == 源文件按 moof/trun 数出来的
  const srcVideo = src.tracks.find((t) => t.handler === 'vide') ?? null
  const srcAudio = src.tracks.find((t) => t.handler === 'soun') ?? null
  check(
    'stsz 样本数 == 源 moof/trun 数出来的样本数（逐轨）',
    !!outVideo && !!outAudio && !!srcVideo && !!srcAudio &&
      outVideo.sampleCount === srcVideo.count &&
      outAudio.sampleCount === srcAudio.count,
    `vide ${outVideo?.sampleCount}/${srcVideo?.count}，soun ${outAudio?.sampleCount}/${srcAudio?.count}`,
  )

  // 3b) 轨的 timescale 沿用源值（换算时长全靠它）
  check(
    '两条轨的 mdhd.timescale 与源一致',
    !!outVideo && !!outAudio && !!srcVideo && !!srcAudio &&
      outVideo.timescale === srcVideo.timescale &&
      outAudio.timescale === srcAudio.timescale,
    `vide ${outVideo?.timescale}/${srcVideo?.timescale}，soun ${outAudio?.timescale}/${srcAudio?.timescale}`,
  )

  // 4) mdat 净荷 == 两轨样本 size 之和
  const sumSizes = out.tracks.reduce((a, t) => a + t.sizes.reduce((x, y) => x + y, 0), 0)
  check(
    'mdat 净荷字节数 == 两条轨所有样本 size 之和',
    out.mdatPayload === sumSizes,
    `mdat=${out.mdatPayload} 样本和=${sumSizes}`,
  )

  // 5) mvhd 时长 vs 源末样本结束（±0.1s）
  const outDurSec = out.mvhdDuration / out.mvhdTimescale
  check(
    'mvhd 时长与源末样本结束时刻一致（±0.1s）',
    Math.abs(outDurSec - srcEndSec) <= 0.1,
    `产物=${outDurSec.toFixed(3)}s 源=${srcEndSec.toFixed(3)}s 差=${(outDurSec - srcEndSec).toFixed(3)}s`,
  )
  check(
    '返回的 durationMs 与 mvhd 时长一致',
    Math.abs(res.durationMs / 1000 - outDurSec) <= 0.001,
    `durationMs=${res.durationMs} mvhd=${(outDurSec * 1000).toFixed(0)}ms`,
  )
  check(
    '返回的视频/音频样本数与产物 stsz 一致',
    res.videoSamples === (outVideo?.sampleCount ?? -1) && res.audioSamples === (outAudio?.sampleCount ?? -1),
    `video ${res.videoSamples}/${outVideo?.sampleCount}，audio ${res.audioSamples}/${outAudio?.sampleCount}`,
  )

  // 6) stco 每个块偏移在文件范围内、落在 mdat 净荷里、且两两不重叠
  const mdatPayloadStart = out.top.find((b) => b.type === 'mdat')!.body
  const spans: { track: number; chunk: number; start: number; end: number }[] = []
  let spanErr = ''
  for (const t of out.tracks) {
    // stsc → 每个块覆盖的样本区间
    const perChunk: number[] = []
    for (let c = 1; c <= t.stco.length; c++) {
      let spc = 0
      for (const e of t.stsc) if (e.firstChunk <= c) spc = e.samplesPerChunk
      if (!spc) throw new Error(`stsc 没覆盖块 ${c}`)
      perChunk.push(spc)
    }
    const total = perChunk.reduce((a, b) => a + b, 0)
    if (total !== t.sampleCount) spanErr = `轨 ${t.id} 的 stsc 覆盖样本数 ${total} ≠ stsz ${t.sampleCount}`
    let sampleIdx = 0
    for (let i = 0; i < t.stco.length; i++) {
      const bytes = t.sizes.slice(sampleIdx, sampleIdx + perChunk[i]).reduce((a, b) => a + b, 0)
      spans.push({ track: t.id, chunk: i + 1, start: t.stco[i], end: t.stco[i] + bytes })
      sampleIdx += perChunk[i]
    }
  }
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  let overlap = ''
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      overlap = `轨${sorted[i - 1].track}块${sorted[i - 1].chunk} 与 轨${sorted[i].track}块${sorted[i].chunk} 重叠`
    }
  }
  const outOfRange = spans.find(
    (s) => s.start < mdatPayloadStart || s.end > outBuf.length || s.start >= s.end,
  )
  check(
    'stco 每个块偏移都在 mdat 净荷范围内且两两不重叠',
    !overlap && !outOfRange && !spanErr,
    spanErr ||
      overlap ||
      (outOfRange
        ? `块 ${outOfRange.track}#${outOfRange.chunk} 偏移 ${outOfRange.start}..${outOfRange.end} 越界（mdat 净荷起点 ${mdatPayloadStart}，文件 ${outBuf.length}）`
        : `块数=${spans.length}，覆盖字节=${spans.reduce((a, s) => a + (s.end - s.start), 0)}`),
  )

  // 7) 样本字节内容与顺序：把产物按 stco/stsc/stsz 重新读出来，与源文件按 moof/trun
  //    读出来的样本拼接逐字节比对。上面所有断言都只看"数量/字节总数/偏移范围"，
  //    两轨在 mdat 里被写反、或某段样本搬错位置，它们全都会通过 —— 只有这一条能抓到。
  const contentErrs: string[] = []
  for (const ot of out.tracks) {
    const st = src.tracks.find((t) => t.handler === ot.handler)
    if (!st) {
      contentErrs.push(`${ot.handler} 在源文件里找不到对应轨`)
      continue
    }
    const perChunk: number[] = []
    for (let c = 1; c <= ot.stco.length; c++) {
      let spc = 0
      for (const e of ot.stsc) if (e.firstChunk <= c) spc = e.samplesPerChunk
      perChunk.push(spc)
    }
    const parts: Buffer[] = []
    let idx = 0
    for (let i = 0; i < ot.stco.length; i++) {
      let len = 0
      for (let k = 0; k < perChunk[i]; k++) len += ot.sizes[idx + k]
      parts.push(outBuf.subarray(ot.stco[i], ot.stco[i] + len))
      idx += perChunk[i]
    }
    const got = Buffer.concat(parts)
    const want = Buffer.concat(st.ranges.map((r) => srcBuf.subarray(r.offset, r.offset + r.size)))
    if (!got.equals(want)) contentErrs.push(`${ot.handler} 轨字节不一致（产物 ${got.length} vs 源 ${want.length}）`)
  }
  check(
    '产物样本字节与源逐字节一致（逐轨：内容 + 顺序）',
    contentErrs.length === 0,
    contentErrs.join('；') || `vide/soun 共 ${out.tracks.reduce((a, t) => a + t.sampleCount, 0)} 个样本全部一致`,
  )

  // 8) mvhd 的**盒子长度**必须符合规范：v0=108 / v1=120 字节。
  //    这一条是 2026-09-30 真踩到的坑：`pre_defined[6]` 应写 24 字节却写成 12，mvhd 于是短 12 字节 ——
  //    Chromium 宽容照读（前面的时长断言全过），而 Windows 的 Media Foundation
  //    （`电影和电视` / 资源管理器"时长"列）直接读不出时长，表现正是"进度条拖不动、倍速不可用"。
  //    实测：错版产物 `System.Media.Duration` 为空，改回 24 后为 7.129s。
  //    前面所有断言都只看字段值（时长/样本数/偏移），**没有一条会看盒子长度**，所以必须单独立一条。
  const mvhdAt = outBuf.indexOf('mvhd') - 4
  const mvhdSize = mvhdAt >= 4 ? outBuf.readUInt32BE(mvhdAt) : 0
  const mvhdVer = mvhdAt >= 4 ? outBuf[mvhdAt + 8] : -1
  check(
    'mvhd 盒子长度符合规范（v0=108 / v1=120）',
    mvhdVer === 0 ? mvhdSize === 108 : mvhdSize === 120,
    `size=${mvhdSize} version=${mvhdVer}`,
  )

  console.log(`\n关键数字：videoSamples=${outVideo?.sampleCount} audioSamples=${outAudio?.sampleCount} durationMs=${res.durationMs} 产物字节=${outBuf.length} 源字节=${srcBuf.length}`)
  console.log(`断言结果：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('验证脚本自身异常：', e)
  process.exit(1)
})
