// 第 17 项：中途退会再入造成的**轨道中断**与**全局时间轴**——真源直跑，零浏览器。
// 这一套过去只在受限实例里量过一次（"18 片并一区"），现在变成可复现断言。
// 说明：gapText 在 TS 里是 private，类型擦除不执行可见性，所以这里按运行时形状直接调它；
//       引擎的构造函数不碰 DOM（media:null），resolveUrl 给个假地址即可。
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

const { ReplayEngine } = await import('@/utils/replayEngine')

const seg = (offsetSec, durationSec, id) => ({ offsetSec, durationSec, blobKey: 'k' + id, recordingId: 'r' + id })
const track = (recordingId, extra) => ({
  recordingId, ownerId: 'u1', ownerName: '测试', kind: 'camera', mediaLabel: '画面',
  hasVideo: true, hasAudio: true, startOffsetSec: 0, endOffsetSec: null, closeReason: null,
  segments: [], ...extra,
})

const mk = (tracks, opts = {}) => new ReplayEngine({
  tracks, durationSec: 60, startAtMs: Date.parse('2026-09-29T10:00:00+08:00'),
  resolveUrl: async () => 'blob:fake', assembleRuns: true, onChange: () => {}, onClock: () => {},
  ...opts,
})

const say = (o) => console.log(JSON.stringify(o))
const spanOf = (e, i) => e.rows[i].spans.map((s) => ({ start: +s.start.toFixed(3), end: +s.end.toFixed(3), n: s.segments.length }))
const gapOf = (e, i, t) => { e.time = t; return e.segmentAt(e.rows[i]) === -1 ? e.gapText(e.rows[i]) : '(有片)' }

// 1) 连续 18 片 → 并成一个可播区（本机录制只有首片带容器头，必须合区才能播）
const contig = Array.from({ length: 18 }, (_, i) => seg(i * 2, 2, i))
const e1 = mk([track('A', { segments: contig })])
say({ step: 'contiguous_merge', spans: spanOf(e1, 0), expectOneSpan: e1.rows[0].spans.length === 1, coversWholeRun: e1.rows[0].spans[0]?.end === 36 })

// 2) 退会再入：中间断 30 秒 → 必须留在同一条全局时间轴上的**两个区**，缺口照实存在
const rejoin = mk([track('B', { segments: [seg(0, 10, 0), seg(40, 10, 1)] })])
say({ step: 'rejoin_two_spans', spans: spanOf(rejoin, 0), twoSpans: rejoin.rows[0].spans.length === 2 })
say({ step: 'rejoin_gap_text', at25: gapOf(rejoin, 0, 25), at5: gapOf(rejoin, 0, 5), at45: gapOf(rejoin, 0, 45) })

// 3) 合区阈值边界：缝 0.25 并进同一区，0.26 分成两区
const seam = (gap) => mk([track('C', { segments: [seg(0, 10, 0), seg(10 + gap, 10, 1)] })]).rows[0].spans.length
say({ step: 'seam_threshold', gap_0_25: seam(0.25), gap_0_26: seam(0.26), mergedAtThreshold: seam(0.25) === 1, splitAbove: seam(0.26) === 2 })

// 4) 四种缺口各说各的话（界面不能只写"没有画面"）
const cases = [
  ['尚未开始', track('D', { segments: [seg(20, 10, 0)] }), 5],
  ['录制已结束(session_end，撑到全场)', track('E', { segments: [seg(0, 10, 0)], endOffsetSec: 10, closeReason: 'session_end' }), 45],
  ['在此刻之前已停止(中途离开且没撑到全场)', track('F', { segments: [seg(0, 10, 0)], endOffsetSec: 10, closeReason: 'left' }), 45],
  ['正在录但无已完成片段', track('G', { segments: [], endOffsetSec: null, closeReason: null }), 30],
  ['有尾段但此刻没画面(停录后又开录前)', track('H', { segments: [seg(0, 10, 0)], endOffsetSec: 50, closeReason: 'paused' }), 30],
]
for (const [label, t, at] of cases) {
  const e = mk([t])
  say({ step: 'gap_kind', label, at, out: gapOf(e, 0, at) })
}

// 5) 脏输入不许污染全局时间轴：0 时长片被丢、乱序入参按起点排好、负偏移夹到 0
const dirty = mk([track('I', { segments: [seg(30, 5, 0), seg(0, 0, 1), seg(10, 5, 2), seg(-8, 5, 3)] })])
say({ step: 'dirty_input', spans: spanOf(dirty, 0), zeroDurationDropped: !dirty.rows[0].spans.some((s) => s.segments.some((x) => x.durationSec === 0)), monotonic: dirty.rows[0].spans.every((s, i, a) => i === 0 || s.start >= a[i - 1].end), negativeClamped: dirty.rows[0].spans[0].start === 0 })

// 6) 全局时钟不动：某一路在缺口里，别的路照常落在自己那片上
const mixed = mk([track('J', { segments: [seg(0, 10, 0), seg(40, 10, 1)] }), track('K', { segments: [seg(20, 10, 2)] })])
mixed.time = 25
say({ step: 'global_clock_shared', rowJ_spanAt25: mixed.segmentAt(mixed.rows[0]), rowK_spanAt25: mixed.segmentAt(mixed.rows[1]), J_is_gap: mixed.segmentAt(mixed.rows[0]) === -1, K_has_video: mixed.segmentAt(mixed.rows[1]) >= 0 })

// 7) 关掉合区（云端一路本来就是完整流）→ 一片就是一个区，不该被并掉
const cloud = mk([track('L', { segments: contig })], { assembleRuns: false })
say({ step: 'assemble_off', spanCount: cloud.rows[0].spans.length, staysPerSegment: cloud.rows[0].spans.length === 18 })
