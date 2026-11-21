// 善后：把探针遗留的运行中会议收掉。
// end 需要会中会话（人已经 leave 就回"请先加入会议"），所以走 stop —— 管理级 Bearer 即可。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
const BASE = process.env.BASE || 'http://localhost:5176'
const rows = readFileSync(process.env.CREDS_FILE, 'utf8').split(/\r?\n/).map((l) => l.split('\t').map((c) => c.trim()))
const rowOf = (u) => rows.find((r) => r[0] === u)

async function api(path, opts = {}, token) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
  const res = await fetch(BASE + path, { ...opts, headers })
  const txt = await res.text()
  let body = null
  try { body = JSON.parse(txt) } catch { /* */ }
  return { status: res.status, body, head: txt.slice(0, 160) }
}

async function login(u) {
  const [name, pw] = [rowOf(u)[0], rowOf(u)[1]]
  const d = (await api('/api/v1/auth/sm2-public-key')).body.data
  const env = JSON.stringify({ username: name, password: pw, challenge: d.challenge, issuedAtMs: Date.now(), nonce: randomBytes(18).toString('hex') })
  const r = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: name, algorithm: 'SM2', keyId: d.keyId, challenge: d.challenge, cipherMode: 'C1C3C2', ciphertextEncoding: 'c1c3c2-hex', ciphertext: sm2.doEncrypt(env, d.publicKey, 1) }) })
  const token = r.body?.data?.token
  if (!token) throw new Error('login failed ' + u + ' ' + JSON.stringify(r.body?.msg))
  return token
}

const PROBE_TITLES = ['ROSTER-37', 'PROBE-37', 'PROBE-38', 'PROBE-39', 'T-localrec', 'T-stream', 'VERIFY-', 'A-张明', 'B-李伟']
const isProbe = (t) => PROBE_TITLES.some((p) => String(t || '').startsWith(p))

for (const user of ['zhangming', 'liwei']) {
  const tok = await login(user)
  const lst = await api('/api/v1/meetings/list?pageNum=1&pageSize=100', {}, tok)
  const rowsAll = lst.body?.rows ?? lst.body?.data?.rows ?? []
  const running = rowsAll.filter((m) => m.status === 'running' || m.status === 'starting')
  console.log(JSON.stringify({ step: 'scan', user, total: rowsAll.length, running: running.map((m) => ({ id: m.id, no: m.meetingNo, title: m.title })) }))
  for (const m of running) {
    if (!isProbe(m.title)) { console.log(JSON.stringify({ step: 'skip-not-probe', user, id: m.id, title: m.title })); continue }
    const r = await api(`/api/v1/meetings/${m.id}/stop`, { method: 'POST', body: JSON.stringify({ id: m.id }) }, tok)
    console.log(JSON.stringify({ step: 'stop', user, id: m.id, no: m.meetingNo, code: r.body?.code, msg: r.body?.msg }))
  }
}
