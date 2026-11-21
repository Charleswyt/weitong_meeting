// 第 9 项尾巴：三方 `POST /api/frontend/auth/logout` 是否存在、是否真的作废 Bearer。
// 只看状态码/耗时/布尔，绝不打印令牌或口令。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BASE = process.env.TP_BASE || 'https://47.114.83.151'
const file = process.env.CREDS_FILE
if (!file) throw new Error('CREDS_FILE not set')
const who = process.env.WHO || 'liwei'
const row = readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.split('\t')[0] === who)
if (!row) throw new Error('no row for ' + who)
const cols = row.split('\t').map((c) => c.trim())
const [tpAccount, tpPassword] = [cols[2], cols[3]]
if (!tpAccount || !tpPassword) { console.log(JSON.stringify({ step: 'creds', who, ok: false, why: 'missing third-party pair' })); process.exit(1) }

async function j(path, opts = {}) {
  const t0 = Date.now()
  const res = await fetch(BASE + path, opts)
  const txt = await res.text()
  let body = null
  try { body = JSON.parse(txt) } catch { /* not json */ }
  // head 里不含凭据：这些端点的响应体是状态/错误说明
  return { ms: Date.now() - t0, status: res.status, body, head: txt.slice(0, 160) }
}

async function loginTp() {
  const pk = await j('/api/frontend/auth/sm2-public-key')
  const d = pk.body?.data ?? pk.body
  const envelope = JSON.stringify({
    username: tpAccount,
    password: tpPassword,
    challenge: d.challenge,
    issuedAtMs: Date.now(),
    nonce: randomBytes(18).toString('hex'),
  })
  const r = await j('/api/frontend/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: tpAccount,
      algorithm: 'SM2',
      keyId: d.keyId,
      challenge: d.challenge,
      cipherMode: 'C1C3C2',
      ciphertextEncoding: 'c1c3c2-hex',
      ciphertext: sm2.doEncrypt(envelope, d.publicKey, 1),
    }),
  })
  return { token: r.body?.token ?? r.body?.data?.token ?? r.body?.accessToken, res: r }
}

const say = (o) => console.log(JSON.stringify(o))

const first = await loginTp()
say({ step: 'login', status: first.res.status, ms: first.res.ms, gotToken: !!first.token })
if (!first.token) process.exit(1)
const H = { Authorization: 'Bearer ' + first.token }

const meBefore = await j('/api/frontend/auth/me', { headers: H })
say({ step: 'me_before_logout', status: meBefore.status, ms: meBefore.ms,
  accountKeys: meBefore.body ? Object.keys(meBefore.body).slice(0, 8) : undefined })

// 1) 不带令牌打 logout —— 应当是 401 类，而不是 404（404=端点不存在）
const noAuth = await j('/api/frontend/auth/logout', { method: 'POST' })
say({ step: 'logout_no_auth', status: noAuth.status, ms: noAuth.ms, head: noAuth.head })

// 2) 带令牌打 logout
const out = await j('/api/frontend/auth/logout', { method: 'POST', headers: { ...H, 'Content-Type': 'application/json' } })
say({ step: 'logout_with_token', status: out.status, ms: out.ms, bodyKeys: out.body ? Object.keys(out.body).slice(0, 8) : undefined, head: out.head })

// 3) logout 后原令牌还能用吗 —— 这一步才证明"真的结束了三方会话"
const meAfter = await j('/api/frontend/auth/me', { headers: H })
say({ step: 'me_after_logout', status: meAfter.status, ms: meAfter.ms, head: meAfter.head })

// 4) 幂等性：再打一次 logout
const out2 = await j('/api/frontend/auth/logout', { method: 'POST', headers: H })
say({ step: 'logout_twice', status: out2.status, ms: out2.ms, head: out2.head })

// 5) 账号没被锁：还能重新登录，并留下一个可用令牌（不打印它）
const re = await loginTp()
say({ step: 'relogin', status: re.res.status, ms: re.res.ms, gotToken: !!re.token })
if (re.token) {
  const meRe = await j('/api/frontend/auth/me', { headers: { Authorization: 'Bearer ' + re.token } })
  say({ step: 'me_after_relogin', status: meRe.status, ms: meRe.ms })
  const bye = await j('/api/frontend/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + re.token } })
  say({ step: 'cleanup_logout', status: bye.status, ms: bye.ms })
}
