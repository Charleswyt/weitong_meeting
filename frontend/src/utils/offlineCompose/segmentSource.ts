/**
 * 离线合成的入料层：把 IndexedDB 里的**分片**铺成一个可以按字节范围懒读的"虚拟文件"。
 *
 * 三条不可让的形状约束，都是撞出来的，不是设计偏好：
 *
 * 1. **绝不整份读**。上一版每路 `new Blob(blobs).arrayBuffer()` 一次把 216 MB 拉进内存，
 *    9 路就是 1.9 GB（`main:composeOffline.ts:69-83` 与它自己的注释 `:144`）。
 *    这里只实现 `CustomSource` 的 `read(start,end)`：谁要多少字节给多少，缓存在库那一侧（8 MiB）。
 *
 * 2. **一片容器的开始 = 片号回绕**。分片是 MediaRecorder 的 timeslice，只有**第一片**带
 *    EBML/容器头；把两次会话的分片拼成一个文件，就会得到一个带 3 个容器头、
 *    `computeDuration()` 回 0、一帧都解不出来的坏件 —— 盘上已经有一份了（见 `scratch/out/intake-s2.json`
 *    里 `chenfang/20260930185052` 那两条，以及计划 §十）。所以这里按 seq 回绕切容器，
 *    **一个容器一次合成输入**，跨容器不拼接。
 *
 * 3. **可播区（run）还要再按时间连续性切**。同一容器里如果中间有断流，
 *    字节是连续的但媒体时间有洞；回放侧早就按 run 处理（`replayEngine.ts:175` `assembleRuns`），
 *    这里保持同一个概念，界面上"缺口"才有唯一的来源。
 */
import type { LayoutLane } from '../composeLayout.ts'

/** IndexedDB `segments` 表里的一条分片记录（形状与 `localRecorder.SegmentRecord` 对齐，不 import 以免拖进 IndexedDB 依赖） */
export interface SliceInput {
  blobKey: string
  seq: number
  /** 相对整场 t0 的起点秒 */
  offsetSec: number
  durationSec: number
  sizeBytes: number
}

/** 取一片的字节。生产传 IndexedDB 查询，测试可注入内存 Map */
export type SliceFetcher = (blobKey: string) => Promise<ArrayBuffer | Uint8Array | null>

/** 一个容器：若干**片号连续**的分片，首片带容器头 */
export interface ContainerSlice {
  offsetSec: number
  durationSec: number
  blobKey: string
  sizeBytes: number
}

export interface RunContainer {
  /** 该容器覆盖的时间窗（半开） */
  startSec: number
  endSec: number
  slices: ContainerSlice[]
  totalBytes: number
  /**
   * 云端那一路：一个容器 = 一个远端文件（我方同源代理的下载地址），按 `UrlSource` 顺序流读。
   * 有它就不走 `slices`/`fetchSlice` 的字节范围模型 —— 后端不支持 Range，
   * 而件是 faststart（`moov` 在前，实测 3/3），先读表再顺流取样本正好单趟前向读。
   * 挂在容器而不是挂在路上：同一格可以横跨多次发布，每次是一个**独立**的远端文件。
   */
  remoteUrl?: string
}

export interface LaneContainers {
  laneId: string
  containers: RunContainer[]
  /** 被识别为"跨会话误并"的次数 —— 大于 1 说明这条 lane 的字节里有多于一个容器头 */
  containerCount: number
  /**
   * 机器码：`seq_restart`（片号回绕）/ `duplicate_blob_key`（两片指向同一字节，两台编码器并写）/
   * `seq_gap`（容器内片号不连续）。非空就**不许直接开合轨** —— 交出一个能播但缺内容的文件，
   * 比报错难查得多（本仓的硬口径）。
   */
  anomalies: string[]
}

/**
 * 把一条 lane 的分片切成容器。
 *
 * ⚠️ **按传入顺序走，绝不按 seq 排序**：传入顺序就是拼接文件的字节顺序，
 * 而"片号回绕"是唯一的现场证据 —— 一盘真实坏件的序列是 `0,0,1,1,2,2,3,3,4,4,0,1,…49`
 * （两台编码器**交错**出片），一排序就把症状洗成"看起来像很多个单片容器"，判据会假绿。
 *
 * 判据：`seq` 不比上一片大 ⇒ 新的一趟录制开始。
 * 不按 offsetSec 判 —— 盘上那份坏件的 offset 是**单调**的，拿它判会正好漏掉。
 */
export function splitContainers(laneId: string, slices: SliceInput[]): LaneContainers {
  const containers: RunContainer[] = []
  const anomalies = new Set<string>()
  const seenKeys = new Set<string>()
  let current: ContainerSlice[] | null = null
  let lastSeq = -1

  const flush = () => {
    if (!current || !current.length) return
    const start = current[0]!.offsetSec
    const last = current[current.length - 1]!
    containers.push({
      startSec: start,
      endSec: last.offsetSec + last.durationSec,
      slices: current,
      totalBytes: current.reduce((s, x) => s + x.sizeBytes, 0),
    })
    current = null
  }

  for (const s of slices) {
    if (seenKeys.has(s.blobKey)) anomalies.add('duplicate_blob_key')
    seenKeys.add(s.blobKey)
    if (s.seq <= lastSeq) {
      anomalies.add('seq_restart')
      flush()
    } else if (lastSeq >= 0 && s.seq > lastSeq + 1) {
      anomalies.add('seq_gap')
    }
    if (!current) current = []
    current.push({ offsetSec: s.offsetSec, durationSec: s.durationSec, blobKey: s.blobKey, sizeBytes: s.sizeBytes })
    lastSeq = s.seq
  }
  flush()
  return { laneId, containers, containerCount: containers.length, anomalies: [...anomalies] }
}

/**
 * 只按清单算这一路的异常码，不切容器 —— 回放、下载与入料**共用这一处判据**，
 * 别再在第二处重算一遍（同一件事两处算是本仓明令禁止的）。
 * 传什么都行，只要带 `seq` 与 `blobKey`；顺序就是**字节顺序**，不许先排序（见 `splitContainers` 的注释）。
 */
export function laneAnomalies(segments: SliceInput[]): string[] {
  return splitContainers('lane', segments).anomalies
}

/**
 * 这一路的字节是不是出自**多于一个容器**：片号回绕，或同一个键出现两次（两台编码器并写）。
 * 这种字节接起来就是个解不出内容的文件，读取侧要拒绝交出它（不修字节，只说实话）。
 * `seq_gap`（中间少一片）不算在这里 —— 那是缺口，回放在那儿本来就断成两块可播区。
 */
export function laneIsDamaged(segments: SliceInput[]): boolean {
  const a = laneAnomalies(segments)
  return a.includes('seq_restart') || a.includes('duplicate_blob_key')
}

/**
 * 在**一个容器内**按时间连续性切可播区。
 * 阈值与回放侧同源（0.25 秒）：两边判"断没断"的标准不一样，导出件和回放页就会各说各话。
 */
export function splitRuns(container: RunContainer, gapToleranceSec = 0.25): Array<{ startSec: number; endSec: number; firstByte: number; byteLength: number }> {
  const runs: Array<{ startSec: number; endSec: number; firstByte: number; byteLength: number }> = []
  let byteCursor = 0
  let run: { startSec: number; endSec: number; firstByte: number; byteLength: number } | null = null
  for (const slice of container.slices) {
    if (run && slice.offsetSec - run.endSec > gapToleranceSec) {
      runs.push(run)
      run = null
    }
    if (!run) run = { startSec: slice.offsetSec, endSec: slice.offsetSec, firstByte: byteCursor, byteLength: 0 }
    run.endSec = slice.offsetSec + slice.durationSec
    run.byteLength += slice.sizeBytes
    byteCursor += slice.sizeBytes
  }
  if (run) runs.push(run)
  return runs
}

export interface IdbRunSourceOptions {
  /** 该容器的总字节数 */
  totalBytes: number
  /** 容器内的分片（顺序即字节顺序） */
  slices: ContainerSlice[]
  fetchSlice: SliceFetcher
  /** 库那一侧的字节缓存上限（字节），默认 8 MiB */
  maxCacheBytes?: number
  /** 读日志（探针与排障用：证明它是范围读而不是整份读） */
  onRead?: (start: number, end: number, bytes: number) => void
}

/**
 * 交给 `new Input({ source })` 的范围读源。
 * 只暴露 `getSize` / `read` —— 剩下的字节映射都在这里算，别在调用方第二次拼前缀和。
 *
 * ⚠️ 返回的 Uint8Array 可能跨多片：`read` 允许返回任意长度区间，所以必须自己拼；
 * 拼的时候不许把整片都留在结果里之后不放（一次 read 的区间就是这一次的用量）。
 */
export function createRunSource(options: IdbRunSourceOptions): {
  getSize: () => number
  read: (start: number, end: number) => Promise<Uint8Array>
} {
  const { totalBytes, slices, fetchSlice } = options
  // 前缀和：第 i 片占据 [start, start+size)；查区间就按它切
  const starts: number[] = []
  let acc = 0
  for (const s of slices) { starts.push(acc); acc += s.sizeBytes }
  if (acc !== totalBytes) throw new Error(`字节账不平：分片合计 ${acc} ≠ 声明 ${totalBytes}`)

  return {
    getSize: () => totalBytes,
    read: async (start, end) => {
      const out = new Uint8Array(end - start)
      let written = 0
      for (let i = 0; i < slices.length && written < out.length; i++) {
        const sliceStart = starts[i]!
        const slice = slices[i]!
        const sliceEnd = sliceStart + slice.sizeBytes
        if (end <= sliceStart || start >= sliceEnd) continue
        const from = Math.max(0, start - sliceStart)
        const to = Math.min(slice.sizeBytes, end - sliceStart)
        const buf = await fetchSlice(slice.blobKey)
        if (!buf) {
          // 库里取不到字节：填零而不是抛 —— 但必须由调用方按"这条 run 不完整"处理，
          // 静默交出一段带洞的视频比报错更糟（本仓的硬口径）。
          options.onRead?.(start, end, 0)
          continue
        }
        const view = buf instanceof Uint8Array ? buf.subarray(from, to) : new Uint8Array(buf, from, to - from)
        out.set(view, written)
        written += view.length
        options.onRead?.(start, end, view.length)
      }
      return out
    },
  }
}

/** 一条 lane 进合成时要的输入：容器列表 + 界面勾选状态（画面/声音是两个维度） */
export interface LaneInput extends LayoutLane {
  containers: RunContainer[]
}
