// 主画面那一路的「原始速率 / 压缩比 / 节省带宽」口径收口在这一处：
// 悬浮统计条（InMeetingView）与侧栏会议信息卡（MainLayout）共用，禁止两处各算一遍。
//
// 口径照三方**两个**页面的实现逆向而来 —— 取证副本 `../../scratch/tp-meeting.js`（会议页，下称 tp，
// 副本哈希 `9f519d23a7358482`）与工作区根 `scratch/app.js`（流媒体看板，下称 app）。
// **引用一律用符号名不用行号**：那两份副本由门禁 G11 按哈希锁着，三方一改版本号行号就全漂。
//
// 〔口径出处补正，2026-11-05 探测〕这三项**只有三方的船端 legacy 会议页有**。三方的云端会议页是另一套
// 实现（`ocean-vue`，副本 `../../scratch/tp-ocean-workspace-core.cloud.js`，哈希 `28488e9dc2718e20`），
// 那里只有一块**聚合**带宽（`session.cloudVideoBitrateKbps` 求和 → Mbps、`ingestTotalBytes` → 累计 MB），
// 没有原始速率/压缩比/节省带宽；且云端 `/meeting` 已退役、只跳转到 `ocean-meeting.html`。
// 所以本文件是实现"船端那一套"的口径，云端页面上的这三项属我方自研 —— 别写成"照三方云端"。
// 实测与探针：`../evidence/2026-11-05-三方云边客户端探测.md`、`../scratch/probe-vendor-clients.mjs`。
//   原始速率 = **发布方自己 getStats 实测出来的编码码率**，由三方在发布记录里上报
//     （我方 `streams[].sourceBitrateKbps`，就是它的 sourceVideoBitrateKbps）；
//   压缩后速率 = 这一路在本端实测到的收发字节速率；
//   压缩倍率 = 原始 ÷ 压缩后（tp 的 `compressionText`），**只在原始确实高于压缩后时才给数**；
//     三方对没经过二次压缩的那一路根本不报倍率，直接写「直传（无 ROI 二次压缩）」；
//   节省带宽 = **百分比，不是速率差值**（app 的 `compressionFieldsFrom`）。三方会议页没有这个量
//     （`节省` 在 tp 里 0 命中），看板才有，所以这一格的口径来自看板那一族。
//
// 单位换算一律 SI（÷1000）并按量级切换显示单位，四处证据一致：app 的 `formatKbpsAsMbps` = `/1000`、
// `formatTrafficMegabytes` = `/1000000`、tp 的 `samplePeerRates` 采样公式 `kbps = Δbytes*8/Δms`
// （即 SI kbit/s）、`formatTransportRate` = `/1000` 且 `value >= 1000 ? Mbps : kbps`。
// 此前这里用 `/1024`、而生产端 `useWhipPublish.ts` 用 `/1000`，两个不同刻度的数相除让倍率系统性偏大约 2.4%，
// 1000 kbps 还被显示成 0.98 Mbps、74 kbps 显示成 0.07 Mbps（2026-11-04 实测确有这么低的轨）。
//
// 这里曾经用「分辨率 × 帧率 × YUV420 每像素 1.5 字节」当原始速率，那是**未压缩基线**、
// 和编码码率不是一个量纲：1080p30 的基线是 700+ Mbps，除上 600 kbps 的实传能得出上千比一，
// 用户看到的「节省带宽 99.x%」就是这么来的（第 26 项：这数夸张得像假的）。
// 未压缩基线只能说明"摄像机原始数据有多大"，不能冒充"这一路省了多少带宽"，故已删除。
//
// 任一字段拿不到时返回 0 / —，调用方不得拿 0 或猜测值冒充真实数据（项目硬规则）。
// 守卫是 `<= 0`，而 **NaN 过不了它**（NaN <= 0 为 false）；两个生产端都按
// `bytes >= prevBytes` 门掉了 NaN 增量（useWhipPublish.ts、whepPlayer.ts），
// 将来接新数据源时若没有同一道门，请在本函数里显式挡，别指望 0 分支。

/**
 * 压缩比的分母量在**哪条腿**上。这是本文件唯一持有这个信息的地方 —— 调用方只负责报告
 * "这一路是不是我自己发的"，不许自己挑分母（挑分母就是口径的第二处实现）。
 *   ingress = 与分子同一条腿（发布端编码输出 vs 这一路进入分发面时实测到的出站码率）
 *   egress  = 跨腿（分子在对方那侧，分母在本机接收这侧）
 * 三方自己也是这么分的：本端那一路（ownRows）用 `upstreamVideoBitrateKbps` 做分母，
 * 远端那一路（remoteRows）传的是裸的本机接收速率。
 */
export type RateBasis = 'ingress' | 'egress'

export interface CompressionInput {
  videoStats?: { decodedFrameKbps: number | null; publishKbps: number | null; cloudOutputKbps: number | null }
  receivedVideoKbps?: number | null
  sourceKbps: number
  transmittedKbps: number
  /** 必填、**没有默认值**：漏了编译不过，免得新接一路时静默按跨腿算出一个看着合理的倍率。 */
  basis: RateBasis
  compressionKind?: string
  reportedRatio?: number
  reportedEstimate?: boolean
}

/**
 * 分母的唯一取处。三方对本端发布用的分母与分子在**同一条腿**上，
 * 所以本端那一路**绝不许回落到本端接收速率** —— 那是另一条腿的数，混进来倍率就没有意义。
 * 取不到就是 0（消费方显示"统计中"），不许拿另一个数顶。
 */
export function pickTransmittedKbps(o: {
  isSelfPublished: boolean
  ingressBitrateKbps: number
  localReceivedKbps: number
}): { transmittedKbps: number; basis: RateBasis } {
  return o.isSelfPublished
    ? { transmittedKbps: Math.max(0, o.ingressBitrateKbps), basis: 'ingress' }
    : { transmittedKbps: Math.max(0, o.localReceivedKbps), basis: 'egress' }
}

export interface CompressionView {
  rawText: string
  ratioText: string
  /** 节省带宽，百分比文本（含「节省 / 估算节省」前缀）。 */
  savedText: string
  /** 分母量在哪条腿上的一句话说明，供 tooltip 用 —— 不进任何算术。 */
  basisText: string
  /** false 表示这一路没有可报的压缩收益，ratioText 里是「直传」而不是倍率 */
  compressed: boolean
  /**
   * false = 这一路**根本没有"压缩前/压缩后"这组量**（直传，没经过二次压缩）。
   * 它与"数还没到"是两件事：前者界面上该合成一行说清楚，后者才该摆着格子写"统计中"。
   * 混成同一个 `—`，用户就分不清"这一路坏了"还是"这一路本来就没有这个量"。
   */
  applicable: boolean
  /** applicable=false 时界面该显示的整句（口径在这一处，不在模板里拼）。 */
  summaryText: string
}

const DIRECT_TEXT = '直传'
const DIRECT_SUMMARY = '直传（没有额外压缩）'
const PENDING_TEXT = '统计中'

/**
 * 速率文本：kbps 入，可空（成员栏那两格的上行本来就测不到，类型是 number|null）。
 * 按量级切换单位（照三方会议页的 `formatTransportRate`），换算用 SI ÷1000。
 * 非正数与 NaN 一律 —，不写 0 冒充测到过。
 * **这是全仓唯一的 kbps→Mbps 换算处**，别在组件里再除一次
 * （`MemberPanel.vue` 的 `mbpsText` 曾是第二份、且用 /1024，已删并改调这里）。
 */
export function rateText(kbps: number | null | undefined): string {
  const v = Number(kbps)
  if (!(v > 0)) return '—'
  return v >= 1000 ? (v / 1000).toFixed(2) + ' Mbps' : v.toFixed(2) + ' kbps'
}

export function measuredRateText(value: number | null | undefined): string {
  return value === 0 ? '0 kbps' : rateText(value)
}

export function fpsText(value: number | null | undefined): string {
  return value == null ? '—' : Number(value.toFixed(1)) + ' fps'
}

/**
 * 紧凑写法：**只去掉单位前的空格，不重算**（换算仍只有 rateText 一处）。
 * 原型对两种排布要求不同 —— 顶部缩略条是带标签的「总上行速率 / 1.25 Mbps」（有空格，
 * 与三方 `formatTransportRate` 同形），宫格与成员面板是「↑1.25Mbps ↓3.82Mbps」（无空格）。
 * 见 `views/meeting/InMeetingView.vue` 宫格那一行的注释。
 */
export function rateTextCompact(kbps: number | null | undefined): string {
  return measuredRateText(kbps).replace(' ', '')
}

/** 节省百分比 = clamp((1 − 压缩后 ÷ 原始) × 100, 0, 100)，照看板 `compressionFieldsFrom`。 */
function savingPercent(sourceKbps: number, transmittedKbps: number): number {
  return Math.max(0, Math.min(100, (1 - transmittedKbps / sourceKbps) * 100))
}

/**
 * 只有上报倍率时的反推：`倍率 = 原始 ÷ 压缩后` ⇒ `压缩后 ÷ 原始 = 1 ÷ 倍率`，纯代数、不引入新信息。
 * 三方看板优先用服务端给的 `bandwidthSavingPercent`、缺失才自算（`compressionFieldsFrom`），
 * 而那个字段**不在会议链路的 transportMetrics 里**（它属看板 `/api/frontend/lanes/{id}` 家族），
 * 所以这条链路上反推是唯一诚实路径。
 */
function savingPercentFromRatio(ratio: number): number {
  return Math.max(0, Math.min(100, (1 - 1 / ratio) * 100))
}

// 分母量在哪条腿，只用来说清"这两个数各量在哪"，不做任何解释 —— 免得替用户下结论。
// 它是全仓唯一一处这句话，悬浮条与侧栏都照抄，别在模板里再写一遍。
const BASIS_INGRESS_TEXT = '两个数都量在发布这一侧：本机编码器输出与出站实测，差值里含上行链路损耗与采样抖动，不是压缩收益'
const BASIS_EGRESS_TEXT = '两个数分别量在两侧：对方上行与本机下行，差值里含网络损耗'

/**
 * @param sourceKbps 该路的**编码码率**（本端=自己 getStats 实测，远端=后端给的 sourceBitrateKbps）
 * @param transmittedKbps 该路在本端实测到的传输速率（取自 `pickTransmittedKbps`，不在这里挑）
 * @param basis 上面那个数量在哪条腿。它**只进 `basisText`，不进任何算术** —— 但两条腿
 *   **报不报倍率**不同：`egress` 照常算；`ingress`（本端发布那一路）**不给倍率也不给节省百分比**，
 *   理由是同侧分母是平台的瞬时出站量、抖动 ±30% 且会倒挂（证据见函数内的注释）。
 * @param compressionKind 后端判好的"这一路经过哪一道二次压缩"。**报不报倍率以它为准**，
 *   不靠数值大小猜（三方就是这么分的）；只有 'unknown'（后端没拿到判据）才退回数值守卫。
 * @param reportedRatio 三方在发布记录里直接上报的压缩倍率（transportMetrics.compressionRatio）：
 *   本端两个数凑不出倍率时用它。三方自己就是这么退的，不是我方发明的兜底。
 *   **`basis='ingress'` 时不用它** —— 实测那个字段就是同一对瞬时量的商，抖动同源。
 * @param reportedEstimate 那个上报值是实测还是估算 —— 三方用这个词区分，界面照实标出来。
 *   **前缀适用于任何来源的数值**（会议页 `compressionText` 就是这么写的），不只退回分支。
 *   两套前缀分别对齐各自来源、不混用：倍率是「压缩 / 估算」（`compressionText`），
 *   节省是「节省 / 估算节省」（看板 `formatCompressionEffect`）。
 */
export function compressionView(i: CompressionInput): CompressionView {
  const {
    sourceKbps, transmittedKbps, basis,
    compressionKind = 'unknown', reportedRatio = 0, reportedEstimate = false,
  } = i
  if (i.videoStats) {
    const { decodedFrameKbps, publishKbps, cloudOutputKbps } = i.videoStats
    const received = i.receivedVideoKbps != null && i.receivedVideoKbps > 0
    const output = received ? i.receivedVideoKbps! : cloudOutputKbps
    const direct = compressionKind === 'none'
    const ratio = !direct && publishKbps != null && publishKbps > 0 && output != null && output > 0
      ? publishKbps / output : null
    return {
      rawText: measuredRateText(decodedFrameKbps),
      ratioText: direct ? DIRECT_TEXT : ratio == null ? '—' : ratio.toFixed(2) + '×',
      savedText: ratio == null ? '—' : (Math.max(0, 1 - 1 / ratio) * 100).toFixed(1) + '%',
      basisText: direct ? '原始转发' : received ? '发布端视频上行 ÷ 本端视频实收' : '发布端视频上行 ÷ 云端视频输出',
      compressed: ratio != null, applicable: !direct, summaryText: direct ? DIRECT_SUMMARY : '',
    }
  }
  const basisText = basis === 'ingress' ? BASIS_INGRESS_TEXT : BASIS_EGRESS_TEXT
  // 判了"没二次压缩"的那一路，三方连原始码率都不报（直接 return 那句直传）——
  // 这一组量对它不适用，不是它缺数。这一支**先于 basis**：直传那一路没有"两个数"可谈论。
  if (compressionKind === 'none') {
    return {
      rawText: DIRECT_TEXT, ratioText: DIRECT_TEXT, savedText: DIRECT_TEXT, basisText: '',
      compressed: false, applicable: false, summaryText: DIRECT_SUMMARY,
    }
  }
  const ratioPrefix = reportedEstimate ? '估算 ' : '压缩 '
  const savedPrefix = reportedEstimate ? '估算节省 ' : '节省 '
  const hasBoth = sourceKbps > 0 && transmittedKbps > 0
  const hasGain = hasBoth && sourceKbps > transmittedKbps
  const rawText = sourceKbps > 0 ? rateText(sourceKbps) : PENDING_TEXT

  // 本端发布那一路（同侧分母）：**这一支不报倍率，也不报节省百分比**。
  //
  // 判据是实测，不是取舍：两个数虽然在同一条腿上，但分母是平台侧的**瞬时**出站量，
  // 秒级就摆 ±30%，而分子每 2–4 秒才更新一次。2026-11-05 云边对拍 30 s × 2 s：
  // 中位 1.39、最小 0.74（**倒挂**）、最大 1.84；1 s 粒度下同一秒内能得出 0% 与 43% 两个"节省"。
  // 证据：evidence/2026-11-05-同侧分母配对-云边对拍.md。
  //
  // 连三方自己上报的 `compressionRatio` 也救不了：实测它就是同一对瞬时数的商
  // （读 A 204/221=0.92 对上 0.92；读 B 215/94=2.29 对上 2.28，见同一份证据）。所以这一支
  // **连 reportedRatio 也不用** —— 用它等于把同一份抖动换个来源再报一次。
  // 一个会摆到 0.74 的比值不是压缩比：压缩不会把出站量变得比编码输出还大。
  if (basis === 'ingress') {
    // 这一格对本端**永远不会**有数：不是"还没到"，是口径决定不给。所以哪怕出站量还没量到，
    // 也写 `—` 而不是 `统计中` —— 「统计中」承诺的是"再等等就有"（本端出站量那一格自己会写它），
    // 拿它填倍率格等于让人以为马上会出一个数。
    return { rawText, ratioText: '—', savedText: '—', basisText, compressed: false, applicable: true, summaryText: '' }
  }

  // kind 未知时保守：只有原始确实高于实传（存在压缩收益）才给数，倒挂就当直传。
  if (compressionKind === 'unknown' && !hasGain) {
    return { rawText, ratioText: DIRECT_TEXT, savedText: '—', basisText, compressed: false, applicable: true, summaryText: '' }
  }
  if (hasGain) {
    return {
      rawText,
      ratioText: ratioPrefix + (sourceKbps / transmittedKbps).toFixed(2) + ':1',
      savedText: savedPrefix + savingPercent(sourceKbps, transmittedKbps).toFixed(2) + '%',
      basisText,
      compressed: true,
      applicable: true,
      summaryText: '',
    }
  }
  // 倍率 ≤1 也不给数：那是"没省"或"倒挂"，clamp 会把它压成 0.00%，而"省了 0%"是假数。
  // 看板 `formatCompressionEffect` 对 `ratio <= 1` 直接不出。
  if (reportedRatio > 1) {
    return {
      rawText,
      ratioText: ratioPrefix + reportedRatio.toFixed(2) + ':1',
      savedText: savedPrefix + savingPercentFromRatio(reportedRatio).toFixed(2) + '%',
      basisText,
      compressed: true,
      applicable: true,
      summaryText: '',
    }
  }
  return {
    rawText, ratioText: PENDING_TEXT, savedText: PENDING_TEXT, basisText,
    compressed: false, applicable: true, summaryText: '',
  }
}
