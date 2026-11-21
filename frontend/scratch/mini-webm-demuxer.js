// 最小 EBML/WebM 解复用器：顺序走元素，抠出各轨的编码帧。
// 三条实测得来的硬约束，改这份代码前先读：
//  ① **关键帧一律从码流判，不看容器** —— MediaRecorder 产物里 SimpleBlock 的 0x80 位实测全为 0，
//     照它喂 VideoDecoder 会被 "A key frame is required" 拒收。VP9 读未压缩头的 frame_type 位；
//  ② **必须平铺解析，不能按嵌套递归** —— 不定长 Cluster 下递归会反复解析同一元素直到爆栈（实测撞过）；
//  ③ `SamplingFrequency` 是 float，而本项目产物写的是**4 字节 float32**（实测 0x473B8000 = 48000.0f）。

const ID = {
  SEGMENT: 0x18538067, INFO: 0x1549A966, TIMECODE_SCALE: 0x2AD7B1,
  TRACKS: 0x1654AE6B, TRACK_ENTRY: 0xAE, TRACK_NUMBER: 0xD7, TRACK_TYPE: 0x83,
  CODEC_ID: 0x86, CODEC_PRIVATE: 0x63A2, VIDEO: 0xE0, AUDIO: 0xE1,
  PIXEL_W: 0xB0, PIXEL_H: 0xBA, SAMPLE_RATE: 0xB5, CHANNELS: 0x9F,
  CLUSTER: 0x1F43B675, CLUSTER_TIME: 0xE7, SIMPLE_BLOCK: 0xA3, BLOCK_GROUP: 0xA0, BLOCK: 0xA1,
}
const CONTAINERS = new Set([ID.SEGMENT, ID.INFO, ID.TRACKS, ID.TRACK_ENTRY, ID.VIDEO, ID.AUDIO, ID.BLOCK_GROUP, ID.CLUSTER])

function vlen(b) { for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1; return 0 }
function readId(dv, p) {
  const len = vlen(dv.getUint8(p)); if (len < 1 || len > 4) return null
  let v = 0; for (let i = 0; i < len; i++) v = v * 256 + dv.getUint8(p + i)
  return { id: v, len }
}
function readSize(dv, p) {
  const len = vlen(dv.getUint8(p)); if (len < 1 || len > 8) return null
  let v = 0, allOnes = true
  for (let i = 0; i < len; i++) {
    const b = dv.getUint8(p + i)
    const data = i === 0 ? (b & (0xFF >> len)) : b
    if (i === 0) { if ((b & (0xFF >> len)) !== (0xFF >> len)) allOnes = false } else if (b !== 0xFF) allOnes = false
    v = v * 256 + data
  }
  return { size: allOnes ? Infinity : v, len }
}
const ru = (dv, p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + dv.getUint8(p + i); return v }
const rs = (dv, p, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(p + i)); return s }

/**
 * @returns { tracks: Map<number, {number,type,codecId,w,h,channels,sampleRate,codecPrivate}>,
 *            frames: Map<number, {tsMs,key,data}[]>, ms, laceWarn }
 */
export function demuxWebM(buf) {
  const dv = new DataView(buf)
  const t0 = performance.now()
  let pos = 0, timecodeScaleNs = 1e6, clusterTimeMs = 0, laceWarn = false
  const tracks = new Map(), frames = new Map()
  let cur = null

  const readBlock = (ds, de) => {
    let p = ds
    const tn = readSize(dv, p); if (!tn) return
    p += tn.len
    const rel = dv.getInt16(p); p += 2
    const flags = dv.getUint8(p); p += 1
    if ((flags & 0x06) >> 1) laceWarn = true
    const t = tracks.get(tn.size); if (!t) return
    const len = de - p; if (len <= 0) return
    const b0 = dv.getUint8(p)
    const key = t.codecId === 'V_VP9'
      ? ((b0 & 0xC0) === 0x80 && (b0 & 0x04) === 0)     // VP9 未压缩头 frame_type=0
      : t.codecId === 'V_VP8' ? (b0 & 0x01) === 0
        : true                                          // 音频每块都算关键帧
    if (!frames.has(tn.size)) frames.set(tn.size, [])
    frames.get(tn.size).push({ tsMs: clusterTimeMs + rel, key, data: new Uint8Array(buf, p, len) })
  }

  while (pos < buf.byteLength - 1) {
    const idr = readId(dv, pos); if (!idr) { pos++; continue }
    const szr = readSize(dv, pos + idr.len); if (!szr) { pos++; continue }
    const ds = pos + idr.len + szr.len
    const de = szr.size === Infinity ? buf.byteLength : Math.min(buf.byteLength, ds + szr.size)
    const id = idr.id
    if (CONTAINERS.has(id)) {
      if (id === ID.TRACK_ENTRY) cur = { number: 0, type: 0, codecId: '' }
      pos = ds
      continue
    }
    if (id === ID.TIMECODE_SCALE) { timecodeScaleNs = ru(dv, ds, de - ds); pos = de; continue }
    if (id === ID.CLUSTER_TIME) { clusterTimeMs = ru(dv, ds, de - ds) * (timecodeScaleNs / 1e6); pos = de; continue }
    if (id === ID.TRACK_NUMBER) { cur.number = ru(dv, ds, de - ds); pos = de; continue }
    if (id === ID.TRACK_TYPE) { cur.type = ru(dv, ds, de - ds); pos = de; continue }
    if (id === ID.CODEC_ID) { cur.codecId = rs(dv, ds, de - ds); tracks.set(cur.number, cur); pos = de; continue }
    if (id === ID.CODEC_PRIVATE) { cur.codecPrivate = new Uint8Array(buf, ds, de - ds); pos = de; continue }
    if (id === ID.PIXEL_W) { cur.w = ru(dv, ds, de - ds); pos = de; continue }
    if (id === ID.PIXEL_H) { cur.h = ru(dv, ds, de - ds); pos = de; continue }
    if (id === ID.CHANNELS) { cur.channels = ru(dv, ds, de - ds); pos = de; continue }
    if (id === ID.SAMPLE_RATE) {
      const n = de - ds
      const d2 = new DataView(buf, ds, n)
      cur.sampleRate = n === 8 ? d2.getFloat64(0) : n === 4 ? d2.getFloat32(0) : ru(dv, ds, n)
      pos = de; continue
    }
    if (id === ID.SIMPLE_BLOCK || id === ID.BLOCK) { readBlock(ds, de); pos = de; continue }
    pos = de
  }
  return { tracks, frames, ms: performance.now() - t0, laceWarn }
}
