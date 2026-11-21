/**
 * 版本更新日志的数据用例（node scratch/verify-changelog.ts）。
 *
 * 钉的是**数据层**的四条判据 —— 渲染层错了肉眼一眼可见，数据层错了没人看得出：
 *   ① 版本号严格递减、不重复、不跳号（跳号会让人以为漏装了某一版）
 *   ② 每条 ≤ 40 字符且**必须单行**；一版 ≤ 6 条（"尽量简洁"落成可判的数）
 *   ③ 无记录版本用空数组表示，且**只有**这一种表示（不加 hasRecord 之类的冗余标志）
 *   ④ currentRelease() 就是最新那一版
 *
 * 素材侧的坑记在这里，免得下一个人重新踩：
 *   - v0.3.0 不单列：它与 v0.4.0 是同一份交付（交付目录被整体改名，构建时间相同）。
 *     拆成两条等于制造一个不存在的版本差异。
 *   - v0.1.0/v0.2.0/v0.4.0/v0.5.0/v0.6.0 的发版说明里没有"本版改了什么"段，但 2026-11-13
 *     按用户授权从**多处汇总**补齐了（tag 区间 feat/fix、子仓前缀 tag 区间、交付说明 diff）。
 *     汇总时两条纪律：① 不编造，没有证据就留空；② 只取用户能感知的 —— 换构建工具、
 *     改文档这类不进 items。v0.4.0 区间里混着吸收进来的子仓历史，必须 `--first-parent`。
 *   - v0.8.1 发版说明里的「v0.8.0 的全部内容（本版一并带着）」是累计段，不是本版条目。
 */
import { CHANGELOG, currentRelease, type Release } from '../src/data/changelog.ts'

let checks = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = '') {
  checks++
  if (!cond) fails.push(`${name}${detail ? ' :: ' + detail : ''}`)
}

// ── ① 版本序列：严格递减、不重复、不跳号
// 先拦"整份为空"：不加这条，后面 `CHANGELOG[0].version` 会抛 TypeError，
// 虽然退出码仍是 1、门禁仍会红，但报错信息是 JS 堆栈而不是"少了什么"，读的人要猜。
ok('CHANGELOG 非空（至少一条版本记录）', CHANGELOG.length > 0)
if (!CHANGELOG.length) {
  console.log(`✗ 版本更新日志数据：${checks - fails.length}/${checks} 条通过，但 CHANGELOG 为空，无法继续`)
  process.exit(1)
}

const versions = CHANGELOG.map((r) => r.version)
ok('版本号形如 vX.Y.Z', versions.every((v) => /^v\d+\.\d+\.\d+$/.test(v)), versions.join(','))

const nums = versions.map((v) => v.slice(1).split('.').map(Number))
function cmp(a: number[], b: number[]) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}
let descending = true
for (let i = 1; i < nums.length; i++) if (cmp(nums[i - 1], nums[i]) <= 0) descending = false
ok('版本号严格递减（最新在最前）', descending, versions.join(' > '))

ok('版本号不重复', new Set(versions).size === versions.length)

/**
 * 不跳号：防的是"漏了一版没写"—— 跳号在界面上看起来就像漏装。
 *
 * 两条判据，方向别搞反（这里曾写错一次，把"前一条"当成"后一条"，于是永远红）：
 *   ① **同次版本内**：补丁号只能差 1（v0.8.1 → v0.8.0）。
 *   ② **跨次版本时**：上一条（号更大的那个）补丁号必须是 0 —— 一个次版本发到 .2 才结束，
 *      却直接从 .2 跳到下一个次版本，说明中间那条 .3 被漏了。
 *
 * 次版本号本身的跳跃**不判**：v0.4.0 → v0.2.0 是真实存在的缺口，因为 v0.3.0 与 v0.4.0
 * 是同一份交付（交付目录被整体改名）。这个例外单独由下面那条断言钉住，不许悄悄扩大。
 */
let noGap = true
const gapDetail: string[] = []
for (let i = 1; i < nums.length; i++) {
  const hi = nums[i - 1]
  const lo = nums[i]
  if (hi[0] === lo[0] && hi[1] === lo[1]) {
    if (hi[2] - lo[2] !== 1) {
      noGap = false
      gapDetail.push(`${versions[i - 1]} → ${versions[i]}（同次版本内补丁号应差 1）`)
    }
  } else if (hi[2] !== 0) {
    noGap = false
    gapDetail.push(`${versions[i - 1]} → ${versions[i]}（跨次版本时上一条补丁号应为 0）`)
  }
}
ok('版本号不跳号', noGap, gapDetail.join('; '))

// 次版本跳跃只允许发生在 v0.4.0 → v0.2.0 这一处（v0.3.0 并入 v0.4.0）。
// 钉死它，是为了让"下次又漏一版"不能靠改这条判据悄悄放行。
// 注意只挑**次版本号真的变了**的相邻对：v0.8.1 → v0.8.0 是同次版本内的补丁回退，
// 由上面那条「同次版本内补丁号差 1」管，不归这里。
const MINOR_GAPS = versions
  .slice(1)
  .map((v, i) => [versions[i], v])
  .filter(([a, b]) => {
    const na = a.slice(1).split('.').map(Number)
    const nb = b.slice(1).split('.').map(Number)
    return na[0] === nb[0] && na[1] !== nb[1] && na[1] - nb[1] !== 1
  })
  .map(([a, b]) => `${a} → ${b}`)
ok(
  '次版本跳跃只允许 v0.4.0 → v0.2.0（v0.3.0 并入 v0.4.0）',
  MINOR_GAPS.join(';') === 'v0.4.0 → v0.2.0',
  MINOR_GAPS.join('; '),
)

// v0.3.0 不单列（与 v0.4.0 同一份交付）
ok('v0.3.0 不单列', !versions.includes('v0.3.0'))

// ── ② 简洁度：每条 ≤ 40 字符且必须单行；一版 ≤ 6 条
const TOO_LONG: string[] = []
const TOO_MANY: string[] = []
for (const rel of CHANGELOG) {
  if (rel.items.length > 6) TOO_MANY.push(`${rel.version} 有 ${rel.items.length} 条`)
  for (const item of rel.items) {
    if ([...item].length > 40) TOO_LONG.push(`${rel.version}: ${[...item].length} 字「${item}」`)
    if (item.split('\n').length > 1) TOO_LONG.push(`${rel.version}: 必须单行「${item}」`)
  }
}
ok('每条不超过 40 字', TOO_LONG.length === 0, TOO_LONG.join('; '))
ok('一版不超过 6 条', TOO_MANY.length === 0, TOO_MANY.join('; '))

// 条目不许为空串（空串会在界面上渲染成一行空白，看起来像坏了）
const BLANK: string[] = []
for (const rel of CHANGELOG) for (const item of rel.items) if (!item.trim()) BLANK.push(rel.version)
ok('条目不许是空白串', BLANK.length === 0, BLANK.join(','))

// ── ③ 无记录只有一种表示：items 为空数组
const recs: Release[] = CHANGELOG
ok(
  '每条记录都有 items 数组（无记录 = 空数组，不用别的标志）',
  recs.every((r) => Array.isArray(r.items)),
)
ok(
  '除 items/version/date 外没有多余字段（防 hasRecord 之类的第二套表示）',
  recs.every((r) => Object.keys(r).sort().join(',') === 'date,items,version'),
  recs.find((r) => Object.keys(r).sort().join(',') !== 'date,items,version')?.version ?? '',
)

// 注意：2026-11-13 之后 10 个版本**全部**有 items，"items 为空时显示灰字"这条渲染路径
// 不再由真实数据走到 —— 它只剩代码里的分支，靠手工验（本仓没有组件测试）。
// 这里不再断言"必须存在无记录版本"：那会逼着人为了过判据而故意留空一条，是本末倒置。
// 一旦将来某版确实无素材，`items: []` 仍是被允许且被上面两条断言覆盖的形状。

// ── ④ currentRelease 就是最新那一版
ok('currentRelease() 返回第一条', currentRelease().version === CHANGELOG[0].version)
ok('currentRelease() 非空', currentRelease() !== undefined)

// ── ⑤ 日期形状（渲染层直接拼字符串，形状不对会显示成乱码）
const BAD_DATE = CHANGELOG.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date)).map((r) => `${r.version}:${r.date}`)
ok('日期形如 YYYY-MM-DD', BAD_DATE.length === 0, BAD_DATE.join(','))

// ── ⑥ 条目里不许出现内部词（文案门禁的禁词表抽样；完整表在前端 check:copy 里）
// 这里抽样是因为**数据文件本身**也要能独立自证，别只依赖另一条门禁。
const BANNED = ['三方', '上游', '板卡', '船端', '岸端', 'WHEP', 'WHIP', 'HLS', 'codec', 'ROI', '落盘', '分路']
const HIT: string[] = []
for (const rel of CHANGELOG) {
  for (const item of rel.items) {
    for (const w of BANNED) if (item.includes(w)) HIT.push(`${rel.version}: 「${item}」含「${w}」`)
  }
}
ok('条目不出现内部词', HIT.length === 0, HIT.join('; '))

// ── ⑦ 条目不写部署侧别
// 边云两份 tar 共用同一份前端产物，前端物理上拿不到自己是哪一侧；
// 写「云端/边端」只会让用户困惑"我这是哪一侧"，而这个问题界面上无解。
// 换成用户能感知的说法（「对方画面」「打开页面」「内嵌打开时」）。
const SIDE_WORDS = ['云端', '边端', '岸端', '船端']
const SIDE_HIT: string[] = []
for (const rel of CHANGELOG) {
  for (const item of rel.items) {
    for (const w of SIDE_WORDS) if (item.includes(w)) SIDE_HIT.push(`${rel.version}: 「${item}」含「${w}」`)
  }
}
ok('条目不写部署侧别（前端拿不到 side，写了用户也无解）', SIDE_HIT.length === 0, SIDE_HIT.join('; '))

// ── ⑧ 只写正向变更〔2026-11-13 用户定〕
// 更新日志只回答"这一版变好了什么"。使用限制、警告、口径收回、功能下线一律不进
// items —— 它们的去处是发版说明（给运维）与界面上的即时提示。
// 这条判据是**启发式**：只抓措辞上明显的坏消息，判断"这条算不算好消息"仍需人来做
// （写判据的人不能假装能判语义）。宁可漏，不要误伤 —— 所以词表刻意短。
const NEGATIVE_MARKERS = ['不保证', '请谨慎', '不支持', '已下线', '已移除', '会变糊']
const NEG_HIT: string[] = []
for (const rel of CHANGELOG) {
  for (const item of rel.items) {
    for (const w of NEGATIVE_MARKERS) if (item.includes(w)) NEG_HIT.push(`${rel.version}: 「${item}」含「${w}」`)
  }
}
ok('条目只写正向变更（不写限制/警告/口径收回）', NEG_HIT.length === 0, NEG_HIT.join('; '))

// ── ⑨ 用书面语，不用口语〔2026-11-13 用户定〕
// 从发版说明里摘用户向段落时，原文全是现场口语（"真的生效""莫名消失""崩了"
// "点了有反应""摆两个空格子"），照抄过来像工单留言。这条是**启发式**：
// 只抓最典型的几个口语词，其余靠写的时候自觉 —— 判据不能假装能判文风。
const ORAL_MARKERS = ['真的', '莫名', '崩了', '存住了', '一片空白', '摆两个空格子', '卡在', '点了']
const ORAL_HIT: string[] = []
for (const rel of CHANGELOG) {
  for (const item of rel.items) {
    for (const w of ORAL_MARKERS) if (item.includes(w)) ORAL_HIT.push(`${rel.version}: 「${item}」含「${w}」`)
  }
}
ok('条目用书面语（不出现"真的/莫名/崩了/点了"这类口语）', ORAL_HIT.length === 0, ORAL_HIT.join('; '))

console.log(
  fails.length
    ? `✗ 版本更新日志数据：${fails.length}/${checks} 条失败：\n  ${fails.join('\n  ')}`
    : `✓ 版本更新日志数据：${checks} 条断言全过（${CHANGELOG.length} 个版本，其中 ${CHANGELOG.filter((r) => !r.items.length).length} 个无记录）`,
)
process.exit(fails.length ? 1 : 0)
