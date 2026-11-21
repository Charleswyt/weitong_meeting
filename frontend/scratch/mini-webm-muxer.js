// 最小 WebM 写出器 —— 只够探针用：VP9 视频 + Opus 音频 + 由调用方自写时间戳。
// 放 scratch 是为了先证明"这条路能不能出一个能播的文件"，不改仓内依赖；
// 真做产品时再决定用现成 muxer 库还是留这份自研（见 docs/录制导出-离线合成方案与口径.md §6 风险 5）。
//
// 写法：自底向上拼字节 —— 先构造子元素，再套父元素并按长度写 size，
// 所以不需要预估长度，也不依赖任何第三方库。

const enc = new TextEncoder()

function cat(list) {
  let n = 0
  for (const x of list) n += x.length
  const out = new Uint8Array(n)
  let p = 0
  for (const x of list) { out.set(x, p); p += x.length }
  return out
}

/** EBML 变长整数：n 字节可表示 7n 位，全 1 的值被"不定长"占用，所以上限是 2^(7n)-2。 */
function vint(v) {
  let n = 1
  while (n < 8 && v > Math.pow(2, 7 * n) - 2) n++
  const out = new Uint8Array(n)
  for (let i = n - 1; i >= 0; i--) { out[i] = v & 0xFF; v = Math.floor(v / 256) }
  out[0] |= 1 << (8 - n)
  return out
}

function uint(v, minLen = 1) {
  const a = []
  do { a.unshift(v & 0xFF); v = Math.floor(v / 256) } while (v > 0)
  while (a.length < minLen) a.unshift(0)
  return new Uint8Array(a)
}

function i16(v) {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setInt16(0, v)
  return b
}

function f64(v) {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setFloat64(0, v)
  return b
}

// 元素 ID 按 EBML 原样（含前导长度位）写成字节
const ID = {
  EBML: [0x1A, 0x45, 0xDF, 0xA3],
  EBMLVersion: [0x42, 0x86], EBMLReadVersion: [0x42, 0xF7],
  EBMLMaxIDLength: [0x42, 0xF2], EBMLMaxSizeLength: [0x42, 0xF3],
  DocType: [0x42, 0x82], DocTypeVersion: [0x42, 0x87], DocTypeReadVersion: [0x42, 0x85],
  Segment: [0x18, 0x53, 0x80, 0x67],
  Info: [0x15, 0x49, 0xA9, 0x66], TimecodeScale: [0x2A, 0xD7, 0xB1],
  MuxingApp: [0x4D, 0x80], WritingApp: [0x57, 0x41], Duration: [0x44, 0x89],
  Tracks: [0x16, 0x54, 0xAE, 0x6B], TrackEntry: [0xAE],
  TrackNumber: [0xD7], TrackUID: [0x73, 0xC5], TrackType: [0x83], FlagLacing: [0x9C],
  CodecID: [0x86], CodecPrivate: [0x63, 0xA2], DefaultDuration: [0x23, 0xE3, 0x83],
  Video: [0xE0], PixelWidth: [0xB0], PixelHeight: [0xBA],
  Audio: [0xE1], SamplingFrequency: [0xB5], Channels: [0x9F],
  Cluster: [0x1F, 0x43, 0xB6, 0x75], Timecode: [0xE7], SimpleBlock: [0xA3],
}

const el = (id, payload) => cat([new Uint8Array(id), vint(payload.length), payload])
const uel = (id, v, minLen = 1) => el(id, uint(v, minLen))
const sel = (id, s) => el(id, enc.encode(s))
const fel = (id, v) => el(id, f64(v))

function ebmlHeader() {
  return el(ID.EBML, cat([
    uel(ID.EBMLVersion, 1), uel(ID.EBMLReadVersion, 1),
    uel(ID.EBMLMaxIDLength, 4), uel(ID.EBMLMaxSizeLength, 8),
    sel(ID.DocType, 'webm'), uel(ID.DocTypeVersion, 4), uel(ID.DocTypeReadVersion, 2),
  ]))
}

/**
 * @param t { number, type: 1|2, codecId: 'V_VP9'|'A_OPUS', codecPrivate?: Uint8Array,
 *            width?, height?, sampleRate?, channels?, defaultDurationNs? }
 */
function trackEntry(t) {
  const parts = [
    uel(ID.TrackNumber, t.number), uel(ID.TrackUID, t.number), uel(ID.TrackType, t.type),
    uel(ID.FlagLacing, 0), sel(ID.CodecID, t.codecId),
  ]
  if (t.codecPrivate && t.codecPrivate.length) parts.push(el(ID.CodecPrivate, t.codecPrivate))
  if (t.defaultDurationNs) parts.push(uel(ID.DefaultDuration, t.defaultDurationNs))
  if (t.type === 1) {
    parts.push(el(ID.Video, cat([uel(ID.PixelWidth, t.width), uel(ID.PixelHeight, t.height)])))
  } else {
    parts.push(el(ID.Audio, cat([fel(ID.SamplingFrequency, t.sampleRate || 48000), uel(ID.Channels, t.channels || 1)])))
  }
  return el(ID.TrackEntry, cat(parts))
}

const CLUSTER_SPAN_MS = 5000   // 相对时间码要落在 int16 里，5 秒一簇既安全又够省

/**
 * @param blocks [{ track:number, tsMs:number, key:boolean, data:Uint8Array }]
 * @returns Uint8Array（整份 webm 字节）
 */
export function muxWebM({ tracks, blocks, durationMs }) {
  const sorted = blocks.slice().sort((a, b) => a.tsMs - b.tsMs)
  const clusters = []
  let cur = null
  for (const b of sorted) {
    if (!cur || b.tsMs - cur.base > CLUSTER_SPAN_MS) {
      if (cur) clusters.push(cur)
      cur = { base: b.tsMs, blocks: [] }
    }
    cur.blocks.push(b)
  }
  if (cur) clusters.push(cur)

  const clusterBytes = clusters.map((c) => el(ID.Cluster, cat([
    uel(ID.Timecode, Math.round(c.base)),
    ...c.blocks.map((b) => el(ID.SimpleBlock, cat([
      vint(b.track), i16(Math.max(0, Math.min(32767, Math.round(b.tsMs - c.base)))),
      new Uint8Array([b.key ? 0x80 : 0x00]), b.data,
    ]))),
  ])))

  const info = el(ID.Info, cat([
    uel(ID.TimecodeScale, 1000000),          // 1ms
    sel(ID.MuxingApp, 'hxt-probe'), sel(ID.WritingApp, 'hxt-probe'),
    fel(ID.Duration, durationMs),
  ]))
  const tracksEl = el(ID.Tracks, cat(tracks.map(trackEntry)))
  const segment = el(ID.Segment, cat([info, tracksEl, ...clusterBytes]))
  return cat([ebmlHeader(), segment])
}
