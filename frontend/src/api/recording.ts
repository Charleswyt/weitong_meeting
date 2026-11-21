import { sitePath } from '@/utils/sitePath'
import { get, del, getPage } from '@/utils/request'
import type { components } from '@/types/api.gen'

// 线格式类型取自契约生成物（../contracts/api.openapi.yaml → src/types/api.gen.ts），不手写第二份。
// 接线时暴露的分叉：旧手写版把 meetingStartedAt/meetingSpanSec 标可选（"旧后端没有"），
// 契约按当前后端运行时两键恒出现（omitempty 无，meetingId 空时 meetingStartedAt 为 ""）。
export type RecordingVo = components['schemas']['RecordingVo']

/**
 * 列表页的一行 = HTTP 的 `RecordingVo` **再加一个只在浏览器里算出来的位**。
 * `dataMissing` 从不经 HTTP（后端 `RecordingVo` 无此字段，DERIVATION §4-C2），
 * 它由 `RecordingListView` 探 IndexedDB/目录句柄得出，所以不能混进 `RecordingVo` ——
 * 混进去就等于宣称线格式里有这个键，生成的契约类型会与后端当场分叉。
 */
export type RecordingRow = RecordingVo & {
  /** 本地录制的分片字节已被浏览器回收，元数据仍在 */
  dataMissing?: boolean
}

// 回放清单的一条流。接线时暴露的分叉：旧手写版把 hasVideo/hasAudio 标可选（给 cloudReplay 的
// "缺字段退回按 mediaKind 猜"留后路），契约按后端运行时两键恒出现 true/false —— 上游真值优先这条
// 口径（AGENTS：不得按 mediaKind 推断）由类型强制了。
export type PlaybackStream = components['schemas']['PlaybackStream']

export type PlaybackMeeting = components['schemas']['PlaybackMeeting']

export type PlaybackTimeline = components['schemas']['PlaybackTimeline']

// 接线时暴露的分叉：旧手写版 meeting/timeline 是可选键；契约里两键恒出现、值为 `对象 | null`
// （无会议事实时后端给 null）。消费点都按真值判，两种形状行为一致。
export type PlaybackData = components['schemas']['PlaybackData']

export function getRecordingList(params?: { pageNum?: number; pageSize?: number; keyword?: string; type?: string; days?: number }) {
  return getPage<RecordingVo>('/api/v1/recordings/list', { params })
}

export function getPlayback(meetingId: string) {
  return get<PlaybackData>(`/api/v1/recordings/${meetingId}/playback`)
}

export function getDownloadUrl(recordingId: string) {
  return sitePath(`/api/v1/recordings/${recordingId}/download`)
}

export function deleteRecording(recordingId: string) {
  return del(`/api/v1/recordings/${recordingId}`)
}
