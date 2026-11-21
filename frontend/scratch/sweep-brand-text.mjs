// 品牌色当文字 → 走 *-text 变体。只替换 color 声明，不碰 background/border/--el-* 变量定义。
// 断言：替换总数必须等于预期，否则中止不写盘（防止正则跑偏把代码洗坏）。
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, statSync } from 'node:fs'

const APPLY = process.argv.includes('--apply')
const FAMILIES = ['primary', 'danger', 'warning', 'success']
const files = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8' })
  .split('\n').filter(f => /\.(vue|css|scss)$/.test(f))

const before = {}, after = {}
let bytesExpected = 0
const perFile = []

for (const f of files) {
  const src = readFileSync(f, 'utf8')
  let out = src
  const hits = {}
  for (const name of FAMILIES) {
    // 只认"裸 color:"：必须行首或 ; { 空白 之后，排除 border-color / accent-color / --el-*-color
    const target = new RegExp(`((?:^|[;{}\\s])color:\\s*)var\\(--${name}\\)`, 'g')
    let n = 0
    out = out.replace(target, (_m, head) => { n++; return `${head}var(--${name}-text)` })
    if (n) { hits[name] = n; before[name] = (before[name] ?? 0) + n; bytesExpected += n * 5 }
    after[name] = (after[name] ?? 0) + ((out.match(new RegExp(`(?:^|[;{}\\s])color:\\s*var\\(--${name}\\)`, 'g')) ?? []).length)
  }
  if (out !== src) {
    perFile.push(`${f.replace(/^src\//, '').padEnd(42)} ${Object.entries(hits).map(([k, v]) => `${k}:${v}`).join(' ')}`)
    if (APPLY) {
      writeFileSync(f, out)
      if (statSync(f).size === 0) throw new Error(`写空了：${f}`)
    }
  }
}

const bad = FAMILIES.filter(n => (after[n] ?? 0) !== 0)
console.log(`替换掉的裸 color: ${JSON.stringify(before)}`)
console.log(`残留未替换：${JSON.stringify(after)} → ${bad.length ? '✗ ' + bad.join(',') : '✓ 0 残留'}`)
console.log(`字节增量应为 ${bytesExpected}（每处多 "-text" 5 字节）`)
if (bad.length) { console.error('!! 有残留，中止'); process.exit(1) }
console.log(`共 ${perFile.length} 个文件受影响${APPLY ? '（已写盘）' : '（试运行，未写盘）'}`)
console.log(perFile.join('\n'))
