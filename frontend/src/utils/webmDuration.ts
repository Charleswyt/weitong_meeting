// 补 WebM 的 Duration（第 16 项"完整的 mp4 或其他主流格式"）。
//
// Chromium 的 MediaRecorder 吐的是**直播流形**的 webm：Segment 不定长、SegmentInfo 里没有 Duration、
// 也没有 Cues。实测后果（2026-09-29，本机 Edge，拿真实合成产物验）：
//   <video>.duration = Infinity —— 播放器时长显示不可信、进度条无法按比例定位；
//   seek 只能落到 Cluster 边界（请求 3.00s 实落 3.86s）；
//   直接交给外部播放器/剪辑软件同样表现为"时长未知"。
// 分片本身是好的（能连续解码出帧），缺的只是那份元数据，所以在把文件交还给用户之前补上。
//
// 只在结构严格对得上时改：EBML 头 → 不定长 Segment → SegmentInfo。任何一步不符就原样返回 ——
// 宁可不补，也不能产出一个坏文件。
const ID_EBML = 0x1a45dfa3
const ID_SEGMENT = 0x18538067
const ID_SEGMENT_INFO = 0x1549a966
const ID_TIMECODE_SCALE = 0x2ad7b1
const ID_DURATION = 0x4489

function readId(buf: Uint8Array, at: number) {
  if (at >= buf.length) return null
  const first = buf[at]
  let len = 1
  let mask = 0x80
  while (len <= 4 && !(first & mask)) {
    mask >>= 1
    len++
  }
  if (len > 4 || at + len > buf.length) return null
  let value = 0
  for (let i = 0; i < len; i++) value = value * 256 + buf[at + i]
  return { value, size: len }
}

/** Matroska 的无符号长度编码；返回 null 表示"不定长"（这正是 MediaRecorder 的 Segment 用的形式）。
 *  不定长的编码是"标记位之后的数据位全为 1"，8 字节时那个数已经超出安全整数范围，
 *  所以必须按字节判全 1，不能算出数值再和 2^n-1 比。 */
function readSize(buf: Uint8Array, at: number) {
  if (at >= buf.length) return null
  const first = buf[at]
  let len = 1
  let mask = 0x80
  while (len <= 8 && !(first & mask)) {
    mask >>= 1
    len++
  }
  if (len > 8 || at + len > buf.length) return null
  let allOnes = (first & (mask - 1)) === mask - 1
  for (let i = 1; allOnes && i < len; i++) allOnes = buf[at + i] === 0xff
  if (allOnes) return { value: -1, size: len }
  let value = first & (mask - 1)
  for (let i = 1; i < len; i++) value = value * 256 + buf[at + i]
  return { value, size: len }
}

function writeSizeVint(value: number): Uint8Array {
  let len = 1
  while (len < 8 && value >= Math.pow(2, 7 * len) - 1) len++
  const out = new Uint8Array(len)
  out[0] = (1 << (8 - len)) | (value >>> (8 * (len - 1)))
  for (let i = 1; i < len; i++) out[i] = (value >>> (8 * (len - 1 - i))) & 0xff
  return out
}

function idBytes(id: number, len: number): Uint8Array {
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) out[i] = (id >>> (8 * (len - 1 - i))) & 0xff
  return out
}

/**
 * 把 `durationMs` 写进 webm 的 SegmentInfo。已经带 Duration、不是 webm、或结构不合预期的，
 * 一律原样返回（调用方不需要判类型，也不需要担心拿到坏文件）。
 */
export async function finalizeWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
  if (!(blob.type || '').includes('webm')) return blob
  if (!Number.isFinite(durationMs) || durationMs <= 0) return blob
  try {
    // 只需读文件头：Chromium 的头里 EBML + SegmentInfo 都在前 80 字节内，256 足够容下更长的 SegmentInfo
    const head = new Uint8Array(await blob.slice(0, 256).arrayBuffer())
    const ebml = readId(head, 0)
    if (!ebml || ebml.value !== ID_EBML) return blob
    const ebmlSize = readSize(head, ebml.size)
    if (!ebmlSize || ebmlSize.value < 0) return blob

    let at = ebml.size + ebmlSize.size + ebmlSize.value
    const seg = readId(head, at)
    if (!seg || seg.value !== ID_SEGMENT) return blob
    const segSize = readSize(head, at + seg.size)
    // Segment 必须是不定长：只有这种情况下往里插 11 个字节不需要改动任何别处的长度
    if (!segSize || segSize.value !== -1) return blob

    at += seg.size + segSize.size
    const info = readId(head, at)
    if (!info || info.value !== ID_SEGMENT_INFO) return blob
    const infoSize = readSize(head, at + info.size)
    if (!infoSize || infoSize.value < 0) return blob

    const infoBody = at + info.size + infoSize.size
    const infoEnd = infoBody + infoSize.value
    if (infoEnd > head.length) return blob

    // 扫 SegmentInfo 的 children：已经有 Duration 就别再写第二个；顺手取 TimecodeScale
    let scale = 1e6
    let p = infoBody
    while (p < infoEnd) {
      const cid = readId(head, p)
      if (!cid) return blob
      const csize = readSize(head, p + cid.size)
      if (!csize || csize.value < 0) return blob
      if (cid.value === ID_DURATION) return blob
      if (cid.value === ID_TIMECODE_SCALE && csize.value <= 8) {
        scale = 0
        for (let i = 0; i < csize.value; i++) scale = scale * 256 + head[p + cid.size + csize.size + i]
      }
      p += cid.size + csize.size + csize.value
    }

    // Duration 以 TimecodeScale 为单位；默认 1e6ns = 1ms，所以数值上就等于毫秒
    const ticks = (durationMs * 1e6) / (scale || 1e6)
    const payload = new Uint8Array(8)
    new DataView(payload.buffer).setFloat64(0, ticks)
    const durationEl = concat(idBytes(ID_DURATION, 2), writeSizeVint(8), payload)
    const newInfoLen = infoSize.value + durationEl.length

    return new Blob(
      [
        blob.slice(0, at),
        concat(idBytes(ID_SEGMENT_INFO, 4), writeSizeVint(newInfoLen)),
        blob.slice(infoBody, infoEnd),
        durationEl,
        blob.slice(infoEnd),
      ],
      { type: blob.type },
    )
  } catch (e) {
    console.warn('[webmDuration] 结构不合预期，原样返回', e)
    return blob
  }
}

const ID_CLUSTER = 0x1f43b675

/**
 * 取一帧 webm 头部（EBML + SegmentInfo + Tracks，即**第一个 Cluster 之前**的全部字节）。
 * 用途：MediaRecorder 的时片只有 seq=0 那一片带这份头，中间断掉之后重新起播的那一段
 * 是从无头的续片开始的，直接喂播放器就是 `MEDIA_ERR_SRC_NOT_SUPPORTED`。
 * 回放时把这份头补到"非 0 起始"的可播区前面，那一段才真能播。
 * 结构对不上就返回 null —— 宁可不补，也不要产出一个看着能播却解不出帧的 Blob。
 */
// 返回的是 `head.slice(...)`，slice 总会新分配一块 ArrayBuffer，所以返回类型写死 ArrayBuffer 底子
// （TS 6 下裸 `Uint8Array` = `<ArrayBufferLike>`，那样喂 new Blob([...]) 会被 BlobPart 拒）。
export function webmInitHeaderBytes(head: Uint8Array): Uint8Array<ArrayBuffer> | null {
  try {
    const ebml = readId(head, 0)
    if (!ebml || ebml.value !== ID_EBML) return null
    const ebmlSize = readSize(head, ebml.size)
    if (!ebmlSize || ebmlSize.value < 0) return null
    let at = ebml.size + ebmlSize.size + ebmlSize.value
    const seg = readId(head, at)
    if (!seg || seg.value !== ID_SEGMENT) return null
    const segSize = readSize(head, at + seg.size)
    if (!segSize) return null
    at += seg.size + segSize.size
    const limit = segSize.value < 0 ? head.length : Math.min(head.length, at + segSize.value)
    while (at < limit) {
      const id = readId(head, at)
      if (!id) return null
      const size = readSize(head, at + id.size)
      if (!size) return null
      if (id.value === ID_CLUSTER) return head.slice(0, at)
      if (size.value < 0) return null
      at += id.size + size.size + size.value
    }
    return null
  } catch (e) {
    console.warn('[webmDuration] 取不出容器头，按无头处理', e)
    return null
  }
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {  const total = parts.reduce((a, b) => a + b.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
