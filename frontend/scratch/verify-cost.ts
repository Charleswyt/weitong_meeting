/**
 * 成本模型与选引擎判据的真源用例（node scratch/verify-cost.ts）。
 *
 * 这些数字就是 §八之二 v8 那张表的可执行版本 —— 表里任何一格改了，这里必须一起改，
 * 否则文档与判据又会各说各话（本仓已经栽过两次）。
 * 常数来源：2026-10-08 S2 探针（真件、hidden 页），`MEASURED_THROUGHPUT` 里 calibrated=false。
 */
import {
  estimateCost,
  pickEngine,
  planDiskGuard,
  MEASURED_THROUGHPUT,
  type CostInput,
  type CostLane,
} from '../src/utils/offlineCompose/costModel.ts'
import { buildLayout } from '../src/utils/composeLayout.ts'

let ran = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = ''): void {
  ran++
  if (!cond) fails.push(`${name}${detail ? ' — ' + detail : ''}`)
}
function eq(name: string, got: unknown, want: unknown): void {
  ok(name, got === want, `got=${String(got)} want=${String(want)}`)
}

const TP = { ...MEASURED_THROUGHPUT, calibrated: true }
const SEC = 960 // 16 分钟

function lanesOf(n: number, w: number, h: number, fps: number): CostLane[] {
  return Array.from({ length: n }, (_, i) => ({ id: `L${i}`, hasVideo: true, width: w, height: h, frameRate: fps }))
}
function input(n: number, w: number, h: number, fpsSrc: number, durationSec = SEC, fpsOut = 15, cols?: number): CostInput {
  const lanes = lanesOf(n, w, h, fpsSrc)
  return { lanes, videoLaneIds: lanes.map((l) => l.id), durationSec, layout: buildLayout({ lanes, mode: 'grid', cols }), fpsOut }
}
const CAPS = { offlineCapable: true }

// —— 1. 模型形状：解码按**帧**算，与源像素无关 ——
const e720 = estimateCost(input(9, 1280, 720, 15), TP)
const eSmall = estimateCost(input(9, 602, 360, 15), TP)
eq('720p 与 602×360 的解码需求相同（都是按帧）', e720.decodeFrames, eSmall.decodeFrames)
eq('720p 与 602×360 的离线墙钟也相同', e720.estDecodeSec, eSmall.estDecodeSec)
eq('9 路 ×15fps × 16 分钟 = 129600 帧', e720.decodeFrames, 129600)
eq('实时需要的聚合解码 = Σ 每路帧率', e720.realtimeRequiredDecodeFps, 135)
eq('负载比 = 135 / 320', e720.decodeLoadRatio, 0.422)
eq('这一档实时喂得过来', e720.realtimeWouldDropFrames, false)
eq('离线解码墙钟 = 129600 / 320 ≈ 405 秒', e720.estDecodeSec, 405)
eq('编码墙钟受每帧上限约束（1440×810 → 100fps）', e720.estEncodeSec, 144)
eq('墙钟取较大的那一端', e720.estOfflineSec, 405)
eq('离线/时长 ≈0.42', Math.round(e720.offlineOverDuration * 100) / 100, 0.42)
eq('选离线', pickEngine(input(9, 1280, 720, 15), TP, CAPS).engine, 'offline')

// —— 2. 源帧率是唯一能砍解码量的自变量 ——
const e10 = estimateCost(input(9, 1280, 720, 10), TP)
const e25 = estimateCost(input(9, 1280, 720, 25), TP)
ok('源 10fps 比 25fps 便宜 2.5 倍', Math.abs(e10.estOfflineSec * 2.5 - e25.estOfflineSec) <= 2)
eq('10fps×9 路 ≈270 秒', e10.estOfflineSec, 270)
eq('输出帧率从 15 降到 10 省不了解码', estimateCost(input(9, 1280, 720, 25, SEC, 10), TP).decodeFrames, e25.decodeFrames)

// —— 3. 编码：小画布撞每帧上限封顶（像素线性会在这里给出离谱的乐观值）——
const tiny = estimateCost({ ...input(1, 1280, 720, 15, SEC, 150), layout: { canvasWidth: 480, canvasHeight: 270 } }, TP)
eq('小画布也被 177fps 封顶', tiny.encodeFps, 177)
eq('2 小时内容 150fps 输出 = 108000 帧', tiny.encodeFrames, 150 * SEC)
const big = estimateCost({ ...input(1, 1280, 720, 15), layout: { canvasWidth: 3840, canvasHeight: 2160 } }, TP)
ok('4K 画布时编码反超解码成为瓶颈', big.estEncodeSec > big.estDecodeSec)
eq('墙钟跟着取编码那一端', big.estOfflineSec, big.estEncodeSec)
ok('同帧数下画布越大越慢', big.estEncodeSec > e720.estEncodeSec)

// —— 4. 实时喂不过来 ⇒ 只能离线（我原来算错的那一格）——
// 25 路 1080p@25：实时需要聚合 625 fps，实测并发只有 320 ⇒ 实时会静默丢一半内容，
// 拿"实时 16 分钟"当基线是错的。
const starved = input(25, 1920, 1080, 25, SEC, 15, 5)
const e4 = estimateCost(starved, TP)
eq('需要的聚合解码 = 625 fps', e4.realtimeRequiredDecodeFps, 625)
ok('判成"实时会丢内容"', e4.realtimeWouldDropFrames)
eq('离线墙钟 ≈1875 秒（31 分钟）', e4.estOfflineSec, 1875)
const c4 = pickEngine(starved, TP, CAPS)
eq('即便比实时慢也选离线', c4.engine, 'offline')
ok('理由带着"实时饿死"', c4.reasons.includes('realtime_decode_starved'))
// 预算 = min(2×时长, 45 分钟) = 1920，上面那格 1875 还在预算内；把时长拉到 30 分钟才既饿死又超预算
const starvedLong = input(25, 1920, 1080, 25, 1800, 15, 5)
const c4b = pickEngine(starvedLong, TP, CAPS)
eq('30 分钟 25 路：离线 3516 秒，超 2700 秒预算', c4b.estimate.estOfflineSec, 3516)
eq('但实时已经喂不过来，仍然只能离线', c4b.engine, 'offline')
ok('如实承认超预算但说明没有第二条路', c4b.reasons.includes('offline_over_budget_but_realtime_broken'))

// 边界：恰好卡在 0.8 余量内外
const edgeOk = estimateCost(input(17, 1280, 720, 15, SEC), TP) // 255 fps 需求 < 256
const edgeBad = estimateCost(input(18, 1280, 720, 15, SEC), TP) // 270 > 256
eq('17 路 720p15 仍在实时可用区内', edgeOk.realtimeWouldDropFrames, false)
eq('18 路起实时开始丢内容', edgeBad.realtimeWouldDropFrames, true)

// —— 5. 预算闸门：超预算**也不**退回前台陪放（2026-10-09 默认引擎翻到离线）——
const long = input(9, 1920, 1080, 15, 7200)
const e5 = estimateCost(long, TP)
ok('两小时长会实时仍可行', !e5.realtimeWouldDropFrames)
ok(`离线预计 ${e5.estOfflineSec}s 超 45 分钟预算`, e5.estOfflineSec > 45 * 60)
const c5 = pickEngine(long, TP, CAPS)
eq('超预算仍走离线：实时喂不过来产的是"缺内容的完整文件"，不能当兜底', c5.engine, 'offline')
ok('理由是超预算', c5.reasons.includes('offline_over_budget'))
eq('未标定也不再退回实时（§9.3 标定门由用户 2026-10-09 明确跳过）',
  pickEngine(long, MEASURED_THROUGHPUT, CAPS).engine, 'offline')
ok('但机器码必须留着，界面与日志要看得出这个预估是猜的',
  pickEngine(long, MEASURED_THROUGHPUT, CAPS).reasons.includes('throughput_uncalibrated'))

// —— 6. 能力闸门与等速判据 ——
eq('浏览器编不了 H.264 时不硬上离线', pickEngine(input(9, 1280, 720, 15), TP, { offlineCapable: false }).engine, 'realtime')
ok('能力不足要落机器码', pickEngine(input(9, 1280, 720, 15), TP, { offlineCapable: false }).reasons.includes('no_offline_capability'))
// 等速/更慢也要选离线：这一格不是路数撑的，是**输出画布太大**（编码端成瓶颈）。
// 单路 720p15 实时毫无压力（需求 15 fps），但 4K 画布 @25fps 的编码吞吐只有 14 fps
// ⇒ 离线要 1702 秒 &gt; 会议 960 秒。选离线是因为它不占前台，不是因为省墙钟。
const parity: CostInput = { ...input(1, 1280, 720, 15, SEC, 25), layout: { canvasWidth: 3840, canvasHeight: 2160 } }
const eP = estimateCost(parity, TP)
ok('实时这一刻完全喂得过来', !eP.realtimeWouldDropFrames)
eq('离线墙钟 1701 秒，比会议的 960 秒还慢', eP.estOfflineSec, 1701)
ok('编码端才是这一格的瓶颈', eP.estEncodeSec > eP.estDecodeSec)
const cP = pickEngine(parity, TP, CAPS)
eq('更慢也选离线（买的是不占前台）', cP.engine, 'offline')
ok('理由是不占前台那一支', cP.reasons.includes('offline_within_budget'))

// —— 7. 只勾声音不勾画面 ——
const audioOnly: CostInput = {
  lanes: [{ id: 'A', hasVideo: false, width: 0, height: 0, frameRate: 0 }],
  videoLaneIds: [],
  durationSec: 600,
  layout: buildLayout({ lanes: [{ id: 'A', hasVideo: false }], mode: 'grid' }),
  fpsOut: 15,
}
eq('零画面路也走离线（只混音，不解视频）', pickEngine(audioOnly, TP, CAPS).engine, 'offline')
eq('零画面路的解码帧数为 0', estimateCost(audioOnly, TP).decodeFrames, 0)

// —— 8. 未标定时的姿态（现值就是未标定的）——
ok('未标定必须带机器码', pickEngine(input(9, 1280, 720, 15), MEASURED_THROUGHPUT, CAPS).reasons.includes('throughput_uncalibrated'))
const uncalSlow = pickEngine(long, MEASURED_THROUGHPUT, CAPS)
// 从前这条是"保守选实时"：未标定 ⇒ 不敢让人干等 ⇒ 退回前台陪放。2026-10-09 默认引擎翻到离线后
// 它反了 —— 陪放的产物在喂不过来时是"缺内容的完整文件"，比多等几分钟更坏；标定门改由人明确豁免。
eq('未标定 + 离线超预算 ⇒ 仍走离线（标定门已豁免，机器码负责说明这是猜的）', uncalSlow.engine, 'offline')
ok('但机器码要在', uncalSlow.reasons.includes('throughput_uncalibrated'))
eq('未标定但明显划算 ⇒ 仍走离线', pickEngine(input(9, 1280, 720, 15), MEASURED_THROUGHPUT, CAPS).engine, 'offline')

// —— 护栏 (d)：合成前的磁盘配额（唯一该硬拒的一条）
// 10 分钟、有画面有声音 ⇒ 产物 ≈ (2M+128k)bps × 600s / 8 ≈ 159 MB
const g1 = planDiskGuard({ durationSec: 600, hasVideo: true, hasAudio: true, availableBytes: 10 * 1024 ** 3 })
ok('余量充足 ⇒ 放行', g1.ok)
ok('产物大小按恒码率算（10 分钟双轨 ≈159MB）', Math.abs(g1.productBytes - 159_000_000) < 5_000_000, `${g1.productBytes}`)
const g2 = planDiskGuard({ durationSec: 600, hasVideo: true, hasAudio: true, availableBytes: 200 * 1024 ** 2 })
ok('余量 200MB、产物 159MB ⇒ 拒（没留一半地板）', !g2.ok)
const g3 = planDiskGuard({ durationSec: 600, hasVideo: true, hasAudio: true, availableBytes: 400 * 1024 ** 2 })
ok('余量 400MB、产物 159MB ⇒ 放行（过半余量还在）', g3.ok)
ok('只勾声音 ⇒ 需求显著变小',
  planDiskGuard({ durationSec: 600, hasVideo: false, hasAudio: true, availableBytes: 1024 ** 3 }).productBytes
    < planDiskGuard({ durationSec: 600, hasVideo: true, hasAudio: true, availableBytes: 1024 ** 3 }).productBytes)
ok('零时长 ⇒ 不拒（空任务不该被配额挡住）', planDiskGuard({ durationSec: 0, hasVideo: true, hasAudio: true, availableBytes: 0 }).ok)

if (ran < 30) {
  console.error(`成本用例自证失败：只跑了 ${ran} 条`)
  process.exit(2)
}
if (fails.length) {
  console.error(`✗ ${fails.length} 条失败（共 ${ran}）:`)
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log(`✓ costModel 全绿：${ran} 条断言`)
