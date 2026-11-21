// 云端录制 → 回放引擎输入（第 15/19 项：云端回看和本地走同一套多路宫格引擎）。
//
// 两边本来就同构：三方回放清单每路给 `offsetSeconds` + `durationSeconds`（相对会议起点），
// 与本机分轨道清单里的 `startOffsetSec` + `segments` 是同一个时间轴模型。
// 实测（2026-09-29，探针直连我方后端）：一场会最多 43 条发布，同一个人中途退会再入
// 在云端同样是**另起一条发布**（第 17 项那个中断，两边都在，形状一致）。
// 所以这里按「人 × 通路」归组 —— 一条组里的多次发布 = 引擎里一条行上的多个片，
// 组与组之间才有"这一路尚未开始 / 此时段录制中断"这些缺口态。
import type { PlaybackStream } from '@/api/recording'
import type { RecordedTrackKind } from '@/utils/localRecorder'
import type { EngineSegment, EngineTrack } from '@/utils/replayEngine'

/** 云端一条片对应的可下载条目（回放清单里每一片都是一条独立的录制）。 */
export interface CloudLane {
  recordingId: string
  fileName: string
}

function kindOf(mediaKind: string): RecordedTrackKind {
  return mediaKind === 'audio' ? 'microphone' : mediaKind === 'screen' ? 'screen' : 'camera'
}

/** 地址本身当分段键用：云端一片就是一条录制、一个清单地址。 */
export function cloudStreamsToTracks(streams: PlaybackStream[]): {
  tracks: EngineTrack[]
  laneBySegmentKey: Map<string, CloudLane>
} {
  const groups = new Map<string, PlaybackStream[]>()
  const lanes = new Map<string, CloudLane>()
  for (const s of streams) {
    if (!s.playbackUrl) continue
    const kind = kindOf(s.mediaKind || '')
    const owner = s.displayName || '未知参会者'
    const key = `${owner}::${kind}`
    let arr = groups.get(key)
    if (!arr) {
      arr = []
      groups.set(key, arr)
    }
    arr.push(s)
    lanes.set(s.playbackUrl, {
      recordingId: s.recordingId,
      fileName: `${owner}·${s.mediaLabel || (kind === 'microphone' ? '声音' : '画面')}.mp4`,
    })
  }

  const tracks: EngineTrack[] = []
  for (const [key, arr] of groups) {
    const sorted = arr.slice().sort((a, b) => a.offsetSeconds - b.offsetSeconds)
    const segments: EngineSegment[] = sorted.map((s, i) => ({
      seq: i,
      offsetSec: s.offsetSeconds,
      durationSec: s.durationSeconds,
      // 云端不回逐片字节数：这一格留 0，界面按"没有这个事实"显示 —，不拿估算充数
      sizeBytes: 0,
      blobKey: s.playbackUrl,
      mime: 'application/vnd.apple.mpegurl',
      // 云端一条片就是一次完整录制，会话标识就是它自己的 recordingId
      session: s.recordingId,
    }))
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const kind = kindOf(first.mediaKind || '')
    tracks.push({
      recordingId: key,
      ownerId: key,
      ownerName: first.displayName || '未知参会者',
      kind,
      mediaLabel: first.mediaLabel || (kind === 'microphone' ? '声音' : '画面'),
      // **上游给了 hasVideo/hasAudio 就用真值**（后端已透传上游这两个字段，契约 §6.5）。
      // 从前这里只能按 mediaKind 推断（`kind === 'microphone'`），推断错一路的代价是那一整路被静音
      // （引擎里 `media.muted = … || !row.hasAudio`）—— 这就是"云端回放没声音"的成因。
      // 字段缺失只可能是旧后端，那时才退回推断。
      hasVideo: first.hasVideo ?? kind !== 'microphone',
      hasAudio: first.hasAudio ?? kind === 'microphone',
      startOffsetSec: first.offsetSeconds,
      endOffsetSec: last.offsetSeconds + last.durationSeconds,
      closedAtMs: null,
      closeReason: 'session_end',
      mime: 'application/vnd.apple.mpegurl',
      fileName: '',
      segments,
      // 云端的"原文件"按片寻址（`laneBySegmentKey`），下载走云端分支，这里没有本机那种整路清单
      sources: [],
    })
  }
  // 同一个人同时有"画面件自带音轨"与"独立音频路"时**二选一**（契约 ADR-0068 五之补二）：
  // 优先独立音频路（那是平台专门录的声音），画面件自带的那条音轨丢弃 —— 否则同一个人会同时出声两遍。
  // 丢弃是我们的决定，不让它悄悄发生：打上 `audioDropped`，回放页的文件信息里如实写出来。
  const ownersWithAudioLane = new Set(
    tracks.filter((t) => !t.hasVideo && t.hasAudio).map((t) => t.ownerId),
  )
  for (const t of tracks) {
    if (t.hasVideo && t.hasAudio && ownersWithAudioLane.has(t.ownerId)) {
      t.hasAudio = false
      t.audioDropped = true
    }
  }

  // 画面行按入会时刻排，声音行排在后面：和引擎里"宫格 + 声音面板"的口径一致
  return { tracks: tracks.sort((a, b) => a.startOffsetSec - b.startOffsetSec), laneBySegmentKey: lanes }
}
