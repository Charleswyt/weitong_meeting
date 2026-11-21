/**
 * 归属判据的用例：`ownerStateOf` 是"谁能看见 / 谁能删"的唯一算式，判错一次就是把别人的录制
 * 当成自己的（或反过来把自己的藏掉）。
 * 跑法：node scratch/verify-local-visibility.ts
 *
 * `register()` 必须早于任何走 `@/` 别名的 import，而静态 import 会被提升到模块最前 ——
 * 所以被测模块用动态导入拿，别改成静态的（那样会解析不到 `@/store/user` 那条桩）。
 */
import { register } from 'node:module'

register('./ts-alias-hooks.mjs', import.meta.url)

const { setStubAccount } = await import('./stub-user-store.ts')
const { ownerStateOf, loginAccount } = await import('../src/utils/recordingAccount.ts')
const { planLocalRecordingSync } = await import('../src/utils/localRecorder.ts')

let failures = 0
let checks = 0
function eq(got: unknown, want: unknown, label: string) {
  checks++
  if (got !== want) {
    failures++
    console.error(`  ✗ ${label}\n      期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`)
  }
}

// —— 1. 身份未就绪时**一律不判**：这是"一次隐藏全部本机录制"那条事故的防线
setStubAccount('')
eq(loginAccount(), '', '未登录时 loginAccount() 给空串')
for (const stored of ['alice', 'bob', '', undefined, null]) {
  eq(ownerStateOf(stored as string | undefined | null), null, `身份未就绪 + 条目账号=${JSON.stringify(stored)} → 不判定`)
}

// —— 2. 三态各自落点
setStubAccount('alice')
eq(ownerStateOf('alice'), 'mine', '自己的')
eq(ownerStateOf('bob'), 'others', '别人的')
eq(ownerStateOf(undefined), 'unknown', '没记账号（本轮字段之前的历史条目）')
eq(ownerStateOf(''), 'unknown', '记了空串 = 同样没证据')
eq(ownerStateOf('   '), 'unknown', '只有空白也算没证据，不能当"别人的"藏掉')

// —— 3. 比对口径：只 trim，不改大小写
eq(ownerStateOf(' alice '), 'mine', '两侧空白容错')
eq(ownerStateOf('Alice'), 'others', '大小写敏感 —— 账号寻址本就大小写敏感，改小写等于造第二个真源')

// —— 4. 磁盘扫描那条分支：旧实现在这里销毁数据，所以必须测到
type Row = {
  id: string
  title: string
  meetingNo: string
  fileName: string
  startedAt: number
  durationSec: number
  sizeBytes: number
  recorderAccount?: string
  dirPath?: string | null
  dirHandle?: boolean
}
// meetingNo 逐条不同、startedAt 用真实毫秒时刻：合并判据看的是"同一会议号 + 起始时刻同一秒内"，
// 全部填 'm' 加 100/200/300 那种占位数据会让所有行互相判定成同一片录制（那才是假的绿灯）
let n = 0
const row = (id: string, startedAt: number, o: { account?: string; dirPath?: string | null } = {}): Row => ({
  id,
  title: id,
  meetingNo: `M${++n}`,
  fileName: id,
  startedAt,
  durationSec: 10,
  sizeBytes: 1,
  recorderAccount: o.account,
  dirPath: o.dirPath,
  dirHandle: !!o.dirPath,
})
const ids = (list: Row[]) => list.map((r) => r.id).join(',')

const T = 1790771644176
const LIVE_MEET = 'M73449655'
setStubAccount('alice')
const cached: never[] = [
  row('a-mine', T - 500000, { account: 'alice' }),
  row('b-others', T - 400000, { account: 'bob' }),
  row('c-noEvidence', T - 300000), // 没记账号、也没写过盘 → 唯一真判不出归属的那一类
  row('d-degraded', T - 200000, { account: 'alice' }), // 从没写过盘的降级条目（dirHandle=false）
  row('disk-gone', T - 100000, { account: 'alice' }), // 上一轮扫描写下、这一轮盘上已无
  { ...row('live-old', T), meetingNo: LIVE_MEET, recorderAccount: 'alice' }, // 与磁盘那行是同一片录制的两份视图
  row('legacy-noAccount', T + 1000, { dirPath: 'hxt/alice/20260930203404/21501555' }), // 缺账号但有目录证据
  row('legacy-otherAccount', T + 2000, { dirPath: 'hxt/bob/20260930203404/77777777' }), // 目录证据指向别人
  { ...row(`disk-${T}`, T), meetingNo: LIVE_MEET, recorderAccount: 'alice' }, // 重复行：扫描每轮都重建一份
] as never[]
// 磁盘扫到的那一片：id 是 disk-{起始时刻}，会议号与时刻与缓存行一致，账号由扫描当场写下
const disk: never[] = [
  {
    ...row(`disk-${T}`, T),
    meetingNo: LIVE_MEET,
    recorderAccount: 'alice',
    dirPath: `hxt/alice/20260930203404/${LIVE_MEET}`,
    dirHandle: true,
  },
] as never[]
const plan = planLocalRecordingSync(cached, disk)

eq(plan.removeIds.includes('disk-gone'), true, '盘上已无的 disk- 行被回收')
eq(plan.mine.some((r: Row) => r.id === 'disk-gone'), false, '盘上没有的行不进列表')
eq(
  ids(plan.mine.filter((r: Row) => r.id === 'live-old' || r.id.startsWith('disk-'))),
  'live-old',
  '同一片录制的两份行合成一条，保留 local 那个 id（分片字节以它为键，换成 disk- 就播不出来）',
)
eq(plan.removeIds.includes(`disk-${T}`), true, '被合并掉的那条 disk- 缓存行一并回收，列表里不许有重复')
eq(
  (plan.mine.find((r: Row) => r.id === 'live-old') as Row).dirHandle,
  true,
  '合并把"真落盘了"这个磁盘事实补进缓存行',
)
eq(
  (plan.mine.find((r: Row) => r.id === 'live-old') as Row).dirPath,
  `hxt/alice/20260930203404/${LIVE_MEET}`,
  '合并把落盘位置补进缓存行',
)
eq(
  plan.mine.some((r: Row) => r.id === 'legacy-noAccount'),
  true,
  '缺账号但有 dirPath 的老行靠目录证据回来（不需要授权目录，也不需要用户手势）',
)
eq(
  (plan.mine.find((r: Row) => r.id === 'legacy-noAccount') as Row).recorderAccount,
  'alice',
  '回填的是原样登录名，不是目录段',
)
eq(plan.mine.some((r: Row) => r.id === 'legacy-otherAccount'), false, '目录证据指向别人的行不算我的')
eq(plan.unattributed.map((r: Row) => r.id).join(','), 'c-noEvidence', '既没账号也没目录证据的才进"判不出归属"')
eq(plan.mine.some((r: Row) => r.id === 'b-others'), false, '别人的行不出现在列表')
eq(plan.mine.length, 4, 'a-mine / d-degraded / live-old / legacy-noAccount 四条')
eq(plan.put.some((r: Row) => r.id === 'legacy-noAccount'), true, '回填过账号的行要写回缓存，下次不用再猜')
eq(plan.put.some((r: Row) => r.id === `disk-${T}`), false, '被合并的磁盘行不再单独写回缓存')

// 磁盘扫描为空（没授权目录）时不许删任何东西，且证据回填照样生效
const plan2 = planLocalRecordingSync(cached, [])
eq(plan2.removeIds.length, 0, '扫不到磁盘时一条都不删')
eq(plan2.mine.some((r: Row) => r.id === 'legacy-noAccount'), true, '扫不到盘也能靠 dirPath 证据认回老行')
eq(plan2.mine.length, 6, '自己的 5 条 + 证据回填的 1 条（扫不到盘时 disk- 行只是普通条目，一条都不回收）')

// 换过账号但没刷新：上一个人留下的 disk- 行不许冒充"我的"（归属看数据，不看 id 前缀）
const plan3 = planLocalRecordingSync([row('disk-live', T, { account: 'bob' })], [])
eq(plan3.mine.length, 0, '别人留下的 disk- 行不算我的')

// 旧形状 dirPath（缺 hxt 那一层）同样是证据，别因为写法不同就把行判成没证据
const plan4 = planLocalRecordingSync([row('legacy-2', T + 9000, { dirPath: 'alice/20260930203404/88888888' })], [])
eq(plan4.mine.length, 1, '旧形状 dirPath 也能取出账号段')

// —— 4b. 同 id 必须收敛成一行：上一轮扫描写下的 disk- 缓存行与这一轮扫到的 disk- 行是同一条。
// 从前这里并排推了两行 → 卡片只出一张而"共 x 个录制"算两条，页头 17 对"已显示 15"，
// 点「加载更多」后端第 2 页是空的，于是按钮永远在、永远点了没反应（2026-10-10 现场）。
const dupId = `disk-${T + 20000}`
const dupCached = [
  { ...row(dupId, T + 20000), meetingNo: 'DUP1', recorderAccount: 'alice' },
  { ...row('local-dup', T + 21000), meetingNo: 'DUP2', recorderAccount: 'alice' },
] as never[]
const dupDisk = [
  { ...row(dupId, T + 20000), meetingNo: 'DUP1', recorderAccount: 'alice', dirPath: `hxt/alice/s/${'DUP1'}`, dirHandle: true },
  { ...row(`disk-${T + 21000}`, T + 21000), meetingNo: 'DUP2', recorderAccount: 'alice', dirPath: `hxt/alice/s/${'DUP2'}`, dirHandle: true },
] as never[]
const plan5 = planLocalRecordingSync(dupCached, dupDisk)
eq(plan5.mine.length, 2, '两条录制就是两张卡：同 id 的扫描行不许再算一条')
eq(new Set(plan5.mine.map((r: Row) => r.id)).size, plan5.mine.length, '结果里不许出现同 id 的两行')
eq(plan5.mine.some((r: Row) => r.id === dupId), true, '没有 local- 行可对时，盘上那份原样留下')
eq(plan5.removeIds.includes(dupId), false, '盘上还在的同 id 行不该被当重复回收')

// —— 5. 变异自证：判据若被写反（把无证据的算成"自己的"），本文件必须红
checks++
if (plan.unattributed.length !== 1 || plan.mine.some((r: Row) => r.id === 'c-noEvidence')) {
  failures++
  console.error('  ✗ 无证据条目被算进了"自己的" —— 那等于允许当前账号删除任何人的历史录制')
}
checks++
if (plan.mine.some((r: Row) => r.id === 'legacy-otherAccount')) {
  failures++
  console.error('  ✗ 目录段是别人账号的行被算成"我的" —— 换账号后会把别人的录制当成自己的删掉')
}
// 用例本身也要自证在跑：断言数少得可疑就是假绿灯
checks++
if (checks < 20) {
  failures++
  console.error(`  ✗ 断言数少得可疑（${checks}），判据大概根本没跑到`)
}

console.log(failures ? `✗ 归属判据 ${failures}/${checks} 条不符` : `✓ 归属判据全绿：${checks} 条断言`)
process.exit(failures ? 1 : 0)
