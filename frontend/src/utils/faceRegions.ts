// 人脸框的纯函数部分：不依赖 MediaPipe，便于 Node 直跑用例。
export interface FaceRegion {
  x: number
  y: number
  width: number
  height: number
  score: number
}

export interface RawFaceBox {
  originX: number
  originY: number
  width: number
  height: number
  score?: number
}

function clamp01(v: number): number {
  if (v !== v) return 0
  return Math.min(1, Math.max(0, v))
}

// 像素框 → 后端要的归一化框。
// 输出画布与源帧同尺寸（虚化不 letterbox），所以直接除以 videoWidth/Height。
export function normalizeRegions(boxes: RawFaceBox[], videoWidth: number, videoHeight: number): FaceRegion[] {
  if (!videoWidth || !videoHeight || !boxes.length) return []
  const out: FaceRegion[] = []
  for (const b of boxes) {
    const x = clamp01(b.originX / videoWidth)
    const y = clamp01(b.originY / videoHeight)
    const width = Math.min(clamp01(b.width / videoWidth), 1 - x)
    const height = Math.min(clamp01(b.height / videoHeight), 1 - y)
    if (width <= 0 || height <= 0) continue
    out.push({ x, y, width, height, score: clamp01(b.score ?? 1) })
  }
  return out
}
