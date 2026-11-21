// 取一个新鲜的管理端令牌写进 scratch/token.json，供浏览器注入 sessionStorage 用。
// 口令只从 CREDS_FILE 指向的文件读，不打日志、不进命令行。
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
const BASE = process.env.BASE || 'http://localhost:5176'
const USER = process.env.PROBE_USER || 'admin'
const rows = readFileSync(process.env.CREDS_FILE, 'utf8').split(/\r?\n/).map((l) => l.split('\t').map((c) => c.trim()))
const row = rows.find((r) => r[0] === USER)

async function api(path, opts = {}, token) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
  const res = await fetch(BASE + path, { ...opts, headers })
  const txt = await res.text()
  try { return JSON.parse(txt) } catch { return { raw: txt.slice(0, 200) } }
}
const d = await api('/api/v1/auth/sm2-public-key')
const env = JSON.stringify({ username: USER, password: row[1], challenge: d.data.challenge, issuedAtMs: Date.now(), nonce: randomBytes(18).toString('hex') })
const r = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: USER, algorithm: 'SM2', keyId: d.data.keyId, challenge: d.data.challenge, cipherMode: 'C1C3C2', ciphertextEncoding: 'c1c3c2-hex', ciphertext: sm2.doEncrypt(env, d.data.publicKey, 1) }) })
if (!r?.data?.token) { console.log(JSON.stringify({ ok: false, msg: r?.msg })); process.exit(1) }
writeFileSync(new URL('./token.json', import.meta.url), JSON.stringify({ token: r.data.token, username: USER, displayName: r.data.user?.displayName || '', mintedAt: new Date().toISOString() }))
console.log(JSON.stringify({ ok: true, user: USER, expiresIn: r.data.expiresIn || null }))
