/**
 * 离线合成的**入料装配**：从一场本地录制（IndexedDB 清单或磁盘清单）直接搭出 `ComposeLane[]`，
 * 全程不碰 DOM —— 这样列表页也能发起合成，任务才能活在 store 里换路由不丢。
 *
 * 三条取材口径（都是这轮实测/审计钉下来的，别改回去）：
 * - `seq`/`blobKey` 用**清单里的真值**，不拿数组下标充当：下标恒单调，"片号回绕"这份唯一证据就没了。
 * - 一条路的字节按**容器**给（`splitContainers`），损坏的那一路直接拒（不交出"下载成功但只有前十几秒"）。
 * - 一片字节走 `getSegmentBlob` 的范围取，**绝不整份 `arrayBuffer()` 读全路**（上一轮 OOM 第二真因）。
 */
import {
  getSegmentBlob,
  type LocalRecording,
  type RecordedTrack,
} from '../localRecorder'
import { laneIsDamaged, splitContainers } from './segmentSource'
import type { ComposeLane } from './engine'

const KIND_LABEL: Record<string, string> = { camera: '画面', screen: '共享屏幕', microphone: '声音' }

export interface LaneIntake {
  lanes: ComposeLane[]
  /** 界面名：这些路的路径上有缺口/多次开录，离线合成还没接这一形（本轮如实回，不静默截半） */
  multiContainerLanes: string[]
  /** 界面名：字节出自多于一次录制，判成损坏，不参与合成 */
  damagedLanes: string[]
}

export interface LaneIntakeOptions {
  /** 进画面的路 id；不给 = 全部有画面的路 */
  videoIds?: Set<string>
  /** 进混音的路 id；不给 = 全部有声音的路 */
  audioIds?: Set<string>
}

export function laneLabelOf(t: RecordedTrack): string {
  return `${t.ownerName || '未知'} · ${KIND_LABEL[t.kind] ?? t.kind}`
}

/**
 * 一路 = 一格，判据与回放**同一条**：`ownerId + kind`（`replayEngine.groupTracksByLane`）。
 * 同一个人退了再入会留下两条录制，回放并成一格 ⇒ 导出也并成一格，否则"导出所见 = 回放所见"当场分叉。
 * 并起来的那条 lane 因此可能带**多个容器**，由内核按时间区间路由（见 composeOffline 的 VideoEntry）。
 */
export async function buildLanesFromRecording(
  rec: LocalRecording,
  opts: LaneIntakeOptions = {},
): Promise<LaneIntake> {
  interface Group { tracks: RecordedTrack[] }
  const groups = new Map<string, Group>()
  const damagedLanes: string[] = []
  for (const t of rec.tracks || []) {
    const segs = t.segments || []
    if (!segs.length) continue
    if (laneIsDamaged(segs)) {
      const label = laneLabelOf(t)
      if (!damagedLanes.includes(label)) damagedLanes.push(label)
      continue
    }
    const k = `${t.ownerId}\u0000${t.kind}`
    const g = groups.get(k) || { tracks: [] }
    g.tracks.push(t)
    groups.set(k, g)
  }

  const lanes: ComposeLane[] = []
  const multiContainerLanes: string[] = []
  for (const [key, g] of groups) {
    const head = g.tracks[0]!
    const label = laneLabelOf(head)
    const containers = g.tracks
      .flatMap((t) => splitContainers(t.recordingId, (t.segments || []).map((s) => ({
        blobKey: s.blobKey, seq: s.seq, offsetSec: s.offsetSec, durationSec: s.durationSec, sizeBytes: s.sizeBytes,
      }))).containers)
      .sort((a, b) => a.startSec - b.startSec)
    if (!containers.length) continue
    // 容器多 = 同人再入会（正常）；内核已经按区间路由，这里只把形状报出去，供文案或以后深挖
    if (containers.length > 1) multiContainerLanes.push(label)
    const withVideo = g.tracks.some((t) => t.hasVideo) && (!opts.videoIds || g.tracks.some((t) => opts.videoIds!.has(t.recordingId)))
    const withAudio = g.tracks.some((t) => t.hasAudio) && (!opts.audioIds || g.tracks.some((t) => opts.audioIds!.has(t.recordingId)))
    if (!withVideo && !withAudio) continue
    const source = g.tracks.find((t) => t.hasVideo && (t.width ?? 0) > 0) || g.tracks.find((t) => t.hasAudio) || head
    lanes.push({
      // id 用 lane 键而不是某一条 recordingId：一格一个 id，勾选、主画面、回放都拿它当同一件事
      id: key,
      label,
      hasVideo: withVideo,
      hasAudio: withAudio,
      kind: head.kind,
      containers,
      fetchSlice: async (blobKey: string) => {
        const blob = await getSegmentBlob(blobKey)
        return blob ? await blob.arrayBuffer() : null
      },
      width: source.width ?? null,
      height: source.height ?? null,
      frameRate: source.frameRate ?? null,
      sampleRate: source.sampleRate ?? null,
      channelCount: source.channelCount ?? null,
      mime: source.mime || '',
    })
  }
  return { lanes, multiContainerLanes, damagedLanes }
}
