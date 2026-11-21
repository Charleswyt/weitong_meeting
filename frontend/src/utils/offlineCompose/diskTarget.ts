/**
 * 离线合成的落盘目标：把编码结果**边合成边写进 OPFS 文件**，而不是整份留在 JS 堆里。
 *
 * 为什么必须换掉 `BufferTarget`：实测 987 秒那一场峰值 JS 堆 **683 MB**，整份产物在 finalize 前
 * 全程驻留内存（实测见口径文档 §7 第七轮第 5 条）。改流式后在途只有 `chunkSize` 那一块。
 *
 * 为什么这里还能用 `fastStart: 'reserve'`：`StreamTarget` 的 chunk 是 `{ data, position }`
 * （见 mediabunny `target.d.ts:79-86`），也就是**允许回写指定偏移**；真正只许追加的是
 * `AppendOnlyStreamTarget`。OPFS 的 `createWritable({ seekable: true })` 吃的正是
 * `{ type:'write', position, data }`，两边形状天然对上 —— 于是"单趟、moov 在前、播放器可拖"
 * 这一条不必为省内存而牺牲。
 *
 * 产物仍交回 `downloadBlob` 走浏览器下载目录（口径 §0 第 4 条不变）：OPFS 的 `File` 是磁盘后备的
 * Blob，锚点下载直接读盘，不会在 JS 侧复制一份。
 */
import { StreamTarget, type StreamTargetChunk } from 'mediabunny'

const PREFIX = 'compose-'

export interface DiskTargetHandle {
  target: StreamTarget
  /** finalize 之后调用：返回盘上那份文件（零拷贝交给下载） */
  finish: () => Promise<File>
  /** 失败或取消：关掉写入流并删掉半成品，不在客户机上堆垃圾 */
  abort: () => Promise<void>
  /** 已写字节数。finalize 报成功但这里是 0，就是"根本没写出内容" */
  bytesWritten: () => number
  readonly fileName: string
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  return await navigator.storage.getDirectory()
}

/**
 * 清扫时跳过最近 30 分钟内出现的文件。OPFS 是**源级**存储：同一浏览器开两个页各合成一次，
 * 谁的清扫都不许动对方正在用的那一份 —— 有写句柄的文件 removeEntry 本来会抛，
 * 但"刚写完、对方还拿着 File 等用户点保存"的那种没有句柄保护，只能按时间划一道保守界。
 */
const SWEEP_MIN_AGE_MS = 30 * 60 * 1000

/**
 * 清掉历史残留的合成件（用户那份已经在下载目录里，OPFS 再留就是白占客户机磁盘）。
 * **逐文件独立成败**：删不掉（别的页在用 / 还太新）就跳过它，绝不让它把整次落盘能力判死 ——
 * 实测正是这一步静默退回了内存目标，把 683 MB 那条老路放回来的。
 */
async function sweepStale(keep: string): Promise<string[]> {
  const dir = await opfsRoot()
  const skipped: string[] = []
  const now = Date.now()
  for await (const [name, entry] of dir.entries()) {
    if (entry.kind !== 'file' || !name.startsWith(PREFIX) || name === keep) continue
    try {
      const file = await (await dir.getFileHandle(name)).getFile()
      if (now - file.lastModified < SWEEP_MIN_AGE_MS) { skipped.push(name); continue }
      await dir.removeEntry(name)
    } catch {
      skipped.push(name)
    }
  }
  return skipped
}

/**
 * 建一个落盘目标。返回 `null` 表示这台浏览器没有 OPFS 可寻址写入
 * （`createWritable` 只有 Chromium 有）—— 调用方据此退回内存目标，这是能力差异不是异常。
 */
export async function createDiskTarget(stamp: string): Promise<DiskTargetHandle | null> {
  const fileName = `${PREFIX}${stamp}.mp4`
  let handle: FileSystemFileHandle
  let writable: FileSystemWritableFileStream
  // 清扫和"这一次能不能落盘"是两件事：残留件删不掉（别的页正在用）不该让本次合成失去落盘能力。
  // 实测就栽在这里 —— 清扫的抛错被下面那个 try 一起吞掉，于是静默退回内存目标，把 683 MB 那条老路放回来；
  // 复现法见 `scratch/disk-capability-probe.html` 第 11-13 步（另一处握着写句柄时旧写法必回落）。
  try {
    const skipped = await sweepStale(fileName)
    if (skipped.length) console.warn('[diskTarget] 有残留合成件暂不能清理，本轮跳过', skipped.length)
  } catch (e) {
    console.warn('[diskTarget] 清扫没成，不影响本次落盘', (e as Error)?.name, (e as Error)?.message)
  }
  try {
    const dir = await opfsRoot()
    handle = await dir.getFileHandle(fileName, { create: true })
    // seekable 是 'reserve' 回填 moov 的前提；不给 seekable 时写指定 position 会直接抛。
    // lib.dom 的 FileSystemCreateWritableOptions 至今没有这一项（Chromium 早已实现），只能显式带上。
    writable = await handle.createWritable({ seekable: true } as FileSystemCreateWritableOptions)
  } catch (e) {
    // 退回内存目标是**能力差异**，但"为什么退"必须留痕：实测同一台机器上一次走通了、下一次
    // 静默回落，回落得无声无息就没人知道 683 MB 那条老路又回来了
    console.warn('[diskTarget] 落盘不可用，退回内存目标', (e as Error)?.name, (e as Error)?.message)
    return null
  }

  let written = 0
  let closed = false
  const keptHandle = handle
  const stream = new WritableStream<StreamTargetChunk>({
    async write(chunk: StreamTargetChunk) {
      await writable.write({ type: 'write', position: chunk.position, data: chunk.data })
      written += chunk.data.byteLength
    },
    async close() {
      if (closed) return
      closed = true
      await writable.close()
    },
    async abort(reason) {
      closed = true
      await writable.abort(reason)
    },
  })

  return {
    target: new StreamTarget(stream, { chunked: true, chunkSize: 8 << 20 }),
    finish: async () => {
      if (!closed) { closed = true; await writable.close() }
      return await keptHandle.getFile()
    },
    abort: async () => {
      try { if (!closed) await writable.abort() } catch { /* 已经关掉的流再 abort 没意义 */ }
      closed = true
      try { await (await opfsRoot()).removeEntry(fileName) } catch { /* 文件本就不在 */ }
    },
    bytesWritten: () => written,
    fileName,
  }
}
