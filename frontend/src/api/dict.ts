import { get } from '@/utils/request'
import type { components } from '@/types/api.gen'

// 线格式类型取自契约生成物（../contracts/api.openapi.yaml → src/types/api.gen.ts），不手写第二份。
// 与旧手写版同形（tagType 带 omitempty，可缺键）。
export type DictItemVo = components['schemas']['DictItemVo']

const cache = new Map<string, DictItemVo[]>()

export async function getDict(type: string): Promise<DictItemVo[]> {
  const hit = cache.get(type)
  if (hit) return hit
  const res = await get<DictItemVo[]>(`/api/v1/dicts/${encodeURIComponent(type)}`)
  const list = res.data || []
  cache.set(type, list)
  return list
}

export function dictLabelSync(type: string, code?: string | null): string {
  if (!code) return ''
  const list = cache.get(type)
  if (!list) return ''
  return list.find((d) => d.value === code)?.label || ''
}

export function dictTagTypeSync(type: string, code?: string | null): string {
  if (!code) return ''
  const list = cache.get(type)
  if (!list) return ''
  return list.find((d) => d.value === code)?.tagType || ''
}

export function clearDictCache(type?: string) {
  if (type) cache.delete(type)
  else cache.clear()
}

export const DICT = {
  accountType: 'account_type',
  position: 'position',
  meetingStatus: 'meeting_status',
  localSyncStatus: 'local_sync_status',
  recordingQuality: 'recording_quality',
  videoResolution: 'video_resolution',
  vbMode: 'vb_mode',
} as const
