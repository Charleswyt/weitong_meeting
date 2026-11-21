import { ImageSegmenter } from '@mediapipe/tasks-vision'
import type { MPMask } from '@mediapipe/tasks-vision'
import { blockUsageTelemetry, getWasmFileset, INIT_STEP_TIMEOUT_MS, withTimeout } from './mediapipeRuntime'

// 背景虚化的真身：逐帧用人像分割掩膜把"人"从画面里抠出来，只糊掩膜之外的区域，
// 输出是一条新的 canvas 轨道 —— 预览与发布共用它，对端拿到的同样是虚化后的画面。
// 旧的 CSS blur(6px) 会糊整帧且只影响本地预览，已由本模块取代。

export interface BgBlurSession {
  /** 处理后（只糊背景）的视频轨道，尺寸与源轨道一致 */
  track: MediaStreamTrack
  /** 释放全部资源：帧循环、分割器、canvas 轨道与源轨道 */
  dispose: () => void
}

export interface BgBlurOptions {
  /** 目标帧率，取偏好的 videoMaxFps；实际以摄像头出帧节奏为上限 */
  fps?: number
  /** 中文降级原因，供调用方展示；加载失败与运行中失效都会走这里 */
  onDegrade?: (reason: string) => void
}

const MODEL_ASSET_PATH = '/mediapipe/selfie_segmenter.tflite'
// 掩膜边缘羽化半径：分割边界是逐像素硬阈值，不羽化会出现锯齿与"剪纸"边。
const MASK_FEATHER_PX = 1.5

// 分割只在小图上跑：全分辨率逐帧推理会把输出轨拖到 0.1fps（实测 2026-11-03，
// 三方官方页的虚化反而不冻 —— 它的推理就是 256x256）。掩膜是低频信号，放大后够用。
const INFERENCE_SIZE = 256
// 推理间隔自适应：下限对齐三方（15fps），上限 1 秒 —— 再慢输出帧也只是复用旧掩膜，画面不会停。
const MIN_INFERENCE_INTERVAL_MS = 1000 / 15
const MAX_INFERENCE_INTERVAL_MS = 1000
// 实测耗时的余量系数：按 EMA 的 1.25 倍排下一次推理，避免推理背靠背把合成挤掉。
const INFERENCE_COST_HEADROOM = 1.25

// 等比内接：源画面放进推理方框，短边留黑边。掩膜回贴时要按这个 rect 换算，
// 否则 16:9 的画面会被拉成方形人形。
function containedRect(sw: number, sh: number, dw: number, dh: number) {
  const scale = Math.min(dw / sw, dh / sh)
  const width = Math.round(sw * scale)
  const height = Math.round(sh * scale)
  return { x: Math.round((dw - width) / 2), y: Math.round((dh - height) / 2), width, height }
}

export async function createBgBlurTrack(
  sourceTrack: MediaStreamTrack,
  options: BgBlurOptions = {},
): Promise<BgBlurSession | null> {
  const onDegrade = options.onDegrade ?? (() => {})
  const fps = Math.min(30, Math.max(5, options.fps ?? 20))

  const probe = document.createElement('canvas')
  if (typeof probe.captureStream !== 'function') {
    onDegrade('当前浏览器不支持画面处理，背景虚化未生效')
    return null
  }

  // 源帧读入：离屏 video 元素消费源轨道，muted+playsInline 满足自动播放策略。
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = new MediaStream([sourceTrack])
  try {
    // play() 同样不设界：源轨道不出帧（设备被占用、轨道已结束）时它会一直挂着，
    // 而调用方是 await 它的 —— 表现就是"选了虚化，预览永久不动、也不给任何提示"。
    await withTimeout(video.play(), INIT_STEP_TIMEOUT_MS, '首帧')
    await waitForFrame(video)
  } catch {
    video.srcObject = null
    onDegrade('无法读取摄像头画面帧，背景虚化未生效')
    return null
  }

  let segmenter: ImageSegmenter | null = null
  try {
    segmenter = await initSegmenter(video)
  } catch {
    video.srcObject = null
    // 诚实降级：保留原始轨道不处理，而不是退回到"整帧 CSS 糊"。
    onDegrade('背景虚化模型加载失败，已按原始画面继续')
    return null
  }

  const width = video.videoWidth
  const height = video.videoHeight
  const inferenceCanvas = document.createElement('canvas')
  inferenceCanvas.width = INFERENCE_SIZE
  inferenceCanvas.height = INFERENCE_SIZE
  const inferenceCtx = inferenceCanvas.getContext('2d')!
  const maskCanvas = document.createElement('canvas')
  const maskCtx = maskCanvas.getContext('2d')!
  const featherCanvas = document.createElement('canvas')
  const featherCtx = featherCanvas.getContext('2d')!
  const baseCanvas = document.createElement('canvas')
  const baseCtx = baseCanvas.getContext('2d')!
  const fgCanvas = document.createElement('canvas')
  const fgCtx = fgCanvas.getContext('2d')!
  const outCanvas = document.createElement('canvas')
  const outCtx = outCanvas.getContext('2d', { alpha: false, desynchronized: true })!
  for (const c of [maskCanvas, featherCanvas, baseCanvas, fgCanvas, outCanvas]) {
    c.width = width
    c.height = height
  }
  // 模糊半径随分辨率缩放，保证 480p 与 1080p 下观感强度一致。
  const blurPx = Math.max(6, Math.round(height / 72))

  let maskImage: ImageData | null = null
  let maskWords: Uint32Array | null = null

  function drawMask(mask: MPMask, rect: { x: number; y: number; width: number; height: number }) {
    const mw = mask.width
    const mh = mask.height
    if (maskCanvas.width !== width || maskCanvas.height !== height) {
      maskCanvas.width = width
      maskCanvas.height = height
    }
    if (!maskImage || maskImage.width !== mw || maskImage.height !== mh) {
      maskImage = maskCtx.createImageData(mw, mh)
      maskWords = new Uint32Array(maskImage.data.buffer)
    }
    // 掩膜实测：高值(255)=人像、低值=背景；写进 alpha 通道即可直接当 destination-in 用。
    const bytes = mask.getAsUint8Array()
    const words = maskWords!
    for (let i = 0; i < words.length; i++) words[i] = (bytes[i] << 24) >>> 0
    // putImageData 是直接替换像素，不留上一帧残底。
    maskCtx.putImageData(maskImage, 0, 0)

    // 小图先等比摆回它在源画面里占的那块并放大到全分辨率 —— 掩膜是低频信号，放大够用，
    // 而按 rect 换算才不会把人形拉扁。羽化在放大的同一次绘制里做。
    featherCtx.clearRect(0, 0, width, height)
    featherCtx.filter = `blur(${MASK_FEATHER_PX}px)`
    featherCtx.drawImage(maskCanvas, rect.x, rect.y, rect.width, rect.height, 0, 0, width, height)
    featherCtx.filter = 'none'
  }

  // 掩膜缓存：输出帧复用最近一次推理结果，不等推理。没有这条，
  // 输出帧率的上限就是推理耗时 —— 实测会把推给三方的轨拖到 0.1fps。
  let hasMask = false

  function compositeFrame() {
    const segment = segmenting && hasMask

    // 底图：整帧模糊。四角先"越界外扩"再裁切，否则 canvas filter 会把边缘糊成半透明。
    baseCtx.filter = segment ? `blur(${blurPx}px)` : 'none'
    baseCtx.drawImage(video, -blurPx, -blurPx, width + blurPx * 2, height + blurPx * 2)
    baseCtx.filter = 'none'

    if (segment) {
      // 前景：原帧画好后按羽化掩膜裁出人形，再叠回模糊底图 —— 人清晰、背景糊。
      fgCtx.globalCompositeOperation = 'source-over'
      fgCtx.drawImage(video, 0, 0, width, height)
      fgCtx.globalCompositeOperation = 'destination-in'
      fgCtx.drawImage(featherCanvas, 0, 0, width, height)
      fgCtx.globalCompositeOperation = 'source-over'
    }

    outCtx.clearRect(0, 0, width, height)
    outCtx.drawImage(baseCanvas, 0, 0)
    if (segment) outCtx.drawImage(fgCanvas, 0, 0)
  }

  // 对齐三方实现：用 captureStream(0) 手动帧请求模式，确保帧率完全可控，
  // 不受源视频帧率波动影响。每次合成后显式调用 requestFrame() 生产一帧。
  const track = outCanvas.captureStream(0).getVideoTracks()[0]
  const manualTrack = track as MediaStreamTrack & { requestFrame?: () => void }
  // 对齐三方：告诉编码器这是运动画面，优先时间分辨率。
  track.contentHint = 'motion'
  console.info('[vb-diag] track settings:', JSON.stringify(track.getSettings()), 'class:', track.constructor.name)

  let running = true
  let segmenting = true
  let lastTs = 0
  let lastDraw = 0
  let rafId = 0
  let rvfcId = 0
  const minInterval = 1000 / fps
  type FrameCallbackHost = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number
    cancelVideoFrameCallback?: (id: number) => void
  }

  // 推理节流：按实测耗时的 1.25 倍排下一次，钳在 66ms~1s 之间。
  // 上限那 1 秒是"画面会不会冻"的分界 —— 到顶也只是掩膜陈旧，输出帧照常走。
  let lastInferenceAt = 0
  let inferenceEmaMs = 0
  let adaptiveInferenceIntervalMs = MIN_INFERENCE_INTERVAL_MS
  let inferenceRect = containedRect(width, height, INFERENCE_SIZE, INFERENCE_SIZE)

  // 临时诊断：每秒报告实际出帧率，并记录 tick 之间的最大空档。
  // 空档到几十秒 = 标签页被后台节流（canvas 轨的帧只能由 JS 定时器驱动）。
  let diagFrameCount = 0
  let diagLastReportAt = performance.now()
  const diagReportIntervalMs = 1000
  let diagLastTickAt = performance.now()
  let diagMaxGapMs = 0

  function recordInference(elapsedMs: number) {
    // 单次耗时先钳住再进 EMA：一次异常慢的推理不该把间隔永久拉到天花板。
    const bounded = Math.min(elapsedMs, MAX_INFERENCE_INTERVAL_MS / INFERENCE_COST_HEADROOM)
    inferenceEmaMs = inferenceEmaMs > 0 ? inferenceEmaMs * 0.8 + bounded * 0.2 : bounded
    adaptiveInferenceIntervalMs = Math.max(
      MIN_INFERENCE_INTERVAL_MS,
      Math.min(MAX_INFERENCE_INTERVAL_MS, Math.max(minInterval, inferenceEmaMs * INFERENCE_COST_HEADROOM)),
    )
  }

  // 返回 false = 分割器失效，调用方转原帧直出。
  function runInference(now: number): boolean {
    inferenceRect = containedRect(video.videoWidth || width, video.videoHeight || height, INFERENCE_SIZE, INFERENCE_SIZE)
    // copy 模式顺带清底，黑边区不会留上一帧的掩膜。
    inferenceCtx.globalCompositeOperation = 'copy'
    inferenceCtx.fillStyle = '#000'
    inferenceCtx.fillRect(0, 0, INFERENCE_SIZE, INFERENCE_SIZE)
    inferenceCtx.globalCompositeOperation = 'source-over'
    inferenceCtx.drawImage(video, inferenceRect.x, inferenceRect.y, inferenceRect.width, inferenceRect.height)
    // segmentForVideo 要求时间戳严格递增。
    lastTs = Math.max(now, lastTs + 1)
    const startedAt = performance.now()
    const result = segmenter!.segmentForVideo(inferenceCanvas, lastTs)
    try {
      const mask = result.confidenceMasks?.[0]
      if (!mask) return false
      drawMask(mask, inferenceRect)
      hasMask = true
      recordInference(performance.now() - startedAt)
      return true
    } finally {
      result.close()
    }
  }

  const cbVideo = video as FrameCallbackHost

  function schedule() {
    if (!running) return
    if (typeof cbVideo.requestVideoFrameCallback === 'function') {
      rvfcId = cbVideo.requestVideoFrameCallback(() => tick())
    } else {
      rafId = requestAnimationFrame(() => tick())
    }
  }

  function tick() {
    if (!running) return
    schedule()
    const now = performance.now()
    const gap = now - diagLastTickAt
    if (gap > diagMaxGapMs) diagMaxGapMs = gap
    diagLastTickAt = now
    if (now - lastDraw < minInterval - 1) return
    lastDraw = now
    try {
      if (segmenting && now - lastInferenceAt >= adaptiveInferenceIntervalMs) {
        lastInferenceAt = now
        if (!runInference(now)) throw new Error('segmenter returned no mask')
      }
      compositeFrame()
      // 对齐三方：手动帧请求模式，显式生产一帧
      manualTrack.requestFrame?.()
      // 临时诊断：计数 + 每秒报告（带最大空档与可见性）
      diagFrameCount++
      if (now - diagLastReportAt >= diagReportIntervalMs) {
        const elapsed = now - diagLastReportAt
        const fps = (diagFrameCount * 1000 / elapsed).toFixed(1)
        console.info(`[vb-diag] 出帧率=${fps}fps 推理间隔=${adaptiveInferenceIntervalMs.toFixed(0)}ms segmenting=${segmenting} 最大空档=${diagMaxGapMs.toFixed(0)}ms 可见=${document.visibilityState}`)
        diagFrameCount = 0
        diagLastReportAt = now
      }
    } catch {
      if (segmenting) {
        // 运行中失效（GPU 上下文丢失等）：停止推理、释放分割器，转为原帧直出，
        // 轨道不冻结，原因如实上报给调用方。
        segmenting = false
        try { segmenter?.close() } catch { /* 已失效，忽略 */ }
        segmenter = null
        onDegrade('背景虚化处理中断，已按原始画面继续')
      }
    }
  }

  // 对齐三方兜底逻辑：即使源视频卡顿，也定时出帧保持轨道活跃。
  // 注意：兜底只 requestFrame()，不重新 compositeFrame()——
  // 不跑推理就合成会把旧掩膜配新画面，虚化不跟人走。
  let fallbackTimer = 0
  const fallbackInterval = Math.max(25, Math.min(100, Math.floor(minInterval / 2)))
  fallbackTimer = window.setInterval(() => {
    if (!running) return
    const now = performance.now()
    // 距上次出帧超过 500ms，强制出一帧（复用上次 canvas 内容）保持轨道活跃
    if (now - lastDraw >= 500) {
      lastDraw = now
      manualTrack.requestFrame?.()
    }
  }, fallbackInterval)

  schedule()

  function dispose() {
    running = false
    if (rvfcId && typeof cbVideo.cancelVideoFrameCallback === 'function') cbVideo.cancelVideoFrameCallback(rvfcId)
    if (rafId) cancelAnimationFrame(rafId)
    if (fallbackTimer) window.clearInterval(fallbackTimer)
    try { segmenter?.close() } catch { /* 可能已 close */ }
    segmenter = null
    track.stop()
    video.srcObject = null
    // 源轨道由本会话独吞消费，停掉它才算真正关掉采集管线。
    sourceTrack.stop()
    console.info('[vb] disposed')
  }

  return { track, dispose }
}

async function initSegmenter(video: HTMLVideoElement): Promise<ImageSegmenter> {
  blockUsageTelemetry()
  const wasm = await withTimeout(getWasmFileset(), INIT_STEP_TIMEOUT_MS, '分割模型')
  // GPU 推理快一个量级；但边端浏览器环境参差，任一种 delegate 失败或卡住就退到下一种，
  // 全部失败才由调用方降级。warmup 用真实首帧，能把"初始化成功但推理必炸"的假可用也筛掉。
  let lastError: unknown = null
  let lastTsForWarmup = 0
  for (const delegate of ['GPU', 'CPU'] as const) {
    let seg: ImageSegmenter | null = null
    try {
      seg = await withTimeout(
        ImageSegmenter.createFromOptions(wasm, {
          baseOptions: { modelAssetPath: MODEL_ASSET_PATH, delegate },
          runningMode: 'VIDEO',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        }),
        INIT_STEP_TIMEOUT_MS,
        `${delegate} 推理初始化`,
      )
      lastTsForWarmup = Math.max(performance.now(), lastTsForWarmup + 1)
      const warm = seg.segmentForVideo(video, lastTsForWarmup)
      warm.close()
      return seg
    } catch (e) {
      lastError = e
      try { seg?.close() } catch { /* 半成品实例，关掉即可 */ }
    }
  }
  throw lastError ?? new Error('no usable delegate')
}

function waitForFrame(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      video.removeEventListener('loadeddata', onLoaded)
      reject(new Error('first frame timeout'))
    }, 5000)
    const onLoaded = () => {
      window.clearTimeout(timer)
      resolve()
    }
    video.addEventListener('loadeddata', onLoaded, { once: true })
  })
}
