// 设计 token 门禁：`var(--x)` 用到的变量必须在样式里真存在，否则浏览器静默吃兜底色。
//
// 为什么会有一条这样的规则：09-29 做第 20 项（回放页风格与全局一致）时踩到 ——
// `var(--bg-page, #f4f6fa)` 里那个 token 全仓根本没定义，于是"用了 var()"看着像接进了设计系统，
// 实际永远走那个硬编码兜底，暗色主题下就是一块不该出现的浅色。这类 bug 不看渲染不出来，只能靠判据。
//
// 口径：
//   - 定义 = 任意 .css / .vue / .ts 里 `--x:` 形式的赋值（含组件 <style> 内的局部作用域变量），
//     注释里出现的不算（所以先剥注释；09-30 那次我漏算了 .vue 的 style 块，报了 9 个假的"未定义"）。
//   - 外部带进来的变量按前缀放行（Element Plus 的 `--el-*`），新增 UI 库时在这张表里加一行。
//   - 兜底值本身合不合规不归本脚本，那是 `check:copy` 与设计走查的事。
//
// 跑法：node scripts/check-css-tokens.mjs   （有未定义引用则退出码 1；自检不过退出码 2）

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, dirname, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const EXTERNAL_PREFIXES = ['--el-']

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
}

function walk(dir) {
  const files = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'scratch' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) files.push(...walk(p))
    else if (/\.(vue|ts|css)$/.test(name)) files.push(p)
  }
  return files
}

export function collectDefined(text) {
  return [...stripComments(text).matchAll(/(^|[\s{;])(--[\w-]+)\s*:/gm)].map((m) => m[2])
}

export function collectUsed(text) {
  return [...stripComments(text).matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1])
}

function isExternal(name) {
  return EXTERNAL_PREFIXES.some((p) => name.startsWith(p))
}

// 自检：未定义引用必须抓到，已定义 / 外部前缀 / 注释里的必须放过。
function selfTest() {
  const defined = new Set(['--bg-card'])
  const mustFlag = collectUsed('x { background: var(--nope, #fff); }').filter((n) => !defined.has(n) && !isExternal(n)).length === 1
  const passDefined = collectUsed('x { background: var(--bg-card); }').filter((n) => !defined.has(n)).length === 0
  const passExternal = collectUsed('x { color: var(--el-color-primary); }').filter((n) => !isExternal(n)).length === 0
  const passComment = collectUsed('/* var(--ghost) */\nx { color: red; }').length === 0
  const ok = mustFlag && passDefined && passExternal && passComment
  if (!ok) {
    console.error(
      `自检失败：抓到未定义=${mustFlag} 放过已定义=${passDefined} 放过外部前缀=${passExternal} 放过注释=${passComment}`,
    )
    console.error('→ 判据本身坏了，此时的"0 命中"没有任何意义。先修这个脚本再谈结果。')
    process.exit(2)
  }
  console.log(`自检 4 条全过（放行前缀：${EXTERNAL_PREFIXES.join(', ')}）`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  selfTest()
  const files = walk(SRC)
  const defined = new Set()
  for (const f of files) for (const n of collectDefined(readFileSync(f, 'utf8'))) defined.add(n)
  let total = 0
  for (const f of files) {
    const text = stripComments(readFileSync(f, 'utf8'))
    text.split('\n').forEach((line, idx) => {
      for (const n of collectUsed(line)) {
        if (defined.has(n) || isExternal(n)) continue
        total++
        console.log(`${relative(ROOT, f)}:${idx + 1}  var(${n}) 没有定义点 —— 现在渲染的是兜底色，不是 token`)
      }
    })
  }
  console.log(`已定义 token ${defined.size} 个`)
  if (total) {
    console.log(`\n${total} 处引用了不存在的变量：改成用真实 token，或把该 token 按两个主题各定义一份。`)
    process.exit(1)
  }
  console.log('设计 token 引用：0 处悬空（判据自检已过，见本文件头部口径）')
}
