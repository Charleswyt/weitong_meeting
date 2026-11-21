// 录制列表的翻页合并。
//
// 为什么需要去重（2026-10-01 现场"云端录制列表好像有重复"）：后端按 offset 翻上游目录，
// 而目录本身一直在变（会议结束、录制归档、用户删除）—— 两次请求之间偏移会滑动，
// 同一条录制可能既出现在第 1 页、又出现在第 2 页；前端再 `concat` 就成了用户看到的两行 "重复"。
// 后端已按 recordingId 去过一次重（`service/dedupeRecordings`），这里再兜一层：
// **列表里同一条录制只许渲染一行**，与后端分页怎么滑无关。
//
// 判据只看 `recordingId`：它是"一条录制"的唯一标识；标题/参会者/时长相同都不代表是同一条
// （同一场会里同一种通路本来就可能有多条）。没有 id 的行去不了重，照原样保留。

export interface HasRecordingId {
  recordingId: string
}

/** 把新到的一页并进已有列表：同 id 只留第一次出现的那行，其余按到达顺序追加。 */
export function mergeUniqueRecordings<T extends HasRecordingId>(prev: readonly T[], next: readonly T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const row of prev) {
    if (!row.recordingId) {
      out.push(row)
      continue
    }
    if (seen.has(row.recordingId)) continue
    seen.add(row.recordingId)
    out.push(row)
  }
  for (const row of next) {
    if (!row.recordingId) {
      out.push(row)
      continue
    }
    if (seen.has(row.recordingId)) continue
    seen.add(row.recordingId)
    out.push(row)
  }
  return out
}

// —— 按**场次**聚合（2026-10-01 用户定：云端那栏一场会一张卡，卡内列出这一场的每一路）——

export interface GroupableRecording {
  recordingId: string
  meetingId: string
  /**
   * **三方会议号**（契约 §6.5：本域唯一的入会号，没有"本地会议号"这种东西）。
   * 云端由线格式恒出现保证，本机由录制时那条会话头保证 —— 两侧都有，所以这里不给可选性。
   * 挂不到会的历史孤立录像给空串，界面按空串如实说，不许拿别的键顶上。
   */
  meetingNo: string
  participant: string
  /** 通路（回放页的"路"就按它 + 参会者分组）；列表里可能为空（未识别）——按回放页的规则当摄像头 */
  mediaKind?: string
  recordingType: 'cloud' | 'local'
  durationSec: number
  fileSizeBytes: number
  deletable: boolean
  startedAt: string
  /**
   * 后端对**这一场全部条目**算出的起点与跨度（契约 §6.5、ADR-0076 三）。
   * 列表是按条翻页的，一场会最早那几行最后才到 —— 卡片那两个数不能由已加载的行推。
   * 本机条目没有（它一条就是一场），缺失时退回 `sessionSpanSec(已加载行)`。
   */
  meetingStartedAt?: string
  meetingSpanSec?: number
}

export interface RecordingGroup<T> {
  /** 稳定键：`cloud:<会议id>`；本机条目各自成组（它一次会话里本来就含多路） */
  key: string
  /** 这一场的**三方会议号**（卡片那一行读它）；空串 = 三方目录里挂不到会的那类孤立录像 */
  meetingNo: string
  /** 组内的每一路**文件**（按下发顺序，列表本身是按开始时间倒序的） */
  lanes: T[]
  /**
   * 进回放页之后能看到的**路**数 —— 与回放页同一口径（「参会者 × 通路」去重）。
   *
   * 两个数不是一回事：同一人中途退会再入会产生**两份画面文件**，回放页把它们并成**一条路**
   * （`cloudReplay.ts` 的 `${owner}::${kind}` 归组），所以 文件数 ≥ 路数。
   * 卡片上那个数字必须是本字段（用户 2026-10-01 定"报回放路数"），否则与进去看到的对不上。
   */
  laneCount: number
  /**
   * 上面的路数按通路拆开（画面 / 声音 / 共享屏幕）—— 卡片那行照本机卡片的写法，
   * 给的是明细而不是一个总数（"1 路画面 · 1 路声音"）。
   * 三条相加恒等于 `laneCount`（每条路只归一类，视频与屏幕分开算），测试里有这条不变式。
   */
  laneBreakdown: { video: number; audio: number; screen: number }
  /** 组里最早那一路的开始时间：这张卡说的是"这一场从什么时候开始录的"（后端聚合优先，见上） */
  startedAt: string
  /**
   * 这一场的时间轴跨度（`max(起点 + 时长) − min(起点)`），与回放页同一个数。
   * 云端优先取后端聚合（该场全集），本机退回已加载行 —— 两条都是跨度，不是"最长那一路"。
   */
  durationSec: number
  /** 各路字节之和（每一路都是一个独立文件，加起来才是这一场占的空间） */
  fileSizeBytes: number
  /** 全部路都可删才可删（三方的删除是**整场**粒度，见 §6.5） */
  deletable: boolean
}

/** 回放页的路键：与 `utils/cloudReplay.ts` 的 `kindOf` + `${owner}::${kind}` 逐字对齐，别在这里另立映射。 */
function playbackLaneKey(r: GroupableRecording): string {
  const kind = r.mediaKind === 'audio' ? 'microphone' : r.mediaKind === 'screen' ? 'screen' : 'camera'
  return `${r.participant || '未知参会者'}\u0000${kind}`
}

/** 卡片明细里归哪一类：声音 / 共享屏幕 / 画面（空 mediaKind 与回放页一样当摄像头 → 画面）。 */
function laneKind(r: GroupableRecording): 'video' | 'audio' | 'screen' {
  return r.mediaKind === 'audio' ? 'audio' : r.mediaKind === 'screen' ? 'screen' : 'video'
}

/**
 * 把列表按**场次**聚成一张卡。
 *
 * 为什么云端要聚：三方归档的单位是**一路发布**（一个人的摄像头、麦克风、屏幕共享各一条 recording，
 * 各有自己的 id/时长/下载地址），一场会平铺出来就是十几行、标题还都是同一个会议名 ——
 * 看起来像"重复"（2026-10-01 现场）。聚起来之后一张卡 = 这一场，卡上写清有几路、有谁，
 * 卡内按参会者分组选一路去播/去下。
 *
 * 本机条目**不聚**：它一条就是一次录制会话，几路已经在会话里面（回到回放页才展开），
 * 所以给它一个唯一键各自成组，与云端走同一条渲染路径。
 */
/**
 * 一场会"录了多久"的**唯一算法**：时间轴跨度 = max(起点 + 时长) − min(起点)。
 *
 * 从前这里写的是 `max(l.durationSec)`（"最长的那一路"），而回放页与合成用的是另一条
 * `max(offsetSeconds + durationSeconds)`（跨度末端）—— 同一个"时长"两个数，
 * 实测同一场会卡片 3:54、回放页 6:28。差值恰好等于"最晚开始那一路的偏移"，
 * 因为云端**一条 recording = 一路发布**，中途入会的那路起点不在 0。
 * 本地那侧 `durationSec` 本来就是一场的跨度，所以这个公式对本地退化成原值，不改行为。
 */
export function sessionSpanSec(rows: Array<{ startedAt: string | number; durationSec: number }>): number {
  let minStart = Infinity
  let maxEnd = -Infinity
  for (const r of rows) {
    const start = typeof r.startedAt === 'number' ? r.startedAt : Date.parse(r.startedAt)
    if (!Number.isFinite(start)) continue
    const end = start + Math.max(0, r.durationSec || 0) * 1000
    if (start < minStart) minStart = start
    if (end > maxEnd) maxEnd = end
  }
  if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) return 0
  return Math.max(0, Math.round((maxEnd - minStart) / 1000))
}

export function groupRecordingsBySession<T extends GroupableRecording>(rows: readonly T[]): RecordingGroup<T>[] {
  const byKey = new Map<string, T[]>()
  const order: string[] = []
  for (const row of rows) {
    // 「场次」= 会议 **ID**（不是会议主题、也不是会议号码串）：`RecordingVo.meetingId`，三方录像目录里
    // 每条 recording 都带它，而"进回放页"那一步也是拿同一个 id 去取数（`/recordings/{id}/playback`）——
    // 卡片的分组键与进回放页取数是**同一个参数**，这是"卡片路数与进去看到的对得上"的前提。
    // 主题只在卡标题上显示：两场会主题相同（例如都叫"临时会议"）时它们是两张卡，靠开始时间区分。
    // meetingId 为空的孤行**不能合并**（`cloud:` 会把不相关的几场并成一张假卡）：各按 recordingId 自成一卡。
    const key =
      row.recordingType === 'local' || !row.meetingId
        ? `${row.recordingType === 'local' ? 'local' : 'cloud-orphan'}:${row.recordingId}`
        : `cloud:${row.meetingId}`
    const arr = byKey.get(key)
    if (arr) arr.push(row)
    else {
      byKey.set(key, [row])
      order.push(key)
    }
  }
  return order.map((key) => {
    const lanes = byKey.get(key)!
    // 卡片那两个数先取**后端聚合**（该场全集算出来的）：列表按条翻页，翻页只到一半时已加载的行里
    // 没有这一场最早那几行，按它们算开始时刻会偏晚、跨度会偏短（ADR-0076 三，实测 1297 vs 1423）。
    // 同一场每一行带的本该是同一个数，这里取最早锚/最大跨度只是兜住上游偶发不齐。
    let anchor = ''
    let span = 0
    let meetingNo = ''
    for (const l of lanes) {
      const a = l.meetingStartedAt
      if (a && (!anchor || Date.parse(a) < Date.parse(anchor))) anchor = a
      if (l.meetingSpanSec && l.meetingSpanSec > span) span = l.meetingSpanSec
      // 同一场各路带的本该是同一个三方号；上游不齐时取第一个拿得到的，一个都没有才留空串
      if (!meetingNo) meetingNo = l.meetingNo
    }
    let startedAt = anchor || lanes[0].startedAt
    for (const l of lanes) if (Date.parse(l.startedAt) < Date.parse(startedAt)) startedAt = l.startedAt
    // 路（去重后的「参会者 × 通路」）决定卡片上的数字与明细；文件（lanes）只决定大小与下载
    const laneKinds = new Map<string, 'video' | 'audio' | 'screen'>()
    for (const l of lanes) laneKinds.set(playbackLaneKey(l), laneKind(l))
    const laneBreakdown = { video: 0, audio: 0, screen: 0 }
    for (const kind of laneKinds.values()) {
      if (kind === 'audio') laneBreakdown.audio++
      else if (kind === 'screen') laneBreakdown.screen++
      else laneBreakdown.video++
    }
    return {
      key,
      meetingNo,
      lanes,
      laneCount: laneKinds.size,
      laneBreakdown,
      startedAt,
      // 聚合是全集算出来的权威值，但已加载行给出的是一个**可证的下界**（子集的跨度不可能大于全集）：
      // 两者打架（上游不齐）时取大的那个，宁可不少报也不要报出一个我们已经知道偏短的数。
      durationSec: Math.max(span, sessionSpanSec(lanes)),
      fileSizeBytes: lanes.reduce((a, l) => a + (l.fileSizeBytes || 0), 0),
      deletable: lanes.every((l) => l.deletable),
    }
  })
}
