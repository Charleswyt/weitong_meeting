// 口令改哈希后的登录回归探针。只打印 code / msg / 是否拿到令牌，绝不打印口令或令牌。
// 真值从被 gitignore 的 seed-credentials.sql 里取，用完即弃。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
const BASE = process.env.BASE || 'http://localhost:5175'
const USER = process.env.PROBE_USER || 'admin'
const SEED = '../../backend/manifest/sql/seed-credentials.sql'

function plainOf(username) {
  const re = new RegExp(`UPDATE\\s+sys_user\\s+SET\\s+password\\s*=\\s*'([^']*)'\\s+WHERE\\s+username\\s*=\\s*'${username}'`, 'i')
  const m = readFileSync(SEED, 'utf8').match(re)
  if (!m) throw new Error(`seed 里找不到 ${username} 的本地口令行`)
  return m[1]
}

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } })
  const txt = await res.text()
  try { return JSON.parse(txt) } catch { return { raw: txt.slice(0, 80) } }
}

async function tryLogin(password, label) {
  const d = await api('/api/v1/auth/sm2-public-key')
  const env = JSON.stringify({
    username: USER, password,
    challenge: d.data.challenge, issuedAtMs: Date.now(), nonce: randomBytes(18).toString('hex'),
  })
  const r = await api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      username: USER, algorithm: 'SM2', keyId: d.data.keyId, challenge: d.data.challenge,
      cipherMode: 'C1C3C2', ciphertextEncoding: 'c1c3c2-hex',
      ciphertext: sm2.doEncrypt(env, d.data.publicKey, 1),
    }),
  })
  console.log(`${label}: code=${r.code} msg=${r.msg} 拿到令牌=${!!r.data?.token}`)
  return r
}

const ok = await tryLogin(plainOf(USER), '真口令（库里已是哈希）')
await tryLogin(plainOf(USER) + '-x', '错一位口令')
await tryLogin('', '空口令')
console.log('判据：真口令 code=200（统一信封的成功码）且拿到令牌；两条错口令都被拒且无令牌')
process.exit(ok.code === 200 && ok.data?.token ? 0 : 1)
