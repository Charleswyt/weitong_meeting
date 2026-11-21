/**
 * 用例自证（变异测试）：判据必须抓得住坏样本，否则"全过"没有意义。
 *
 * 为什么需要这个：本仓有过两次教训 —— 判据自己坏了却报"0 命中"，比没有门禁更糟。
 * 这里对 `verify-changelog.ts` 做三组变异，每组都必须让用例变红；还原后必须转绿。
 *
 * 跑法：node scratch/selftest-changelog.mjs   （判据坏了退出码 2，正常退出 0）
 * 用 Node 读写而不是 shell，因为 PowerShell 写 UTF-8 会破坏中文（踩过）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'src/data/changelog.ts')
const CASE = join(ROOT, 'scratch/verify-changelog.ts')

const original = readFileSync(DATA, 'utf8')

/** 跑一次用例，返回 {ok, out} */
function runCase() {
  try {
    const out = execFileSync(process.execPath, ['--experimental-strip-types', CASE], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, out }
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }
  }
}

const results = []
function mutate(name, from, to, expectRed = true) {
  if (!original.includes(from)) {
    results.push({ name, pass: false, why: `样本锚点没找到：${from.slice(0, 30)}` })
    return
  }
  writeFileSync(DATA, original.replace(from, to), 'utf8')
  const r = runCase()
  const pass = expectRed ? !r.ok : r.ok
  results.push({ name, pass, why: pass ? '' : `期望${expectRed ? '变红' : '转绿'}，实际${r.ok ? '绿' : '红'}` })
}

// ── 变异样本：定位文本从文件里现取，不硬编码任何条目文案 ──────────────
// 教训：这些样本原来写死了某条 item 的原文，文案一改（口语→书面语、补条、删条）
// 就报"样本锚点没找到"—— 而那不是判据坏了，是样本自己过期了。已经为此返工四次。
// 现在统一从 original 里取第一处 / 最后一处 items 数组，文案怎么改都不影响。
const ARRAY_RE = /items: \['[^\]]*'\]/g
const arrays = [...original.matchAll(ARRAY_RE)].map((m) => m[0])
const firstArray = arrays[0] ?? ''
const lastArray = arrays.at(-1) ?? ''
const firstItem = firstArray.match(/'([^']*)'/)?.[1] ?? ''

if (!firstArray || !lastArray || !firstItem) {
  console.error('✗ 自证无法进行：文件里找不到 items 数组，先检查 changelog.ts 的形状。')
  process.exit(2)
}

// ① 超 40 字
mutate(
  '超 40 字 → 必须变红',
  `'${firstItem}'`,
  `'${firstItem}而且这一条故意写得很长很长超过四十个字符用来验证判据是否真的抓得住'`,
)

// ② 一版超过 6 条（直接替换整行 items，不依赖该版本原本有几条）
mutate(
  '一版 7 条 → 必须变红',
  firstArray,
  "items: ['条目一','条目二','条目三','条目四','条目五','条目六','条目七']",
)

// ③ 出现内部词
mutate('出现禁词「三方」→ 必须变红', `'${firstItem}'`, "'三方接口修复'")

// ③b 出现部署侧别词（前端拿不到 side，写进日志用户也无解）
mutate('出现侧别词「云端」→ 必须变红', `'${firstItem}'`, "'云端机器能打开页面了'")

// ③c 出现换行（条目必须单行）
mutate('条目含换行 → 必须变红', `'${firstItem}'`, "'内嵌打开时\\n录制保存位置点了有反应'")

// ③d 出现坏消息（只写正向变更：限制/警告/口径收回不进 items）
mutate('出现警告「请谨慎」→ 必须变红', `'${firstItem}'`, "'范围放宽了但低码率请谨慎'")

// ③e 出现口语（用书面语）
mutate('出现口语「真的」→ 必须变红', `'${firstItem}'`, "'这条真的修好了'")

// ④ 版本号乱序（把最新的改成最小）
mutate('版本号破坏递减 → 必须变红', "version: 'v0.8.1'", "version: 'v0.0.1'")

// ⑤ 跳号（把 v0.8.0 的版本号改成非法值，造成 0.8.1 → 0.7.0 的跨次版本跳跃）
mutate(
  '删掉 v0.8.0 造成跳号 → 必须变红',
  "  {\n    version: 'v0.8.0',",
  "  {\n    version: 'v0.8.1b',",
)

// ⑥ 空白条目（用最后一处 items 数组作锚点）
mutate('空白条目 → 必须变红', lastArray, "items: ['   ']")

// 还原，必须转绿
writeFileSync(DATA, original, 'utf8')
const restored = runCase()
results.push({ name: '还原后 → 必须转绿', pass: restored.ok, why: restored.ok ? '' : '还原后仍红，文件没洗干净' })

// 确认盘上内容与原始逐字节一致（防止变异残留）
const final = readFileSync(DATA, 'utf8')
results.push({
  name: '盘上内容与原始逐字节一致',
  pass: final === original,
  why: final === original ? '' : '文件被改坏了',
})

const bad = results.filter((r) => !r.pass)
for (const r of results) console.log(`${r.pass ? '✓' : '✗'} ${r.name}${r.why ? ' :: ' + r.why : ''}`)

if (bad.length) {
  console.error(`\n✗ 用例自证失败 ${bad.length} 条 —— 判据抓不住坏样本，此时的"全过"没有意义。`)
  process.exit(2)
}
console.log(
  `\n✓ 用例自证 ${results.length} 条全过（${results.filter((r) => r.name.includes('必须变红')).length} 组变异都变红、还原转绿、盘上无残留）`,
)
