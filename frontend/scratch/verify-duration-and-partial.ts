/**
 * 时长口径与半截件判据的真源用例（node scratch/verify-duration-and-partial.ts）。
 * 数字来自 2026-10-09 复现现场：云端会 meeting_1790600078_ev1-TRdK。
 */
import { groupRecordingsBySession, sessionSpanSec } from '../src/utils/recordingRows.ts'
import { partialSeconds, lanesTimelineEndSec, type ComposeLane } from '../src/utils/offlineCompose/engine.ts'

let checks = 0
const fails: string[] = []
function eq(name: string, got: unknown, want: unknown) {
  checks++
  if (got !== want) fails.push(name + ' :: got ' + String(got) + ' want ' + String(want))
}
const T0 = Date.parse('2026-10-08T10:00:00Z')
const row = (offsetSec: number, durationSec: number) =>
  ({ startedAt: new Date(T0 + offsetSec * 1000).toISOString(), durationSec })

// —— 卡片时长 = 时间轴跨度（复现案例：从前这里给 234，回放页给 388）
const cloudRows = [row(0, 49), row(3, 50), row(151, 231), row(154, 234), row(199, 186), row(202, 56)]
eq('云端一场会卡片时长 = 跨度末端 388', sessionSpanSec(cloudRows), 388)
eq('旧算法（最长一路）确实给 234 —— 用例能区分两种口径', Math.max(...cloudRows.map((r) => r.durationSec)), 234)
eq('单行退化成自身时长（本地那侧行为不变）', sessionSpanSec([row(0, 120)]), 120)
eq('起点不在 0 也算跨度', sessionSpanSec([row(200, 50)]), 50)
eq('空集合给 0 而不是 Infinity', sessionSpanSec([]), 0)
eq('脏 startedAt 被跳过而不是污染结果', sessionSpanSec([row(0, 60), { startedAt: 'not-a-date', durationSec: 9 } as never]), 60)

// —— 半截件判据：分母只认内核自己规划的那条时间轴
// 复现的误报：只勾王强那格，合成覆盖 385.53 s，而 spec 里填的是整场 387.605 s
eq('勾了部分路不算半截件（旧代码在这里会误报）',
  partialSeconds({ kind: 'ok', coveredSec: 385.53, durationSec: 385.48 }), null)
eq('旧口径复现：拿整场跨度当分母就会判成半截',
  partialSeconds({ kind: 'ok', coveredSec: 385.53, durationSec: 387.605 }), 386)
eq('真没合成完要如实标', partialSeconds({ kind: 'ok', coveredSec: 225.1, durationSec: 300 }), 225)
eq('停摆必标', partialSeconds({ kind: 'stalled', coveredSec: 100, durationSec: 300 }), 100)
eq('取消后短于计划要标', partialSeconds({ kind: 'cancelled', coveredSec: 50, durationSec: 300 }), 50)
eq('2 秒容差内不标（帧量化与音频尾巴）', partialSeconds({ kind: 'ok', coveredSec: 298.5, durationSec: 300 }), null)
eq('计划时长为 0 时不判', partialSeconds({ kind: 'ok', coveredSec: 0, durationSec: 0 }), null)

// —— 两条 spec.durationSec 走同一个函数
const lane = (endSec: number, startSec = 0): ComposeLane =>
  ({ id: 'l' + endSec, label: 'l', hasVideo: true, hasAudio: false, containers: [{ startSec, endSec, slices: [], totalBytes: 0 }] }) as unknown as ComposeLane
eq('取被勾选路的跨度末端', lanesTimelineEndSec([lane(120), lane(388, 154), lane(56, 202)]), 388)
eq('空集合给 0', lanesTimelineEndSec([]), 0)

// —— 卡片那两个数：翻页翻不全时必须用后端同场聚合（契约 ADR-0076 三）
// 复现现场：临时会议卡片 1297 s、回放页 1423 s —— 差的就是没翻到的那几行里最早那段起点。
const cloudRow = (offsetSec: number, durationSec: number, agg?: { meetingStartedAt?: string; meetingSpanSec?: number }) => ({
  recordingId: 'r' + offsetSec,
  meetingId: 'm1',
  meetingNo: '48124890',
  participant: 'p' + offsetSec,
  mediaKind: 'camera',
  recordingType: 'cloud' as const,
  durationSec,
  fileSizeBytes: 0,
  deletable: true,
  startedAt: new Date(T0 + offsetSec * 1000).toISOString(),
  ...(agg || {}),
})
// 已加载的两行（倒序分页里最新的那两条）：自己算只有 160 s，而这一场其实跨到 388 s
const paged = [cloudRow(260, 100), cloudRow(200, 60)]
const withAgg = groupRecordingsBySession(paged.map((r) => ({ ...r, meetingStartedAt: new Date(T0).toISOString(), meetingSpanSec: 388 })))[0]
eq('卡片时长用后端聚合，不用已加载行的跨度', withAgg.durationSec, 388)
eq('卡片开始时刻用后端聚合锚', withAgg.startedAt, new Date(T0).toISOString())
eq('旧行为复现：同一批已加载行自己算只有 160 —— 用例能区分两种口径', sessionSpanSec(paged), 160)
const withoutAgg = groupRecordingsBySession(paged)[0]
eq('旧后端没这两个字段时退回已加载行（不报错、不假装知道）', withoutAgg.durationSec, 160)
eq('退化时开始时刻就是已加载里最早那条', withoutAgg.startedAt, new Date(T0 + 200000).toISOString())
// 聚合与已加载行打架有两种方向，两种都要有断言：
// ① 聚合跨度比已加载行还短 —— 不可能（全集 ⊇ 已加载），不采纳，取可证下界；
const disagree = groupRecordingsBySession([
  { ...paged[0], meetingStartedAt: new Date(T0 + 180000).toISOString(), meetingSpanSec: 120 },
  paged[1],
])[0]
eq('聚合给得比已加载行还短时不采纳（可证下界优先）', disagree.durationSec, 160)
// ② 聚合锚比已加载行**晚** —— 也不可能（锚是全集最小起点），那时不许把时刻推到更晚的位置。
// （反过来"锚比所有已加载行都早"才是正常情况，就是上面 withAgg 那两条钉的）
const lateAnchor = groupRecordingsBySession([
  { ...paged[0], meetingStartedAt: new Date(T0 + 280000).toISOString(), meetingSpanSec: 388 },
  paged[1],
])[0]
eq('聚合锚晚于已加载行时保留更早的那条', lateAnchor.startedAt, new Date(T0 + 200000).toISOString())
// 本机条目一条就是一场，没有聚合也没有翻页
const localRow = { ...cloudRow(0, 240), recordingId: 'local-1', meetingId: 'local', recordingType: 'local' as const }
eq('本机卡片时长照旧是这一条自身的跨度', groupRecordingsBySession([localRow])[0].durationSec, 240)

ok('自证下限', checks >= 23)
function ok(name: string, cond: boolean) { checks++; if (!cond) fails.push(name) }
console.log(fails.length ? '✗ 时长口径 ' + fails.length + '/' + checks + ' 条不符' : '✓ 时长口径全绿：' + checks + ' 条断言')
for (const f of fails) console.error('  - ' + f)
process.exit(fails.length ? 1 : 0)
