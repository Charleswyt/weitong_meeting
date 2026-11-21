// 查指定标题的会在**我方列表**里报什么状态/时间，并可选删除本侧残留的探针会。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
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
  let body = null
  try { body = JSON.parse(txt) } catch { /* */ }
  return { status: res.status, body }
}
async function login() {
  const d = (await api('/api/v1/auth/sm2-public-key')).body.data
  const env = JSON.stringify({ username: USER, password: row[1], challenge: d.challenge, issuedAtMs: Date.now(), nonce: randomBytes(18).toString('hex') })
  const r = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: USER, algorithm: 'SM2', keyId: d.keyId, challenge: d.challenge, cipherMode: 'C1C3C2', ciphertextEncoding: 'c1c3c2-hex', ciphertext: sm2.doEncrypt(env, d.publicKey, 1) }) })
  return r.body.data.token
}
const tok = await login()
const all = []
for (let p = 1; p <= 20; p++) {
  const r = await api(`/api/v1/meetings/list?pageNum=${p}&pageSize=100`, {}, tok)
  const page = r.body?.rows ?? []
  all.push(...page)
  if (all.length >= (r.body?.total ?? all.length) || page.length === 0) break
}
const wanted = (process.env.PROBE_TITLES || '双向音频验证会议,PROBE-41').split(',')
const hits = all.filter((m) => wanted.some((w) => (m.title || '').includes(w)))
console.log(JSON.stringify({ total: all.length, hits: hits.map((m) => ({ id: m.id, no: m.meetingNo, title: m.title, status: m.status, managed: m.managed, start: m.startTime, dur: m.durationMinutes })) }))

if (process.env.PROBE_DELETE === '1') {
  for (const m of hits.filter((x) => x.managed)) {
    const r = await api(`/api/v1/meetings/${m.id}`, { method: 'DELETE' }, tok)
    console.log(JSON.stringify({ step: 'delete', id: m.id, code: r.body?.code, msg: r.body?.msg }))
  }
}
