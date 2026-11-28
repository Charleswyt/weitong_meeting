import type { components } from '@/types/api.gen'
import { clientPrefs, updateClientPrefs } from '@/utils/clientPrefs'

export type VideoDelivery = components['schemas']['VideoDelivery']
export type VideoKind = 'camera' | 'screen'
export const strategies = [
  { value: 'source_frames', label: '原始帧率' },
  { value: 'bandwidth_first', label: '动态帧率' },
  { value: 'optimized', label: '优化策略' },
] as const

// 账号维度的传输偏好存在后端 user_client_pref；account 参数保留只为兼容旧调用点。
export function readDelivery(_account: string, kind: VideoKind): VideoDelivery {
  const value = kind === 'camera' ? clientPrefs.cameraDelivery : clientPrefs.screenDelivery
  return { ...value } as VideoDelivery
}

export function saveDelivery(_account: string, kind: VideoKind, value: VideoDelivery) {
  const pref = {
    transportMode: value.transportMode,
    encodingStrategy: value.encodingStrategy,
    targetBitrateKbps: value.targetBitrateKbps,
  } as typeof clientPrefs.cameraDelivery
  return updateClientPrefs(kind === 'camera' ? { cameraDelivery: pref } : { screenDelivery: pref }, { immediate: true })
}
