// 录制清单上那几个判据的真源直跑取证（第 4 步 D4/D9 收口用）。
// 跑法：cd edge/conference/frontend && node scratch/verify-recording-judgments.ts
//
// D4 的"量纲错"必须能被用例证伪，否则修了等于没修：这里每条都同时跑一遍**旧式**
// `t.endOffsetSec < spanSec - 1`，把"旧判据漏掉、新判据抓到"的那一类形状点名出来。
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

const { isPartialSession, segmentsHaveGap } = await import('@/utils/trackRecorder')
const { containerOf } = await import('@/utils/localRecorder')
// 先自证路由：本用例测的必须是 `src/utils/localRecorder.ts` 真实现。
// 桩一旦被全局挂上，"全 webm → webm"会由桩的返回值给出假绿（2026-10-10 实测炸过）。
const routed = import.meta.resolve('@/utils/localRecorder')
if (!/[\\/]src[\\/]utils[\\/]localRecorder\.ts$/.test(routed)) {
  console.error(`FAIL 路由不是真实现（落到 ${routed}）—— 本用例无效，别把它的绿灯当证据`)
  process.exit(2)
}

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  OK   ${name}${detail ? ' · ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' · ' + detail : ''}`) }
}

const segs = (from: number, to: number, step = 2) => {
  const out = []
  for (let o = from; o < to; o += step) out.push({ seq: out.length, offsetSec: o, durationSec: step, sizeBytes: 1000, blobKey: `t#${out.length}`, mime: 'video/webm' })
  return out
}
const track = (recordingId: string, startSec: number, ranges: Array<[number, number]>, extra = {}) => {
  const segments = ranges.flatMap(([a, b]) => segs(a, b))
  const last = segments[segments.length - 1]
  return {
    recordingId, ownerId: 'u', ownerName: '测试', kind: 'camera', mediaLabel: '画面',
    hasVideo: true, hasAudio: false, startOffsetSec: startSec,
    endOffsetSec: last ? last.offsetSec + last.durationSec : null, closedAtMs: null, closeReason: 'session_end',
    mime: 'video/webm;codecs=vp9', fileName: `${recordingId}.webm`, segments, ...extra,
  }
}
/** 旧判据原样复现（D4 修前的写法），用来证明用例真的能打在失真方向上 */
const oldPartial = (ts) => {
  const withSeg = ts.filter((t) => t.segments.length > 0)
  if (!withSeg.length) return false
  const span = Math.max(...withSeg.flatMap((t) => t.segments.map((s) => s.offsetSec + s.durationSec)))
    - Math.min(...withSeg.map((t) => t.startOffsetSec))
  return withSeg.some((t) => t.segments.length === 0 || segmentsHaveGap(t) || (t.endOffsetSec ?? 0) < span - 1)
}

console.log('\n① isPartialSession 的四种真形')
const clean = [track('A', 0, [[0, 60]]), track('B', 0, [[0, 60]])]
check('两路连续录到同一刻 → 完整', isPartialSession(clean) === false)

const hole = [track('A', 0, [[0, 10], [40, 60]]), track('B', 0, [[0, 60]])]
check('路内有断流 → 不完整', isPartialSession(hole) === true)

const early = [track('A', 0, [[0, 60]]), track('B', 0, [[0, 30]])]
check('某一路比全场早收 30 秒 → 不完整', isPartialSession(early) === true)

const lateJoin = [track('A', 0, [[0, 60]]), track('B', 35, [[35, 60]])]
check('有人中途入会但一路录到结尾 → 完整（起点不齐不是缺口）', isPartialSession(lateJoin) === false)

console.log('\n② 旧判据失真的那一类：全场不是从 0 开始')
const offsetStart = [track('A', 100, [[100, 200]]), track('B', 100, [[100, 150]])]
check('新判据抓到（B 比全场早收 50 秒）', isPartialSession(offsetStart) === true)
check('旧判据在这一场漏了（用例确实打在失真方向上）', oldPartial(offsetStart) === false,
  `旧式给 ${oldPartial(offsetStart)}`)

console.log('\n③ 边界与退化形状')
check('一路都没有 → 不判不完整（没有内容根本不会登记成条目）', isPartialSession([]) === false)
const onlyOne = [track('A', 0, [[0, 4]])]
check('一路 4 秒连续 → 完整', isPartialSession(onlyOne) === false)
const thinGap = [track('A', 0, [[0, 30], [31, 60]]), track('B', 0, [[0, 60]])]
check('1 秒缝不算断流（判据 >1s，抖动不该报缺口）', isPartialSession(thinGap) === false)
const wideGap = [track('A', 0, [[0, 30], [32, 60]]), track('B', 0, [[0, 60]])]
check('2 秒缝算断流', isPartialSession(wideGap) === true)

console.log('\n④ 容器判读（D9：不存顶层字段，从各路真 mime 判）')
check('全 webm → webm', containerOf([track('A', 0, [[0, 4]])]) === 'webm')
check('混进一路 mp4 就不说 webm', containerOf([
  { mime: 'video/mp4;codecs=avc1' }, { mime: 'video/webm' },
]) === 'webm', '两路容器不一致时保守判 webm，交由逐路 mime 自己说话')
check('全 mp4 → mp4', containerOf([{ mime: 'video/mp4;codecs=avc1.640028' }]) === 'mp4')

console.log(`\n${fail} FAIL · ${pass} OK`)
process.exitCode = fail ? 1 : 0
