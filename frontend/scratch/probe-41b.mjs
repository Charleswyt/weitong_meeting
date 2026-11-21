// 第13/38项收口的端到端验证：预约 → 列表可见 → 删除 → 列表不再出现 → 按号入会被拒。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
const BASE = process.env.BASE || 'http://localhost:5176'
const rows = readFileSync(process.env.CREDS_FILE, 'utf8').split(/\r?\n/).map((l) => l.split('\t').map((c) => c.trim()))
const USER = process.env.PROBE_USER || 'admin'

async function api(path, opts = {}, token) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
  const res = await fetch(BASE + path, { ...opts, headers })
  const txt = await res.text()
  let body = null
  try { body = JSON.parse(txt) } catch { /* */ }
  return { status: res.status, body }
}
async function login(name, pw) {
  const d = (await api('/api/v1/auth/sm2-public-key')).body.data
  const env = JSON.stringify({ username: name, password: pw, challenge: d.challenge, issuedAtMs: Date.now(), nonce: randomBytes(18).toString('hex') })
  const r = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: name, algorithm: 'SM2', keyId: d.keyId, challenge: d.challenge, cipherMode: 'C1C3C2', ciphertextEncoding: 'c1c3c2-hex', ciphertext: sm2.doEncrypt(env, d.publicKey, 1) }) })
  const tk = r.body?.data?.token
  if (!tk) throw new Error('login failed: ' + JSON.stringify(r.body?.msg))
  return tk
}
const log = (o) => console.log(JSON.stringify(o))
const list = async (tok) => {
  const all = []
  for (let p = 1; p <= 20; p++) {
    const r = await api(`/api/v1/meetings/list?pageNum=${p}&pageSize=100`, {}, tok)
    const page = r.body?.rows ?? r.body?.data?.rows ?? []
    all.push(...page)
    const total = r.body?.total ?? r.body?.data?.total ?? all.length
    if (all.length >= total || page.length === 0) break
  }
  return all
}

const tok = await login(USER, rows.find((r) => r[0] === USER)[1])
const start = new Date(Date.now() + 30 * 60 * 1000)
const startTime = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')} ${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}:00`
const title = `PROBE-41-压制复验 ${Date.now()}`
const sc = await api('/api/v1/meetings/schedule', { method: 'POST', body: JSON.stringify({ title, startTime, durationMinutes: 15 }) }, tok)
const created = sc.body?.data?.meeting || sc.body?.data
log({ step: 'schedule', http: sc.status, ok: !!created, id: created?.id, no: created?.meetingNo, managed: created?.managed, msg: sc.body?.msg })
if (!created) process.exit(1)

const before = await list(tok)
log({ step: 'visibleAfterCreate', found: before.filter((m) => m.meetingNo === created.meetingNo).map((m) => ({ id: m.id, status: m.status, managed: m.managed })) })

const del = await api(`/api/v1/meetings/${created.id}`, { method: 'DELETE' }, tok)
log({ step: 'delete', http: del.status, code: del.body?.code, msg: del.body?.msg })

const after = await list(tok)
const still = after.filter((m) => m.meetingNo === created.meetingNo)
log({ step: 'visibleAfterDelete', count: still.length, rows: still.map((m) => ({ id: m.id, status: m.status, managed: m.managed })) })

const join = await api('/api/v1/meetings/join', { method: 'POST', body: JSON.stringify({ meetingNo: created.meetingNo, displayName: '压制复验', recordingConsent: true }) }, tok)
log({ step: 'joinByNumber', http: join.status, code: join.body?.code, msg: join.body?.msg })
