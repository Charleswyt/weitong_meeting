// IndexedDB 那一层的桩：这一场测试要看的是**开录与清单的形状**，不是存储实现。
// 语义照抄真库的两条关键性质，别的都不装：
//   ① `blobs` 是按 `blobKey` 的键值表 —— 同一个键写第二次就是**覆盖**（并写坏件的现场证据）；
//   ② 分片字节与片级记录同事务落库。
// 其余函数要么记下调用参数供断言，要么直接抛：真被走到而桩里没有实现，宁可炸出来。

export interface StubSegment {
  blobKey: string
  trackId: string
  seq: number
  offsetSec: number
  durationSec: number
  sizeBytes: number
  mime: string
}

export const blobs = new Map<string, Blob>()
/** 同一个 blobKey 被写第二次起的次数 —— 两条编码器并写同一路就会 >0 */
export let blobOverwrites = 0
export const segmentRecords: StubSegment[] = []
export const sessionsWritten: Array<{ id: string; open: boolean; trackIds: string[] }> = []
export const diskWrites: Array<{ parts: string[]; fileName: string; size: number }> = []
export const registered: Array<Record<string, unknown>> = []
export const downloaded: Array<{ fileName: string; size: number }> = []

export function resetStub(): void {
  blobs.clear()
  blobOverwrites = 0
  quotaFailuresLeft = 0
  segmentRecords.length = 0
  sessionsWritten.length = 0
  diskWrites.length = 0
  registered.length = 0
  downloaded.length = 0
}

/** 覆盖计数只能由 setter 更新，测试侧读它走这个出口 */
export function overwrites(): number {
  return blobOverwrites
}

export const SESSION_HEARTBEAT_MIN_MS = 5000

export async function putSession(session: { id: string; open: boolean; tracks: Record<string, unknown> }): Promise<void> {
  sessionsWritten.push({ id: session.id, open: session.open, trackIds: Object.keys(session.tracks) })
}

export async function putSegmentWithRecord(rec: StubSegment, blob: Blob): Promise<void> {
  if (quotaFailuresLeft > 0) {
    quotaFailuresLeft--
    // 浏览器写满时抛的就是这个名字的 DOMException：这里造得出同一个形状，才能测"配额耗尽只播报一次"
    throw { name: 'QuotaExceededError', message: 'quota exhausted (stub)' }
  }
  if (blobs.has(rec.blobKey)) blobOverwrites++
  blobs.set(rec.blobKey, blob)
  segmentRecords.push(rec)
}

let quotaFailuresLeft = 0
/** 让接下来 N 次写入抛 QuotaExceededError（配额耗尽那条路的夹具） */
export function failNextWrites(n: number): void {
  quotaFailuresLeft = n
}

/** 与真实现同判据（真源在 `localRecorder.isQuotaError`；桩顶掉了整个模块，所以这里带一份） */
export function isQuotaError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'QuotaExceededError'
}

export async function getSegmentBlob(key: string): Promise<Blob | null> {
  return blobs.get(key) || null
}

// 纯函数一律转发真源。桩自己实现它们就是第二真源 —— 2026-10-10 这里把 containerOf 写成常量
// 'webm'，于是 verify-recording-judgments 测的是桩而非实现（假绿）；把它改成抛错又会带崩
// trackRecorder 的写盘路径（它真的调 containerOf）。两个症状是同一个错的两面：**桩只该顶掉
// 浏览器才有的那一层（IndexedDB / 目录授权 / DOM 下载），不该代替可判定真假的事实。**
export {
  makeLocalRecordingId,
  sanitizePathPart,
  recordingRelParts,
  containerOf,
  RECORDING_ROOT_DIR,
  trackSegmentsFromManifest,
} from '../src/utils/localRecorder.ts'

export async function ensureRecordingDirAccess(): Promise<'granted'> {
  return 'granted'
}

export async function writeRecordingAt(parts: string[], fileName: string, blob: Blob): Promise<boolean> {
  diskWrites.push({ parts, fileName, size: blob.size })
  return true
}

export async function addLocalRecording(meta: Record<string, unknown>): Promise<void> {
  registered.push(meta)
}

export function downloadBlob(fileName: string, blob: Blob): void {
  downloaded.push({ fileName, size: blob.size })
}

/**
 * 磁盘授权目录这一层在 Node 里不存在，所以这里恒走"按清单拼分片"那条降级路。
 * 损坏判定**不在桩里重复一遍** —— 它把调用方注入的 `assemble`（真源 `assembleTrackBlob`）原样叫出去，
 * 于是判据仍然由真实现跑，桩只提供"盘上没有整路文件"这个前提。
 */
export async function getTrackBlob(
  _recording: unknown,
  track: { segments: Array<{ seq: number; blobKey: string; offsetSec: number; durationSec: number; sizeBytes: number; mime: string }> },
  assemble: (t: never) => Promise<Blob | null>,
): Promise<Blob | null> {
  return assemble(track as never)
}
