// 录制列表"按场次聚合"的回归用例（纯逻辑，node 直跑：`node scratch/verify-group-rows.ts`）。
//
// 钉的是 2026-10-01 用户定的口径：云端归档的单位是**一路发布**（一场会里每个人的画面/声音/共享屏幕
// 各是一条 recording，各有 id/时长/下载地址），平铺出来像"重复"；所以要**按场次**聚成一张卡、
// 卡内再按参会者分组选一路。注意不是"按人" —— 同一场会里所有人的路都在同一张卡上。
import { groupRecordingsBySession } from '../src/utils/recordingRows.ts'

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

// 标签 ↔ 通路 的对应照后端 `LaneOf` 的口径（画面=camera / 声音=audio / 共享屏幕=screen）
const kindOfLabel = (label: string) => (label === '声音' ? 'audio' : label === '共享屏幕' ? 'screen' : 'camera')
const cloud = (id: string, participant: string, kind: string, opts: Partial<{ meetingId: string; no: string; dur: number; size: number; deletable: boolean; startedAt: string; mediaKind: string }> = {}) => {
  const meetingId = opts.meetingId ?? 'm1'
  return {
    recordingId: id,
    meetingId,
    // 号与场次同源：有会议 id 的行，三方目录里必然带着那场会的摘要号；空 id 的孤行只能是空串
    meetingNo: opts.no ?? (meetingId ? '48124890' : ''),
    participant,
    recordingType: 'cloud' as const,
    durationSec: opts.dur ?? 35,
    fileSizeBytes: opts.size ?? 1000,
    deletable: opts.deletable ?? true,
    startedAt: opts.startedAt ?? '2026-10-01T10:23:00+08:00',
    mediaKind: opts.mediaKind ?? kindOfLabel(kind),
    mediaLabel: kind,
  }
}
const local = (id: string, dur: number, size: number) => ({
  recordingId: id,
  meetingId: 'local',
  // 本机条目带的是当时入会用的三方号（录制只可能发生在已入会之后）
  meetingNo: '48124891',
  participant: '本机',
  recordingType: 'local' as const,
  durationSec: dur,
  fileSizeBytes: size,
  deletable: true,
  startedAt: '2026-10-01T09:00:00+08:00',
  mediaLabel: '2 路画面 · 1 路声音',
})

// 1) 同一场会的所有路（含不同参会者）→ 一张卡（本次需求的核心）
{
  const rows = [
    cloud('rec_a_cam', '陈芳', '画面'),
    cloud('rec_b_cam', '李四', '画面'),
    cloud('rec_a_mic', '陈芳', '声音'),
  ]
  const g = groupRecordingsBySession(rows)
  check('一场会聚成一张卡（不分人）', g.length === 1 && g[0].lanes.length === 3, `${g.length} 组 / ${g[0]?.lanes.length} 路`)
  check('组内顺序保留下发顺序（列表按开始时间倒序）', g[0].lanes.map((l) => l.recordingId).join(',') === 'rec_a_cam,rec_b_cam,rec_a_mic', g[0].lanes.map((l) => l.recordingId).join(','))
}

// 2) 不同场次：各成一张卡
{
  const rows = [cloud('a', '陈芳', '画面'), cloud('b', '陈芳', '画面', { meetingId: 'm2' }), cloud('c', '李四', '画面', { meetingId: 'm3' })]
  const g = groupRecordingsBySession(rows)
  check('按场次分开', g.length === 3, g.map((x) => x.key).join(' | '))
  check('键就是会议号', g.map((x) => x.key).join(',') === 'cloud:m1,cloud:m2,cloud:m3', g.map((x) => x.key).join(','))
}

// 3) 时长取最长、大小求和（几路是同一时刻并行的，相加会把时长翻倍 —— 那是假数）
{
  const rows = [cloud('a', '陈芳', '画面', { dur: 35, size: 1000 }), cloud('b', '李四', '声音', { dur: 33, size: 200 })]
  const g = groupRecordingsBySession(rows)[0]
  check('时长取最长的那一路', g.durationSec === 35, String(g.durationSec))
  check('大小是各路之和', g.fileSizeBytes === 1200, String(g.fileSizeBytes))
}

// 4) startedAt 取组内最早那一路（"这一场从什么时候开始录的"）
{
  const rows = [
    cloud('a', '陈芳', '画面', { startedAt: '2026-10-01T10:23:00+08:00' }),
    cloud('b', '李四', '声音', { startedAt: '2026-10-01T10:20:00+08:00' }),
  ]
  const g = groupRecordingsBySession(rows)[0]
  check('开始时间取最早', g.startedAt === '2026-10-01T10:20:00+08:00', g.startedAt)
}

// 5) 可删 = 全部路都可删（删除是三方的整场粒度，只要有一路说不能删，这张卡就不该给可点的删除）
{
  const rows = [cloud('a', '陈芳', '画面', { deletable: true }), cloud('b', '李四', '声音', { deletable: false })]
  check('任一路不可删 → 整组不可删', groupRecordingsBySession(rows)[0].deletable === false)
}

// 6) 本机条目各自成组（它一条就是一次会话，几路在会话里），不与同场次的云端条目混
{
  const rows = [local('local-1', 100, 500), local('local-2', 60, 300), cloud('x', '本机', '画面')]
  const g = groupRecordingsBySession(rows)
  check('本机各自成组', g.filter((x) => x.key.startsWith('local:')).length === 2, g.map((x) => x.key).join(' | '))
  check('单路的组照样成立（卡内不用出选择器）', g.every((x) => x.lanes.length >= 1))
}

// 7) 空输入不出组（列表空态由页面自己说话）
{
  check('空输入 → 空数组', groupRecordingsBySession([]).length === 0)
}

// 8) **卡片报的是回放路数**（2026-10-01 用户定）：同一人退了再入会的两份画面在回放页并成一条，
//    所以文件数 ≥ 路数；卡片那个数字必须是路数，否则与进去看到的对不上。
{
  const rows = [
    cloud('cam_1', '陈芳', '画面', { startedAt: '2026-10-01T10:00:00+08:00' }),
    cloud('cam_2', '陈芳', '画面', { startedAt: '2026-10-01T10:30:00+08:00' }), // 中途退了再入 = 第二份画面文件
    cloud('mic', '陈芳', '声音'),
    cloud('scr', '陈芳', '共享屏幕'),
  ]
  const g = groupRecordingsBySession(rows)[0]
  check('文件数与路数是两个数', g.lanes.length === 4 && g.laneCount === 3, `文件=${g.lanes.length} 路=${g.laneCount}`)
}

// 9) 路数按「参会者 × 通路」数：不同人同通路不并、同一人不同通路不并
{
  const rows = [
    cloud('a1', '陈芳', '画面'),
    cloud('a2', '李四', '画面'),
    cloud('a3', '陈芳', '声音'),
    cloud('a4', '李四', '声音'),
    cloud('a5', '陈芳', '共享屏幕'),
  ]
  const g = groupRecordingsBySession(rows)[0]
  check('路数 = 参会者 × 通路', g.laneCount === 5, String(g.laneCount))
}

// 10) mediaKind 为空（未识别）按回放页的规则当摄像头 —— 别在这里另立一套映射
{
  const rows = [cloud('a', '陈芳', '画面', { mediaKind: '' }), cloud('b', '陈芳', '画面', { mediaKind: 'camera' })]
  check('空 mediaKind 与 camera 算同一条路', groupRecordingsBySession(rows)[0].laneCount === 1)
}

// 11) 卡片那行给的是**明细**（照本机卡片的写法）：按通路拆开，三条相加恒等于路数
{
  const rows = [
    cloud('c1', '陈芳', '画面'),
    cloud('c2', '陈芳', '声音'),
    cloud('s1', '陈芳', '共享屏幕'),
    cloud('c3', '李四', '画面'),
    cloud('c4', '陈芳', '画面', { startedAt: '2026-10-01T10:40:00+08:00' }), // 退了再入 → 与前面那条画面并成一路
  ]
  const g = groupRecordingsBySession(rows)[0]
  const b = g.laneBreakdown
  check('明细：画面 2 · 声音 1 · 共享屏幕 1', b.video === 2 && b.audio === 1 && b.screen === 1, JSON.stringify(b))
  check('明细相加恒等于路数', b.video + b.audio + b.screen === g.laneCount, `和=${b.video + b.audio + b.screen} 路数=${g.laneCount}`)
}

// 12) meetingId 为空的孤行不许被并成一张假卡（没有会议 id 就无法判断是不是同一场）
{
  const rows = [
    cloud('orphan_1', '陈芳', '画面', { meetingId: '' }),
    cloud('orphan_2', '李四', '画面', { meetingId: '' }),
    cloud('normal', '陈芳', '画面', { meetingId: 'm1' }),
  ]
  const g = groupRecordingsBySession(rows)
  check('空 meetingId：各成一卡', g.length === 3, g.map((x) => x.key).join(' | '))
  check('空 meetingId 的卡键带 orphan 前缀（一眼看出它不是按场次聚的）', g[0].key.startsWith('cloud-orphan:'), g[0].key)
}

// 13) 卡片那一行「会议号」：号取自分组摘要，同一场各路本该同一个号
{
  const one = groupRecordingsBySession([
    cloud('a', '陈芳', '画面'),
    cloud('b', '李四', '声音'),
  ])[0]
  check('会议号：同一场各路给的是同一个号', one.meetingNo === '48124890', one.meetingNo)
  // 上游不齐（前面那行的摘要还没带上号、后面那行带了）时不能因为顺序就报空 —— 卡片宁可给出号
  const mixed = groupRecordingsBySession([
    cloud('c', '陈芳', '画面', { no: '' }),
    cloud('d', '陈芳', '声音', { no: '48124890' }),
  ])[0]
  check('会议号：组内有一行带着号就不报空', mixed.meetingNo === '48124890', mixed.meetingNo)
  // 三方点名的历史孤立录像：meeting 为 null → 没有号，界面按空串如实说，不许拿 recordingId/会话键顶上
  const orphan = groupRecordingsBySession([cloud('e', '陈芳', '画面', { meetingId: '' })])[0]
  check('会议号：孤立录像就是空串（不拿别的键冒充）', orphan.meetingNo === '', JSON.stringify(orphan.meetingNo))
}

console.log(`\n断言结果：${failed === 0 ? '全部通过' : `${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
