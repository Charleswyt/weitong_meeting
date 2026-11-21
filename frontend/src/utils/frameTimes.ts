// 「采集时间」的真源在船端网关的本机遥测里（`/api/local/frame-times?lane=N`，每帧带 Unix 纳秒），
// 不在 WebRTC 的统计里 —— 局域网那条腿不经我方容器，帧头里没有采集墙钟。
//
// 本模块只做一件事：把"浏览器正在解的这一帧"的 RTP 时间戳对到那张表里的同一帧，取它的采集时刻。
// **对不上就回 0**：报一个别的帧的采集时刻，比这一格空着更糟 —— 它会带着一个看起来很合理的假数
// 进到时区的比对里，没人能发现。
//
// 表由后端代理原样透传（不在 Go 侧解析）：`sourceEncodeUnixNs` 与 `sourceClockId` 都超出
// JSON number 的安全整数范围，过一遍 float 就会被静默改掉末几位。纳秒末几位本就不可信
// （约 ±256 ns），这里一律换算成毫秒后使用。

export interface FrameTimeEntry {
  /** RTP 时间戳（32 位，按无符号解释）。 */
  rtp: number
  /** 这一帧在采集端的墙钟（Unix 毫秒）。 */
  captureEpochMs: number
}

export interface FrameTimesSnapshot {
  entries: FrameTimeEntry[]
  /** 源时钟标识：换它等于换了一条时间线，基准必须重立。 */
  sourceClockId: string
  /** 源钟是否与服务器对齐。false 时**绝对**延迟不可信，只能报相对漂移。 */
  sourceClockSynchronized: boolean
  /** 同一份遥测里的音频源钟标识，与上面不等就说明两条轨不在同一时钟域（"源音画差"算不出）。 */
  audioSourceClockId: string
}

/** 一次拉表的解析结果；null = 形状不认识，调用方按"没取到"处理，不许猜。 */
export function parseFrameTimes(raw: unknown): FrameTimesSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.ok !== true || !Array.isArray(o.frames)) return null
  const entries: FrameTimeEntry[] = []
  for (const f of o.frames as Array<Record<string, unknown>>) {
    const rtp = Number(f.rtpTimestamp)
    const ns = Number(f.sourceEncodeUnixNs)
    if (!Number.isFinite(rtp) || !Number.isFinite(ns) || ns <= 0) continue
    entries.push({ rtp: rtp >>> 0, captureEpochMs: ns / 1e6 })
  }
  if (!entries.length) return null
  // 表按时间递增返回，但回绕点会在中间：调用方按"最近邻 + 有符号差"处理，这里不排序也不裁剪。
  return {
    entries,
    sourceClockId: o.sourceClockId === undefined ? '' : String(o.sourceClockId),
    sourceClockSynchronized: o.sourceClockSynchronized === true,
    audioSourceClockId: o.audioSourceClockId === undefined ? '' : String(o.audioSourceClockId),
  }
}

/**
 * 只认"就是这一帧"：RTP 时间戳必须逐值相等（容 1 tick 的换算余量）。
 *
 * 为什么不用"最近邻 + 若干容差"：那张表是**稠密**的（现场 256 帧覆盖 10.28 秒，帧间隔约 40ms），
 * 表里到处都有帧，于是任何 rtp 都能命中"某个"帧 —— 容差再小也挡不住命中邻近的别的帧，
 * 报出来的就是一个错了近一秒却看起来完全合理的采集时刻。
 * 两侧取的是同一个上游 RTP 时间戳（不像 rVFC 的 mediaTime 被浏览器归零过），所以相等是常态；
 * 万一哪天不再相等，这里就是 0 → 界面留「统计中」，这是诚实的失败而不是猜一个。
 */
const RTP_MATCH_SLACK = 1

/**
 * 用当前帧的 RTP 时间戳在表里找同一帧，回它的采集时刻（Unix 毫秒）；0 = 表里没有这一帧。
 * 差值按**有符号 32 位**解释，所以表跨过回绕点也不会漏掉回绕两侧本该相邻的帧。
 */
export function captureEpochMsFor(
  snapshot: FrameTimesSnapshot | null,
  rtp: number,
  clockRate = 0,
): number {
  void clockRate // 不再参与容差，保留形参是为了调用方不必区分时基
  if (!snapshot || !snapshot.entries.length) return 0
  if (!Number.isFinite(rtp) || rtp < 0) return 0
  for (const e of snapshot.entries) {
    const delta = ((rtp - e.rtp) | 0) // |0 折成有符号 32 位：回绕两侧才算得对
    if (delta <= RTP_MATCH_SLACK && delta >= -RTP_MATCH_SLACK) return e.captureEpochMs
  }
  return 0
}

/** 两条轨是否同一时钟域 —— 不等就别去算"源音画差"，那是拿两个起点相减。 */
export function sourceClocksShared(snapshot: FrameTimesSnapshot | null): boolean {
  if (!snapshot) return false
  return !!snapshot.sourceClockId && snapshot.sourceClockId === snapshot.audioSourceClockId
}
