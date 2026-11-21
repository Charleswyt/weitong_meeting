/**
 * 云端录制的入料装配：把回放清单（`/playback` 的 streams）搭成与本地同一条形状的 `ComposeLane[]`。
 *
 * 为什么能共用一套合成器：三方回放清单每路给 `offsetSeconds` + `durationSeconds`（相对会议起点），
 * 与本机分轨道清单是同一个时间轴模型（实测一场最多 43 条发布，同人再入会 = 另起一条，两边同形）。
 * 所以这里不另造选路模型 —— 画面路、音频路各自独立可选，同一格多次发布并成多容器。
 *
 * 与本机唯一的差别在字节从哪来：本机是 IndexedDB 里的分片范围读，云端是
 * 「一条发布 = 一个远端 faststart MP4」，交给 `UrlSource` 顺序流读（后端不支持 Range）。
 */
import type { PlaybackStream } from '@/api/recording'
import type { EngineTrack } from '../replayEngine'
import type { ComposeLane } from './engine'
import type { RunContainer } from './segmentSource'
import { laneLabelOf } from './intake'

export interface CloudLaneIntake {
  lanes: ComposeLane[]
  /** 勾了但拿不到可下载地址的路（界面名）—— 报出来，不静默少一路 */
  emptyLanes: string[]
  /** 这一场要从云端拉多少字节（成本模型的带宽项用它） */
  remoteBytes: number
}

export interface CloudIntakeOptions {
  videoIds?: Set<string>
  audioIds?: Set<string>
  /** recordingId → fileSizeBytes，来自 `/recordings/list`。没有就记 0，不许拿估算充数 */
  sizeByRecordingId?: Map<string, number>
}

/** 只有带 `downloadUrl` 的发布才能当入料（回放地址是 m3u8，合成不吃它） */
function indexStreams(streams: PlaybackStream[]): Map<string, PlaybackStream> {
  const m = new Map<string, PlaybackStream>()
  for (const s of streams) if (s.downloadUrl) m.set(s.recordingId, s)
  return m
}

export function buildLanesFromCloud(
  tracks: EngineTrack[],
  streams: PlaybackStream[],
  opts: CloudIntakeOptions = {},
): CloudLaneIntake {
  const byId = indexStreams(streams)
  const lanes: ComposeLane[] = []
  const emptyLanes: string[] = []
  let remoteBytes = 0

  for (const t of tracks) {
    const withVideo = !!t.hasVideo && (!opts.videoIds || opts.videoIds.has(t.recordingId))
    const withAudio = !!t.hasAudio && (!opts.audioIds || opts.audioIds.has(t.recordingId))
    if (!withVideo && !withAudio) continue

    const containers: RunContainer[] = []
    for (const seg of t.segments || []) {
      // seg.session 就是这条发布自己的 recordingId（云端一片 = 一条完整录制）
      const src = byId.get(seg.session || '')
      if (!src) continue
      const bytes = opts.sizeByRecordingId?.get(seg.session || '') ?? 0
      containers.push({
        startSec: seg.offsetSec,
        endSec: seg.offsetSec + seg.durationSec,
        // 一个远端文件就是**一整段连续内容**：给它一个覆盖全片的 slice，
        // 否则 splitRuns 逐 slice 算缺口会得到空数组 ⇒ 这一路一个时间戳都没有 ⇒ 画面整段凭空消失
        slices: [{
          blobKey: src.downloadUrl,
          offsetSec: seg.offsetSec,
          durationSec: seg.durationSec,
          sizeBytes: bytes,
        }],
        totalBytes: bytes,
        remoteUrl: src.downloadUrl,
      })
      remoteBytes += bytes
    }
    if (!containers.length) {
      emptyLanes.push(laneLabelOf(t))
      continue
    }
    containers.sort((a, b) => a.startSec - b.startSec)

    lanes.push({
      // 云端一格一条 recordingId（cloudReplay 按「人 × 通路」归组时就是拿它当键），
      // 视图查表时两种键都建，见 RecordingPlaybackView 的 rowsByKey
      id: t.recordingId,
      label: laneLabelOf(t),
      hasVideo: withVideo,
      hasAudio: withAudio,
      kind: t.kind,
      containers,
      // 云端没有"逐片取字节"这件事：一个容器就是一个远端文件，地址在 container.remoteUrl 上
      fetchSlice: undefined,
      width: t.width ?? null,
      height: t.height ?? null,
      frameRate: t.frameRate ?? null,
      sampleRate: t.sampleRate ?? null,
      channelCount: t.channelCount ?? null,
      mime: t.mime || '',
    })
  }
  return { lanes, emptyLanes, remoteBytes }
}
