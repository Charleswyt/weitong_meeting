// 端点路径门禁：手写的请求路径必须以 `/api/` 开头。
//
// 为什么会有一条这样的规则：10-13 接船端 `frame-times` 代理时，在视图里直接写了
// `get('/v1/meetings/…/frame-times')` —— 少了 `/api` 这一段。dev 下 vite 把它当前端路由，
// 回 200 + index.html；拦截器拿到的响应体没有 `code`，于是判成"业务失败"，每 2 秒弹一条
// 「请求失败」。HTTP 是 200，所以网络面板、后端日志、`vue-tsc` 三处都不报错，只有用户在开会
// 时看得见。这类 bug 靠读代码抓不住，必须判。
//
// 口径：
//   - 真源是 vite 代理与生产 nginx 都只转发 `/api`，所以路径前缀不是风格问题而是路由正确性。
//   - `src/api/` 与 `src/utils/request.ts` 是端点的家；视图里内联一个 `get()` 本身就是走偏，
//     但本脚本只判前缀（把"必须走 api 层"变成判据要先把现存两处内联调用收干净，那是另一件事）。
//   - 只判字面量开头的路径；拼出来的（`const base = …` 再传进来）判不了，也不假装判得了。
//
// 跑法：node scripts/check-endpoint-paths.mjs          （有违规则退出码 1）
//       node scripts/check-endpoint-paths.mjs --selftest（只跑判据自证）

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, dirname, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
// 请求助手的名字：新增封装要加进这张表，否则新写法从判据眼皮底下溜过去。
const HELPERS = ['get', 'post', 'put', 'del', 'getPage']

/** 从一批源码里挑出"路径没以 /api/ 开头"的调用点，返回 `文件:行号 片段`。 */
export function findBadPaths(text, file) {
  const hits = []
  // 允许 get<T>( 这种泛型实参；第一个实参必须是引号或反引号开头、且以 / 起头的路径。
  const re = new RegExp(`\\b(?:${HELPERS.join('|')})(?:<[^>()]*>)?\\(\\s*[\`'\"](/(?!api/)[^\`'\"]*)[\`'\"]`, 'g')
  for (const m of text.matchAll(re)) {
    hits.push(`${file}:${text.slice(0, m.index).split('\n').length} ${m[1]}`)
  }
  return hits
}

function walk(dir) {
  const files = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'scratch' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) files.push(...walk(p))
    else if (/\.(vue|ts)$/.test(name)) files.push(p)
  }
  return files
}

/** 判据自证：坏样本必须命中、好样本必须不命中。不通过则调用方 exit 2。 */
export function selfTest() {
  const cases = [
    { text: "get('/v1/meetings/1/frame-times')", wantHit: true, why: '少 /api 前缀' },
    { text: 'get<unknown>(`/v1/meetings/${id}/x`)', wantHit: true, why: '模板串同样要判' },
    { text: "getPage('/api/v1/meetings/list')", wantHit: false, why: '正确前缀' },
    { text: "post<{ token: string }>('/api/v1/auth/auto-login', {})", wantHit: false, why: '带泛型实参的正确前缀' },
    { text: "get(API_BASE)", wantHit: false, why: '拼出来的路径判不了，也不误伤' },
    { text: "router.push('/v1/meetings')", wantHit: false, why: '不是请求助手，前端路由本来就不带 /api' },
  ]
  const fails = []
  for (const c of cases) {
    const hit = findBadPaths(c.text, 'selftest').length > 0
    if (hit !== c.wantHit) fails.push(`${c.why}：期望 ${c.wantHit ? '命中' : '不命中'}，实际 ${hit ? '命中' : '不命中'} — ${c.text}`)
  }
  return fails
}

async function main() {
  if (process.argv[2] === '--selftest') {
    const fails = selfTest()
    if (fails.length) {
      console.error('自检失败，判据本身坏了：\n  ' + fails.join('\n  '))
      process.exit(2)
    }
    console.log('自检通过：6 例（3 坏 3 好）全对')
    return
  }
  const fails = selfTest()
  if (fails.length) {
    console.error('判据自检不过，下面的统计不作数：\n  ' + fails.join('\n  '))
    process.exit(2)
  }
  const bad = []
  for (const f of walk(SRC)) {
    if (f.endsWith('src/utils/request.ts')) continue
    bad.push(...findBadPaths(readFileSync(f, 'utf8'), relative(ROOT, f).replace(/\\/g, '/')))
  }
  if (bad.length) {
    console.error(`端点路径缺 /api 前缀（${bad.length} 处）：\n  ` + bad.join('\n  '))
    process.exit(1)
  }
  console.log('端点路径检查通过')
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main()
