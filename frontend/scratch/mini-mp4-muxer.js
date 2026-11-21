// 最小 MP4（progressive）写出器：H.264 视频 + AAC 音频，时间戳全由调用方给。
// 为什么不用 WebM：归档上交要对方随手能播，而 Opus-in-WebM 在 Windows 自带播放器播不出来（实测）。
//
// 关键设计：**moov 在 mdat 之前**（progressive，对老播放器最友好）。
// 因此要先算出所有 sample 表，再回填 chunk 偏移 —— 做法是"先用占位偏移建一次 moov 量出长度、
// 再用真偏移重建一次"。stco 的值变但字节数不变，所以两趟结果的长度一致。
//
// 放 scratch 先把整条链走通；验证通过后整体落进 src/（见 docs/录制导出-离线合成方案与口径.md）。

function cat(list) {
  let n = 0
  for (const x of list) {
    // 拼装前先卡一道：裸 number 混进来（少包一层 u32/u16）会让长度算成 NaN，
    // 报出来的是 "offset is out of bounds" 这种没头没尾的 RangeError —— 实测踩过一次。
    if (!(x instanceof Uint8Array)) throw new TypeError('cat() 只吃 Uint8Array，收到 ' + Object.prototype.toString.call(x))
    n += x.length
  }
  const out = new Uint8Array(n)
  let p = 0
  for (const x of list) { out.set(x, p); p += x.length }
  return out
}
const u8 = (v) => new Uint8Array([v & 0xFF])
const u16 = (v) => new Uint8Array([(v >>> 8) & 0xFF, v & 0xFF])
const u32 = (v) => { const n = v >>> 0; return new Uint8Array([(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]) }
const i16 = (v) => u16(v < 0 ? v + 0x10000 : v)
const fourcc = (s) => new TextEncoder().encode(s)
const zeros = (n) => new Uint8Array(n)
const fixed16 = (v) => u32(Math.round(v * 65536) >>> 0)

function box(type, ...parts) {
  const payload = cat(parts)
  return cat([u32(payload.length + 8), fourcc(type), payload])
}
const fullBox = (type, version, flags, ...parts) =>
  box(type, new Uint8Array([version, (flags >>> 16) & 0xFF, (flags >>> 8) & 0xFF, flags & 0xFF]), ...parts)

/** MPEG-4 描述符：长度用单字节形式（我们的载荷都 <128） */
function desc(tag, payload) { return cat([u8(tag), u8(payload.length), payload]) }

const UNITY_MATRIX = cat([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
])

// ── 样本表 ────────────────────────────────────────────────────────────
/**
 * @param samples [{ durationTicks:number, key:boolean, data:Uint8Array }]
 * @param chunkMs 每多少毫秒的内容合成一个 chunk（影响 stco/stsc 的条目数）
 * @param timescale 该轨的时间基
 */
function buildChunks(samples, timescale, chunkMs, timeOfFirstSampleMs) {
  const chunks = []
  let cur = null
  let accMs = 0
  for (const s of samples) {
    if (!cur) cur = { samples: [], parts: [], startMs: 0 }
    if (cur.samples.length === 0) {
      cur.startMs = timeOfFirstSampleMs
    }
    cur.samples.push(s)
    cur.parts.push(s.data)
    accMs += (s.durationTicks / timescale) * 1000
    if (accMs >= chunkMs) { chunks.push(cur); cur = null; accMs = 0 }
    timeOfFirstSampleMs += (s.durationTicks / timescale) * 1000
  }
  if (cur) chunks.push(cur)
  for (const c of chunks) c.bytes = cat(c.parts)
  return chunks
}

function sttsOf(samples) {
  const runs = []
  for (const s of samples) {
    const last = runs[runs.length - 1]
    if (last && last.delta === s.durationTicks) last.count++
    else runs.push({ count: 1, delta: s.durationTicks })
  }
  return fullBox('stts', 0, 0, u32(runs.length), ...runs.map((r) => cat([u32(r.count), u32(r.delta)])))
}

function stscOf(chunks) {
  const runs = []
  for (let i = 0; i < chunks.length; i++) {
    const n = chunks[i].samples.length
    const last = runs[runs.length - 1]
    if (last && last.n === n) continue
    runs.push({ firstChunk: i + 1, n })
  }
  return fullBox('stsc', 0, 0, u32(runs.length), ...runs.map((r) => cat([u32(r.firstChunk), u32(r.n), u32(1)])))
}

function stszOf(samples) {
  return fullBox('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.data.length)))
}

function stcoOf(offsets) {
  return fullBox('stco', 0, 0, u32(offsets.length), ...offsets.map((o) => u32(o)))
}

function videoSampleEntry(width, height, avcC) {
  return box('avc1',
    zeros(6), u16(1),                       // reserved, data_reference_index
    u16(0), u16(0), zeros(12),              // pre_defined / reserved / pre_defined[3]
    u16(width), u16(height),
    u32(0x00480000), u32(0x00480000),       // 72 dpi
    u32(0), u16(1),                         // reserved, frame_count
    zeros(32),                              // compressorname（首字节=长度 0）
    u16(0x0018), i16(-1),                   // depth, pre_defined
    // avcC 是**盒子**，不是裸记录：必须补上 [size]['avcC'] 那 8 字节头，
    // 少了它播放器解不出 H.264 参数集（第一版就是这么漏的，靠本地校验器抓出来）。
    box('avcC', avcC))
}

function audioSampleEntry(sampleRate, channels, asc, bitrate) {
  const esds = fullBox('esds', 0, 0,
    desc(0x03, cat([u16(0), u8(0),
      desc(0x04, cat([u8(0x40), u8(0x15), new Uint8Array([0, 0, 0]), u32(bitrate), u32(bitrate),
        desc(0x05, asc)])),
    ])))
  return box('mp4a',
    zeros(6), u16(1),                       // reserved, data_reference_index
    u32(0), u32(0),                         // reserved
    u16(channels), u16(16),                 // channelcount, samplesize
    u16(0), u16(0),                         // pre_defined, reserved
    fixed16(sampleRate),
    esds)
}

function stblOf({ samples, chunks, chunkOffsets, entry }) {
  const parts = [
    fullBox('stsd', 0, 0, u32(1), entry),
    sttsOf(samples),
  ]
  if (samples.some((s) => s.key)) {
    const syncs = samples.map((s, i) => (s.key ? i + 1 : 0)).filter((x) => x)
    parts.push(fullBox('stss', 0, 0, u32(syncs.length), ...syncs.map((x) => u32(x))))
  }
  parts.push(stscOf(chunks), stszOf(samples), stcoOf(chunkOffsets))
  return box('stbl', ...parts)
}

function trakOf({ trackId, isVideo, timescale, durationTicks, movieTimescale, entry, samples, chunks, chunkOffsets, width, height }) {
  const mdia = box('mdia',
    fullBox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(durationTicks), u16(0x55C4), u16(0)),
    // hdlr 是 **FullBox**：必须带 4 字节 version/flags，否则后面 handler_type 起全部错位 4 字节
    // （第一版用 box 写的，本地校验器读出来的 handler_type 是空的）。
    fullBox('hdlr', 0, 0, u32(0), fourcc(isVideo ? 'vide' : 'soun'), u32(0), u32(0), u32(0),
      new TextEncoder().encode(isVideo ? 'VideoHandler\0' : 'SoundHandler\0')),
    box('minf',
      isVideo ? fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0))
        : fullBox('smhd', 0, 0, u16(0), u16(0)),
      box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
      stblOf({ samples, chunks, chunkOffsets, entry })))

  const durationMovie = Math.round((durationTicks / timescale) * movieTimescale)
  const tkhd = fullBox('tkhd', 0, 3,          // flags 3 = enabled | in movie
    u32(0), u32(0), u32(trackId), u32(0), u32(durationMovie),
    u32(0), u32(0),
    i16(0), i16(0), u16(isVideo ? 0 : 0x0100), u16(0),
    UNITY_MATRIX,
    fixed16(width || 0), fixed16(height || 0))
  return box('trak', tkhd, mdia)
}

function durationTicksOf(samples) {
  let d = 0
  for (const s of samples) d += s.durationTicks
  return d
}

/**
 * @param video { width, height, avcC, timescale, samples:[{durationTicks,key,data}] }
 * @param audio { sampleRate, channels, asc, bitrate, samples:[{durationTicks,key,data}] }
 * @returns { bytes } —— 整份 mp4
 */
export function muxMP4({ video, audio, movieTimescale = 1000, chunkMs = 1000 }) {
  const ftyp = box('ftyp', fourcc('isom'), u32(0x200),
    fourcc('isom'), fourcc('iso2'), fourcc('avc1'), fourcc('mp41'))

  const vChunks = video ? buildChunks(video.samples, video.timescale, chunkMs, 0) : []
  const aChunks = audio ? buildChunks(audio.samples, audio.sampleRate, chunkMs, 0) : []
  // 交错顺序 = mdat 里的落盘顺序（按各 chunk 的起始时刻排）
  const merged = [...vChunks.map((c) => ({ t: 'v', c })), ...aChunks.map((c) => ({ t: 'a', c }))]
    .sort((x, y) => x.c.startMs - y.c.startMs)

  const relOf = new Map()
  let rel = 0
  for (const m of merged) { relOf.set(m.c, rel); rel += m.c.bytes.length }
  const mdatPayload = rel

  const movieDur = Math.max(
    video ? Math.round((durationTicksOf(video.samples) / video.timescale) * movieTimescale) : 0,
    audio ? Math.round((durationTicksOf(audio.samples) / audio.sampleRate) * movieTimescale) : 0,
  )
  const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(movieTimescale), u32(movieDur),
    u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), UNITY_MATRIX, zeros(24), u32(3))

  const buildMoov = (vOff, aOff) => {
    const tracks = []
    if (video) tracks.push(trakOf({
      trackId: 1, isVideo: true, timescale: video.timescale,
      durationTicks: durationTicksOf(video.samples), movieTimescale,
      entry: videoSampleEntry(video.width, video.height, video.avcC),
      samples: video.samples, chunks: vChunks, chunkOffsets: vOff,
      width: video.width, height: video.height,
    }))
    if (audio) tracks.push(trakOf({
      trackId: 2, isVideo: false, timescale: audio.sampleRate,
      durationTicks: durationTicksOf(audio.samples), movieTimescale,
      entry: audioSampleEntry(audio.sampleRate, audio.channels, audio.asc, audio.bitrate || 128000),
      samples: audio.samples, chunks: aChunks, chunkOffsets: aOff,
      width: 0, height: 0,
    }))
    return box('moov', mvhd, ...tracks)
  }

  // 第一趟占位量长度，第二趟回填真实偏移；stco 的值变、字节数不变，所以两者长度必须相等
  const placeholder = buildMoov(vChunks.map(() => 0), aChunks.map(() => 0))
  const base = ftyp.length + placeholder.length + 8          // 8 = mdat 的 size + type
  const moov = buildMoov(
    vChunks.map((c) => base + relOf.get(c)),
    aChunks.map((c) => base + relOf.get(c)),
  )
  if (moov.length !== placeholder.length) {
    throw new Error(`moov 两趟长度不一致：${placeholder.length} → ${moov.length}`)
  }
  const mdat = cat([u32(mdatPayload + 8), fourcc('mdat'), ...merged.map((m) => m.c.bytes)])
  return {
    bytes: cat([ftyp, moov, mdat]),
    chunkCount: merged.length, moovBytes: moov.length, mdatBytes: mdat.length, movieDurMs: movieDur,
  }
}

