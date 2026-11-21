// 契约 ↔ 运行时 桥接回归：/settings/ 的键集必须与 api.openapi.yaml 声明的完全一致。
//
// 为什么要有这个脚本：`recordingFps` 曾只存在于前端类型与设置页下拉框，后端 PreferenceVo 根本没有它
// —— GET 从不返回、PUT 当未知键丢弃，是个"有控件但存不住"的死设置（2026-10-10 补成
// user_settings.RECORDING_FPS 真列）。G5 只保证"生成类型 == schema"，管不到"运行时 == schema"，
// 所以这一层要单独有人看。
//
// 跑法：后端已在 :8082 运行时 `node tests/regression/verify-contract-settings.mjs`
// 只读校验 + 一次自我还原的写校验（改完立刻写回原值，不留副作用）。
const BASE = process.env.BASE || 'http://127.0.0.1:8082'
// 本文件在 backend/tests/regression/，契约在应用仓根的 contracts/ —— 往上三级
const SCHEMA = new URL('../../../contracts/api.openapi.yaml', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')

const read = await import('node:fs').then((m) => m.readFileSync)

// 不引第三方 YAML 库：只取 PreferenceVo 那一段的 properties 键名，够用且不会误抓别处。
//
// ⚠ 2026-11-18 修过一个假红：原文用 `indexOf('\n    DictItemVo:')` 当结束边界，假设
// PreferenceVo 后面紧跟 DictItemVo。但契约后来在两者之间插进了 SettingsCapabilitiesVo
// 与 CapabilityVo，后者的 supported/message 被 `^        (\w+):` 一起吞进来，于是脚本报
// "后端缺 supported, message" —— 而实际后端 /settings/ 返回的 18 键与契约 PreferenceVo 逐键吻合。
// 教训同本仓一贯口径：**结束边界不能靠"下一个定义叫什么名字"，要靠结构本身**。
// 改为：从 PreferenceVo 的 `properties:` 起，只收缩进恰好 8 空格的键；遇到下一个
// 4 空格缩进的顶层 schema（或更高层）就停 —— 中间再插多少 Vo 都不会误抓。
function contractKeys(text) {
  const start = text.indexOf('    PreferenceVo:')
  if (start < 0) throw new Error('契约里找不到 PreferenceVo —— 改名了？那这个脚本要一起改')
  const body = text.slice(start)
  const propsAt = body.indexOf('\n      properties:')
  if (propsAt < 0) throw new Error('PreferenceVo 里找不到 properties —— 契约形状变了，脚本要一起改')
  const keys = []
  for (const line of body.slice(propsAt).split('\n')) {
    if (/^    \S/.test(line)) break                       // 下一个 4 空格缩进的 schema 定义 = 本段结束
    const m = line.match(/^        (\w+):\s*\{/)          // 只认恰好 8 空格缩进的属性键
    if (m) keys.push(m[1])
  }
  return keys
}

let fails = 0
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`) }

const { token } = (await (await fetch(`${BASE}/api/v1/auth/auto-login`, { method: 'POST' })).json()).data
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

const want = contractKeys(read(SCHEMA, 'utf8'))
const res = await (await fetch(`${BASE}/api/v1/settings/`, { headers: H })).json()
check('GET /api/v1/settings/ 200', res.code === 200)
const got = Object.keys(res.data)

const missing = want.filter((k) => !got.includes(k))
const extra = got.filter((k) => !want.includes(k))
check('契约声明的键后端全都发', missing.length === 0, missing.length ? '后端缺：' + missing.join(',') : `（${want.length} 键）`)
check('后端发的键契约全都声明', extra.length === 0, extra.length ? '契约缺：' + extra.join(',') : '')

// 写路径也要对得上：PUT 全量覆盖，所以拿 GET 的结果原样回写，值不该变
const back = await (await fetch(`${BASE}/api/v1/settings/`, { method: 'PUT', headers: H, body: JSON.stringify(res.data) })).json()
check('原样回写 PUT 成功（无 data 键）', back.code === 200 && !('data' in back), `code=${back.code} 有data=${'data' in back}`)
const again = await (await fetch(`${BASE}/api/v1/settings/`, { headers: H })).json()
const drift = want.filter((k) => JSON.stringify(again.data[k]) !== JSON.stringify(res.data[k]))
check('回写后读回与写前逐键相等', drift.length === 0, drift.length ? '漂了：' + drift.join(',') : '')

console.log(fails ? `\n${fails} 项失败 —— 契约与运行时又分叉了` : '\n全部通过')
// 不用 process.exit()：Windows 上 fetch 的 socket 还没关就强退会撞 libuv 断言
// （实测 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，退出码 127 ——
//  一条全绿的门禁跑出非零码，比没有门禁更糟）。让事件循环自己排空。
process.exitCode = fails ? 1 : 0
