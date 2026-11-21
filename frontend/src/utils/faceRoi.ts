import { sitePath } from '@/utils/sitePath'
import { FaceDetector } from '@mediapipe/tasks-vision'
import { blockUsageTelemetry, getWasmFileset, INIT_STEP_TIMEOUT_MS, withTimeout } from './mediapipeRuntime'
import { normalizeRegions, type FaceRegion, type RawFaceBox } from './faceRegions'

export { normalizeRegions } from './faceRegions'
export type { FaceRegion, RawFaceBox } from './faceRegions'

// 人脸增强的前端半边：只负责"人脸在哪"。
// 真正的增强在三方编码器侧，这里把归一化人脸框定期报上去；本地预览不会因此变化。

export interface FaceRoiSample {
  regions: FaceRegion[]
  sourceTimestampMs: number
  inferenceMs: number
}

export interface FaceRoiObserver {
  stop: () => void
}

const FACE_MODEL_PATH = sitePath('/mediapipe/blaze_face_short_range.tflite')
const MIN_INTERVAL_MS = 125
const MAX_INTERVAL_MS = 500

let detectorPromise: Promise<FaceDetector | null> | null = null

export function loadFaceDetector(): Promise<FaceDetector | null> {
  if (!detectorPromise) {
    detectorPromise = initDetector().catch((e) => {
      detectorPromise = null
      console.warn('[face] 人脸模型加载失败', e)
      return null
    })
  }
  return detectorPromise
}

async function initDetector(): Promise<FaceDetector> {
  blockUsageTelemetry()
  const wasm = await withTimeout(getWasmFileset(), INIT_STEP_TIMEOUT_MS, '人脸模型')
  // 与分割同一条策略：GPU 优先，失败或卡住就退 CPU；全部失败由调用方降级。
  let lastError: unknown = null
  for (const delegate of ['GPU', 'CPU'] as const) {
    try {
      return await withTimeout(
        FaceDetector.createFromOptions(wasm, {
          baseOptions: { modelAssetPath: FACE_MODEL_PATH, delegate },
          runningMode: 'VIDEO',
          minDetectionConfidence: 0.5,
        }),
        INIT_STEP_TIMEOUT_MS,
        `${delegate} 人脸初始化`,
      )
    } catch (e) {
      lastError = e
    }
  }
  throw lastError ?? new Error('no usable delegate')
}

export function closeFaceDetector() {
  const pending = detectorPromise
  detectorPromise = null
  pending?.then((d) => d?.close()).catch(() => undefined)
}

type FrameCallbackHost = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number
  cancelVideoFrameCallback?: (id: number) => void
}

// 检测频率对齐三方：≥125ms 一检（上限 8fps），慢到 200ms 以上自动降到 500ms，
// 把 GPU/CPU 让回给同时开着的背景虚化。
export function createFaceRoiObserver(
  video: HTMLVideoElement,
  onSample: (s: FaceRoiSample) => void,
  onError?: (e: unknown) => void,
): FaceRoiObserver {
  let running = true
  let busy = false
  let lastAt = 0
  let lastTs = 0
  let rvfcId = 0
  let rafId = 0
  let interval = MIN_INTERVAL_MS
  const host = video as FrameCallbackHost
  const detectorPromise = loadFaceDetector()

  function schedule() {
    if (!running) return
    if (typeof host.requestVideoFrameCallback === 'function') {
      rvfcId = host.requestVideoFrameCallback(() => void tick())
    } else {
      rafId = requestAnimationFrame(() => void tick())
    }
  }

  async function tick() {
    if (!running) return
    schedule()
    if (busy || document.hidden) return
    const now = performance.now()
    if (now - lastAt < interval) return
    lastAt = now
    if (!video.videoWidth || !video.videoHeight) return
    const detector = await detectorPromise
    if (!detector || !running) return
    busy = true
    const started = performance.now()
    try {
      // VIDEO 模式要求时间戳严格递增。
      lastTs = Math.max(Math.round(now), lastTs + 1)
      const result = detector.detectForVideo(video, lastTs)
      const boxes: RawFaceBox[] = (result.detections || []).map((d) => ({
        originX: d.boundingBox?.originX ?? 0,
        originY: d.boundingBox?.originY ?? 0,
        width: d.boundingBox?.width ?? 0,
        height: d.boundingBox?.height ?? 0,
        score: d.categories?.[0]?.score,
      }))
      const inferMs = performance.now() - started
      interval = inferMs > 200 ? MAX_INTERVAL_MS : MIN_INTERVAL_MS
      onSample({
        regions: normalizeRegions(boxes, video.videoWidth, video.videoHeight),
        sourceTimestampMs: Math.round(now),
        inferenceMs: Math.round(inferMs),
      })
    } catch (e) {
      onError?.(e)
    } finally {
      busy = false
    }
  }

  schedule()
  return {
    stop() {
      running = false
      if (rvfcId && typeof host.cancelVideoFrameCallback === 'function') host.cancelVideoFrameCallback(rvfcId)
      if (rafId) cancelAnimationFrame(rafId)
    },
  }
}
