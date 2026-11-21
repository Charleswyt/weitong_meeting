import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
const { sm2 } = createRequire(import.meta.url)('sm-crypto')
const BASE = 'http://localhost:5176'
const USER = 'zhangming'
const rows = readFileSync(process.env.CREDS_FILE, 'utf8').split(/\r?\n/).map((l) => l.split('\t').map((c) => c.trim()))
const row = rows.find((r) => r[0] === USER)
async function api(path, opts = {}, token) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
  const res = await fetch(BASE + path, { ...opts, headers })
  const txt = await res.text(); let body = null; try { body = JSON.parse(txt) } catch { /* */ }
  return { status: res.status, body }
}
const d = (await api('/api/v1/auth/sm2-public-key')).body.data
const env = JSON.stringify({ username: USER, password: row[1], challenge: d.challenge, issuedAtMs: Date.now(), nonce: randomBytes(18).toString('hex') })
const lg = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: USER, algorithm: 'SM2', keyId: d.keyId, challenge: d.challenge, cipherMode: 'C1C3C2', ciphertextEncoding: 'c1c3c2-hex', ciphertext: sm2.doEncrypt(env, d.publicKey, 1) }) })
const tok = lg.body.data.token
for (let i = 0; i < 3; i++) {
  const st = await api('/api/v1/meetings/79/stop', { method: 'POST' }, tok)
  console.log(JSON.stringify({ try: i + 1, msg: st.body?.msg }))
  const del = await api('/api/v1/meetings/79', { method: 'DELETE' }, tok)
  if (del.body?.code === 200) { console.log(JSON.stringify({ step: 'delete', msg: del.body?.msg })); break }
  console.log(JSON.stringify({ step: 'delete', msg: del.body?.msg }))
}
