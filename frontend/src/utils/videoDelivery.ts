import type { components } from '@/types/api.gen'

export type VideoDelivery = components['schemas']['VideoDelivery']
export type VideoKind = 'camera' | 'screen'
export const strategies = [
  { value: 'source_frames', label: '原始帧率' },
  { value: 'bandwidth_first', label: '动态帧率' },
  { value: 'optimized', label: '优化策略' },
] as const

const defaults: VideoDelivery = { transportMode: 'original', encodingStrategy: 'source_frames', targetBitrateKbps: 300 }

function key(account: string, kind: VideoKind) {
  return `weitong.videoDelivery.${account}.${kind}`
}

export function readDelivery(account: string, kind: VideoKind): VideoDelivery {
  try {
    const value = JSON.parse(localStorage.getItem(key(account, kind)) || 'null')
    if (value && ['original', 'cloud'].includes(value.transportMode) &&
        strategies.some(s => s.value === value.encodingStrategy) &&
        Number.isInteger(value.targetBitrateKbps) && value.targetBitrateKbps >= 20 && value.targetBitrateKbps <= 6000) return value
  } catch { /* Unavailable storage or an old saved format. */ }
  return { ...defaults }
}

export function saveDelivery(account: string, kind: VideoKind, value: VideoDelivery) {
  localStorage.setItem(key(account, kind), JSON.stringify(value))
}
