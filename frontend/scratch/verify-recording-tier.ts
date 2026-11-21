/**
 * 录制档位与录制帧率的真源用例（node scratch/verify-recording-tier.ts）。
 * 盯的是两件事：档位不许"只压码率却宣称分辨率"，帧率不许把源补成重复帧。
 */
import { recordingTier, canvasFpsFor, RECORDING_FPS_VALUES, RECORDING_QUALITY_VALUES } from '../src/utils/recordingTier.ts'

let checks = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  checks++
  if (!cond) fails.push(name + (detail ? ' :: ' + detail : ''))
}
function eq(name: string, got: unknown, want: unknown) { ok(name, got === want, `got ${String(got)} want ${String(want)}`) }

eq('档位三档齐全', RECORDING_QUALITY_VALUES.length, 3)
ok('高档码率 > 中档 > 低档',
  recordingTier('high').videoBitsPerSecond > recordingTier('medium').videoBitsPerSecond
  && recordingTier('medium').videoBitsPerSecond > recordingTier('low').videoBitsPerSecond)
eq('脏值按 medium，绝不等于"没有上限"', recordingTier('1080p').videoBitsPerSecond, recordingTier('medium').videoBitsPerSecond)
eq('undefined 也按 medium', recordingTier(undefined).videoBitsPerSecond, 2_000_000)
ok('体积估算与码率自洽（MB/分 ≈ bps×60/8/1e6）',
  Math.abs(recordingTier('high').approxMbPerMinute - 4_000_000 * 60 / 8 / 1e6) < 1.5,
  String(recordingTier('high').approxMbPerMinute))

eq('源 8fps + 上限 15 ⇒ 8（不补重复帧）', canvasFpsFor(15, 8), 8)
eq('源 25fps + 上限 15 ⇒ 15（按上限）', canvasFpsFor(15, 25), 15)
eq('没设帧率 ⇒ 默认 15', canvasFpsFor(undefined, 30), 15)
eq('源缺失(0/null) ⇒ 用上限而不是 0', canvasFpsFor(10, 0), 10)
eq('上限非法 ⇒ 落回 15', canvasFpsFor(-3, 20), 15)
ok('结果恒在 1..30', [1, 5, 15, 25, 30, 60].every((f) => canvasFpsFor(25, f) >= 1 && canvasFpsFor(25, f) <= 30))
eq('界面可选帧率就是这三档', RECORDING_FPS_VALUES.join('/'), '10/15/25')

// 自证：判据若被写坏（档位不再影响码率），本文件必须红
ok('变异检查：档位必须真的改变码率', recordingTier('high').videoBitsPerSecond !== recordingTier('low').videoBitsPerSecond)

console.log(fails.length ? `✗ 录制档位 ${fails.length}/${checks} 条不符` : `✓ 录制档位全绿：${checks} 条断言`)
for (const f of fails) console.error('  - ' + f)
process.exit(fails.length ? 1 : 0)
