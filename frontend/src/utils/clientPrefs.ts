import { reactive } from 'vue'
import {
  getClientPrefs,
  patchClientPrefs,
  type ClientPrefsVo,
  type VideoDeliveryPref,
} from '@/api/settings'

// 个人偏好的唯一真源在后端 user_client_pref；这里只是本页会话内的内存副本，
// 让音量、画质增强这类同步读取的调用点不必每次都 await。
function defaults(): ClientPrefsVo {
  const delivery: VideoDeliveryPref = {
    transportMode: 'original',
    encodingStrategy: 'source_frames',
    targetBitrateKbps: 300,
  }
  return {
    videoEnhance: true,
    speakerVolume: 80,
    captionLanguage: 'zh',
    cameraDelivery: { ...delivery },
    screenDelivery: { ...delivery },
  }
}

export const clientPrefs = reactive<ClientPrefsVo>(defaults())

let loadedFor: string | null = null
let inflight: Promise<void> | null = null
const listeners = new Set<(p: ClientPrefsVo) => void>()

/** 偏好从后端到位（或被重置）时回调，供音量等需要立刻作用到 DOM 的模块订阅。 */
export function onClientPrefsChange(fn: (p: ClientPrefsVo) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit() {
  for (const fn of listeners) fn(clientPrefs)
}

export function loadClientPrefs(force = false): Promise<void> {
  const session = localStorage.getItem('weitong.token') || ''
  if (!session) return Promise.resolve()
  if (!force && loadedFor === session) return Promise.resolve()
  if (inflight) return inflight
  inflight = getClientPrefs()
    .then((res) => {
      if (res.data && (localStorage.getItem('weitong.token') || '') === session) {
        Object.assign(clientPrefs, res.data)
        loadedFor = session
        emit()
      }
    })
    .catch(() => {
      /* 后端暂不可达时沿用默认值，不挡页面 */
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function resetClientPrefs() {
  Object.assign(clientPrefs, defaults())
  loadedFor = null
  emit()
}

let pending: Partial<ClientPrefsVo> = {}
let timer: ReturnType<typeof setTimeout> | null = null

/** 先改内存立刻生效，再合并短时间内的多次改动一次写回后端（滑块拖动不会刷爆接口）。 */
export function updateClientPrefs(patch: Partial<ClientPrefsVo>, opts: { immediate?: boolean } = {}): Promise<void> {
  Object.assign(clientPrefs, patch)
  pending = { ...pending, ...patch }
  if (timer) clearTimeout(timer)
  const flush = async () => {
    timer = null
    const body = pending
    pending = {}
    if (!Object.keys(body).length) return
    try {
      const res = await patchClientPrefs(body)
      if (res.data) Object.assign(clientPrefs, res.data)
    } catch (e) {
      pending = { ...body, ...pending }
      throw e
    }
  }
  if (opts.immediate) return flush()
  timer = setTimeout(() => {
    flush().catch(() => {
      /* 拦截器已提示；内存值保留，下次修改会再带上 */
    })
  }, 400)
  return Promise.resolve()
}
