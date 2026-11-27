import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { getCapabilities } from '@/api/settings'

export type AccessNodeMode = 'checking' | 'unknown' | 'cloud' | 'edge' | 'offline'

const NODE_POLL_MS = 30_000

/**
 * 边/云入会模式自动检测与低频自主刷新：
 * - 通过只读接口 /api/v1/settings/capabilities 识别当前部署侧别（cloud / edge）并测算往返时延；
 * - 页面可见时每 30 秒静默刷新，后台暂停；切回标签页或网络状态变化时立即重测。
 */
export function useAccessNode() {
  const mode = ref<AccessNodeMode>('checking')
  const checking = ref(false)
  const rttMs = ref<number | null>(null)
  let pollTimer: number | null = null

  const label = computed(() => {
    if (mode.value === 'cloud') return '云端入会'
    if (mode.value === 'edge') return '边缘入会'
    if (mode.value === 'offline') return '连接异常'
    if (mode.value === 'unknown') return '节点类型未知'
    return '检测入会节点'
  })

  const subText = computed(() => {
    if (mode.value === 'cloud') {
      return rttMs.value !== null ? `云端链路 · ${rttMs.value}ms` : '云端链路在线'
    }
    if (mode.value === 'edge') {
      return rttMs.value !== null ? `边缘协同 · ${rttMs.value}ms` : '边缘节点在线'
    }
    if (mode.value === 'offline' || mode.value === 'unknown') return '点击重新检测'
    return '正在识别节点…'
  })

  const tooltip = computed(() => {
    const desc =
      mode.value === 'cloud'
        ? '当前为云端入会模式'
        : mode.value === 'edge'
          ? '当前为边缘入会模式'
          : '正在检测当前入会模式'
    return `${desc}（每 30 秒自动刷新，点击可立即重新检测）`
  })

  async function detect() {
    if (checking.value) return
    if (!navigator.onLine) {
      mode.value = 'offline'
      rttMs.value = null
      return
    }
    checking.value = true
    const started = performance.now()
    try {
      const res = await getCapabilities()
      rttMs.value = Math.max(1, Math.round(performance.now() - started))
      const side = res.data?.accessNode
      mode.value = side === 'cloud' || side === 'edge' ? side : 'unknown'
    } catch {
      mode.value = 'offline'
      rttMs.value = null
    } finally {
      checking.value = false
    }
  }

  function clearPoll() {
    if (pollTimer !== null) {
      window.clearTimeout(pollTimer)
      pollTimer = null
    }
  }

  function schedulePoll() {
    clearPoll()
    if (document.visibilityState !== 'visible') return
    pollTimer = window.setTimeout(() => {
      pollTimer = null
      if (document.visibilityState !== 'visible') return
      void detect().finally(() => schedulePoll())
    }, NODE_POLL_MS)
  }

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') {
      void detect().finally(() => schedulePoll())
    } else {
      clearPoll()
    }
  }

  function onNetworkChange() {
    void detect().finally(() => schedulePoll())
  }

  onMounted(() => {
    void detect().finally(() => schedulePoll())
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('online', onNetworkChange)
    window.addEventListener('offline', onNetworkChange)
  })

  onBeforeUnmount(() => {
    clearPoll()
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('online', onNetworkChange)
    window.removeEventListener('offline', onNetworkChange)
  })

  return {
    mode,
    checking,
    rttMs,
    label,
    subText,
    tooltip,
    detect,
  }
}
