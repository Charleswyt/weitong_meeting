/**
 * 本机录制的画质档位 —— **唯一真源**。
 *
 * 为什么这一档只管码率与录制帧率，**不碰采集约束**：
 * 摄像头那条轨是**与推流共用**的（`useMediaSettings` 算出的 `getUserMedia` 约束同时喂给会议和本机录制），
 * 在这里降采集分辨率等于**把别人在会里看到的画面也降了** —— 而这一档的名字叫"本地录制"。
 * 真要按档位降采集，得先能给录制单独开一条轨（当前媒体面三方锁定，做不到）。
 *
 * 所以档位改的是两件**只作用于本机这份文件**的东西：
 * 1. `MediaRecorder` 的 `videoBitsPerSecond` —— 此前刻意不传（`trackRecorder.ts` 那句注释），
 *    结果是"默认档位的磁盘成本完全由 Chromium 心情决定"（实测 720p 画面轨 1.80 Mbps，
 *    而 1080p 默认档从没量过）。钉死它同时管住体积、离线合成耗时与实时丢帧风险。
 * 2. 录制画布的出帧上限 —— 画布那一路是 `captureStream(0)` 手动出帧，
 *    出帧频率本来就在我方手里，不需要动采集。
 *
 * ⚠️ 界面上**不许**再写"目标 1080P/720P/540P"：只压码率却宣称分辨率是假档位。
 */
export type RecordingQuality = 'high' | 'medium' | 'low'

export interface RecordingTierPlan {
  /** 传给 MediaRecorder 的 `videoBitsPerSecond` */
  videoBitsPerSecond: number
  /** 界面用的一句体积估算：每分钟大约多少 MB */
  approxMbPerMinute: number
}

/**
 * 档位表。码率取的是"720p 实测 1.80 Mbps 能读清 PPT"这条锚点上下外推，
 * 不是照抄某个播放器的推荐值；`approxMbPerMinute` = bps/8×60/1MB，用来在界面上说实话。
 */
const TIERS: Record<RecordingQuality, RecordingTierPlan> = {
  high: { videoBitsPerSecond: 4_000_000, approxMbPerMinute: 30 },
  medium: { videoBitsPerSecond: 2_000_000, approxMbPerMinute: 15 },
  low: { videoBitsPerSecond: 1_000_000, approxMbPerMinute: 8 },
}

export const RECORDING_QUALITY_VALUES: RecordingQuality[] = ['high', 'medium', 'low']

/** 取不到的值一律按 medium：宁可保守也不让一个脏字典值变成"没上限" */
export function recordingTier(quality: string | undefined | null): RecordingTierPlan {
  return TIERS[(quality as RecordingQuality) || 'medium'] ?? TIERS.medium
}

/** 录制帧率的可选档位：与采集无关，只决定本机这份文件每秒画几帧 */
export const RECORDING_FPS_VALUES = [25, 30, 60, 120] as const

/**
 * 录制画布实际出帧率 = min(源实测帧率, 用户设的录制帧率)。
 * 取 min 而不是取档位：源只有 15 fps 时按 30 出帧等于**重复帧填时间轴**，
 * 那是把"没拍到的内容"伪造成"拍到了"，与"缺口画占位、不许重复末帧"同一条纪律。
 * 硬顶 120：与设置页可选档对齐，避免脏值把编码器拖垮。
 */
export function canvasFpsFor(fpsCap: number | undefined | null, sourceFps: number | undefined | null): number {
  const raw = Number.isFinite(fpsCap as number) && (fpsCap as number) > 0 ? (fpsCap as number) : 30
  const cap = (RECORDING_FPS_VALUES as readonly number[]).includes(raw) ? raw : 30
  const src = Number.isFinite(sourceFps as number) && (sourceFps as number) > 0 ? (sourceFps as number) : cap
  return Math.max(1, Math.min(120, Math.min(src, cap)))
}
