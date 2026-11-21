// 第 9 项尾巴的端到端取证：我方 /auth/logout 是否真的把三方那次登录也结束了。
// 判据两段：① 后端日志出现「三方会话已随登出结束」（只有 adapter 收到 2xx 才会打）；
// ② 登出接口本身不被三方往返拖住（异步 + 限时）。口令只从 creds.tsv 读。
import sm from 'sm-crypto'
import { readFileSync } from 'node:fs'

const { sm2 } = sm
const BASE = process.env.BASE || 'http://localhost:8082'
const WHO = process.env.WHO || 'wangqiang'
const LOG = process.env.LOG || '../../scratch/backend-logout-e2e.out'
const creds = readFileSync(process.env.TEMP + '/creds.tsv', 'utf8').split('\n').map((l) => l.split('\t'))
const cred = creds.find((r) => r[0] === WHO)
if (!cred) throw new Error(WHO + ' 不在 creds.tsv 里')

const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (x) => x.toString(16).padStart(2, '0')).join('')
const markerCount = (re) => (readFileSync(LOG, 'utf8').match(new RegExp(re, 'g')) || []).length

async function login() {
  const desc = await fetch(BASE + '/api/v1/auth/sm2-public-key').then((r) => r.json())
  const d = desc.data
  const envelope = JSON.stringify({ username: cred[0], password: cred[1], challenge: d.challenge, issuedAtMs: Date.now(), nonce: nonce() })
  const res = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cred[0], algorithm: d.algorithm, keyId: d.keyId, challenge: d.challenge, cipherMode: d.cipherMode, ciphertextEncoding: d.ciphertextEncoding, ciphertext: sm2.doEncrypt(envelope, d.publicKey, 1) })
  }).then((r) => r.json())
  if (!res.data?.token) throw new Error(WHO + ' 登录失败 code=' + res.code + ' msg=' + res.msg)
  return res.data.token
}

const say = (o) => console.log(JSON.stringify(o))

const okBefore = markerCount('三方会话已随登出结束')
const badBefore = markerCount('三方会话未随登出结束')

// 登录会把该用户的三方令牌放进后端缓存（日志里能看到 refreshed third-party token）
const tk = await login()
say({ step: 'login', who: WHO, ok: true })

// 登出：测接口耗时 —— 三方往返 ~100ms，若我方还在等它，这个数会明显大于本地清理
const t0 = Date.now()
const lo = await fetch(BASE + '/api/v1/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + tk } }).then((r) => r.json())
const elapsed = Date.now() - t0
say({ step: 'logout_response', code: lo.code, msg: lo.msg, elapsedMs: elapsed })

// 异步收尾要一点时间，等日志行落盘
await new Promise((r) => setTimeout(r, 800))
const okAfter = markerCount('三方会话已随登出结束')
const badAfter = markerCount('三方会话未随登出结束')
say({ step: 'log_markers', okDelta: okAfter - okBefore, warnDelta: badAfter - badBefore })

// 再来一轮 登录→登出：缓存被重新填满，所以三方登出应再次发生（okDelta 仍为 1）。
// 真正的"无缓存就不打三方"负分支由 PeekCachedToken 的单测覆盖，这里不制造半路状态。
const tk2 = await login()
const lo2 = await fetch(BASE + '/api/v1/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + tk2 } }).then((r) => r.json())
await new Promise((r) => setTimeout(r, 800))
say({ step: 'second_logout', code: lo2.code, okDelta: markerCount('三方会话已随登出结束') - okAfter })

// 登出后旧令牌必须已经废掉（我方 JWT 层）
const me = await fetch(BASE + '/api/v1/auth/me', { headers: { Authorization: 'Bearer ' + tk } }).then((r) => r.json())
say({ step: 'me_with_revoked_jwt', code: me.code, msg: me.msg })

// 本次改动的爆炸半径：同一用户另开一个会话（两个本地标签共用按 userId 键控的三方令牌缓存），
// 一边登出会把缓存清掉并作废那枚三方令牌 —— 另一边接着打需要三方令牌的接口必须自愈（重新登录），
// 不能把 401 冒成用户看得见的错误。这一步就是验这个。
const tkA = await login()
// JWT 的 iat 只到秒，同一秒内签两次是同一个字符串 —— 要错开才是"两个会话"
await new Promise((r) => setTimeout(r, 1100))
const tkB = await login()
say({ step: 'two_sessions', distinctTokens: tkA !== tkB })
await fetch(BASE + '/api/v1/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + tkA } })
await new Promise((r) => setTimeout(r, 600))
const still = await fetch(BASE + '/api/v1/recordings/list?pageSize=3', { headers: { Authorization: 'Bearer ' + tkB } }).then((r) => r.json())
say({ step: 'other_session_after_peer_logout', code: still.code, msg: still.msg, rows: Array.isArray(still.rows) ? still.rows.length : undefined })
