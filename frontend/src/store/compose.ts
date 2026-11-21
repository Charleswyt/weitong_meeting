/**
 * 应用级合成任务队列：任务活在这里，不活在回放页的组件里。
 *
 * 为什么必须在 store（口径 §9.4）：本轮选离线引擎的理由就是"点完可以离开这一页"，
 * 而任务挂在组件局部 ref 上时，换路由 = 组件卸载 = 任务丢。所以列表页与回放页都只做两件事：
 * **dispatch** 与 **读状态**；进度浮标只挂在 `MainLayout` 一处。
 *
 * 三条口径：
 * - 并发 = 1（队列那份纯状态机保证），其余排队；两个任务并行会把解码吞吐摊薄，双双变慢。
 * - 引擎在这里按成本模型选（等速也选离线），**降级必须如实说一句**，不许静默换实现。
 * - 重复点同一个任务不许静默吞掉：给一句"已在队列里"，否则用户以为没响应。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  createComposeQueue,
  type ComposeTaskRecord,
  type QueueCtl,
} from '@/utils/offlineCompose/composeQueue'
import {
  pickComposeEngine,
  partialSeconds,
  probeEngineCapabilities,
  defaultDurationOf,
  type ComposeCtl,
  type ComposeLane,
  type ComposeOutcome,
  type ComposeSpec,
  type EngineCapabilities,
} from '@/utils/offlineCompose/engine'
import { composeFailureText, composeEngineNote, composeNotice } from '@/utils/offlineCompose/composeCopy'
import { planDiskGuard } from '@/utils/offlineCompose/costModel'
import { autoCols, type LayoutMode } from '@/utils/composeLayout'
import { downloadBlob, storageHeadroom } from '@/utils/localRecorder'
import { businessDirStamp, humanizeSize } from '@/utils/time'

type TaskRecord = ComposeTaskRecord<ComposeOutcome>

export interface ComposeDispatchInput {
  /** 去重键：同一场同一参数重复点只算一个任务 */
  id: string
  /** 浮标与提示里认这一场用的短名 */
  label: string
  spec: ComposeSpec
  /**
   * 实时引擎的执行体。画面来源是回放页上那些媒体元素，所以**只有那一页能给**；
   * 不给就意味着这一场只能走后台合成（走不了就如实说，不硬跑）。
   * 参数给的是引擎无关的 `ComposeCtl`：实时/后台两条路对调用方长得一样，换页时少一份状态。
   */
  runRealtime?: (ctl: ComposeCtl) => Promise<ComposeOutcome>
  /** 关掉自动落下载目录（探针、只想拿产物的调用方） */
  autoDownload?: boolean
  /**
   * 结果之后还要补的那几句（如"这几路的文件本来就是坏的，成品里那几段是缺的"）。
   * 由调用方在派单前算好：这些是**关于素材**的事实，不是关于这次合成的结局，内核不该知道它。
   */
  followUpNotices?: string[]
}

function classifyOutcome(r: ComposeOutcome) {
  if (r.kind === 'ok') return 'succeeded' as const
  if (r.kind === 'cancelled') return 'cancelled' as const
  if (r.kind === 'stalled') return 'stalled' as const
  return 'failed' as const
}

/**
 * 任务键：同一场 + 同一批勾选 + 同一列数只算一个任务（改了参数就是另一件成品，各自排队）。
 * 放在 store 这一侧而不是页面里：列表页与回放页要对**同一个任务**说话，两边各拼一次迟早分叉。
 */
/**
 * 任务键：同一条录制 + 同一份形状 = 同一个任务（幂等，重复点不排队两次）。
 * 形状必须带上**档与主画面**：只带列数的话，"宫格 2 列"和"主画面在右 2 列"会撞成同一个键，
 * 后点的直接被当成"已在队列里"吞掉，用户等到的是一个没在排的形状。
 */
export function composeTaskIdOf(
  scopeKey: string,
  lanes: readonly ComposeLane[],
  shape: { mode: LayoutMode; cols: number; focusId?: string | null },
): string {
  const sel = lanes.map((l) => `${l.id}#${l.hasVideo ? 'v' : ''}${l.hasAudio ? 'a' : ''}`).sort().join(',')
  return `compose:${scopeKey}:${shape.mode}:${shape.cols}:${shape.focusId || ''}:${sel}`
}

function modeLabel(mode: LayoutMode, cols: number): string {  if (mode === 'grid') return `${cols}列`
  return mode === 'top' ? '顶部' : '右侧'
}

/** 与实时路径同一套命名：形状 + 时刻，半截件在名字里就写清只到第几秒 */
function composeFileName(spec: ComposeSpec, outcome: ComposeOutcome, partialSec: number | null): string {
  const videoCount = spec.lanes.filter((l) => l.hasVideo).length
  const cols = spec.cols ?? autoCols(videoCount)
  const tail = partialSec != null ? `-只有前${Math.max(1, Math.round(partialSec))}秒` : ''
  return `合成-${modeLabel(spec.mode, cols)}-${businessDirStamp(Date.now())}${tail}.${outcome.ext || 'mp4'}`
}

export const useComposeStore = defineStore('compose', () => {
  const tasks = ref<TaskRecord[]>([])
  const caps = ref<EngineCapabilities | null>(null)
  let capsPromise: Promise<EngineCapabilities> | null = null

  const queue = createComposeQueue<ComposeOutcome>({ classify: classifyOutcome })
  queue.subscribe((list) => { tasks.value = list as TaskRecord[] })

  function ensureCaps(): Promise<EngineCapabilities> {
    if (caps.value) return Promise.resolve(caps.value)
    if (!capsPromise) {
      capsPromise = probeEngineCapabilities().then((c) => {
        caps.value = c
        capsPromise = null
        return c
      })
    }
    return capsPromise
  }

  const activeTask = computed(() => tasks.value.find((t) => t.state === 'running') ?? null)
  const queuedCount = computed(() => tasks.value.filter((t) => t.state === 'queued').length)
  /** 离开页面的守卫只对实时任务生效：离线任务不依赖这一页的元素 */
  const hasPageBoundWork = computed(() => tasks.value.some((t) => t.pageBound && (t.state === 'running' || t.state === 'queued')))

  /** 落盘 + 一句话结果。文案全从这里出，页面不再各写一套 */
  function deliver(input: ComposeDispatchInput, outcome: ComposeOutcome, spec: ComposeSpec) {
    const fullSec = outcome.durationSec
    const madeSec = partialSeconds(outcome)
    const file = outcome.blob && outcome.blob.size > 0 ? outcome.blob : null

    if (file && input.autoDownload !== false) {
      const name = composeFileName(spec, outcome, madeSec)
      downloadBlob(name, file)
      ElMessage.success(madeSec != null
        ? `已下载到浏览器下载目录：${name}（这条只到 ${madeSec} 秒，整场 ${Math.round(fullSec)} 秒）`
        : `已下载到浏览器下载目录：${name}`)
    } else if (outcome.kind === 'cancelled') {
      ElMessage.info('已取消合成')
    } else if (outcome.kind === 'ok') {
      ElMessage.success(`${input.label} 合成完成`)
    } else {
      ElMessage.error(composeFailureText(outcome.failureCode ?? outcome.reasons[0] ?? ''))
    }
    // 素材本身的问题跟在结果后面说：用户是拿着产物判断缺没缺的人，先报结局再报成因
    for (const n of input.followUpNotices || []) ElMessage.warning(n)
    const notice = composeNotice(outcome.reasons)
    if (notice) ElMessage.warning(notice)
  }

  async function execute(
    input: ComposeDispatchInput,
    spec: ComposeSpec,
    capsNow: EngineCapabilities,
    engine: 'offline' | 'realtime',
    ctl: QueueCtl,
  ): Promise<ComposeOutcome> {
    const innerCtl: ComposeCtl = {
      onProgress: (p) => ctl.onProgress({
        ratio: p.ratio,
        coveredSec: p.coveredSec,
        expectedSec: p.expectedFrames ? p.expectedFrames / Math.max(1, spec.fpsOut ?? 15) : spec.durationSec,
        engine,
        phase: p.phase,
      }),
      cancel: () => ctl.cancel(),
      isCancelled: () => ctl.isCancelled(),
    }
    if (engine === 'offline') {
      // 动态引入：合成内核只在有任务时才需要，别把它压进首屏
      const m = await import('@/utils/offlineCompose/composeOffline')
      return m.composeOffline(spec, innerCtl, capsNow)
    }
    if (input.runRealtime) return input.runRealtime(innerCtl)
    // 判据说该走实时、但这一页没给实时执行体（列表页就是这种）：后台还能力可行就照跑，
    // 否则如实说一句，不静默交出一个坏文件
    if (capsNow.offlineCapable) return (await import('@/utils/offlineCompose/composeOffline')).composeOffline(spec, innerCtl, capsNow)
    return {
      engine: 'realtime', kind: 'failed', mime: '', ext: 'mp4', coveredSec: 0, durationSec: spec.durationSec ?? 0,
      droppedAudioLanes: [], placeholderLanes: [], skippedAnomalousLanes: [], unusableVideoLanes: [],
      reasons: ['no_realtime_runner'],
    }
  }

  /**
   * 派一个合成任务。返回 `{ duplicate }`：调用方据此决定要不要把按钮变灰，
   * 但**不返回 Promise 等结果** —— 结果走状态订阅，这是"可以离开这一页"的前提。
   */
  async function dispatch(input: ComposeDispatchInput): Promise<{ id: string; duplicate: boolean; engine: 'offline' | 'realtime' }> {
    const capsNow = await ensureCaps()
    // 护栏 (d)：唯一该**硬拒**的一条（其余三条都是降级 + 如实说明）。
    // 量不到余量的浏览器照常放行 —— 不许因为量不出来而拦人。
    const headroom = await storageHeadroom()
    if (headroom) {
      const guard = planDiskGuard({
        durationSec: input.spec.durationSec ?? defaultDurationOf(input.spec),
        hasVideo: input.spec.lanes.some((l) => l.hasVideo),
        hasAudio: input.spec.lanes.some((l) => l.hasAudio && !l.audioMuted),
        availableBytes: headroom.availableBytes,
      })
      if (!guard.ok) {
        ElMessage.error(`剩余空间放不下这份成品（约需 ${humanizeSize(guard.productBytes)}）。先删几场旧录制，或少勾几路画面`)
        return { id: input.id, duplicate: false, engine: 'offline' }
      }
    }
    const choice = pickComposeEngine(input.spec, capsNow)
    const note = composeEngineNote(choice.reasons, choice.engine)
    if (note) ElMessage.info(note)
    const { task, duplicate } = queue.enqueue({
      id: input.id,
      label: input.label,
      pageBound: choice.engine === 'realtime' && input.runRealtime != null,
      run: async (ctl) => {
        const outcome = await execute(input, input.spec, capsNow, choice.engine, ctl)
        deliver(input, outcome, input.spec)
        return outcome
      },
    })
    if (duplicate) ElMessage.info(`这场已经在队列里了（${task.label}）`)
    return { id: input.id, duplicate, engine: choice.engine }
  }

  /**
   * 派单前先问一嘴"这场会走哪条路"。它存在的理由只有一个：实时引擎要陪放一整场，
   * 得让用户先点头；后台合成不需要（不占前台，点下去就能走，还能离开这一页）。
   */
  async function previewEngine(spec: ComposeSpec): Promise<{ engine: 'offline' | 'realtime'; reasons: string[] }> {
    const c = await ensureCaps()
    const { engine, reasons } = pickComposeEngine(spec, c)
    return { engine, reasons }
  }

  function cancel(id: string): boolean { return queue.cancel(id) }
  function dismiss(id: string): boolean { return queue.dismiss(id) }
  function idle(): Promise<void> { return queue.idle() }

  /**
   * 登出/换账号时忘掉所有任务。队列是内存态、不跟着身份走 —— 不清的话，
   * 下一个登录的人能在进度浮标上看见并下载上一个人合成的那一场（那正是隔离要挡的事）。
   * 先取消在跑与排队的，再连同已结束的条目一起摘掉。
   */
  function forgetAll(): void {
    for (const t of [...tasks.value]) {
      if (t.state === 'queued' || t.state === 'running') cancel(t.id)
    }
    for (const t of [...tasks.value]) dismiss(t.id)
  }

  return {
    tasks,
    caps,
    activeTask,
    queuedCount,
    hasPageBoundWork,
    dispatch,
    previewEngine,
    cancel,
    dismiss,
    forgetAll,
    idle,
    ensureCaps,
  }
})
