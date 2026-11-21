import { ref } from 'vue'
import { getCapabilities } from '@/api/settings'
import { postRoiHint } from '@/api/meeting'
import {
  closeFaceDetector,
  createFaceRoiObserver,
  loadFaceDetector,
  type FaceRegion,
  type FaceRoiObserver,
} from '@/utils/faceRoi'
import { useMediaSettings } from '@/composables/useMediaSettings'

// 人脸增强的运行时：检测与上报在这里，UI 只读 enabled/supported/notice。
// 三方语义：回报人脸框给编码器，本地预览不会变化；关闭时发一次空数组清除。

const supported = ref(false)
const enabled = ref(false)
const notice = ref('')
const loading = ref(false)

const MIN_INTERVAL_MS = 250
const MAX_FAILURES = 5

let capabilityChecked = false
let observer: FaceRoiObserver | null = null
let video: HTMLVideoElement | null = null
let boundTrack: MediaStreamTrack | null = null
let stream: MediaStream | null = null
let publicationId = ''
let meetingId: number | string = 0
let sequence = 0
let inflight = false
let pending: FaceRegion[] | null = null
let pendingMeta: { sourceTimestampMs: number; inferenceMs: number } | null = null
let lastSentAt = 0
let failures = 0
let flushTimer = 0

export function useFaceEnhancement() {
  const media = useMediaSettings()

  async function loadSupport(force = false) {
    if (capabilityChecked && !force) return supported.value
    capabilityChecked = true
    try {
      const res = await getCapabilities()
      const cap = res.data?.faceEnhancement
      supported.value = !!cap?.supported
      notice.value = supported.value ? '' : cap?.message || '人脸增强不可用'
    } catch {
      supported.value = false
      notice.value = '人脸增强不可用'
    }
    if (supported.value) {
      const p = media.prefs.value || (await media.loadPreferences())
      if (p?.faceEnhancement === 1) enabled.value = true
    } else {
      enabled.value = false
    }
    return supported.value
  }

  async function setEnabled(on: boolean, persist = true) {
    if (on && !(await loadSupport())) return
    enabled.value = on
    if (persist) {
      const p = media.prefs.value || (await media.loadPreferences())
      if (p) {
        // 只改这一项时不要把预检页/会中临时选的设备覆盖成库里的值。
        await media.savePreferences({ ...p, faceEnhancement: on ? 1 : 0 }, false)
      }
    }
    if (on) {
      await ensureObserver()
    } else {
      stopObserver()
      // 清掉上游已经记住的 ROI，否则关掉之后人脸区域仍会被特殊照顾。
      send([], { sourceTimestampMs: Math.round(performance.now()), inferenceMs: 0 }, true)
    }
  }

  // 重采（切虚化/换摄像头）换的是轨道；重发布换的是 publicationId。两个时机分开，漏一个就静默失效。
  function attachStream(next: MediaStream | null) {
    stream = next
    const track = next?.getVideoTracks().find((t) => t.readyState === 'live') || null
    if (track !== boundTrack) {
      // 旧 observer 还盯着旧 video，换轨时必须先停掉，否则会一直报旧画面的框。
      stopObserver()
    }
    if (enabled.value) void ensureObserver()
  }

  function bind(id: number | string, pubId: string) {
    meetingId = id
    if (publicationId !== pubId) {
      publicationId = pubId
      sequence = 0
      failures = 0
    }
    if (enabled.value) void ensureObserver()
  }

  function unbind() {
    stopObserver()
    publicationId = ''
  }

  function stop() {
    stopObserver()
    stream = null
    boundTrack = null
    publicationId = ''
    if (video) {
      video.srcObject = null
      video = null
    }
  }

  function dispose() {
    stop()
    closeFaceDetector()
  }

  async function ensureObserver() {
    if (!stream || !publicationId || observer || loading.value) return
    const track = stream.getVideoTracks().find((t) => t.readyState === 'live')
    if (!track) return
    if (!video) {
      video = document.createElement('video')
      video.muted = true
      video.playsInline = true
    }
    if (boundTrack !== track) {
      boundTrack = track
      // 只消费轨道，不 stop 它 —— 它同时还在预览、推流与录制。
      video.srcObject = new MediaStream([track])
      try {
        await video.play()
      } catch {
        /* 自动播放被拦时下一帧仍可能到达，检测会自然降为空结果 */
      }
    }
    if (!enabled.value || observer) return
    loading.value = true
    const detector = await loadFaceDetector()
    loading.value = false
    if (!detector) {
      // 模型起不来就把开关退回去，别留一个勾着但不干活的控件。
      enabled.value = false
      notice.value = '人脸增强不可用'
      return
    }
    if (!enabled.value || observer) return
    observer = createFaceRoiObserver(
      video,
      (sample) => send(sample.regions, sample),
      (e) => console.warn('[face] 人脸检测失败', e),
    )
  }

  function stopObserver() {
    observer?.stop()
    observer = null
    if (flushTimer) {
      window.clearTimeout(flushTimer)
      flushTimer = 0
    }
    pending = null
    pendingMeta = null
  }

  function send(regions: FaceRegion[], meta: { sourceTimestampMs: number; inferenceMs: number }, immediate = false) {
    if (!publicationId || !meetingId) return
    pending = regions
    pendingMeta = meta
    if (immediate) {
      void flush()
      return
    }
    const wait = MIN_INTERVAL_MS - (performance.now() - lastSentAt)
    if (wait <= 0) {
      void flush()
      return
    }
    if (!flushTimer) {
      flushTimer = window.setTimeout(() => {
        flushTimer = 0
        void flush()
      }, wait)
    }
  }

  async function flush() {
    if (inflight || !pending || !pendingMeta || !publicationId) return
    const regions = pending
    const meta = pendingMeta
    pending = null
    pendingMeta = null
    inflight = true
    lastSentAt = performance.now()
    const seq = ++sequence
    try {
      await postRoiHint(meetingId, publicationId, {
        detector: 'mediapipe_blazeface_short_range',
        sequence: seq,
        sourceTimestampMs: meta.sourceTimestampMs,
        inferenceMs: meta.inferenceMs,
        regions,
      })
      failures = 0
    } catch (e) {
      // 失败静默：这条只影响编码器偏置，不该弹窗让用户以为画面坏了。
      failures++
      console.warn('[face] 人脸增强上报失败', e)
      if (failures >= MAX_FAILURES) {
        enabled.value = false
        notice.value = '人脸增强已停用'
        stopObserver()
      }
    } finally {
      inflight = false
    }
  }

  return {
    supported,
    enabled,
    notice,
    loading,
    loadSupport,
    setEnabled,
    attachStream,
    bind,
    unbind,
    stop,
    dispose,
  }
}
