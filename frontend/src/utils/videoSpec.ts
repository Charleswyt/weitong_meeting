// 视频规格归一的**唯一实现**：发布与界面显示必须吃同一份。
//
// 为什么单独一个文件：这三条常量与那个函数原先埋在 `composables/useWhipPublish.ts` 里，
// 而 `InMeetingView` 要显示「本端这一格的分辨率/帧率」时只能拿 `track.getSettings()` 的
// **采集**规格 —— 于是同一格里「原始速率」描述的是发布出去的那条流（已归一），
// 「分辨率」却描述采集侧（未归一）：摄像头给 2561×1601@30 时显示 2561×1601，
// 而实际发出去的是 1920×1080@25。两个数指的不是同一条流，这属于口径错位，不是显示偏好。
//
// 三方只接受固定档位（其 meeting.html 的分辨率/帧率下拉），裸 `getSettings()` 会报出整屏
// DPI 缩放后的非标值（实测 2561×1601@30）并被 `bad_publication_video_spec` 拒。
//
// 纯函数、零依赖，可在 Node 里直跑：`scratch/verify-video-spec.ts`。

/** 三方接受的两种分辨率档（按从大到小排列，取第一个"装得下采集尺寸"的）。 */
export const ALLOWED_RES: ReadonlyArray<readonly [number, number]> = [[1920, 1080], [1280, 720]]

/** 三方接受的帧率档（≤25）。 */
export const ALLOWED_FPS: readonly number[] = [10, 15, 20, 25]

export interface VideoSpec {
  width: number
  height: number
  fps: number
}

/**
 * 把采集规格归一成发布规格。
 *
 * 边界口径（原样保留，不在本轮改动）：
 * - 采集尺寸**小于最小档**时落到 1280×720 —— 三方没有更小的档，这是"报一个它能接受的档"，
 *   不是"真的按 1280×720 发"；采集端仍按自己的尺寸送帧，编码器再按参数缩放。
 * - `w`/`h` 为 0（拿不到 settings）时不猜档位，只把帧率夹到 ≤25。
 * - 帧率取**不小于采集帧率的最小档**（30 → 25、24 → 25、18 → 20），不往下取。
 */
export function normalizeVideoSpec(w: number, h: number, fps: number): VideoSpec {
  if (!w || !h) return { width: w, height: h, fps: Math.min(Math.round(fps) || 0, 25) }
  let width = ALLOWED_RES[ALLOWED_RES.length - 1][0]
  let height = ALLOWED_RES[ALLOWED_RES.length - 1][1]
  for (const [aw, ah] of ALLOWED_RES) {
    if (w >= aw && h >= ah) {
      width = aw
      height = ah
      break
    }
  }
  const f = Math.round(fps) || ALLOWED_FPS[0]
  let rate = ALLOWED_FPS[ALLOWED_FPS.length - 1]
  for (const a of ALLOWED_FPS) {
    if (f <= a) {
      rate = a
      break
    }
  }
  return { width, height, fps: rate }
}
