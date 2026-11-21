/**
 * 合成队列状态机的真源用例（直接 import src/，不复制副本）。
 * 跑法：node scratch/verify-offline-queue.ts
 *
 * 这份用例存在的理由是"并发 = 1"和"排队中取消永不起跑"这两条**看不见**的约定：
 * 它们错了不会报错，只会让现场观察到"两个任务都变慢"或"取消后文件照样生成"。
 * 所以每条都拿 run 次数的硬计数钉住，而不是只看状态字符串。
 */
import {
  createComposeQueue,
  isTerminal,
  type ComposeTaskRecord,
  type QueueCtl,
} from '../src/utils/offlineCompose/composeQueue.ts'

type Outcome = { kind: 'ok' | 'cancelled' | 'stalled' | 'failed'; n: number }

let ran = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = ''): void {
  ran++
  if (!cond) fails.push(`${name}${detail ? ' — ' + detail : ''}`)
}
function eq(name: string, got: unknown, want: unknown): void {
  ok(name, got === want, `got=${String(got)} want=${String(want)}`)
}

const classify = (r: Outcome) =>
  r.kind === 'ok' ? 'succeeded' : r.kind === 'cancelled' ? 'cancelled' : r.kind === 'stalled' ? 'stalled' : 'failed'

/** 可控时钟：断言 started/finished 用得上，且不让用例依赖真实耗时 */
let clock = 1000
const now = () => clock
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
async function drainTicks(n: number) { for (let i = 0; i < n; i++) await settle() }

/** 外部释放的闸门：并发是不是真的 1，只有"第二个何时能起跑"能说清 */
function gated(n: number) {
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  return { n, gate, release: () => { release() } }
}

function task(rec: readonly ComposeTaskRecord<Outcome>[], id: string): ComposeTaskRecord<Outcome> {
  const hit = rec.find((t) => t.id === id)
  if (!hit) throw new Error(`没有这条任务：${id}`)
  return hit
}

// —— 1. 并发 = 1 且按入队顺序 ——
{
  const q = createComposeQueue<Outcome>({ now, classify })
  const started: string[] = []
  const gates: Record<string, ReturnType<typeof gated>> = {}
  const mk = (id: string) => ({
    id,
    label: `场 ${id}`,
    run: async (ctl: QueueCtl) => {
      started.push(id)
      const g = gates[id]!
      await g.gate
      ctl.onProgress({ ratio: 1, coveredSec: 10, expectedSec: 10, engine: 'offline' })
      return { kind: 'ok' as const, n: g.n }
    },
  })
  for (const id of ['A', 'B', 'C']) gates[id] = gated(id.charCodeAt(0))
  q.enqueue(mk('A')); q.enqueue(mk('B')); q.enqueue(mk('C'))
  await drainTicks(3)
  eq('同时只跑一条', q.runningCount(), 1)
  eq('先跑队首', started.join(','), 'A')
  gates.A!.release(); await drainTicks(3)
  eq('A 完才轮到 B', started.join(','), 'A,B')
  gates.B!.release(); await drainTicks(3)
  eq('B 完才轮到 C', started.join(','), 'A,B,C')
  gates.C!.release(); await q.idle()
  eq('三条都成功', q.tasks().filter((t) => t.state === 'succeeded').length, 3)
  eq('排空后没有活跃任务', q.active(), null)
  eq('idle 时全部终态', q.tasks().every((t) => isTerminal(t.state)), true)
}

// —— 2. 同一 id 未终态不许重复排（重复点击不该排第二份）——
{
  const q = createComposeQueue<Outcome>({ now, classify })
  const g = gated(1)
  let runs = 0
  const mk = () => ({ id: 'X', label: '场 X', run: async () => { runs++; await g.gate; return { kind: 'ok' as const, n: 1 } } })
  const first = q.enqueue(mk())
  const second = q.enqueue(mk())
  eq('第二次判定为重复', second.duplicate, true)
  eq('列表只有一条', q.tasks().length, 1)
  await drainTicks(3)
  eq('任务体只跑一次', runs, 1)
  g.release(); await q.idle()
  eq('终态仍是成功', task(q.tasks(), 'X').state, 'succeeded')
  // 终态后同 id 再排一次：换新记录并真的再跑
  const third = q.enqueue(mk())
  eq('终态后可重排', third.duplicate, false)
  await drainTicks(3)
  eq('重排后跑第二次', runs, 2)
  eq('重排不留历史副本', q.tasks().length, 1)
}

// —— 3. 排队中取消：永不起跑 ——
{
  const q = createComposeQueue<Outcome>({ now, classify })
  const g = gated(1)
  let runs = 0
  q.enqueue({ id: 'A', label: 'A', run: async () => { runs++; await g.gate; return { kind: 'ok' as const, n: 1 } } })
  q.enqueue({ id: 'B', label: 'B', run: async () => { runs++; return { kind: 'ok' as const, n: 2 } } })
  await drainTicks(3)
  eq('取消排队中的返回真', q.cancel('B'), true)
  eq('B 判定为已取消', task(q.tasks(), 'B').state, 'cancelled')
  g.release(); await q.idle()
  eq('B 从未起跑', runs, 1)
  eq('取消已终态返回假', q.cancel('B'), false)
}

// —— 4. 在跑的任务取消：只置意图，终态由任务自己定（半截件口径）——
{
  const q = createComposeQueue<Outcome>({ now, classify })
  let sawCancel = false
  let inside = 0
  const t = q.enqueue({
    id: 'R',
    label: 'R',
    run: async (ctl) => {
      inside++
      await settle()
      ctl.cancel()
      await settle()
      sawCancel = ctl.isCancelled()
      if (sawCancel) return { kind: 'cancelled' as const, n: inside }
      return { kind: 'ok' as const, n: inside }
    },
  })
  eq('入队即 queued 或 running', isTerminal(t.task.state), false)
  await q.idle()
  eq('任务内部看到了取消', sawCancel, true)
  const rec = task(q.tasks(), 'R')
  eq('取消按任务返回定性', rec.state, 'cancelled')
  eq('取消后取消标记已清', q.cancel('R'), false)
  eq('终态时间戳有值', typeof rec.finishedAtMs, 'number')
}

// —— 5. 停摆：终态、可带产物、界面能如实说"只到第 N 秒" ——
{
  const q = createComposeQueue<Outcome>({ now, classify })
  q.enqueue({ id: 'S', label: 'S', run: async (ctl) => { ctl.onProgress({ ratio: 0.4, coveredSec: 37, expectedSec: 100, engine: 'offline' }); return { kind: 'stalled' as const, n: 1 } } })
  await q.idle()
  const rec = task(q.tasks(), 'S')
  eq('停摆是终态', isTerminal(rec.state), true)
  eq('停摆定性', rec.state, 'stalled')
  eq('停摆保留已覆盖秒数', rec.coveredSec, 37)
  eq('停摆保留结果', rec.result?.kind, 'stalled')
}

// —— 6. 进度钳制与字段带上 ——
{
  const q = createComposeQueue<Outcome>({ now, classify })
  const ratios: number[] = []
  q.subscribe((ts) => { const r = ts.find((t) => t.id === 'P'); if (r) ratios.push(r.ratio) })
  q.enqueue({
    id: 'P',
    label: 'P',
    run: async (ctl) => {
      ctl.onProgress({ ratio: 7, coveredSec: 5, expectedSec: 9, engine: 'realtime', phase: 'encode' })
      ctl.onProgress({ ratio: 0.9, coveredSec: 5, phase: 'wrap' })
      ctl.onProgress({ ratio: -3, coveredSec: 5 })
      return { kind: 'ok' as const, n: 1 }
    },
  })
  await q.idle()
  const rec = task(q.tasks(), 'P')
  ok('上报超 1 被钳到 1', ratios.includes(1), ratios.join(','))
  eq('上报负值被钳到 0', rec.ratio, 0)
  eq('引擎按上报带上', rec.engine, 'realtime')
  eq('第二次不带 expectedSec 时保留原值', rec.expectedSec, 9)
  // 收尾阶段必须留得住：进度到 100% 之后界面靠它说"正在生成文件"，不然就像卡死；
  // 上报里没带 phase 时也不许把它清空
  eq('阶段按最后一次带值的上报保留', rec.phase, 'wrap')
}

// —— 7. 任务抛错：判失败但不钉死队列，下一条照跑 ——
{
  const q = createComposeQueue<Outcome>({ now, classify })
  let second = 0
  q.enqueue({ id: 'E', label: 'E', run: async () => { throw new TypeError('boom') } })
  q.enqueue({ id: 'F', label: 'F', run: async () => { second++; return { kind: 'ok' as const, n: 2 } } })
  await q.idle()
  const e = task(q.tasks(), 'E')
  eq('抛错判失败', e.state, 'failed')
  eq('错误只留机器码', e.failureCode, 'task_error:TypeError')
  eq('下一条照样跑', second, 1)
  eq('失败任务保留记录用于展示', q.tasks().length, 2)
}

// —— 8. dismiss 只收终态 ——
{
  const q = createComposeQueue<Outcome>({ now, classify })
  const g = gated(1)
  q.enqueue({ id: 'D', label: 'D', run: async () => { await g.gate; return { kind: 'ok' as const, n: 1 } } })
  await drainTicks(3)
  eq('在跑的不许删', q.dismiss('D'), false)
  g.release(); await q.idle()
  eq('终态可删', q.dismiss('D'), true)
  eq('删完列表空', q.tasks().length, 0)
  eq('不存在的 id 返回假', q.dismiss('D'), false)
}

// —— 9. 订阅：每次状态变化都给快照，取消订阅后不再收 ——
{
  const q = createComposeQueue<Outcome>({ now, classify })
  const seen: string[] = []
  const un = q.subscribe((ts) => { seen.push(ts.map((t) => `${t.id}:${t.state}`).join('|')) })
  q.enqueue({ id: 'Z', label: 'Z', run: async () => ({ kind: 'ok' as const, n: 1 }) })
  await q.idle()
  un()
  const before = seen.length
  q.enqueue({ id: 'Y', label: 'Y', run: async () => ({ kind: 'ok' as const, n: 1 }) })
  await q.idle()
  ok('订阅看到 queued→running→succeeded', seen.some((s) => s.includes('Z:running')) && seen[seen.length - 1]!.includes('Z:succeeded'), seen.join(' / '))
  eq('退订后不再收', seen.length, before)
}

// —— 10. 自证下限：用例条数不够就说明有分支没被钉住 ——
if (ran < 40) {
  console.error(`队列用例自证失败：只跑了 ${ran} 条`)
  process.exit(2)
}
if (fails.length) {
  console.error(`✗ ${fails.length} 条失败（共 ${ran}）:`)
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log(`✓ composeQueue 全绿：${ran} 条断言`)
