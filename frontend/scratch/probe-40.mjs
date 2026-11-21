// 第40项复现：会话在上游已判死之后点"离开会议"，必须是幂等成功而不是「系统异常」。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
const BASE = process.env.BASE || 'http://localhost:5176'
const USER = process.env.PROBE_USER || 'liwei'
const rows = readFileSync(process.env.CREDS_FILE, 'utf8').split(/\r?\n/).map((l) => l.split('\t').map((c) => c.trim()))
const rowOf = (u) => rows.find((r) => r[0] === u)
async function api(path, opts = {}, token) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
  const res = await fetch(BASE + path, { ...opts, headers })
  const txt = await res.text()
  let body = null
  try { body = JSON.parse(txt) } catch { /* */ }
  return { status: res.status, body, head: txt.slice(0, 140) }
}
async function login(u) {
  const [name, pw] = [rowOf(u)[0], rowOf(u)[1]]
  const d = (await api('/api/v1/auth/sm2-public-key')).body.data
  const env = JSON.stringify({ username: name, password: pw, challenge: d.challenge, issuedAtMs: Date.now(), nonce: randomBytes(18).toString('hex') })
  const r = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: name, algorithm: 'SM2', keyId: d.keyId, challenge: d.challenge, cipherMode: 'C1C3C2', ciphertextEncoding: 'c1c3c2-hex', ciphertext: sm2.doEncrypt(env, d.publicKey, 1) }) })
  return r.body?.data?.token
}
const log = (o) => console.log(JSON.stringify(o))
const tok = await login(USER)
if (!tok) { log({ step: 'login', err: 'failed' }); process.exit(1) }
const qs = await api('/api/v1/meetings/quick-start', { method: 'POST', body: JSON.stringify({ title: 'PROBE-40-离会幂等', durationMinutes: 10, cloudRecord: false }) }, tok)
const q = qs.body?.data || {}
const id = q.id ?? q.meetingId
log({ step: 'quickStart', id, no: q.meetingNo })
const j = await api('/api/v1/meetings/join', { method: 'POST', body: JSON.stringify({ meetingNo: q.meetingNo, displayName: '李伟', recordingConsent: true }) }, tok)
log({ step: 'join', code: j.body?.code, pid: j.body?.data?.participantId?.slice(-8) })
const stop = await api(`/api/v1/meetings/${id}/stop`, { method: 'POST', body: JSON.stringify({ id }) }, tok)
log({ step: 'stopUpstream', code: stop.body?.code, msg: stop.body?.msg })
await new Promise((r) => setTimeout(r, 2500))
const leave1 = await api('/api/v1/meetings/leave', { method: 'POST', body: JSON.stringify({ meetingId: id }) }, tok)
log({ step: 'leaveAfterUpstreamGone', code: leave1.body?.code, msg: leave1.body?.msg, reason: leave1.body?.reason })
const leave2 = await api('/api/v1/meetings/leave', { method: 'POST', body: JSON.stringify({ meetingId: id }) }, tok)
log({ step: 'leaveAgain', code: leave2.body?.code, msg: leave2.body?.msg, reason: leave2.body?.reason })
