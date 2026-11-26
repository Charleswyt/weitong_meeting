import { onBeforeUnmount, onMounted, ref } from 'vue'

export type RecoveryState = 'idle' | 'offline' | 'recovering' | 'failed'

export interface MeetingRecoveryOptions {
  /** 是否已完成入会且会议仍在活跃状态 */
  isActive: () => boolean
  /** 重新拉起 WebSocket 信令连接 */
  reconnectWs: () => Promise<void>
  /** 恢复本端推流（摄像头/麦克风/屏幕共享） */
  recoverPublish: () => Promise<void>
  /** 恢复远端音视频订阅 */
  recoverSubscribe: () => Promise<void>
}

const SLEEP_DETECT_INTERVAL_MS = 2000
const SLEEP_GAP_THRESHOLD_MS = 8000
const RECOVER_COOLDOWN_MS = 4000

/**
 * 会中网络断开 / 电脑休眠唤醒自动恢复器。
 * 统一监测 offline/online、系统时钟跳跃（休眠唤醒）与 WS 重连事件，
 * 并输出状态提示条与一键手动重连能力。
 */
export function useMeetingRecovery(opts: MeetingRecoveryOptions) {
  const state = ref<RecoveryState>('idle')
  const message = ref('')

  let recovering = false
  let lastRecoverAt = 0
  let lastTickAt = Date.now()
  let sleepTimer: number | null = null
  let hideTimer: number | null = null

  function clearHideTimer() {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer)
      hideTimer = null
    }
  }

  async function triggerRecovery(reason: string, force = false) {
    if (!opts.isActive()) return
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      state.value = 'offline'
      message.value = '当前网络已断开，恢复连接后将自动重连音视频'
      return
    }
    const now = Date.now()
    if (!force && (recovering || now - lastRecoverAt < RECOVER_COOLDOWN_MS)) return
    recovering = true
    lastRecoverAt = now
    clearHideTimer()
    state.value = 'recovering'
    message.value = `${reason}，正在自动重连信令与音视频…`

    try {
      await opts.reconnectWs().catch(() => {})
      await Promise.all([
        opts.recoverPublish().catch((e) => {
          console.warn('[recovery] 本端推流恢复失败:', e)
        }),
        opts.recoverSubscribe().catch((e) => {
          console.warn('[recovery] 远端订阅恢复失败:', e)
        }),
      ])
      state.value = 'idle'
      message.value = ''
    } catch (e) {
      console.error('[recovery] 自动重连失败:', e)
      state.value = 'failed'
      message.value = '音视频自动重连未完成，请点击右侧按钮重试'
    } finally {
      recovering = false
    }
  }

  function onOffline() {
    if (!opts.isActive()) return
    clearHideTimer()
    state.value = 'offline'
    message.value = '当前网络已断开，恢复连接后将自动重连音视频'
  }

  function onOnline() {
    if (!opts.isActive()) return
    void triggerRecovery('网络已恢复', true)
  }

  function onVisibilityChange() {
    if (document.visibilityState !== 'visible' || !opts.isActive()) return
    const gap = Date.now() - lastTickAt
    lastTickAt = Date.now()
    if (gap >= SLEEP_GAP_THRESHOLD_MS) {
      void triggerRecovery('检测到设备从休眠/后台唤醒')
    }
  }

  onMounted(() => {
    lastTickAt = Date.now()
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    document.addEventListener('visibilitychange', onVisibilityChange)
    sleepTimer = window.setInterval(() => {
      const now = Date.now()
      const gap = now - lastTickAt
      lastTickAt = now
      if (gap >= SLEEP_GAP_THRESHOLD_MS && opts.isActive()) {
        void triggerRecovery('检测到系统休眠唤醒')
      }
    }, SLEEP_DETECT_INTERVAL_MS)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('offline', onOffline)
    window.removeEventListener('online', onOnline)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    if (sleepTimer !== null) {
      window.clearInterval(sleepTimer)
      sleepTimer = null
    }
    clearHideTimer()
  })

  return {
    recoveryState: state,
    recoveryMessage: message,
    triggerRecovery,
  }
}
