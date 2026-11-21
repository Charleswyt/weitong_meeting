// 第 15/16/17 项的时间轴不变量：直接 import 生产模块真源（src/utils/replayEngine.ts），
// 不复制副本、不 mock —— Node 24 会剥掉 TS 类型（那条 import type 整个被擦，所以不需要 @/ 别名解析）。
// 这里证的是**对齐逻辑**（哪个时刻该播哪一片、缺口该说哪句话、归组后窗格数）；
// 画面/声音是否真的同时出来仍要在用户浏览器里看（通道断，见 contracts 里的待补标记）。
import { ReplayEngine, groupTracksByLane } from '../src/utils/replayEngine.ts'

const ok = []
const bad = []
function check(name, got, want) {
  const a = JSON.stringify(got)
  const b = JSON.stringify(want)
  ;(a === b ? ok : bad).push(`${name}: ${a === b ? '得 ' + a : `期望 ${b}，实得 ${a}`}`)
}

function seg(session, seq, offsetSec, durationSec) {
  return { seq, offsetSec, durationSec, sizeBytes: 100, blobKey: `${session}#${seq}`, mime: 'video/webm' }
}
function track(recordingId, ownerId, ownerName, kind, segments, endOffsetSec, closeReason) {
  return {
    recordingId,
    ownerId,
    ownerName,
    kind,
    mediaLabel: kind === 'microphone' ? '麦克风' : '摄像头',
    hasVideo: kind !== 'microphone',
    // 本机画面那一路是画布重取的，天然没有音轨；声音永远单独成一路 microphone
    hasAudio: kind === 'microphone',
    startOffsetSec: segments.length ? segments[0].offsetSec : 0,
    endOffsetSec,
    closedAtMs: 1,
    closeReason,
    mime: 'video/webm',
    fileName: `${ownerName}-${recordingId}.webm`,
    segments,
  }
}

// 场景：u1 0-3s 退会、7s 再入录到 10s（两次会话）；u2 全程 0-10s；u3 0-6s 后彻底离会；u1 另有一路麦克风。
const manifest = [
  track('local-A1', 'u1', 'P1', 'camera', [seg('local-A1', 0, 0, 1.5), seg('local-A1', 1, 1.5, 1.5)], 3, 'publisher_left'),
  track('local-A2', 'u1', 'P1', 'camera', [seg('local-A2', 0, 7, 1.5), seg('local-A2', 1, 8.5, 1.5)], 10, 'session_end'),
  track('local-B1', 'u2', 'P2', 'camera', [seg('local-B1', 0, 0, 5), seg('local-B1', 1, 5, 5)], 10, 'session_end'),
  track('local-C1', 'u3', 'P3', 'camera', [seg('local-C1', 0, 0, 3), seg('local-C1', 1, 3, 3)], 6, 'publisher_left'),
  track('local-M1', 'u1', 'P1', 'microphone', [seg('local-M1', 0, 0, 10)], 10, 'session_end'),
]

const grouped = groupTracksByLane(manifest)
check('归组后窗格数（3 人 4 次会话 = 3 格 + 1 路麦克风，不是 5 格）', grouped.length, 4)
check(
  '窗格按开始时刻排',
  grouped.map((t) => `${t.ownerName}/${t.kind}`),
  ['P1/camera', 'P2/camera', 'P3/camera', 'P1/microphone'],
)
const laneA = grouped.find((t) => t.kind === 'camera' && t.ownerId === 'u1')
check('同一人两次会话挂在同一格里', laneA.sources.map((s) => s.recordingId), ['local-A1', 'local-A2'])
check(
  '每片带上自己那次会话的标记',
  laneA.segments.map((s) => `${s.blobKey}|${s.session}`),
  ['local-A1#0|local-A1', 'local-A1#1|local-A1', 'local-A2#0|local-A2', 'local-A2#1|local-A2'],
)

const eng = new ReplayEngine({
  tracks: grouped,
  durationSec: 10,
  startAtMs: 0,
  resolveUrl: async () => 'blob:x',
  assembleRuns: true,
})
check('有画面的格子数（麦克风不占格）', eng.videoRows.length, 3)
const rowA = eng.rows.find((r) => r.ownerId === 'u1' && r.hasVideo)
const rowB = eng.rows.find((r) => r.ownerId === 'u2')
const rowC = eng.rows.find((r) => r.ownerId === 'u3')
check('P1 一格里有 2 个可播区（中断不被抹平）', rowA.spans.map((s) => [s.start, s.end, s.session]), [  [0, 3, 'local-A1'],
  [7, 10, 'local-A2'],
])
check('P2 一格 1 个可播区（同会话连续两片并成一个区）', rowB.spans.length, 1)
check('全局时长仍是整场 10 秒，不被那 4 秒空洞缩短', eng.duration, 10)

const at = (t) => {
  eng.seek(t)
  return [eng.segmentAt(rowA), eng.segmentAt(rowB)]
}
check('t=1s 两路都在播', at(1), [0, 0])
check('t=5s（退会空洞）P1 没有片、P2 照常在播', at(5), [-1, 0])
check('t=8s P1 落在再入会那个区', at(8), [1, 0])

// gapText 是 private（只挡编译期），界面那句缺口文案就出自它
const gapA = (t) => {
  eng.seek(t)
  return eng.gapText(rowA)
}
const gapC = (t) => {
  eng.seek(t)
  return eng.gapText(rowC)
}
check('空洞里说「此时段录制中断」', gapA(5), '此时段录制中断')
check('整点收尾说「此刻没有画面」', gapA(10), '这一路此刻没有画面')
check('彻底离会且没再入说「在此刻之前已经停止」', gapC(8), '这一路在此刻之前已经停止')

// 跨会话不许合区：秒退秒进即便时间相接，拼到一起也是一段缺自己容器头的坏流
const adjacent = groupTracksByLane([
  track('s1', 'x1', 'P4', 'camera', [seg('s1', 0, 0, 2)], 2, 'publisher_left'),
  track('s2', 'x1', 'P4', 'camera', [seg('s2', 0, 2.1, 2)], 4.1, 'session_end'),
])
const eng2 = new ReplayEngine({ tracks: adjacent, durationSec: 5, startAtMs: 0, resolveUrl: async () => '', assembleRuns: true })
check('跨会话即使相接也不并成一个可播区', eng2.rows[0].spans.map((s) => [s.start, s.end, s.session]), [
  [0, 2, 's1'],
  [2.1, 4.1, 's2'],
])
const sameSession = groupTracksByLane([
  track('s3', 'x2', 'P5', 'camera', [seg('s3', 0, 0, 2), seg('s3', 1, 2.1, 2)], 4.1, 'session_end'),
])
const eng3 = new ReplayEngine({ tracks: sameSession, durationSec: 5, startAtMs: 0, resolveUrl: async () => '', assembleRuns: true })
check('同会话相接片仍并成一个可播区（原行为不变）', eng3.rows[0].spans.length, 1)

// 仍在录的那次会话不能被已收尾的那次冒充终点
const open = groupTracksByLane([
  track('s4', 'x3', 'P6', 'camera', [seg('s4', 0, 0, 2)], 2, 'publisher_left'),
  track('s5', 'x3', 'P6', 'camera', [seg('s5', 0, 5, 2)], null, ''),
])
check('任一会话没终值 → 整格 endOffsetSec 为 null', open[0].endOffsetSec, null)

// 回归：起点为负的脏片夹到 0（时长照实保留），不能留下 end<start 的反向区间
const negative = groupTracksByLane([track('s6', 'x4', 'P7', 'camera', [seg('s6', 0, -1, 2)], 1, 'session_end')])
const eng4 = new ReplayEngine({ tracks: negative, durationSec: 5, startAtMs: 0, resolveUrl: async () => '', assembleRuns: true })
check('负起点夹到 0 且区间不倒挂', eng4.rows[0].spans.map((s) => [s.start, s.end]), [[0, 2]])

check(
  '麦克风不进宫格',
  eng.videoRows.map((r) => r.ownerId),
  ['u1', 'u2', 'u3'],
)
check('音频行只有一路麦克风', eng.audioRows.length, 1)

console.log(`PASS ${ok.length}`)
for (const l of ok) console.log('  ok  ' + l)
if (bad.length) {
  console.log(`FAIL ${bad.length}`)
  for (const l of bad) console.log('  XX  ' + l)
  process.exitCode = 1
}
