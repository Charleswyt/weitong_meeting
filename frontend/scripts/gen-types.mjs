#!/usr/bin/env node
// openapi → TS 类型生成器。**生成物里必须带源哈希**，G5 靠它发现两类事：
// schema 改了没重生成、生成物被人手改。
// 这条规矩的由来：本工作区把"不互相复制文件"换成了"禁止手抄、允许生成"，
// 而带不上来源指纹的生成物迟早会变成第二份真源 —— 最后又回到文档一份、代码一份。
//
// 用法：node scripts/gen-types.mjs          生成/更新 src/types/api.gen.ts
//       node scripts/gen-types.mjs --check  只校验不写盘（给 tools/check.mjs G5 调）
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const FE = join(here, '..')
// 契约真源在本应用 cloud/contracts/（与 edge 解耦）。
const SCHEMA = join(FE, '..', 'contracts', 'api.openapi.yaml')
const OUT = join(FE, 'src', 'types', 'api.gen.ts')
const TMP = join(FE, 'src', 'types', '.api.gen.raw.ts')
const CHECK = process.argv.includes('--check')

const sha = (b) => createHash('sha256').update(b).digest('hex')
const srcSha = sha(readFileSync(SCHEMA))

function generate() {
  // 不用 `pnpm exec`：Windows 上 pnpm 是 .cmd 垫片，node 不带 shell 就 spawn 不到（实测 ENOENT）。
  // 直接用自己的 execPath 跑包的 bin 入口，少一层 shell 引号风险（路径里带空格也不炸）。
  const cli = join(FE, 'node_modules', 'openapi-typescript', 'bin', 'cli.js')
  if (!existsSync(cli)) { console.log('缺 openapi-typescript，先跑 pnpm add -D openapi-typescript@7'); process.exit(2) }
  execFileSync(process.execPath, [cli, SCHEMA, '--output', TMP], { cwd: FE, stdio: 'pipe' })
  const body = readFileSync(TMP, 'utf8')
  unlinkSync(TMP)
  return body
}

const header = (s) => [
  '// 派生件，不要手改：改 `contracts/api.openapi.yaml` 后跑 `pnpm run gen:types`。',
  '// source: contracts/api.openapi.yaml',
  `// source-sha256: ${s}`,
  '// generator: openapi-typescript，经 scripts/gen-types.mjs（门禁 G5 校验此哈希与正文一致性）',
  '',
]

const render = (s, body) => header(s).join('\n') + body

if (CHECK) {
  if (!existsSync(OUT)) { console.log('src/types/api.gen.ts 不存在 —— 跑 pnpm run gen:types'); process.exit(1) }
  const cur = readFileSync(OUT, 'utf8')
  const m = cur.match(/source-sha256:\s*([0-9a-f]{64})/)
  if (!m) { console.log('api.gen.ts 缺 source-sha256 头（手建或被手改掉头部了）'); process.exit(1) }
  if (m[1] !== srcSha) {
    console.log(`api.gen.ts 与 schema 不同步：头 ${m[1].slice(0, 12)}… vs 现 ${srcSha.slice(0, 12)}… —— 跑 pnpm run gen:types`)
    process.exit(1)
  }
  // 逐字节比对，不做"去注释"之类的归一：曾按 strip() 比较，因两侧前导空行不同而一侧留下块注释、
  // 另一侧剥掉，刚生成的文件自己就对不上（假阳性）。规矩是"生成物不许手改"，那就按字节判。
  const want = render(srcSha, generate())
  if (cur !== want) {
    const a = cur.split('\n'), b = want.split('\n')
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    console.log(`api.gen.ts 第 ${i + 1} 行与重新生成结果不一致 —— 生成物被手改了，改 schema 再重生成`)
    console.log(`  现: ${JSON.stringify((a[i] ?? '').slice(0, 80))}`)
    console.log(`  望: ${JSON.stringify((b[i] ?? '').slice(0, 80))}`)
    process.exit(1)
  }
  console.log('G5 通过：api.gen.ts 与 schema 同哈希、逐字节等于生成结果')
  process.exit(0)
}

writeFileSync(OUT, render(srcSha, generate()))
console.log(`已生成 src/types/api.gen.ts（schema sha ${srcSha.slice(0, 12)}…）`)
