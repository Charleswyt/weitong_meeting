/**
 * 录制排列的**几何唯一真源**：回放页的 DOM 与离线合成导出的 canvas 都必须消费这里算出的 rect。
 *
 * 为什么要有这一个文件：口径 ADR-0055 ① 定的是"导出所见 = 回放所见"，而两侧原本各算各的
 * （回放页 CSS + `engine.cols`，导出 `composeGrid` 里再乘一遍 cellW×cols）。一旦排列变成三档，
 * 两套算法必然分叉 —— 分叉的症状不是报错，而是"我看到的宫格和他拿到的文件不一样"，
 * 那种差异没人能一眼看出来。所以这里只允许一处构造。
 *
 * 三档的真实语义（口径见 `docs/录制导出-离线合成方案与口径.md` §9.1）：`grid` 无主画面（概览），`top`/`right` 都是"一路大画面 + 一圈缩略"，
 * 差别只在缩略条方位。屏幕共享看不清的解法是**主画面**（面积 7.1×），不是方位。
 *
 * 全文件不许出现 DOM：这是纯函数，`node scratch/verify-layout.ts` 直接跑真源。
 */

export type LayoutMode = 'grid' | 'top' | 'right'

export interface LayoutLane {
  id: string
  /** 只有带画面的路进格子；纯音轨行在界面下方"会议声音"面板里，不占宫格 */
  hasVideo: boolean
  kind?: 'camera' | 'screen' | 'microphone'
  /** 自动选主画面时用：多路共享屏幕取最长的那一路 */
  durationSec?: number
}

export interface LayoutCell {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** 该格是否主画面（grid 档恒为 false） */
  main: boolean
}

export interface LayoutInput {
  lanes: LayoutLane[]
  mode: LayoutMode
  /** 宫格档列数 1–6；缺省按路数自动算（见 autoCols） */
  cols?: number
  /** 宫格单格宽，默认 480（与实时合成路径同源） */
  cellWidth?: number
  /** top/right 档主画面宽，默认 1280 */
  mainWidth?: number
  /** top/right 档缩略格宽，默认 160 */
  thumbWidth?: number
  /** 用户指定的主画面；缺省时 screen 优先 */
  focusId?: string | null
}

export interface LayoutResult {
  mode: LayoutMode
  canvasWidth: number
  canvasHeight: number
  cells: LayoutCell[]
  /** grid 档为 null */
  mainId: string | null
  cols: number
  rows: number
  cellWidth: number
  cellHeight: number
  /** 缩略条用了哪一格的宽（降级后的真值），grid 档等于 cellWidth */
  thumbWidth: number
  thumbHeight: number
  /** 机器码，不是文案：界面按码取词，不许把警告原文上桌 */
  warnings: string[]
}

/** 缩略格降级阶梯：先牺牲缩略，最后才牺牲主画面（主画面是 top/right 存在的理由） */
const THUMB_LADDER = [160, 128, 112, 96]
const CELL_LADDER = [480, 426, 384, 320, 256]
const MAIN_LADDER = [1280, 1024, 854, 640]
/** 右侧条一格的最小可接受宽度：比这还小就看不清了，此时改用两列（阶梯末档同值） */
const SIDE_THUMB_MIN = THUMB_LADDER[THUMB_LADDER.length - 1]!
/** 右侧条的宽度上限 = 主画面宽 ÷ 这个比值；再宽就是侧条在抢主画面的地方 */
const SIDE_THUMB_DIVISOR = 3

/** H.264 4:2:0 不接受奇数维；一律取偶，且不小于 2 */
function even(v: number): number {
  return Math.max(2, Math.round(v / 2) * 2)
}

/** 向下取偶：算预算时用（`even` 会四舍五入到上一格，把"不超过主画面高"这条判据弄假） */
function evenFloor(v: number): number {
  return Math.max(2, Math.floor(v / 2) * 2)
}

function fromWidth(w: number): { w: number; h: number } {
  const ww = even(w)
  return { w: ww, h: even((ww * 9) / 16) }
}

/**
 * 默认列数 = clamp(⌈√路数⌉, 1, 6)（口径正本 §4）。
 * 上限 6 合理但默认必须自动：列数不改编码量只改形状，而在 16:9 屏上画布越扁每格越小，
 * "路多就加列"是把体验治反了 —— 默认要接近正方形。
 */
export function autoCols(videoLaneCount: number): number {
  return Math.max(1, Math.min(6, Math.ceil(Math.sqrt(Math.max(0, videoLaneCount)))))
}

function videoIds(lanes: LayoutLane[]): LayoutLane[] {
  return lanes.filter((l) => l.hasVideo)
}

/**
 * 主画面归属：用户指定 > 共享屏幕（多路取时长最长）> 第一路画面。
 * 取"第一路 screen"而不是"第一路画面"是关键 —— 默认那一路往往是先入会那个人的镜头，
 * 而这三档要救的正是共享屏幕看不清。
 */
function pickMainLane(video: LayoutLane[], focusId?: string | null): { id: string | null; warnings: string[] } {
  const warnings: string[] = []
  if (focusId) {
    const hit = video.find((l) => l.id === focusId)
    if (hit) return { id: hit.id, warnings }
    warnings.push('focus_not_video')
  }
  const screens = video.filter((l) => l.kind === 'screen')
  if (screens.length) {
    const longest = screens.reduce((a, b) => ((b.durationSec ?? 0) > (a.durationSec ?? 0) ? b : a), screens[0]!)
    return { id: longest.id, warnings }
  }
  return { id: video[0]?.id ?? null, warnings }
}

function emptyResult(mode: LayoutMode, warnings: string[]): LayoutResult {
  const c = fromWidth(480)
  return {
    mode,
    canvasWidth: c.w,
    canvasHeight: c.h,
    cells: [],
    mainId: null,
    cols: 0,
    rows: 0,
    cellWidth: c.w,
    cellHeight: c.h,
    thumbWidth: c.w,
    thumbHeight: c.h,
    warnings,
  }
}

/**
 * 右侧档缩略条的几何：这些路能不能**在不超过主画面高度的前提下**排进**一列**。
 * 排得下就用一列，并把格子放大到那个高度预算允许的最大值；排不下才退回两列、用阶梯默认格。
 *
 * 为什么预算钉在"主画面高"：画布一旦比主画面还高，舞台要按画布宽高比夹宽
 * （回放页 `stageStyle` 那句 `maxWidth = ratio × 52vh`），于是整块画面连同主画面一起缩小 ——
 * 那正是 §9.1 第 4 条「主画面最后才被动」要挡的事。（2026-10-11 用户："右侧排列时缩略图总是两列、太小"。）
 *
 * `explicitThumbWidth` 是降级阶梯给的：给了就照它算列数、**不再放大** ——
 * 阶梯的每一档必须是可复现的确切形状，否则 `fitLayout` 拿基线与候选一比就虚报"已降低单格尺寸"。
 */
function fitSideStrip(others: number, main: { w: number; h: number }, explicitThumbWidth?: number): { cols: number; thumbWidth: number } {
  if (explicitThumbWidth !== undefined) {
    const t = fromWidth(even(explicitThumbWidth))
    return { cols: others * t.h <= main.h ? 1 : 2, thumbWidth: t.w }
  }
  const minThumb = fromWidth(SIDE_THUMB_MIN)
  if (others * minThumb.h > main.h) return { cols: 2, thumbWidth: THUMB_LADDER[0]! }
  // 两次都向下取偶：先算每格可用的最大高度，再由它推宽度，`others × 格高 ≤ 主画面高` 才立得住
  const heightBudget = evenFloor(main.h / others)
  const cap = evenFloor(main.w / SIDE_THUMB_DIVISOR)
  return { cols: 1, thumbWidth: Math.min(cap, evenFloor((heightBudget * 16) / 9)) }
}

export function buildLayout(input: LayoutInput): LayoutResult {
  const video = videoIds(input.lanes)
  const warnings: string[] = []
  if (!video.length) {
    return emptyResult(input.mode, [...warnings, 'no_video_lane'])
  }

  if (input.mode === 'grid') {
    const cols = Math.max(1, Math.min(6, input.cols ?? autoCols(video.length)))
    const cell = fromWidth(input.cellWidth ?? CELL_LADDER[0]!)
    const rows = Math.ceil(video.length / cols)
    const cells: LayoutCell[] = video.map((l, i) => ({
      id: l.id,
      x: (i % cols) * cell.w,
      y: Math.floor(i / cols) * cell.h,
      w: cell.w,
      h: cell.h,
      main: false,
    }))
    return {
      mode: 'grid',
      canvasWidth: even(cols * cell.w),
      canvasHeight: even(rows * cell.h),
      cells,
      mainId: null,
      cols,
      rows,
      cellWidth: cell.w,
      cellHeight: cell.h,
      thumbWidth: cell.w,
      thumbHeight: cell.h,
      warnings,
    }
  }

  const main = pickMainLane(video, input.focusId)
  warnings.push(...main.warnings)
  const mainCell = fromWidth(input.mainWidth ?? MAIN_LADDER[0]!)
  const others = video.filter((l) => l.id !== main.id)

  if (!others.length) {
    // 只剩主画面一路：两档都退化成"就一格"，不必硬塞一条空缩略带
    return {
      mode: input.mode,
      canvasWidth: mainCell.w,
      canvasHeight: mainCell.h,
      cells: [{ id: main.id!, x: 0, y: 0, w: mainCell.w, h: mainCell.h, main: true }],
      mainId: main.id,
      cols: 1,
      rows: 1,
      cellWidth: mainCell.w,
      cellHeight: mainCell.h,
      thumbWidth: 0,
      thumbHeight: 0,
      warnings: [...warnings, 'single_lane_no_strip'],
    }
  }

  const thumbW = even(input.thumbWidth ?? THUMB_LADDER[0]!)
  const thumb = fromWidth(thumbW)

  if (input.mode === 'top') {
    // 一行放得下就一行；放不下就**加行**，绝不翻页（导出件没有"下一页"这个概念）
    const perRow = Math.max(1, Math.floor(mainCell.w / thumb.w))
    const stripRows = Math.ceil(others.length / perRow)
    const stripHeight = even(stripRows * thumb.h)
    const cells: LayoutCell[] = [
      { id: main.id!, x: 0, y: stripHeight, w: mainCell.w, h: mainCell.h, main: true },
    ]
    others.forEach((l, i) => {
      cells.push({
        id: l.id,
        x: (i % perRow) * thumb.w,
        y: Math.floor(i / perRow) * thumb.h,
        w: thumb.w,
        h: thumb.h,
        main: false,
      })
    })
    return {
      mode: 'top',
      canvasWidth: mainCell.w,
      canvasHeight: even(stripHeight + mainCell.h),
      cells,
      mainId: main.id,
      cols: perRow,
      rows: stripRows + Math.ceil(mainCell.h / thumb.h),
      cellWidth: mainCell.w,
      cellHeight: mainCell.h,
      thumbWidth: thumb.w,
      thumbHeight: thumb.h,
      warnings,
    }
  }

  // right：缩略条竖排在主画面右侧。**一列放得下就用一列并把格子放大**，放不下才两列（见 fitSideStrip）；
  // 两种情况下超出预算都继续加行、画布变高，同样不翻页
  const side = fitSideStrip(others.length, mainCell, input.thumbWidth)
  const sideThumb = fromWidth(side.thumbWidth)
  const stripRows = Math.ceil(others.length / side.cols)
  const sideWidth = even(side.cols * sideThumb.w)
  const canvasHeight = even(Math.max(mainCell.h, stripRows * sideThumb.h))
  const cells: LayoutCell[] = [
    { id: main.id!, x: 0, y: 0, w: mainCell.w, h: mainCell.h, main: true },
  ]
  others.forEach((l, i) => {
    cells.push({
      id: l.id,
      x: mainCell.w + (i % side.cols) * sideThumb.w,
      y: Math.floor(i / side.cols) * sideThumb.h,
      w: sideThumb.w,
      h: sideThumb.h,
      main: false,
    })
  })
  return {
    mode: 'right',
    canvasWidth: even(mainCell.w + sideWidth),
    canvasHeight,
    cells,
    mainId: main.id,
    cols: side.cols,
    rows: stripRows,
    cellWidth: mainCell.w,
    cellHeight: mainCell.h,
    thumbWidth: sideThumb.w,
    thumbHeight: sideThumb.h,
    warnings,
  }
}

/**
 * 撞编码器上限时的降级（口径 §9.2 护栏 b）：缩略格 → 宫格单格 → 主画面，按这个顺序试，取第一个装得下的。
 * 返回的一定是可用布局：全阶梯都装不下时给最小的一档并标 `exceeds_encoder_limit`，
 * 由调用方决定是提示减路还是分段 —— 不是报错，也不是悄悄超限开跑。
 */
export function fitLayout(
  input: LayoutInput,
  maxPixels: number,
): { layout: LayoutResult; degraded: boolean } {
  const video = videoIds(input.lanes)
  if (!video.length) return { layout: buildLayout(input), degraded: false }
  // 基线取"按默认参数算出来的那一版"，比较的是**落地的尺寸**而不是入参：
  // 调用方通常不给 thumbWidth/mainWidth（它们是可选的），拿 `cand.thumbWidth !== input.thumbWidth`
  // 判降级会让 top/right 每一次都虚报"为控制体积已降低单格尺寸" —— 实测就是这么虚报的。
  const base = buildLayout(input)
  const isDegraded = (l: LayoutResult) =>
    l.cellWidth !== base.cellWidth || l.cellHeight !== base.cellHeight
    || l.thumbWidth !== base.thumbWidth || l.thumbHeight !== base.thumbHeight

  const candidates: LayoutInput[] = []
  if (input.mode === 'grid') {
    for (const cellWidth of CELL_LADDER) candidates.push({ ...input, cellWidth })
  } else {
    // 先试**默认形状本身**（right 档那是不给 thumbWidth 时的自适应结果），再按阶梯降。
    // 少了这一条，自适应基线（比如 320）与阶梯第一档（160）一比就 `degraded=true`，
    // 上限明明够用却报"为控制体积已降低单格尺寸" —— 这个虚报法 `scratch/verify-layout.ts` 钉着。
    // grid 那侧不用补：阶梯首档 480 就是默认值，候选[0] 已经等于基线。
    candidates.push(input)
    for (const thumbWidth of THUMB_LADDER) candidates.push({ ...input, thumbWidth })
    for (const thumbWidth of THUMB_LADDER) {
      for (const mainWidth of MAIN_LADDER.slice(1)) candidates.push({ ...input, mainWidth, thumbWidth })
    }
  }

  for (const cand of candidates) {
    const layout = buildLayout(cand)
    if (layout.canvasWidth * layout.canvasHeight <= maxPixels) {
      return { layout, degraded: isDegraded(layout) }
    }
  }
  const smallest = buildLayout(candidates[candidates.length - 1]!)
  return {
    layout: { ...smallest, warnings: [...smallest.warnings, 'exceeds_encoder_limit'] },
    degraded: true,
  }
}
