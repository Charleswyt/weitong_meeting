// 视频规格归一的判据（`utils/videoSpec.ts`）。纯函数，Node 24 直跑仓内真源。
//
// 为什么要钉它：这条归一化同时被**发布**（`useWhipPublish` 报给平台的宽高帧率）和**显示**
// （会中页「本端这一格」的分辨率/帧率）用。两处吃的不是同一份，就会出现"同一个格子里
// 原始速率说 1920×1080、分辨率却说 2561×1601"这种自相矛盾 —— 那不是显示偏好，是两个数
// 指了两条流。归一化本身被改坏（档位顺序、边界方向、帧率往下取）也会静默发生。
//
// 跑法：node scratch/verify-video-spec.ts   （有失败则退出码 1）

import { ALLOWED_FPS, ALLOWED_RES, normalizeVideoSpec, publicVideoSpec } from '../src/utils/videoSpec.ts'

import { videoSampler } from '../src/utils/videoObservations.ts'

let fail = 0
const check = (name: string, cond: boolean, extra = '') => {
  if (!cond) { fail++; console.log(`  FAIL ${name}${extra ? ' · ' + extra : ''}`) } else console.log(`  OK   ${name}`)
}
const same = (a: { width: number; height: number; fps: number }, w: number, h: number, f: number) =>
  a.width === w && a.height === h && a.fps === f

// 1) 档位表本身：三方只收这两档、帧率 ≤25（改表就是改契约，先钉住）
check('分辨率档只有 1920×1080 与 1280×720', JSON.stringify(ALLOWED_RES) === '[[1920,1080],[1280,720]]', JSON.stringify(ALLOWED_RES))
check('帧率档是 10/15/20/25，最大 25', JSON.stringify(ALLOWED_FPS) === '[10,15,20,25]', JSON.stringify(ALLOWED_FPS))

// 2) 实测踩过的那一台：整屏 DPI 缩放报出 2561×1601@30 → 必须落到 1920×1080@25
//    （不归一会被平台按 bad_publication_video_spec 拒）
check('2561×1601@30 → 1920×1080@25（实测过的非标值）',
  same(normalizeVideoSpec(2561, 1601, 30), 1920, 1080, 25), JSON.stringify(normalizeVideoSpec(2561, 1601, 30)))

// 3) 标准档原样保留，帧率往下取到"不小于采集帧率"的那一档
check('1920×1080@25 原样', same(normalizeVideoSpec(1920, 1080, 25), 1920, 1080, 25))
check('1280×720@30 → 帧率 25（不留 30）', same(normalizeVideoSpec(1280, 720, 30), 1280, 720, 25))
check('1280×720@24 → 帧率 25（不往下取 20）', same(normalizeVideoSpec(1280, 720, 24), 1280, 720, 25))
check('1280×720@18 → 帧率 20', same(normalizeVideoSpec(1280, 720, 18), 1280, 720, 20))
check('1280×720@12 → 帧率 15', same(normalizeVideoSpec(1280, 720, 12), 1280, 720, 15))
check('1280×720@6 → 帧率 10（最低档）', same(normalizeVideoSpec(1280, 720, 6), 1280, 720, 10))

// 4) 小于最小档：落到 1280×720（三方没有更小的档；这是"报它能接受的档"，不是按这个尺寸采）
check('640×480@30 → 1280×720@25', same(normalizeVideoSpec(640, 480, 30), 1280, 720, 25),
  JSON.stringify(normalizeVideoSpec(640, 480, 30)))

// 5) 拿不到 settings（0）：不猜档位，只把帧率夹到 ≤25
check('尺寸未知时不动宽高', same(normalizeVideoSpec(0, 0, 30), 0, 0, 25), JSON.stringify(normalizeVideoSpec(0, 0, 30)))
check('尺寸未知且帧率为 0 时仍是 0（交给上层判"拿不到"）', same(normalizeVideoSpec(0, 0, 0), 0, 0, 0))

// 6) 宽高非零但帧率取整后为 0：按最低档 10 处理（与三方的下拉缺省一致）
check('帧率取整为 0 → 10', same(normalizeVideoSpec(1920, 1080, 0.4), 1920, 1080, 10),
  JSON.stringify(normalizeVideoSpec(1920, 1080, 0.4)))

check('公网轨保留 854×480 及 30 fps', same(publicVideoSpec({ width: 854, height: 480, frameRate: 30 }), 854, 480, 30))
check('公网轨保留 60 fps', publicVideoSpec({ frameRate: 60 }).fps === 60)
const sample = videoSampler()
const report = (t: number, captured: number, sent: number) => new Map([
  ['video-source', { type: 'media-source', kind: 'video', id: 'video-source', trackIdentifier: 'camera', timestamp: t, frames: captured }],
  ['video-out', { type: 'outbound-rtp', kind: 'video', id: 'video-out', mediaSourceId: 'video-source', timestamp: t, framesSent: sent, targetBitrate: 100000 }],
]) as unknown as RTCStatsReport
check('只有配置和首个计数时，实测帧率为空', sample(report(1000, 5, 5), 'camera').captureFps === null)
const measured = sample(report(2000, 35, 25), 'camera')
check('同一路采集 30 帧、编码发送 20 帧分别计数', measured.captureFps === 30 && measured.publishFps === 20)
check('有效样本停帧返回零', sample(report(3000, 35, 25), 'camera').publishFps === 0)
check('切到另一轨不沿用摄像头的计数', sample(report(4000, 45, 32), 'screen').captureFps === null)

if (fail) {
  console.log(`\nvideoSpec 取证：${fail} 条失败`)
  process.exit(1)
}
console.log('\nvideoSpec 取证：全过')
