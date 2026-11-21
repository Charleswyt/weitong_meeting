/**
 * 入料层的真源用例（node scratch/verify-offline-intake.ts）。
 * 这里钉的是三条会静默出错的性质：容器切分、可播区切分、范围读的字节映射。
 */
import { splitContainers, splitRuns, createRunSource, type SliceInput } from '../src/utils/offlineCompose/segmentSource.ts'

let ran = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = ''): void {
  ran++
  if (!cond) fails.push(`${name}${detail ? ' — ' + detail : ''}`)
}
function eq(name: string, got: unknown, want: unknown): void {
  ok(name, got === want, `got=${String(got)} want=${String(want)}`)
}

const slice = (seq: number, offsetSec: number, durationSec = 2, sizeBytes = 1000): SliceInput => ({
  blobKey: `k${seq}@${offsetSec}`, seq, offsetSec, durationSec, sizeBytes,
})

// —— 1a. 两趟录制**顺序相接** → 两个容器 ——
const appended = splitContainers('L', [slice(0, 0), slice(1, 2), slice(2, 4), slice(0, 6), slice(1, 8), slice(2, 10)])
eq('顺序相接切成两个容器', appended.containerCount, 2)
eq('第一个容器的时间窗', `${appended.containers[0]!.startSec}-${appended.containers[0]!.endSec}`, '0-6')
eq('第二个容器的时间窗', `${appended.containers[1]!.startSec}-${appended.containers[1]!.endSec}`, '6-12')
eq('每个容器 3 片', appended.containers.map((c) => c.slices.length).join(','), '3,3')
ok('顺序相接也要报 seq_restart', appended.anomalies.includes('seq_restart'))
ok('顺序相接不该误报 duplicate', !appended.anomalies.includes('duplicate_blob_key'))

// —— 1b. 盘上那份真坏件的形状：两台编码器**交错**出片 ——
// 序列 0,0,1,1,2,2,3,3,4,4,0..49，blobKey 按 `recordingId#seq` 构造 ⇒ 前 5 个键各出现两次
const interleaved: SliceInput[] = []
for (const [i, s] of [0, 0, 1, 1, 2, 2, 3, 3, 4, 4].entries()) {
  interleaved.push({ blobKey: `r#${s}`, seq: s, offsetSec: i * 2, durationSec: 2, sizeBytes: 1000 })
}
for (let s = 0; s < 50; s++) interleaved.push({ blobKey: `r#${s}`, seq: s, offsetSec: 100 + s * 2, durationSec: 2, sizeBytes: 1000 })
const bad = splitContainers('L', interleaved)
ok('交错并写要报 seq_restart', bad.anomalies.includes('seq_restart'))
ok('交错并写要报 duplicate_blob_key（同一键指向两份字节）', bad.anomalies.includes('duplicate_blob_key'))
ok('异常非空 ⇒ 调用方据此拒绝直接合轨', bad.anomalies.length > 0)
// 关键：算法不许"排序后看起来正常"—— 排序会把回绕洗掉，判据就会假绿
eq('容器数量确实大于 1（没有被排成一串）', bad.containerCount > 1, true)

// 正常那份：seq 单调 → 只有一个容器，且**不许有任何异常码**（防误伤好样本）
const fine = splitContainers('L', Array.from({ length: 487 }, (_, i) => slice(i, i * 2, 2, 456000)))
eq('487 片单调只出一个容器', fine.containerCount, 1)
eq('单调好件零异常码', fine.anomalies.length, 0)
eq('容器字节合计', fine.containers[0]!.totalBytes, 487 * 456000)

// 重复片号但 offset 也回绕（真的两趟）
const dup = splitContainers('L', [slice(0, 0), slice(0, 0), slice(1, 2)])
eq('完全重复的片号同样算回绕', dup.containerCount, 2)

// —— 2. 可播区按时间连续性切（同一容器内的断流）——
const container = fine.containers[0]!
const withGap = splitContainers('G', [slice(0, 0), slice(1, 2), slice(2, 20), slice(3, 22)]).containers[0]!
const runs = splitRuns(withGap)
eq('同容器内断流切成两段 run', runs.length, 2)
eq('run1 时间窗', `${runs[0]!.startSec}-${runs[0]!.endSec}`, '0-4')
eq('run2 时间窗', `${runs[1]!.startSec}-${runs[1]!.endSec}`, '20-24')
eq('run2 的字节起点 = 前两片的合计', runs[1]!.firstByte, 2000)
eq('run2 的字节长度', runs[1]!.byteLength, 2000)
eq('阈值内的抖动不算断流', splitRuns(splitContainers('H', [slice(0, 0), slice(1, 2), slice(2, 4.1)]).containers[0]!).length, 1)
eq('超过阈值算断流', splitRuns(splitContainers('I', [slice(0, 0), slice(1, 2), slice(2, 4.3)]).containers[0]!).length, 2)

// —— 3. 范围读的字节映射（跨片、片内、越界三种）——
const slices = [slice(0, 0, 2, 10), slice(1, 2, 2, 20), slice(2, 4, 2, 30)]
const store = new Map(slices.map((s) => [s.blobKey, Uint8Array.from({ length: s.sizeBytes }, (_, i) => i)]))
const reads: Array<[number, number]> = []
const src = createRunSource({
  totalBytes: 60,
  slices: slices.map((s) => ({ offsetSec: s.offsetSec, durationSec: s.durationSec, blobKey: s.blobKey, sizeBytes: s.sizeBytes })),
  fetchSlice: async (k) => store.get(k) ?? null,
  onRead: (a, b) => reads.push([a, b]),
})
eq('总大小', src.getSize(), 60)
const a = await src.read(0, 8)
eq('片内区间长度', a.length, 8)
eq('片内区间内容', Array.from(a).join(','), '0,1,2,3,4,5,6,7')
const b = await src.read(5, 25)
eq('跨片区间长度', b.length, 20)
eq('跨片拼接的前半', Array.from(b.slice(0, 5)).join(','), '5,6,7,8,9')
eq('跨片拼接的后半（第二片从 0 开始）', Array.from(b.slice(5, 10)).join(','), '0,1,2,3,4')
const c = await src.read(30, 45)
eq('落在第三片内部', Array.from(c).join(','), Array.from({ length: 15 }, (_, i) => i).join(','))
const tail = await src.read(55, 60)
eq('末片尾部', tail.length, 5)

// —— 4. 字节账不平要立刻炸（不能默默交出短读的文件）——
let threw = false
try {
  createRunSource({ totalBytes: 999, slices: [{ offsetSec: 0, durationSec: 2, blobKey: 'x', sizeBytes: 10 }], fetchSlice: async () => null })
} catch { threw = true }
ok('声明字节与分片合计不符时必须报错', threw)

// —— 5. 库里取不到字节：零填充且 onRead 记 0，由调用方判不完整 ——
const missing = createRunSource({
  totalBytes: 10,
  slices: [{ offsetSec: 0, durationSec: 2, blobKey: 'gone', sizeBytes: 10 }],
  fetchSlice: async () => null,
})
const hole = await missing.read(0, 10)
eq('缺字节仍返回请求长度（否则库会以为读到头了）', hole.length, 10)
ok('缺字节全是零', Array.from(hole).every((v) => v === 0))

// —— 6. 范围读的证据：读 8 字节只该取到 1 片，不该把 60 字节全捞 ——
const fetched: string[] = []
const spy = createRunSource({
  totalBytes: 60,
  slices: slices.map((s) => ({ offsetSec: s.offsetSec, durationSec: s.durationSec, blobKey: s.blobKey, sizeBytes: s.sizeBytes })),
  fetchSlice: async (k) => { fetched.push(k); return store.get(k) ?? null },
})
await spy.read(0, 8)
eq('小区间只碰了首片', fetched.length, 1)
eq('没把整份捞进内存', fetched.join(','), 'k0@0')

if (ran < 20) {
  console.error(`入料用例自证失败：只跑了 ${ran} 条`)
  process.exit(2)
}
if (fails.length) {
  console.error(`✗ ${fails.length} 条失败（共 ${ran}）:`)
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log(`✓ segmentSource 全绿：${ran} 条断言`)
