/**
 * 混音层的真源用例（node scratch/verify-audiomix.ts）。
 * 重点是三条会静默出错的性质：跨块对齐、采样率换算、削顶计数。
 */
import { mixChunk, splitPackets, audioChunkPlan, type MixInput } from '../src/utils/offlineCompose/audioMix.ts'

let ran = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = ''): void {
  ran++
  if (!cond) fails.push(`${name}${detail ? ' — ' + detail : ''}`)
}
function eq(name: string, got: unknown, want: unknown): void {
  ok(name, got === want, `got=${String(got)} want=${String(want)}`)
}
function near(name: string, got: number, want: number, tol = 1e-3): void {
  ok(name, Math.abs(got - want) <= tol, `got=${got} want=${want}`)
}
const flat = (n: number, v: number) => Float32Array.from({ length: n }, () => v)
const at = (arr: Float32Array, i: number) => arr[i] ?? 0

// —— 两路同速率求和 ——
const sum2 = mixChunk(
  [
    { laneId: 'A', startSec: 0, channels: [flat(48000, 0.3)], sampleRate: 48000 },
    { laneId: 'B', startSec: 0, channels: [flat(48000, 0.2)], sampleRate: 48000 },
  ],
  0,
  1,
)
eq('一块 1 秒 = 48000 帧', sum2.frames, 48000)
near('两路相加', at(sum2.channels[0], 100), 0.5)
near('立体声两路一致（都是单声道源铺出来的）', at(sum2.channels[1], 100), 0.5)
eq('两条路都算贡献过声音', sum2.activeLanes.length, 2)
eq('没削顶', sum2.clippedSamples, 0)

// —— 削顶：求和后夹到 ±1，并且要数得出来 ——
const clip = mixChunk(
  [
    { laneId: 'A', startSec: 0, channels: [flat(48000, 0.8)], sampleRate: 48000 },
    { laneId: 'B', startSec: 0, channels: [flat(48000, 0.8)], sampleRate: 48000 },
  ],
  0,
  1,
)
eq('削顶后不越界', at(clip.channels[0], 0), 1)
eq('削顶次数如实回报（左右各算一次）', clip.clippedSamples, 96000)

// —— 起点偏移：中途入会的人前 2 秒必须是静音，不能拿别的填 ——
const late = mixChunk([{ laneId: 'A', startSec: 2, channels: [flat(48000, 0.6)], sampleRate: 48000 }], 0, 3)
eq('未进场段为静音', at(late.channels[0], 48000 * 2 - 1), 0)
near('进场那一刻起有声音', at(late.channels[0], 48000 * 2), 0.6)
eq('进场后 1 秒的尾巴也还在', at(late.channels[0], 48000 * 3 - 1) > 0.59, true)

// —— 跨块拼接不重不漏（分块流式的正确性命门）——
const srcA: MixInput = { laneId: 'A', startSec: 0, channels: [flat(96000, 0.4)], sampleRate: 48000 }
const c0 = mixChunk([srcA], 0, 1)
const c1 = mixChunk([srcA], 1, 2)
const whole = mixChunk([srcA], 0, 2)
ok(
  '两块拼起来 == 一次算完（逐帧）',
  c0.channels[0].every((v, i) => v === at(whole.channels[0], i)) &&
    c1.channels[0].every((v, i) => v === at(whole.channels[0], 48000 + i)),
)
eq('第二块自己也认这条路', c1.activeLanes[0], 'A')

// —— 采样率换算：44.1k 的源铺到 48k 栅格，占的**时长**要还是 1 秒 ——
const rs = mixChunk([{ laneId: 'A', startSec: 0, channels: [flat(44100, 1)], sampleRate: 44100 }], 0, 2)
near('44.1k 的 44100 样本在 48k 栅格上占满第 1 秒', at(rs.channels[0], 48000 - 1), 1)
eq('第 1 秒整之后就该结束（没有把样本数当帧数用）', at(rs.channels[0], 48000), 0)
eq('也没提前结束', at(rs.channels[0], 44100), 1)

// 上面那组用的是恒定信号，**它对"索引算错"天然免疫**（换成不换算的实现照样全绿），
// 所以再钉一条带跳变的：源在第 0.5 秒处从 1 掉到 0，跳变必须落在输出的第 0.5 秒，
// 而不是落在"源样本下标 22050 当作输出下标"的位置。
const step = Float32Array.from({ length: 44100 }, (_, i) => (i < 22050 ? 1 : 0))
const rs2 = mixChunk([{ laneId: 'A', startSec: 0, channels: [step], sampleRate: 44100 }], 0, 2)
near('跳变前仍是 1', at(rs2.channels[0], 1000), 1)
ok('跳变落在时间上的第 0.5 秒（不是源下标）', at(rs2.channels[0], 23999) > 0.5)
eq('第 0.5 秒之后立刻为 0', at(rs2.channels[0], 24001), 0)
eq('第 1 秒末尾也是 0（没把 44100 个样本平铺成 44100 帧）', at(rs2.channels[0], 47999), 0)

// —— 素材对不上块：不能崩，也不能冒充有声 ——
const outside = mixChunk([{ laneId: 'A', startSec: 10, channels: [flat(48000, 0.5)], sampleRate: 48000 }], 0, 1)
eq('源完全在窗外时不产出声音', outside.activeLanes.length, 0)
eq('窗外源不算 dropped（它只是不属于这块）', outside.droppedLanes.length, 0)
const empty = mixChunk([{ laneId: 'A', startSec: 0, channels: [], sampleRate: 48000 }], 0, 1)
eq('零声道要记机器码', empty.droppedLanes[0]?.reason, 'no_channel_data')
const badRate = mixChunk([{ laneId: 'B', startSec: 0, channels: [flat(10, 0.5)], sampleRate: 0 }], 0, 1)
eq('采样率<=0 要记机器码', badRate.droppedLanes[0]?.reason, 'bad_sample_rate')

// —— AAC 分包：尾部不足一包要补零，不许丢内容 ——
const pk = splitPackets({ channels: [flat(1500, 0.25), flat(1500, 0.25)] }, 1024)
eq('1500 帧切成 2 包', pk.length, 2)
eq('每包都是满 1024（AAC 的硬要求）', pk.every((p) => p.numberOfFrames === 1024), true)
near('第二包最后一个真样本还在', at(pk[1]!.channels[0], 475), 0.25)
eq('补的那一段是 0（1500 帧之后）', at(pk[1]!.channels[0], 476), 0)
eq('整帧数不丢', pk.length * 1024 - 1500, 548)

// —— 预留包数 == 实吐包数（'reserve' 的硬约束；不等就是 finalize 炸）——
for (const durSec of [1, 15, 60, 123.8, 987.4, 3600]) {
  const totalFrames = Math.round(durSec * 48000)
  const plan = audioChunkPlan(totalFrames, Math.round(15 * 48000), 1024)
  const reserved = plan.reduce((s, p) => s + p.packets, 0)
  let emitted = 0
  for (const p of plan) {
    const mixed = mixChunk([{ laneId: 'A', startSec: p.startFrame / 48000, channels: [flat(p.frames, 0.1)], sampleRate: 48000 }], p.startFrame / 48000, (p.startFrame + p.frames) / 48000)
    emitted += splitPackets(mixed, 1024).length
  }
  eq(`${durSec}s 场：预留包数 = 实吐包数`, reserved, emitted)
  ok(`${durSec}s 场：每块都是整包（末块除外）`, plan.every((p, i) => i === plan.length - 1 || p.frames % 1024 === 0))
}
eq('零时长不产生块', audioChunkPlan(0, 720000, 1024).length, 0)
ok('按秒切块的旧算法确实会超包数', (() => {
  const total = Math.ceil(987.4 * 48000 / 1024)
  let emitted = 0
  for (let s = 0; s < 987.4; s += 15) emitted += Math.ceil(Math.min(15, 987.4 - s) * 48000 / 1024)
  return emitted > total
})())

if (ran < 20) {
  console.error(`混音用例自证失败：只跑了 ${ran} 条`)
  process.exit(2)
}
if (fails.length) {
  console.error(`✗ ${fails.length} 条失败（共 ${ran}）:`)
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log(`✓ audioMix 全绿：${ran} 条断言`)
