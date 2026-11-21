// 相对帧延迟口径的用例：Node 直跑 src 真源（必须带 .ts 后缀），不复制副本 —— 副本漂移会让绿灯失去意义。
// 跑法：node scratch/verify-mediaclock-drift.ts
//
// 这些用例钉的是"漂移"这个量的定义本身：源时钟前进多少、本地钟就该前进多少，
// 多出来的部分才是延迟在长。三方在同一条局域网通道上用的就是这个口径。

import { FrameDriftMeter, normalizeEpochMs } from '../src/utils/mediaClock.ts'

let failed = 0
function check(name: string, got: unknown, want: unknown) {
  const ok = Object.is(got, want)
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
}
function near(name: string, got: number, want: number, tol: number) {
  const ok = Number.isFinite(got) && Math.abs(got - want) <= tol
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}  got=${got} want=${want}±${tol}`)
}

// —— 1. 首个样本只立基准，报不出漂移（没有基准可比）
{
  const m = new FrameDriftMeter()
  check('首样本返回 null', m.observe({ sourceMs: 1000, observedMs: 5000 }), null)
  check('基准源时刻已记下', m.anchorSourceMs, 1000)
}

// —— 2. 稳定播放：源前进 100ms、本地也前进 100ms → 漂移 0
{
  const m = new FrameDriftMeter()
  m.observe({ sourceMs: 1000, observedMs: 5000 })
  const d = m.observe({ sourceMs: 1100, observedMs: 5100 })
  near('稳定播放漂移为 0', d?.driftMs ?? NaN, 0, 0.001)
  check('未重锚', d?.resets, 0)
}

// —— 3. 延迟在长：本地走了 300ms，源只走了 100ms → +200
{
  const m = new FrameDriftMeter()
  m.observe({ sourceMs: 1000, observedMs: 5000 })
  const d = m.observe({ sourceMs: 1100, observedMs: 5300 })
  near('延迟在长为正', d?.driftMs ?? NaN, 200, 0.001)
}

// —— 4. 在追赶：本地走 100ms，源走 250ms → -150（负值是合法读数，不许被"必须为正"挡掉）
{
  const m = new FrameDriftMeter()
  m.observe({ sourceMs: 1000, observedMs: 5000 })
  const d = m.observe({ sourceMs: 1250, observedMs: 5100 })
  near('追赶为负', d?.driftMs ?? NaN, -150, 0.001)
}

// —— 5. 换源钟（对端重启采集）：必须重立基准并计数，而不是报出一个巨大的跳变
{
  const m = new FrameDriftMeter()
  m.observe({ sourceMs: 1000, observedMs: 5000, clockId: 'clockA' })
  const jumped = m.observe({ sourceMs: 90000, observedMs: 5100, clockId: 'clockB' })
  check('换钟当帧不报数', jumped, null)
  const after = m.observe({ sourceMs: 90100, observedMs: 5200, clockId: 'clockB' })
  near('新钟上重新算得 0', after?.driftMs ?? NaN, 0, 0.001)
  check('重锚计一次', after?.resets, 1)
}

// —— 6. 口径退化（源时间戳拿不到，改用轨道交付）：也是换基准
{
  const m = new FrameDriftMeter()
  m.observe({ sourceMs: 1000, observedMs: 5000 })
  check('转退化口径当帧不报数', m.observe({ sourceMs: 1100, observedMs: 5100, estimated: true }), null)
  const d = m.observe({ sourceMs: 1200, observedMs: 5200, estimated: true })
  check('退化口径要标出来', d?.estimated, true)
  near('退化口径下漂移仍可算', d?.driftMs ?? NaN, 0, 0.001)
}

// —— 7. 源时刻倒退：超过阈值算钟跳（重锚），阈值内当正常抖动（不重锚）
{
  const m = new FrameDriftMeter()
  m.observe({ sourceMs: 5000, observedMs: 5000 })
  const small = m.observe({ sourceMs: 4500, observedMs: 5100 })
  near('倒退 500ms 内不重锚', small?.driftMs ?? NaN, 600, 0.001)
  check('未计重锚', small?.resets, 0)
  const big = m.observe({ sourceMs: 3000, observedMs: 5200 })
  check('倒退超阈值当帧不报数', big, null)
  check('倒退超阈值计一次重锚', m.anchorSourceMs, 3000)
}

// —— 8. 坏输入不许污染基准，也不许算出 NaN 摆到界面上
{
  const m = new FrameDriftMeter()
  check('NaN 源时刻被挡', m.observe({ sourceMs: NaN, observedMs: 1 }), null)
  check('基准未被坏输入立起来', m.anchorSourceMs, 0)
  m.observe({ sourceMs: 1000, observedMs: 5000 })
  check('Infinity 本地时刻被挡', m.observe({ sourceMs: 1100, observedMs: Infinity }), null)
  near('坏输入之后基准没变', m.observe({ sourceMs: 1100, observedMs: 5100 })?.driftMs ?? NaN, 0, 0.001)
}

// —— 9. 时钟域归一：三方线上实测三种纪元都出现过，用字面量钉住度量
{
  const UNIX = 1791859725880
  const NTP_UNIX_OFFSET = 2208988800000
  check('Unix 毫秒原样', normalizeEpochMs(UNIX), UNIX)
  check('NTP 纪元减偏移', normalizeEpochMs(UNIX + NTP_UNIX_OFFSET), UNIX)
  near('performance 纪元加 timeOrigin', normalizeEpochMs(12345.6) - (performance.timeOrigin + 12345.6), 0, 0.001)
  check('零当没有值', normalizeEpochMs(0), 0)
  check('负数当没有值', normalizeEpochMs(-5), 0)
  check('NaN 当没有值', normalizeEpochMs(NaN), 0)
  // 看着像 NTP（>=3e12）但减完落在 2000 年之前的，是别的东西，必须原样退回而不是硬归一。
  // 取 3e12 是因为它减掉偏移 = 7.91e11（1995 年），刚好掉出 [2000, 2100] 那道门。
  check('伪 NTP 不硬减', normalizeEpochMs(3e12), 3e12)
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条不通过`)
process.exit(failed === 0 ? 0 : 1)
