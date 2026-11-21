/**
 * timeline 的真源用例（直接 import src/，不复制副本）。
 * 跑法：node scratch/verify-timeline.ts
 */
import {
  buildTimeline,
  chunkWindows,
  AAC_PACKET_SAMPLES,
  AAC_SAMPLE_RATE,
  type TimelineLane,
} from '../src/utils/offlineCompose/timeline.ts'

let ran = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = ''): void {
  ran++
  if (!cond) fails.push(`${name}${detail ? ' — ' + detail : ''}`)
}
function eq(name: string, got: unknown, want: unknown): void {
  ok(name, got === want, `got=${String(got)} want=${String(want)}`)
}

const lane = (id: string, runs: Array<[number, number]>, opts: Partial<TimelineLane> = {}): TimelineLane => ({
  id,
  hasVideo: true,
  hasAudio: true,
  runs: runs.map(([startSec, endSec]) => ({ startSec, endSec })),
  ...opts,
})

// —— 基本形状：3 路各 10 秒、连续一整段 ——
const base = buildTimeline([lane('A', [[0, 10]]), lane('B', [[0, 10]]), lane('C', [[0, 10]])], 15)
eq('时长取最大终点', base.durationSec, 10)
eq('输出时间戳条数', base.frameTimestamps.length, 150)
eq('视频轨包数=时间戳条数', base.expectedVideoPackets, 150)
eq('音频包数按 1024 节拍', base.expectedAudioPackets, Math.ceil((10 * AAC_SAMPLE_RATE) / AAC_PACKET_SAMPLES))
eq('三路各 150 帧', base.expectedSampleFetches, 450)
eq('采样率常量', base.audioSampleRate, 48000)
ok('时间戳单调递增', base.frameTimestamps.every((t, i) => i === 0 || t > base.frameTimestamps[i - 1]!))
eq('首帧在 0', base.frameTimestamps[0], 0)
for (const p of base.perLane) {
  eq(`${p.laneId} 无缺口`, p.absent.length, 0)
  eq(`${p.laneId} 取满 150 帧`, p.timestamps.length, 150)
}

// —— 中途入会：起点不齐不算缺陷，但只解它在场的那段 ——
const join = buildTimeline([lane('A', [[0, 10]]), lane('B', [[4, 10]])], 15)
const b = join.perLane.find((p) => p.laneId === 'B')!
eq('中途入会那一路只取在场帧', b.timestamps.length, 90)
eq('全场按最长那一路', join.expectedVideoPackets, 150)
eq('not_started 记为占位而非缺陷', b.absent[0]?.kind, 'not_started')
eq('not_started 区间', b.absent[0]?.toSec, 4)
eq('总取帧数=150+90', join.expectedSampleFetches, 240)

// —— 断流：缺口那一路**不解码**（这是上一轮 OOM 的反面）——
const gap = buildTimeline([lane('A', [[0, 4], [6, 10]])], 15)
const g = gap.perLane[0]!
eq('缺口时段不生成取帧请求', g.timestamps.length, 120)
const gapSeg = g.absent.find((a) => a.kind === 'gap')
ok('缺口被如实标出来', !!gapSeg && gapSeg.fromSec === 4 && gapSeg.toSec === 6)

// —— 提前收场：ended 段 ——
const early = buildTimeline([lane('A', [[0, 10]]), lane('B', [[0, 3]])], 15)
const e = early.perLane.find((p) => p.laneId === 'B')!
ok('早收场标 ended', e.absent.some((a) => a.kind === 'ended' && a.fromSec === 3 && a.toSec === 10))
eq('早收场那一路不取 3 秒之后的帧', e.timestamps.length, 45)

// —— 分片首尾相接 + 微小浮点缝：要并成一段，不能每片算一次缺口 ——
const slices = Array.from({ length: 300 }, (_, i) => [i * 0.1 + 1e-9, (i + 1) * 0.1] as [number, number])
const merged = buildTimeline([lane('A', slices)], 15)
eq('300 片相邻缝不产生假缺口', merged.perLane[0]!.absent.filter((a) => a.kind === 'gap').length, 0)
eq('30 秒按 15fps 出 450 帧', merged.expectedVideoPackets, 450)

// —— 越界/退化输入 ——
const dirty = buildTimeline([lane('A', [[-5, 3], [2, 1], [3, 8]])], 15)
eq('负起点夹到 0 且坏区间丢弃', dirty.durationSec, 8)
eq('脏输入不重复计数', dirty.perLane[0]!.timestamps.length, 120)
const none = buildTimeline([], 15)
ok('零路要留机器码', none.warnings.includes('no_lane_selected'))
eq('零路时长为 0', none.durationSec, 0)
eq('零路零包', none.expectedVideoPackets, 0)
const audioOnly = buildTimeline([lane('A', [[0, 10]], { hasVideo: false })], 15)
eq('纯音轨不占画面格', audioOnly.perLane[0]!.timestamps.length, 0)
eq('纯音轨仍算进全场时长', audioOnly.durationSec, 10)

// —— fps 兜底与分块窗口 ——
eq('fps<=0 退回 15', buildTimeline([lane('A', [[0, 1]])], 0).fps, 15)
const win = chunkWindows(50, 15)
eq('50 秒分 4 块', win.length, 4)
eq('末块夹到时长', win[3]![1], 50)
eq('块首尾相接', win.every(([, end], i) => i === 0 || win[i - 1]![1] === win[i]![0]), true)
eq('0 时长不产生块', chunkWindows(0, 15).length, 0)

if (ran < 30) {
  console.error(`时间轴用例自证失败：只跑了 ${ran} 条`)
  process.exit(2)
}
if (fails.length) {
  console.error(`✗ ${fails.length} 条失败（共 ${ran}）:`)
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log(`✓ timeline 全绿：${ran} 条断言`)
