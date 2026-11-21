// 「相对帧延迟」的唯一口径：以本次播放收到的第一个有效帧为固定基准，只量延迟在长还是在缩。
//
// 为什么不是"播放时刻 − 采集时刻"：那个绝对量要采集端墙钟，而它只存在于直连拉流的容器帧头
// （mediaPlayer.ts 的 session.baseUnixNs）。局域网 WHEP 那条腿不经我方容器，拿不到；
// 三方在同一条腿上也只做相对量，其栏内说明原文是"不代表绝对单向延迟"。
// 把绝对偏移消在 anchor 之差里，两条腿就能共用同一个口径，而不是两条腿各说一套。
//
// 口径只持有在这一处，页面不许另算一遍（同 utils/compression.ts 的规矩）。

export interface FrameTimeSample {
  /** 帧在源时钟上的时刻（毫秒）。直连腿来自 PTS/timebase，WHEP 腿来自 mediaTime。 */
  sourceMs: number
  /** 本地单调钟（performance.now()）：漂移只认它，墙钟被改也不受影响。 */
  observedMs: number
  /** 源时刻取自"轨道交付时间"而非帧自身时间戳 —— 退化口径，数值必须标"估计"。 */
  estimated?: boolean
  /**
   * 源时钟标识（三方在局域网遥测里给的那个）。对方重启采集、换采集设备都会换它，
   * 基准必须跟着重立 —— 拿旧钟的起点量新钟，报出来的是重启量，不是延迟。
   * 它在线上是个超出安全整数范围的 JSON number，末几位已被舍入，
   * 所以**只能用来判"换没换钟"，不许当精确标识跨系统比对**。
   */
  clockId?: string
}

export interface FrameDrift {
  /** 相对首帧的延迟漂移：正值=延迟在长，负值=在追赶。 */
  driftMs: number
  /** 这一路当前用的是退化口径。 */
  estimated: boolean
  /** 已重锚次数（换基准、源钟跳变各算一次）。 */
  resets: number
}

// 源时刻比基准帧还早出这个量，就当钟跳了：重锚，而不是把一个大正数当成"延迟暴涨"。
const CLOCK_RESET_MS = 1000

// NTP 纪元（1900-01-01）到 Unix 纪元（1970-01-01）的毫秒差。
const NTP_UNIX_EPOCH_OFFSET_MS = 2208988800000

/**
 * 把浏览器吐出来的时间戳统一成 Unix 毫秒。
 * Chromium 各 build 不一致：estimatedPlayoutTimestamp 有的给 NTP 纪元，有的给 Unix 毫秒，
 * 而 RTCStats.timestamp 是 performance 纪元（相对 timeOrigin）。不先归一，音画差就是拿
 * 两个不同起点相减，数值看着像那么回事但完全不可信。
 */
export function normalizeEpochMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  if (value >= 3e12) {
    const unix = value - NTP_UNIX_EPOCH_OFFSET_MS
    // 减完落在 2000-01-01 ~ 2100-01-01 才算真是 NTP，否则是别的东西，原样退回。
    if (unix >= 946684800000 && unix <= 4102444800000) return unix
  }
  if (value >= 1e12) return value
  return performance.timeOrigin + value
}

/**
 * 首帧基准漂移表。一条腿一个实例：换腿时必须丢掉旧实例（见 InMeetingView 的 dropLanWhepLeg
 * 那条"出过帧的证据必须跟着走"），拿旧腿的基准量新腿，报出来的是两条腿之差。
 */
export class FrameDriftMeter {
  private anchor: FrameTimeSample | null = null
  private anchorKey = ''
  private resets = 0

  /** 收到一个帧样本。返回 null 表示这一帧刚立/重立了基准，还没有可报的漂移。 */
  observe(sample: FrameTimeSample): FrameDrift | null {
    if (!Number.isFinite(sample.sourceMs) || !Number.isFinite(sample.observedMs)) return null

    const key = `${sample.clockId ?? ''}|${sample.estimated ? 'track' : 'source'}`
    const prev = this.anchor
    // 基准的身份 = 源钟 + 口径。换源钟（对方重启采集）或换口径都等于换了一条时间线，
    // 继续拿旧基准比就会得出一个谁也不是的数 —— 重立，并把这一路重新当"首帧"看。
    if (!prev || this.anchorKey !== key) return this.reanchor(sample, key, prev !== null)
    // 源时刻比基准帧还早回去一整个阈值，就是钟跳了（32 位回绕、对端重推流都会这样）。
    if (sample.sourceMs < prev.sourceMs - CLOCK_RESET_MS) return this.reanchor(sample, key, true)

    return {
      driftMs: (sample.observedMs - prev.observedMs) - (sample.sourceMs - prev.sourceMs),
      estimated: sample.estimated === true,
      resets: this.resets,
    }
  }

  /** 当前基准帧的源时刻，供"这一路从哪一帧算起"这类展示与断言用。 */
  get anchorSourceMs(): number {
    return this.anchor?.sourceMs ?? 0
  }

  /** 基准的身份键，测试与"换腿必须重锚"的断言都读它。 */
  get anchorKeyOf(): string {
    return this.anchorKey
  }

  reset(): void {
    this.anchor = null
    this.anchorKey = ''
    this.resets = 0
  }

  private reanchor(sample: FrameTimeSample, key: string, counted: boolean): null {
    if (counted) this.resets += 1
    this.anchor = { sourceMs: sample.sourceMs, observedMs: sample.observedMs, estimated: sample.estimated === true }
    this.anchorKey = key
    return null
  }
}
