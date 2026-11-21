/**
 * 合成任务队列的**纯状态机**：没有 Vue、没有 DOM、没有 Pinia，`node scratch/verify-offline-queue.ts` 直接跑这份真源。
 *
 * 为什么要这一层（口径 §9.4）：合成任务原本挂在回放页组件的局部 ref 上，换路由就丢，
 * 而"点完可以离开这一页"正是本轮选离线引擎的理由。任务必须活在一个不随组件销毁的地方，
 * 并且**并发 = 1** —— 两个任务并行会把解码吞吐分摊掉，结果两个都比单独跑慢。
 *
 * 三条不可回退的口径：
 * - 同一个 `id` 在未终态前**只许一个任务**（重复点按钮不该排第二份，也不该吞掉点击）。
 * - 排队中的任务可以取消，且**永不起跑**；在跑的任务只置取消意图，终态由引擎的返回决定
 *   （引擎负责产出"只到第 N 秒"的半截件，队列不许替它编一个结局）。
 * - 状态只能向前：`queued → running → 终态`，终态不可逆 —— 否则进度浮标会在完成后又跳回在跑。
 */

export type ComposeTaskState = 'queued' | 'running' | 'succeeded' | 'stalled' | 'failed' | 'cancelled'

const TERMINAL: ComposeTaskState[] = ['succeeded', 'stalled', 'failed', 'cancelled']

export function isTerminal(state: ComposeTaskState): boolean {
  return TERMINAL.includes(state)
}

/** 引擎在跑的过程中回给队列的进度；`coveredSec` 是内容秒数，不是墙钟 */
export interface QueueProgress {
  ratio: number
  coveredSec: number
  expectedSec?: number
  engine?: 'offline' | 'realtime'
  /** 收尾阶段（封装/重排容器）：这段时间进度条已经到 100%，不给个说法就像卡死 */
  phase?: 'intake' | 'encode' | 'wrap'
}

/** 传给任务体的控制句柄：取消只置标志，收尾仍走任务自己的分支 */
export interface QueueCtl {
  onProgress: (p: QueueProgress) => void
  cancel: () => void
  isCancelled: () => boolean
}

export interface ComposeTaskInput<R> {
  /** 去重键（一般是这一场的标识 + 参数指纹） */
  id: string
  /** 浮标上显示的一句话，界面按它认"哪场会在跑" */
  label: string
  run: (ctl: QueueCtl) => Promise<R>
  /**
   * 实时引擎的任务：画面来源是某个页面上的媒体元素，离开那个页元素就没了。
   * 队列不管这件事，只是把它如实带上，让离开页面的守卫**只对这一类**生效。
   */
  pageBound?: boolean
}

export interface ComposeTaskRecord<R> {
  id: string
  label: string
  state: ComposeTaskState
  pageBound: boolean
  ratio: number
  coveredSec: number
  expectedSec: number
  engine: 'offline' | 'realtime' | null
  /** 最近一次上报的阶段；`wrap` = 进度已到 100% 但还在收尾，界面得给一句说法 */
  phase: QueueProgress['phase'] | null
  /** 任务体抛错时的机器码；中文文案在界面取词，错误原文不上桌 */
  failureCode: string
  result: R | null
  queuedAtMs: number
  startedAtMs: number | null
  finishedAtMs: number | null
}

export interface EnqueueResult<R> {
  task: ComposeTaskRecord<R>
  /** true = 这个 id 已经有一个未终态任务在队里，本次没有重复排 */
  duplicate: boolean
}

export interface ComposeQueueOptions<R> {
  now?: () => number
  /**
   * 任务体正常返回后怎么定性。离线引擎返回 `kind: 'ok' | 'cancelled' | 'stalled' | 'failed'`，
   * 缺这个映射就会把用户取消记成成功 —— 那是"静默"的一种，界面会报喜不报忧。
   */
  classify?: (result: R) => ComposeTaskState
}

export interface ComposeQueue<R> {
  tasks: () => readonly ComposeTaskRecord<R>[]
  enqueue: (input: ComposeTaskInput<R>) => EnqueueResult<R>
  cancel: (id: string) => boolean
  dismiss: (id: string) => boolean
  active: () => ComposeTaskRecord<R> | null
  runningCount: () => number
  subscribe: (listener: (tasks: readonly ComposeTaskRecord<R>[]) => void) => () => void
  /** 队列排空（测试与"等它跑完再收尾"用）；没有任务时立即 resolve */
  idle: () => Promise<void>
}

export function createComposeQueue<R>(opts: ComposeQueueOptions<R> = {}): ComposeQueue<R> {
  const now = opts.now ?? (() => Date.now())
  const classify = opts.classify ?? (() => 'succeeded' as ComposeTaskState)

  const records: ComposeTaskRecord<R>[] = []
  const inputs = new Map<string, ComposeTaskInput<R>>()
  const cancelFlags = new Set<string>()
  const listeners = new Set<(tasks: readonly ComposeTaskRecord<R>[]) => void>()
  let running: string | null = null
  let idleWaiters: Array<() => void> = []

  const snapshot = () => records.map((t) => ({ ...t })) as ComposeTaskRecord<R>[]

  function notify() {
    const snap = snapshot()
    for (const l of listeners) l(snap)
    if (running === null && !records.some((t) => !isTerminal(t.state))) {
      const waiters = idleWaiters
      idleWaiters = []
      for (const w of waiters) w()
    }
  }

  function find(id: string): ComposeTaskRecord<R> | undefined {
    return records.find((t) => t.id === id)
  }

  function setState(id: string, patch: Partial<ComposeTaskRecord<R>>) {
    const rec = find(id)
    if (!rec) return
    Object.assign(rec, patch)
  }

  /** 只取队首：并发 = 1 是这里的唯一调度规则，不是"看起来慢所以少开几个" */
  function pump() {
    if (running !== null) return
    const next = records.find((t) => t.state === 'queued')
    if (!next) return
    const input = inputs.get(next.id)
    if (!input) {
      // 入队记录还在但任务体没了（只可能是 dismiss 与 pump 抢在同一次 tick）：直接判失败，
      // 不许把它留在 queued 里把整条队列钉死
      setState(next.id, { state: 'failed', failureCode: 'task_body_missing', finishedAtMs: now() })
      notify()
      pump()
      return
    }
    running = next.id
    setState(next.id, { state: 'running', startedAtMs: now() })
    notify()

    const ctl: QueueCtl = {
      onProgress: (p) => {
        if (running !== next.id) return
        setState(next.id, {
          ratio: Math.max(0, Math.min(1, p.ratio)),
          coveredSec: p.coveredSec,
          expectedSec: p.expectedSec ?? find(next.id)?.expectedSec ?? 0,
          engine: p.engine ?? find(next.id)?.engine ?? null,
          phase: p.phase ?? find(next.id)?.phase ?? null,
        })
        notify()
      },
      cancel: () => { cancelInternal(next.id) },
      isCancelled: () => cancelFlags.has(next.id),
    }

    const finish = (state: ComposeTaskState, extra: Partial<ComposeTaskRecord<R>>) => {
      if (running === next.id) running = null
      setState(next.id, { state, finishedAtMs: now(), ...extra })
      cancelFlags.delete(next.id)
      notify()
      pump()
    }

    void input.run(ctl).then(
      (result) => finish(classify(result), { result }),
      (err: unknown) => {
        // 错误原文只进控制台；上桌的是机器码（AGENTS 的"技术细节不上桌"）
        console.error('[composeQueue] 任务抛出', next.id, err)
        const code = err instanceof Error ? err.name : 'unknown'
        finish('failed', { failureCode: `task_error:${code}` })
      },
    )
  }

  function cancelInternal(id: string): boolean {
    const rec = find(id)
    if (!rec || isTerminal(rec.state)) return false
    cancelFlags.add(id)
    // 排队中的没有人在听这个标志，直接定终态；在跑的交给任务自己收尾
    if (rec.state === 'queued') {
      setState(id, { state: 'cancelled', finishedAtMs: now() })
      cancelFlags.delete(id)
      notify()
      return true
    }
    notify()
    return true
  }

  return {
    tasks: snapshot,
    enqueue: (input) => {
      const existing = find(input.id)
      if (existing && !isTerminal(existing.state)) {
        return { task: { ...existing }, duplicate: true }
      }
      // 同一个 id 重开一次（改完参数再点）：丢掉上一次的记录，浮标才不会挂着三条同名历史
      if (existing) {
        const i = records.indexOf(existing)
        if (i >= 0) records.splice(i, 1)
      }
      const rec: ComposeTaskRecord<R> = {
        id: input.id,
        label: input.label,
        state: 'queued',
        pageBound: input.pageBound === true,
        ratio: 0,
        coveredSec: 0,
        expectedSec: 0,
        engine: null,
        phase: null,
        failureCode: '',
        result: null,
        queuedAtMs: now(),
        startedAtMs: null,
        finishedAtMs: null,
      }
      records.push(rec)
      inputs.set(input.id, input)
      notify()
      pump()
      return { task: { ...rec }, duplicate: false }
    },
    cancel: cancelInternal,
    dismiss: (id) => {
      const rec = find(id)
      if (!rec || !isTerminal(rec.state)) return false
      const i = records.indexOf(rec)
      if (i >= 0) records.splice(i, 1)
      inputs.delete(id)
      notify()
      return true
    },
    active: () => {
      const id = running
      return id ? { ...find(id)! } : null
    },
    runningCount: () => (running ? 1 : 0),
    subscribe: (listener) => {
      listeners.add(listener)
      listener(snapshot())
      return () => { listeners.delete(listener) }
    },
    idle: () => {
      if (running === null && !records.some((t) => !isTerminal(t.state))) return Promise.resolve()
      return new Promise<void>((resolve) => { idleWaiters.push(resolve) })
    },
  }
}
