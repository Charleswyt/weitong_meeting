/**
 * 分片 MP4（fMP4）→ 渐进 MP4（progressive MP4）重排（remux，不重编码）。
 *
 * 为什么需要它：MediaRecorder 录出来的 MP4 是**分片**形态 ——
 *   ftyp + moov（带 mvex，但 stbl 里 stsz 的 sample_count 是 0，样本表整张是空的）
 *   + 若干 moof/mdat +（末尾可能有）mfra。
 * 样本的时长、大小、同步标志全散在各个 moof 的 trun 里，moov 里没有任何一张完整样本表。
 * 播放器于是在 moov 里读不到 duration、也建不出索引：文件"能播"，但**进度条拖不动、
 * 倍速失效**（用户实测反馈的原话）。mfra 只是个提示盒，多数播放器不看它 ——
 * 靠它算时长是碰运气，不是契约。
 *
 * 这里只重排容器，绝不重编码：样本字节原样搬运，把散在 moof 里的信息收拢成
 * 一张完整的样本表（stts/ctts/stss/stsc/stsz/stco），时长写进 mvhd，
 * 产物形态固定为 ftyp → moov → mdat。
 *
 * 约定：**任何结构对不上的情况一律返回 null**。宁可让调用方看到"重排失败"，
 * 也不要吐出一个看着像 MP4、实际索引错位的文件 —— 那种坏文件最难归因。
 *
 * 已知不覆盖（都是有意的取舍，不是漏做）：
 * - 除 `vide`/`soun` 以外的轨（字幕、提示、元数据）→ 返回 null（不产半成品轨）；
 * - 样本总字节超过 4GB（stco 只有 32 位偏移）→ 返回 null，不降级成 co64；
 * - 源文件本身不是分片形态（没有 moof）→ 返回 null。它要么已经带完整样本表、
 *   要么根本不是 MediaRecorder 的产物，两种情况都不该由这里"修一遍"；
 * - 编辑列表（edts/elst）不搬迁：产物是一张**从 0 开始**的平坦时间轴。
 *   MediaRecorder 给两条轨的 tfdt 都是 0，所以对它没有影响；但源文件若真用 elst
 *   表达"某条轨整体延后 N 秒"，那点偏移在产物里会丢（补齐它需要一张自己造的 elst）。
 * - mdat 不交错，每轨样本连续摆放：换取 stco 只有每段一条记录。
 *   代价是"边下边播"要等更多字节 —— 本地文件场景不需要，别顺手加交错。
 *
 * 参考：ISO/IEC 14496-12（box 结构、trun/tfhd 的 flag 位、stbl 各表的语义）。
 */

export interface RemuxResult {
  blob: Blob
  /** 视频/音频实际写进去的样本数，调用方用它判断"有没有画面/有没有声音" */
  videoSamples: number
  audioSamples: number
  durationMs: number
}

/** 分片 MP4 → 渐进 MP4。任何结构对不上的情况一律返回 null（绝不产出坏文件）。 */
export async function remuxFmp4ToProgressive(src: Blob): Promise<RemuxResult | null> {
  try {
    return await remux(src)
  } catch (e) {
    // 失败原因不上抛给用户（界面不该看到 box 名），但控制台要留全，方便定位是"哪种结构"没兜住。
    console.warn('[remuxFmp4] 放弃重排：', e instanceof Error ? e.message : e)
    return null
  }
}

/* ============================ 数据结构 ============================ */

interface BoxNode {
  type: string
  /** box 首字节在文件里的绝对偏移 */
  start: number
  /** box 总字节数（含 8 或 16 字节头） */
  size: number
  /** box 净荷首字节（size/type/可选 largesize 之后） */
  bodyStart: number
  end: number
}

interface Sample {
  /** 样本字节在**源文件**里的绝对偏移 */
  offset: number
  size: number
  /** 解码时间（该轨 timescale 为单位） */
  dts: number
  duration: number
  /** 呈现时间 = dts + composition time offset；没有 ctts 时与 dts 相等 */
  cts: number
  isSync: boolean
}

interface Chunk {
  /** 该块在 track.samples 里的起始下标 */
  firstSample: number
  sampleCount: number
  /** stsc 的 sample_description_index（来自 tfhd，默认 1） */
  descIndex: number
  /** mdat **净荷**内的相对字节偏移（写 stco 时再加 mdat 净荷的绝对起点） */
  byteOffset: number
}

interface Track {
  trackId: number
  kind: 'video' | 'audio'
  /** mdia/mdhd 的 timescale（原样沿用；换算时长只在这里做一次） */
  timescale: number
  /** tkhd 里的宽/高，**原始的 16.16 定点值**，不换算 */
  widthRaw: number
  heightRaw: number
  /** 整段 stsd 的原始字节（size+type+内容） */
  stsd: Uint8Array
  stsdEntryCount: number
  samples: Sample[]
  chunks: Chunk[]
  /** 供 tfdt 缺失时续接：下一段的起始解码时间 */
  nextDts: number
}

interface TrexDefault {
  hasDuration: boolean
  duration: number
  hasSize: boolean
  size: number
  hasFlags: boolean
  flags: number
}

/* tfhd 的 flag 位（FullBox 的 24 位 flags 部分） */
const TFHD_BASE_DATA_OFFSET = 0x000001
const TFHD_SAMPLE_DESC_INDEX = 0x000002
const TFHD_DEFAULT_DURATION = 0x000008
const TFHD_DEFAULT_SIZE = 0x000010
const TFHD_DEFAULT_FLAGS = 0x000020
const TFHD_DEFAULT_BASE_IS_MOOF = 0x020000

/* trun 的 flag 位 */
const TRUN_DATA_OFFSET = 0x000001
const TRUN_FIRST_SAMPLE_FLAGS = 0x000004
const TRUN_SAMPLE_DURATION = 0x000100
const TRUN_SAMPLE_SIZE = 0x000200
const TRUN_SAMPLE_FLAGS = 0x000400
const TRUN_SAMPLE_CTO = 0x000800

/** 样本 flags 里的"非同步样本"位：这一位为 0 才是关键帧（可作为随机访问点） */
const SAMPLE_IS_NON_SYNC = 0x00010000

/** mdat 净荷上限：stco 只有 32 位偏移，超过就写不出来（规格要求这种情况返回 null，不降级成 co64） */
const MAX_MDAT_PAYLOAD = 0xffffffff - 8

function fail(why: string): never {
  throw new Error(why)
}

/* ============================ box 遍历 ============================ */

function readFourcc(view: DataView, off: number): string {
  return String.fromCharCode(
    view.getUint8(off),
    view.getUint8(off + 1),
    view.getUint8(off + 2),
    view.getUint8(off + 3),
  )
}

function readU64(view: DataView, off: number): number {
  const hi = view.getUint32(off)
  const lo = view.getUint32(off + 4)
  return hi * 0x100000000 + lo
}

/**
 * 平铺遍历一段区间里的 box。任何"越界 / 长度对不上"都返回 null ——
 * 调用方据此整体放弃：结构看不懂时，任何猜测都会把偏移算歪。
 */
function parseBoxes(view: DataView, start: number, end: number): BoxNode[] | null {
  const out: BoxNode[] = []
  let p = start
  while (p < end) {
    if (p + 8 > end) return null
    let size = view.getUint32(p)
    const type = readFourcc(view, p + 4)
    let bodyStart = p + 8
    if (size === 1) {
      // 64 位 largesize：本模块只在"仍然小于 4GB"时才接得住，否则后面 stco 一定写不出来
      if (p + 16 > end) return null
      const hi = view.getUint32(p + 8)
      const lo = view.getUint32(p + 12)
      if (hi !== 0) return null
      size = lo
      bodyStart = p + 16
    } else if (size === 0) {
      // size===0 表示"一直到文件/父盒末尾"
      size = end - p
    }
    if (size < bodyStart - p) return null
    if (p + size > end) return null
    out.push({ type, start: p, size, bodyStart, end: p + size })
    p += size
  }
  return p === end ? out : null
}

function childBoxes(view: DataView, box: BoxNode): BoxNode[] {
  const kids = parseBoxes(view, box.bodyStart, box.end)
  if (!kids) fail(`${box.type} 的子 box 越界`)
  return kids
}

function findBox(boxes: readonly BoxNode[], type: string): BoxNode | null {
  for (const b of boxes) if (b.type === type) return b
  return null
}

function needChild(view: DataView, box: BoxNode, type: string): BoxNode {
  const found = findBox(childBoxes(view, box), type)
  if (!found) fail(`${box.type} 里缺少 ${type}`)
  return found
}

/** 带边界检查的定长读；越界即"结构对不上" */
function rd32(view: DataView, off: number, end: number, what: string): number {
  if (off + 4 > end) fail(`${what} 越界`)
  return view.getUint32(off)
}

/* ============================ 源文件解析 ============================ */

function parseTrak(view: DataView, ab: ArrayBuffer, trak: BoxNode): Track {
  const tkhd = needChild(view, trak, 'tkhd')
  const mdia = needChild(view, trak, 'mdia')
  const tkhdVer = view.getUint8(tkhd.bodyStart)
  if (tkhdVer !== 0 && tkhdVer !== 1) fail(`tkhd version ${tkhdVer} 不认识`)
  // v1 的 creation/modification 是 8 字节、duration 也是 8 字节 —— 位移量前后不一样：
  // track_ID 之后只移 8，duration 之后的字段（含宽高）要移 12。用一个 shift 会读错宽高。
  const tkhdShiftId = tkhdVer === 1 ? 8 : 0
  const tkhdShiftSize = tkhdVer === 1 ? 12 : 0
  const trackId = rd32(view, tkhd.bodyStart + 12 + tkhdShiftId, tkhd.end, 'tkhd.track_ID')
  // 宽高是 16.16 定点：高 16 位才是整数像素。这里连原始 4 字节一起留着，重建时原样写回，
  // 不自己换算再乘回去 —— 那是一次没有必要的取整。
  const widthRaw = rd32(view, tkhd.bodyStart + 76 + tkhdShiftSize, tkhd.end, 'tkhd.width')
  const heightRaw = rd32(view, tkhd.bodyStart + 80 + tkhdShiftSize, tkhd.end, 'tkhd.height')

  const mdhd = needChild(view, mdia, 'mdhd')
  const mdhdVer = view.getUint8(mdhd.bodyStart)
  if (mdhdVer !== 0 && mdhdVer !== 1) fail(`mdhd version ${mdhdVer} 不认识`)
  // v1 的 creation/modification 各 8 字节：timescale 从 +12 挪到 +20
  const mdhdShift = mdhdVer === 1 ? 8 : 0
  const timescale = rd32(view, mdhd.bodyStart + 12 + mdhdShift, mdhd.end, 'mdhd.timescale')
  if (!timescale) fail('mdhd.timescale 为 0')

  const hdlr = needChild(view, mdia, 'hdlr')
  const handler = readFourcc(view, hdlr.bodyStart + 8)
  if (handler !== 'vide' && handler !== 'soun') {
    // 字幕/提示/元数据轨我们不重建（它们大多也没有样本）—— 宁可整份放弃，不要出一条半成品轨
    fail(`暂不支持 handler=${handler} 的轨道`)
  }

  const minf = needChild(view, mdia, 'minf')
  const stbl = needChild(view, minf, 'stbl')
  const stsd = needChild(view, stbl, 'stsd')
  const stsdEntryCount = rd32(view, stsd.bodyStart + 4, stsd.end, 'stsd.entry_count')
  if (stsdEntryCount < 1) fail('stsd 里一个 sample entry 都没有')

  return {
    trackId,
    kind: handler === 'vide' ? 'video' : 'audio',
    timescale,
    widthRaw,
    heightRaw,
    // stsd 整段**原样**保留：里面是 avcC / mp4a+esds 这类解码器初始化数据
    // （SPS/PPS、AudioSpecificConfig）。重编码才需要重建它，我们只搬容器，
    // 动一个字节就可能让解码器初始化失败 —— 那是"文件能播但画面全黑"的经典成因。
    stsd: new Uint8Array(ab, stsd.start, stsd.size),
    stsdEntryCount,
    samples: [],
    chunks: [],
    nextDts: 0,
  }
}

function parseMoof(
  view: DataView,
  ab: ArrayBuffer,
  moof: BoxNode,
  byId: Map<number, Track>,
  trex: Map<number, TrexDefault>,
): void {
  const kids = childBoxes(view, moof)
  // "上一个 traf 的字节末尾"：tfhd 既没给 base_data_offset 也没给 default-base-is-moof 时，
  // 规范要求后续 traf 的基准是它（而不是 moof 起点）
  let prevTrafDataEnd = 0
  let isFirstTraf = true

  for (const traf of kids) {
    if (traf.type !== 'traf') continue
    const tkids = childBoxes(view, traf)
    const tfhd = findBox(tkids, 'tfhd')
    if (!tfhd) fail('traf 里没有 tfhd')

    const tfFlags = view.getUint32(tfhd.bodyStart) & 0xffffff
    let p = tfhd.bodyStart + 4
    const trackId = rd32(view, p, tfhd.end, 'tfhd.track_ID')
    p += 4
    const track = byId.get(trackId)
    if (!track) fail(`moof 里出现了 moov 没有的 trackId=${trackId}`)

    let baseDataOffset: number | null = null
    if (tfFlags & TFHD_BASE_DATA_OFFSET) {
      if (p + 8 > tfhd.end) fail('tfhd.base_data_offset 越界')
      baseDataOffset = readU64(view, p)
      p += 8
    }
    let descIndex = 1
    if (tfFlags & TFHD_SAMPLE_DESC_INDEX) {
      descIndex = rd32(view, p, tfhd.end, 'tfhd.sample_description_index')
      p += 4
      // 重建后的 stsc 只有"块"这个粒度能带描述索引，而我们的块恰好等于一次 traf，
      // 所以这里带得住；但索引必须落在 stsd 的条目范围内，否则产品解不出来
      if (descIndex < 1 || descIndex > track.stsdEntryCount) {
        fail(`traf 的 sample_description_index=${descIndex} 超出 stsd 条目数 ${track.stsdEntryCount}`)
      }
    }
    let hasDefDuration = false
    let defDuration = 0
    let hasDefSize = false
    let defSize = 0
    let hasDefFlags = false
    let defFlags = 0
    if (tfFlags & TFHD_DEFAULT_DURATION) {
      defDuration = rd32(view, p, tfhd.end, 'tfhd.default_sample_duration')
      hasDefDuration = true
      p += 4
    }
    if (tfFlags & TFHD_DEFAULT_SIZE) {
      defSize = rd32(view, p, tfhd.end, 'tfhd.default_sample_size')
      hasDefSize = true
      p += 4
    }
    if (tfFlags & TFHD_DEFAULT_FLAGS) {
      defFlags = rd32(view, p, tfhd.end, 'tfhd.default_sample_flags')
      hasDefFlags = true
      p += 4
    }

    const trexDef = trex.get(trackId)
    // tfhd 缺省值 → trex 缺省值 → 没有：最后一种情况写不出 stts/stsz，只能放弃
    const fallbackDuration = hasDefDuration ? defDuration : trexDef?.hasDuration ? trexDef.duration : null
    const fallbackSize = hasDefSize ? defSize : trexDef?.hasSize ? trexDef.size : null
    const fallbackFlags = hasDefFlags ? defFlags : trexDef?.hasFlags ? trexDef.flags : 0

    const base =
      baseDataOffset !== null
        ? baseDataOffset
        : tfFlags & TFHD_DEFAULT_BASE_IS_MOOF
          ? moof.start
          : isFirstTraf
            ? moof.start
            : prevTrafDataEnd

    // 段内解码时间：优先 tfdt（同一轨跨多个 moof 时它是唯一的绝对时间轴），
    // 缺 tfdt 就接着上一段末尾累加（老实现里有过"每段都从 0 开始"的坑，结果是时长整段回退）
    const tfdt = findBox(tkids, 'tfdt')
    let dts = track.nextDts
    if (tfdt) {
      const ver = view.getUint8(tfdt.bodyStart)
      dts = ver === 1 ? readU64(view, tfdt.bodyStart + 4) : rd32(view, tfdt.bodyStart + 4, tfdt.end, 'tfdt.baseMediaDecodeTime')
    }

    let cursor = base
    const firstSampleIndex = track.samples.length
    // 同一轨的样本在源文件里必须单调不减：产物是按"连续游程"切片搬 mdat 的，
    // 源里一出现回退，搬运顺序就与 stco 记的顺序不一致（声音画面错位，且极难查）。
    const lastExisting = track.samples[track.samples.length - 1]
    let prevSampleEnd = lastExisting ? lastExisting.offset + lastExisting.size : -1
    for (const trun of tkids) {
      if (trun.type !== 'trun') continue
      const ver = view.getUint8(trun.bodyStart)
      const flags = view.getUint32(trun.bodyStart) & 0xffffff
      let q = trun.bodyStart + 4
      const sampleCount = rd32(view, q, trun.end, 'trun.sample_count')
      q += 4
      let dataOffset = 0
      const hasDataOffset = (flags & TRUN_DATA_OFFSET) !== 0
      if (hasDataOffset) {
        // data_offset 是**有符号**的（相对 base 的偏移，允许为负）
        if (q + 4 > trun.end) fail('trun.data_offset 越界')
        dataOffset = view.getInt32(q)
        q += 4
      }
      let firstSampleFlags: number | null = null
      if (flags & TRUN_FIRST_SAMPLE_FLAGS) {
        firstSampleFlags = rd32(view, q, trun.end, 'trun.first_sample_flags')
        q += 4
      }
      if (hasDataOffset) cursor = base + dataOffset

      // 样本 flags 的取值链（ISO 14496-12 §8.8.7/§8.8.8，也是 Chromium/ffmpeg 的实际读法）：
      //   逐样本 flags → (仅第 0 个样本) first_sample_flags → tfhd/trex 的 default_sample_flags
      // 注意"first_sample_flags 只管第一个样本"这条：MediaRecorder 正是用
      // first_sample_flags=0x02000000（同步）+ default_sample_flags=0x01010000（非同步）
      // 来表达"首帧是关键帧、其余是 P 帧"。如果错当成"所有样本都同步"，
      // stss 会列出每一帧 —— 那样播放器以为处处可随机访问，拖动就跳到解不出来的地方。
      let runningFlags = firstSampleFlags !== null ? firstSampleFlags : fallbackFlags
      for (let i = 0; i < sampleCount; i++) {
        let duration: number | null = fallbackDuration
        let size: number | null = fallbackSize
        let sampleFlags = runningFlags
        let cto = 0
        if (flags & TRUN_SAMPLE_DURATION) {
          duration = rd32(view, q, trun.end, 'trun sample_duration')
          q += 4
        }
        if (flags & TRUN_SAMPLE_SIZE) {
          size = rd32(view, q, trun.end, 'trun sample_size')
          q += 4
        }
        if (flags & TRUN_SAMPLE_FLAGS) {
          sampleFlags = rd32(view, q, trun.end, 'trun sample_flags')
          q += 4
        }
        if (flags & TRUN_SAMPLE_CTO) {
          // version 1 的 cto 是**有符号**的：B 帧的呈现时间可以早于解码时间，
          // 当成无符号读会得到 40 亿这种天文数字，ctts 直接写废
          if (q + 4 > trun.end) fail('trun sample_composition_time_offset 越界')
          cto = ver === 1 ? view.getInt32(q) : view.getUint32(q)
          q += 4
        }
        if (duration === null) fail('样本既没有 duration 也没有 tfhd/trex 缺省 duration')
        if (size === null) fail('样本既没有 size 也没有 tfhd/trex 缺省 size')
        if (size <= 0) fail('样本 size 为 0')
        if (cursor < 0 || cursor + size > ab.byteLength) fail('样本字节超出源文件范围')
        if (cursor < prevSampleEnd) fail('同一轨的样本在源文件里发生重叠或回退')

        // 解码时间必须不倒退；两段之间**有间隙**时把间隙并进前一个样本的时长。
        // 为什么必须并：产物是一张从 0 开始的 stts 表，"间隙"在那里无法表达 ——
        // 直接丢掉的后果是整条时间轴被压缩（页面切后台暂停录制再回来时，
        // 视频与音频各自的间隙长度不同，压缩量也不同 → 音画从那一刻起永久漂移）。
        // 并进前一个样本 = 那一帧多停一会儿，是这段间隙唯一诚实的表达。
        const prevSample = track.samples[track.samples.length - 1]
        if (prevSample) {
          const gap = dts - (prevSample.dts + prevSample.duration)
          if (gap < 0) fail('同一轨的解码时间倒退')
          if (gap > 0) prevSample.duration += gap
        }

        track.samples.push({
          offset: cursor,
          size,
          dts,
          duration,
          cts: dts + cto,
          isSync: (sampleFlags & SAMPLE_IS_NON_SYNC) === 0,
        })
        cursor += size
        prevSampleEnd = cursor
        dts += duration
        runningFlags = fallbackFlags
      }
    }

    if (track.samples.length > firstSampleIndex) {
      track.chunks.push({
        firstSample: firstSampleIndex,
        sampleCount: track.samples.length - firstSampleIndex,
        descIndex,
        byteOffset: 0,
      })
    }
    track.nextDts = dts
    prevTrafDataEnd = Math.max(prevTrafDataEnd, cursor)
    isFirstTraf = false
  }
}

/* ============================ 写 box ============================ */

/** 可增长的字节缓冲；moov 最大也就几百 KB，用简单的倍增即可 */
class Buf {
  private a: Uint8Array<ArrayBuffer>
  private n = 0
  constructor(cap = 256) {
    this.a = new Uint8Array(cap)
  }
  private grow(k: number): void {
    if (this.n + k <= this.a.length) return
    let cap = this.a.length * 2
    while (cap < this.n + k) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.a.subarray(0, this.n))
    this.a = next
  }
  u8(v: number): void {
    this.grow(1)
    this.a[this.n++] = v & 0xff
  }
  u16(v: number): void {
    this.grow(2)
    this.a[this.n++] = (v >>> 8) & 0xff
    this.a[this.n++] = v & 0xff
  }
  u32(v: number): void {
    this.grow(4)
    this.a[this.n++] = (v >>> 24) & 0xff
    this.a[this.n++] = (v >>> 16) & 0xff
    this.a[this.n++] = (v >>> 8) & 0xff
    this.a[this.n++] = v & 0xff
  }
  /** 字节序写 64 位值（js 的数值安全范围足够覆盖本模块允许的文件尺寸） */
  u64(v: number): void {
    this.u32(Math.floor(v / 0x100000000))
    this.u32(v % 0x100000000)
  }
  fourcc(s: string): void {
    for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i))
  }
  raw(b: Uint8Array): void {
    this.grow(b.length)
    this.a.set(b, this.n)
    this.n += b.length
  }
  /** 预留 k 字节的 0（Uint8Array 初始就是 0，只需把游标推过去） */
  zeros(k: number): void {
    this.grow(k)
    this.n += k
  }
  done(): Uint8Array<ArrayBuffer> {
    return this.a.slice(0, this.n)
  }
}

function box(type: string, body: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(8 + body.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, out.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(body, 8)
  return out
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** 单位矩阵：不旋转、不缩放。写 0 矩阵会让部分播放器把画面缩没。 */
function pushUnityMatrix(b: Buf): void {
  b.u32(0x00010000)
  b.u32(0)
  b.u32(0)
  b.u32(0)
  b.u32(0x00010000)
  b.u32(0)
  b.u32(0)
  b.u32(0)
  b.u32(0x40000000)
}

/** stts/ctts 的 (count, value) 游程压缩：一帧一条会让表比样本本身还大 */
function pushRunLength(b: Buf, values: readonly number[]): void {
  let runs = 0
  for (let i = 0; i < values.length; ) {
    let j = i + 1
    while (j < values.length && values[j] === values[i]) j++
    runs++
    i = j
  }
  b.u32(runs)
  for (let i = 0; i < values.length; ) {
    let j = i + 1
    while (j < values.length && values[j] === values[i]) j++
    b.u32(j - i)
    b.u32(values[i])
    i = j
  }
}

function buildTkhd(track: Track, durationMs: number, volume: number): Uint8Array {
  const b = new Buf(104)
  b.u32(0x000003) // enabled | in_movie：可用且属于这条"影片"
  b.u32(0) // creation_time
  b.u32(0) // modification_time
  b.u32(track.trackId)
  b.u32(0) // reserved
  b.u32(durationMs)
  b.zeros(8) // reserved
  b.u16(0) // layer
  b.u16(0) // alternate_group
  b.u16(volume)
  b.u16(0) // reserved
  pushUnityMatrix(b)
  b.u32(track.widthRaw)
  b.u32(track.heightRaw)
  return box('tkhd', b.done())
}

function buildMdhd(track: Track, durationTicks: number): Uint8Array {
  const b = new Buf(44)
  if (durationTicks > 0xffffffff) {
    // 32 位装不下才升 version 1；能装下就用 v0，老播放器对 v0 的兼容面最宽
    b.u32(0x01000000)
    b.u64(0)
    b.u64(0)
    b.u32(track.timescale)
    b.u64(durationTicks)
  } else {
    b.u32(0)
    b.u32(0)
    b.u32(0)
    b.u32(track.timescale)
    b.u32(durationTicks)
  }
  b.u16(0x55c4) // language = 'und'（未指定）：MediaRecorder 也不写语言，编个假的反而误导
  b.u16(0) // pre_defined
  return box('mdhd', b.done())
}

function buildHdlr(kind: 'video' | 'audio'): Uint8Array {
  const b = new Buf(45)
  // FullBox 的 version/flags 必须写：少了这 4 字节，后面所有字段整体前移 4 位，
  // 解析器读到的 handler_type 就是垃圾（"文件能播但被当成数据轨"的成因之一）
  b.u32(0)
  b.u32(0) // pre_defined
  b.fourcc(kind === 'video' ? 'vide' : 'soun')
  b.zeros(12) // reserved
  const name = kind === 'video' ? 'VideoHandler' : 'SoundHandler'
  for (let i = 0; i < name.length; i++) b.u8(name.charCodeAt(i))
  b.u8(0) // null 结尾
  return box('hdlr', b.done())
}

function buildMediaHeaderBox(kind: 'video' | 'audio'): Uint8Array {
  if (kind === 'video') {
    const b = new Buf(20)
    b.u32(0x000001) // vmhd 的 flags 必须是 1（规范写死），否则部分解析器认为该盒非法
    b.u16(0) // graphicsmode = copy
    b.u16(0)
    b.u16(0)
    b.u16(0)
    return box('vmhd', b.done())
  }
  const b = new Buf(16)
  b.u32(0)
  b.u16(0) // balance
  b.u16(0) // reserved
  return box('smhd', b.done())
}

function buildDinf(): Uint8Array {
  const url = new Buf(12)
  url.u32(0x000001) // flags=1 表示"数据就在本文件里"（self-contained），这时不带 location 字符串
  const dref = new Buf(28)
  dref.u32(0)
  dref.u32(1) // entry_count
  dref.raw(box('url ', url.done()))
  return box('dinf', box('dref', dref.done()))
}

function buildStbl(track: Track, mdatPayloadBase: number): Uint8Array {
  const deltas: number[] = []
  const ctos: number[] = []
  const sizes: number[] = []
  const offsets: number[] = []
  const syncIndices: number[] = []
  let hasCto = false
  let minCto = 0

  for (let i = 0; i < track.samples.length; i++) {
    const s = track.samples[i]
    deltas.push(s.duration)
    sizes.push(s.size)
    const cto = s.cts - s.dts
    ctos.push(cto)
    if (cto !== 0) hasCto = true
    if (cto < minCto) minCto = cto
    if (s.isSync) syncIndices.push(i + 1) // stss 里的样本号从 1 开始
  }
  for (const c of track.chunks) {
    offsets.push(mdatPayloadBase + c.byteOffset)
  }

  // stts：解码时间表，每个样本的 duration 都从这里读。它缺失/写错 = 时长和拖动全废
  const stts = new Buf(16)
  stts.u32(0)
  pushRunLength(stts, deltas)

  const parts: Uint8Array[] = [track.stsd, box('stts', stts.done())]

  // ctts 只在真的有"呈现时间 ≠ 解码时间"（有 B 帧/重排）时才写：
  // 写一张全 0 的 ctts 不是"更保险"，它是多余的第二事实源 —— 有些播放器会据此
  // 认为存在重排而去等后续帧，反而把首帧显示推迟。
  if (hasCto) {
    const ctts = new Buf(16)
    // 有负偏移时必须 version 1（v0 的 offset 是无符号，负值会被读成 40 亿）
    ctts.u32(minCto < 0 ? 0x01000000 : 0)
    const tmp = new Buf(ctos.length * 2 + 8)
    pushRunLength(tmp, ctos.map((v) => (minCto < 0 ? v + 0x100000000 : v)))
    ctts.raw(tmp.done())
    parts.push(box('ctts', ctts.done()))
  }

  if (track.kind === 'video') {
    if (!syncIndices.length) {
      // 一个关键帧都没有的视频轨，任何播放器都起不来（第一帧就解不出）。
      // 与其交一个"能拖但全花屏"的文件，不如让上层知道这次合成没有可用产物。
      fail('视频轨里没有找到任何关键帧样本')
    }
    const stss = new Buf(8 + syncIndices.length * 4)
    stss.u32(0)
    stss.u32(syncIndices.length)
    for (const idx of syncIndices) stss.u32(idx)
    parts.push(box('stss', stss.done()))
  }

  // stsc：样本 → 块的映射。块的切法与源文件的 traf 一一对应（每段一块），
  // 于是"描述索引不同"这件事也能原样保住；相邻块样本数相同时合并成一条。
  const stscRuns: { firstChunk: number; count: number; descIndex: number }[] = []
  for (let i = 0; i < track.chunks.length; i++) {
    const c = track.chunks[i]
    const prev = stscRuns[stscRuns.length - 1]
    if (prev && prev.count === c.sampleCount && prev.descIndex === c.descIndex) continue
    stscRuns.push({ firstChunk: i + 1, count: c.sampleCount, descIndex: c.descIndex })
  }
  const stsc = new Buf(16)
  stsc.u32(0)
  stsc.u32(stscRuns.length)
  for (const r of stscRuns) {
    stsc.u32(r.firstChunk) // first_chunk 从 1 开始
    stsc.u32(r.count)
    stsc.u32(r.descIndex)
  }
  parts.push(box('stsc', stsc.done()))

  const stsz = new Buf(12 + sizes.length * 4)
  stsz.u32(0)
  stsz.u32(0) // sample_size=0 表示"大小逐样本给"，永远写全表（有些样本大小恰好全等时压缩才划算，但那张表更易读错）
  stsz.u32(sizes.length)
  for (const v of sizes) stsz.u32(v)
  parts.push(box('stsz', stsz.done()))

  const stco = new Buf(8 + offsets.length * 4)
  stco.u32(0)
  stco.u32(offsets.length)
  for (const v of offsets) stco.u32(v)
  parts.push(box('stco', stco.done()))

  return box('stbl', concat(parts))
}

function buildTrak(track: Track, durationMs: number, durationTicks: number, mdatPayloadBase: number): Uint8Array {
  const stbl = buildStbl(track, mdatPayloadBase)
  const minf = box('minf', concat([buildMediaHeaderBox(track.kind), buildDinf(), stbl]))
  const mdia = box('mdia', concat([buildMdhd(track, durationTicks), buildHdlr(track.kind), minf]))
  const volume = track.kind === 'audio' ? 0x0100 : 0
  return box('trak', concat([buildTkhd(track, durationMs, volume), mdia]))
}

/**
 * 产一个 moov。stco 里的偏移 = mdatPayloadBase + 块在 mdat 净荷内的相对偏移。
 *
 * 为什么要两遍：stco 记的是**绝对**文件偏移（相对文件头），而它自己就住在 moov 里 ——
 * moov 有多长直接决定 mdat 从哪开始。所以先按"stco 全 0"占位算一遍总长
 * （结构固定，只与 box 数量有关，两遍长度必然相同），得出 mdat 起点后再回填真实值。
 */
function buildMoov(tracks: readonly Track[], mdatPayloadBase: number, durationMs: number): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = []
  const mvhd = new Buf(108)
  mvhd.u32(0)
  mvhd.u32(0)
  mvhd.u32(0)
  mvhd.u32(1000) // 影片 timescale 固定 1000 = 毫秒：mvhd.duration 因此就是毫秒数，换算只做一次
  mvhd.u32(durationMs)
  mvhd.u32(0x00010000) // rate 1.0
  mvhd.u16(0x0100) // volume 1.0
  mvhd.u16(0) // reserved
  mvhd.zeros(8) // reserved
  pushUnityMatrix(mvhd)
  // `pre_defined[6]` = 6×u32 = **24 字节**（ISO/IEC 14496-12 §8.2.2）。写 12 会让整个 mvhd 短 12 字节：
  // Chromium 宽容照读，而 Windows 的 Media Foundation（`电影和电视`/资源管理器的"时长"列）直接读不出时长
  // —— 表现正是"进度条拖不动、倍速不可用"。实测：错版产物 `System.Media.Duration` 为空，改回 24 后为 7.13s。
  mvhd.zeros(24) // pre_defined
  let maxTrackId = 0
  for (const t of tracks) maxTrackId = Math.max(maxTrackId, t.trackId)
  mvhd.u32(maxTrackId + 1) // next_track_ID
  parts.push(box('mvhd', mvhd.done()))

  for (const t of tracks) {
    const endTicks = t.samples.length
      ? t.samples[t.samples.length - 1].dts + t.samples[t.samples.length - 1].duration
      : 0
    // 轨时长按"影片 timescale"（1000）写进 tkhd，按该轨自己的 timescale 写进 mdhd：
    // 两张表单位不同，混用就是倍增或缩小的时长显示
    const trackMs = Math.round((endTicks / t.timescale) * 1000)
    parts.push(buildTrak(t, trackMs, endTicks, mdatPayloadBase))
  }
  // 注意：这里**刻意不带 mvex**。mvex 是"本文件由 moof 分片组成"的声明，
  // 渐进文件带上它，读取器会去找不存在的 moof —— 那正是我们要摆脱的形态。
  return box('moov', concat(parts))
}

/* ============================ 主流程 ============================ */

async function remux(src: Blob): Promise<RemuxResult | null> {
  const ab = await src.arrayBuffer()
  const view = new DataView(ab)
  const top = parseBoxes(view, 0, ab.byteLength)
  if (!top) fail('顶层 box 越界或长度对不上')

  const ftypBox = findBox(top, 'ftyp')
  if (!ftypBox) fail('源文件没有 ftyp')
  // ftyp 照抄原字节：major brand / compatible brands 是"这份码流是什么"的声明，
  // 自己编一个 isom 会丢掉 avc1/mp41 这些兼容标记
  const ftyp = new Uint8Array(ab, ftypBox.start, ftypBox.size)

  const moov = findBox(top, 'moov')
  if (!moov) fail('源文件没有 moov')

  const moofs = top.filter((b) => b.type === 'moof')
  if (!moofs.length) fail('源文件没有 moof：它不是分片 MP4，不需要重排')

  const trex = new Map<number, TrexDefault>()
  const mvex = findBox(childBoxes(view, moov), 'mvex')
  if (mvex) {
    for (const tb of childBoxes(view, mvex)) {
      if (tb.type !== 'trex') continue
      const id = rd32(view, tb.bodyStart + 4, tb.end, 'trex.track_ID')
      trex.set(id, {
        hasDuration: true,
        duration: rd32(view, tb.bodyStart + 12, tb.end, 'trex.default_sample_duration'),
        hasSize: true,
        size: rd32(view, tb.bodyStart + 16, tb.end, 'trex.default_sample_size'),
        hasFlags: true,
        flags: rd32(view, tb.bodyStart + 20, tb.end, 'trex.default_sample_flags'),
      })
    }
  }

  const tracks: Track[] = []
  for (const b of childBoxes(view, moov)) {
    if (b.type !== 'trak') continue
    tracks.push(parseTrak(view, ab, b))
  }
  if (!tracks.length) fail('moov 里没有任何 trak')
  const byId = new Map<number, Track>()
  for (const t of tracks) {
    if (byId.has(t.trackId)) fail(`trackId ${t.trackId} 重复`)
    byId.set(t.trackId, t)
  }

  for (const moof of moofs) parseMoof(view, ab, moof, byId, trex)

  // 有轨但没样本 = 这条轨在产物里是空的，播放器会显示一条永远没有画面的轨。
  // 交给调用方判断"这次合成到底出了什么"比替它兜底更有用。
  for (const t of tracks) {
    if (!t.samples.length || !t.chunks.length) fail(`trackId ${t.trackId} 一个样本都没有`)
  }

  // 布局：每轨的样本连续摆放（先视频后音频）。本地文件不需要交错 ——
  // 交错只对"边下边播"有意义，代价是 stco 要记一大堆块偏移。
  let totalBytes = 0
  for (const t of tracks) {
    for (const c of t.chunks) {
      c.byteOffset = totalBytes
      for (let i = c.firstSample; i < c.firstSample + c.sampleCount; i++) totalBytes += t.samples[i].size
    }
  }
  if (totalBytes > MAX_MDAT_PAYLOAD) fail('样本总字节超过 4GB，stco 记不下')

  let endMs = 0
  for (const t of tracks) {
    const last = t.samples[t.samples.length - 1]
    endMs = Math.max(endMs, ((last.dts + last.duration) / t.timescale) * 1000)
  }
  const durationMs = Math.round(endMs)
  if (durationMs <= 0 || durationMs > 0xffffffff) fail(`算出的时长为 ${durationMs}ms`)

  const placeholder = buildMoov(tracks, 0, durationMs)
  const mdatPayloadBase = ftyp.length + placeholder.length + 8
  const moovBytes = buildMoov(tracks, mdatPayloadBase, durationMs)
  if (moovBytes.length !== placeholder.length) fail('moov 两遍算出的长度不一致')

  const mdatHeader = new Uint8Array(8)
  new DataView(mdatHeader.buffer).setUint32(0, totalBytes + 8)
  for (let i = 0; i < 4; i++) mdatHeader[4 + i] = 'mdat'.charCodeAt(i)

  // mdat 净荷用"连续游程"切片搬运：同轨相邻且地址连续的样本合成一次 slice，
  // 避免为几十万个样本各建一个 Blob 分片（那会让 Blob 组装本身成为瓶颈）
  const payload: BlobPart[] = []
  for (const t of tracks) {
    let runStart = -1
    let runEnd = -1
    for (const s of t.samples) {
      if (runStart >= 0 && s.offset === runEnd) {
        runEnd += s.size
        continue
      }
      if (runStart >= 0) payload.push(new Uint8Array(ab, runStart, runEnd - runStart))
      runStart = s.offset
      runEnd = s.offset + s.size
    }
    if (runStart >= 0) payload.push(new Uint8Array(ab, runStart, runEnd - runStart))
  }

  const blob = new Blob([ftyp, moovBytes, mdatHeader, ...payload], { type: 'video/mp4' })

  let videoSamples = 0
  let audioSamples = 0
  for (const t of tracks) {
    if (t.kind === 'video') videoSamples = t.samples.length
    else audioSamples = t.samples.length
  }
  return { blob, videoSamples, audioSamples, durationMs }
}
