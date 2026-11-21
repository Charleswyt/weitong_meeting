/**
 * composeLayout 的真源用例（不复制副本，直接 import src/）。
 * 跑法：node scratch/verify-layout.ts
 *
 * 为什么有第 42 行那条"跑够 30 条"的下限断言：本仓已经被"判据自己坏了却报 0 命中"
 * 咬过两次（第 38 项），所以一个扫描型用例必须先自证它在跑。
 */
import { buildLayout, fitLayout, autoCols, type LayoutLane, type LayoutResult } from '../src/utils/composeLayout.ts'
import { estimateCanvas } from '../src/utils/offlineCompose/engine.ts'

let ran = 0
const fails: string[] = []

function ok(name: string, cond: boolean, detail = ''): void {
  ran++
  if (!cond) fails.push(`${name}${detail ? ' — ' + detail : ''}`)
}

function eq(name: string, got: unknown, want: unknown): void {
  ok(name, got === want, `got=${String(got)} want=${String(want)}`)
}

function lanes(n: number, opts: { screenAt?: number[]; durations?: Record<number, number> } = {}): LayoutLane[] {
  const screenAt = new Set(opts.screenAt ?? [])
  return Array.from({ length: n }, (_, i) => ({
    id: `L${i}`,
    hasVideo: true,
    kind: screenAt.has(i) ? 'screen' : 'camera',
    durationSec: opts.durations?.[i],
  }))
}

/** 三条全档通用的不变式 */
function invariants(label: string, r: LayoutResult, videoCount: number): void {
  eq(`${label}: 格子数=进画面的路数`, r.cells.length, videoCount)
  ok(`${label}: 尺寸全为偶数`, [r.canvasWidth, r.canvasHeight, ...r.cells.flatMap((c) => [c.w, c.h, c.x, c.y])].every((v) => v % 2 === 0))
  ok(
    `${label}: 不越界`,
    r.cells.every((c) => c.x >= 0 && c.y >= 0 && c.x + c.w <= r.canvasWidth && c.y + c.h <= r.canvasHeight),
  )
  // 重叠是最贵的一类：导出件上两格叠在一起不会报错，只会让其中一个人永远看不见
  const overlap = r.cells.some((a, i) =>
    r.cells.slice(i + 1).some((b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h),
  )
  ok(`${label}: 任意两格不重叠`, !overlap)
  const mains = r.cells.filter((c) => c.main)
  if (r.mode === 'grid') eq(`${label}: 宫格无主画面`, mains.length, 0)
  else eq(`${label}: 主画面恰一个`, mains.length, 1)
  if (r.mainId) eq(`${label}: mainId 与格子标记一致`, mains.find((c) => c.id === r.mainId)?.main, true)
}

// —— 宫格 ——
const g9 = buildLayout({ lanes: lanes(9), mode: 'grid' })
invariants('宫格9路', g9, 9)
eq('宫格9路默认列数', g9.cols, 3)
eq('宫格9路画布宽', g9.canvasWidth, 1440)
eq('宫格9路画布高', g9.canvasHeight, 810)
eq('单格高（16:9 取偶）', g9.cellHeight, 270)
const g1 = buildLayout({ lanes: lanes(1), mode: 'grid' })
eq('单路宫格 1 列', g1.cols, 1)
eq('自动列数 16 路→4', autoCols(16), 4)
eq('自动列数 25 路→5', autoCols(25), 5)
eq('自动列数 36 路→6', autoCols(36), 6)
eq('自动列数 100 路仍封顶 6', autoCols(100), 6)

// —— 顶部：主画面归属 ——
const t9 = buildLayout({ lanes: lanes(9, { screenAt: [4, 7], durations: { 4: 200, 7: 640 } }), mode: 'top' })
invariants('顶部9路', t9, 9)
eq('顶部9路默认主画面=最长那一路共享屏幕', t9.mainId, 'L7')
eq('顶部9路主画面宽', t9.cells.find((c) => c.main)?.w, 1280)
eq('顶部9路主画面面积是宫格单格的 7.1×', Math.round((1280 * 720) / (480 * 270) * 10) / 10, 7.1)
eq('顶部9路缩略一格宽', t9.thumbWidth, 160)
const tFocus = buildLayout({ lanes: lanes(9, { screenAt: [4] }), mode: 'top', focusId: 'L0' })
eq('用户指定的主画面优先于 screen', tFocus.mainId, 'L0')
const tBad = buildLayout({
  lanes: [{ id: 'A', hasVideo: false, kind: 'microphone' }, ...lanes(4)],
  mode: 'top',
  focusId: 'A',
})
ok('focus 指向非画面路要留机器码', tBad.warnings.includes('focus_not_video'))
eq('focus 无效时回落自动归属', tBad.mainId, 'L0')
invariants('顶部focus无效', tBad, 4)

// —— 超容量：降格/加行，绝不翻页 ——
const t17 = buildLayout({ lanes: lanes(17), mode: 'top' })
invariants('顶部17路', t17, 17)
ok('17 路一行放不下要靠加行（不是分页）', t17.canvasHeight > 720 + 90)
eq('布局结果里没有"页"这个概念', (t17 as Record<string, unknown>).page, undefined)

// —— 右侧 ——
const r9 = buildLayout({ lanes: lanes(9, { screenAt: [2] }), mode: 'right' })
invariants('右侧9路', r9, 9)
eq('右侧9路主画面=L2 的共享屏幕', r9.mainId, 'L2')
/* 这两条钉的是**旧行为**："右侧条恒两列、恒 160 宽"（`canvasWidth = 1280 + 2×160`、`cols = 2`）。
   2026-10-11 用户判它"缩略图太小"，规则改成"一列在主画面高度预算内放得下就用一列并放大格子"。
   其余 8 路按新判据仍是一列 160（预算刚好），所以画布比旧值窄一格的 160 —— 不是算错，是侧条让掉的。
   新判据的两侧都有下面的用例钉着，改回固定两列会当场红。 */
eq('右侧9路画布宽 = 主画面 + 一列缩略', r9.canvasWidth, 1280 + 160)
eq('右侧9路缩略列数', r9.cols, 1)

// —— 右侧条自适应（fitSideStrip）：一列放得下就放大格子，放不下才两列 ——
{
  const sideOf = (videoLanes: number) =>
    buildLayout({ lanes: lanes(videoLanes, { screenAt: [0] }), mode: 'right' })
  // 其余 4 路（共 5 路）：720 ÷ 4 = 180 高预算 → 320 宽，是旧值 160 的两倍
  const r5 = sideOf(5)
  eq('其余4路 → 一列', r5.cols, 1)
  eq('其余4路缩略格放大到高度预算允许的最大（320）', r5.thumbWidth, 320)
  eq('其余4路侧条总高不超主画面高', r5.rows * r5.thumbHeight <= 720, true)
  eq('其余4路画布宽 = 主画面 + 一列320', r5.canvasWidth, 1600)
  // 其余 2 路：预算再大也 capped 在主画面宽的 1/3（426），侧条不能反过来抢主画面
  const r3 = sideOf(3)
  eq('其余2路 → 一列且触上限 426', `${r3.cols}:${r3.thumbWidth}`, '1:426')
  // 判据两侧：13 路还能挤进一列（13×54=702 ≤ 720），14 路开始挤不下（756 > 720）→ 两列
  const r14 = sideOf(14)
  eq('其余13路仍是一列（贴着最小可接受格 96）', `${r14.cols}:${r14.thumbWidth}`, '1:96')
  const r15 = sideOf(15)
  eq('其余14路 → 回落两列', `${r15.cols}:${r15.thumbWidth}`, '2:160')
  eq('回落两列时画布与旧行为同宽（不比现在更小）', r15.canvasWidth, 1280 + 320)
  // 降级阶梯给的宽度**不被放大**：否则 fitLayout 的候选与基线一比就虚报"已降低单格尺寸"
  const explicit = buildLayout({ lanes: lanes(5, { screenAt: [0] }), mode: 'right', thumbWidth: 160 })
  eq('显式给 thumbWidth 时照它算列数、不放大', `${explicit.cols}:${explicit.thumbWidth}`, '1:160')
}

// —— 退化形状 ——
const single = buildLayout({ lanes: lanes(1), mode: 'right' })
invariants('右侧单路', single, 1)
ok('只剩一路时不硬塞空缩略带', single.warnings.includes('single_lane_no_strip'))
const noVideo = buildLayout({ lanes: [{ id: 'A', hasVideo: false, kind: 'microphone' }], mode: 'grid' })
ok('没有画面路要留机器码', noVideo.warnings.includes('no_video_lane'))
eq('没有画面路时零格', noVideo.cells.length, 0)

// —— 编码器上限降级（§八之五 b：先牺牲缩略，最后才牺牲主画面）——
const big36 = buildLayout({ lanes: lanes(36), mode: 'grid' })
eq('36 路宫格 6×6 画布', big36.canvasWidth * big36.canvasHeight, 2880 * 1620)
const fit36 = fitLayout({ lanes: lanes(36), mode: 'grid' }, 4_000_000)
ok('超上限时降级而不是报错', fit36.degraded)
eq('降级后格子数不变', fit36.layout.cells.length, 36)
ok('降级后面积装得下', fit36.layout.canvasWidth * fit36.layout.canvasHeight <= 4_000_000)
invariants('降级后36路', fit36.layout, 36)

const tightMain = fitLayout({ lanes: lanes(9, { screenAt: [4] }), mode: 'top' }, 1_000_001)
invariants('顶部强压面积', tightMain.layout, 9)
ok(
  '主画面是最后才被动的那一个',
  tightMain.layout.cellWidth === 1280 ? tightMain.layout.thumbWidth < 160 : tightMain.layout.cellWidth < 1280,
  `main=${tightMain.layout.cellWidth} thumb=${tightMain.layout.thumbWidth}`,
)
const hopeless = fitLayout({ lanes: lanes(36), mode: 'grid' }, 10)
ok('阶梯用尽仍超限要如实标记', hopeless.layout.warnings.includes('exceeds_encoder_limit'))

// —— 全档位扫一遍不变式（1–24 路 × 三档）——
for (let n = 1; n <= 24; n++) {
  for (const mode of ['grid', 'top', 'right'] as const) {
    const r = buildLayout({ lanes: lanes(n, { screenAt: n > 3 ? [2] : [] }), mode })
    invariants(`${mode}-${n}路`, r, n)
  }
}

/**
 * 第二处几何必须问 `composeLayout`（口径 §9.1）。
 * `estimateCanvas` 是成本模型/护栏 (b) 用的画布尺寸来源，从前它自己按"grid 的保守形状"算一套，
 * 注释还写着"主画面档的画布只会更小或相当"—— 实测**正好相反**：四路时 top 档是 1280×810，
 * 而它估的是 960×540，差出一倍。所以这里双向钉：既钉"等于 buildLayout"，也钉"旧算法给的是另一个数"。
 */
const specOf = (mode: 'grid' | 'top' | 'right', focusId: string | null = null, cols?: number) => ({
  lanes: ['a', 'b', 'c', 'd'].map((id) => ({
    id, label: id, hasVideo: true, hasAudio: false,
    containers: [{ startSec: 0, endSec: 60, slices: [], totalBytes: 1 }],
  })),
  mode, cols, focusId, fpsOut: 15,
}) as unknown as Parameters<typeof estimateCanvas>[0]
const lanesOf = (spec: ReturnType<typeof specOf>) => spec.lanes.map((l) => ({
  id: l.id, hasVideo: true, durationSec: 60,
}))
for (const mode of ['grid', 'top', 'right'] as const) {
  const spec = specOf(mode, mode === 'grid' ? null : 'c')
  const est = estimateCanvas(spec)
  const real = buildLayout({ lanes: lanesOf(spec), mode, cols: spec.cols, focusId: spec.focusId })
  eq(`${mode} 档：成本模型用的画布 === 导出件的画布`, `${est.canvasWidth}x${est.canvasHeight}`, `${real.canvasWidth}x${real.canvasHeight}`)
}
const topEst = estimateCanvas(specOf('top', 'c'))
const gridCols2 = buildLayout({ lanes: lanesOf(specOf('grid')), mode: 'grid', cols: 2 })
ok('top 档画布比"按 grid 保守估"更大（旧注释那句"只会更小或相当"是假的）',
  topEst.canvasWidth * topEst.canvasHeight > gridCols2.canvasWidth * gridCols2.canvasHeight,
  `top=${topEst.canvasWidth}x${topEst.canvasHeight} grid2=${gridCols2.canvasWidth}x${gridCols2.canvasHeight}`)
// 旧算法对 4 路 cols=2 的估算值，钉住它是为了"改回去就红"
ok('旧算法给的是另一个数（960x540），别再用它当主画面档的预算',
  !(topEst.canvasWidth === 960 && topEst.canvasHeight === 540))
const audioOnly = estimateCanvas({ lanes: [], mode: 'top' } as unknown as Parameters<typeof estimateCanvas>[0])
ok('没有画面路时给 0 而不是抛', audioOnly.canvasWidth === 0 && audioOnly.canvasHeight === 0)

/**
 * `fitLayout` 的 `degraded` 不许虚报（实测虚报过一次）：调用方一般不给 thumbWidth/mainWidth，
 * 拿"候选值 !== 入参"判降级会让 top/right **每一次**都报"为控制体积已降低单格尺寸"。
 * 双向钉：默认参数 + 够用的上限必须 false；上限真的不够时必须 true。
 */
const fourLanes: LayoutLane[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, hasVideo: true, kind: 'camera', durationSec: 60 }))
for (const mode of ['top', 'right'] as const) {
  const big = fitLayout({ lanes: fourLanes, mode }, 1 << 30)
  eq(`${mode} 档默认参数、上限够用时不该报降级`, big.degraded, false)
  const base = buildLayout({ lanes: fourLanes, mode })
  const px = base.canvasWidth * base.canvasHeight
  const tight = fitLayout({ lanes: fourLanes, mode }, px - 1)
  ok(`${mode} 档上限真的不够时必须报降级`, tight.degraded === true, `degraded=${String(tight.degraded)}`)
  ok(`${mode} 档降级之后画布确实变小`, tight.layout.canvasWidth * tight.layout.canvasHeight < px,
    `${tight.layout.canvasWidth}x${tight.layout.canvasHeight} vs ${base.canvasWidth}x${base.canvasHeight}`)
}
const gridTight = fitLayout({ lanes: fourLanes, mode: 'grid', cellWidth: 480 }, 480 * 270 * 4 - 1)
ok('grid 档同理：默认够用不报、真紧才报',
  fitLayout({ lanes: fourLanes, mode: 'grid' }, 1 << 30).degraded === false && gridTight.degraded === true)

if (ran < 30) {
  console.error(`布局用例自证失败：只跑了 ${ran} 条断言，判据没生效`)
  process.exit(2)
}
if (fails.length) {
  console.error(`✗ ${fails.length} 条失败（共 ${ran} 条）:`)
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log(`✓ composeLayout 全绿：${ran} 条断言`)
