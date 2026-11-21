// 第38项取证：管理员按会议号入会 9232 3537，逐步打印每一步的返回码与文案。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
const BASE = process.env.BASE || 'http://localhost:5176'
const USER = process.env.PROBE_USER || 'admin'
const NO = (process.env.PROBE_NO || '92323537').replace(/\s/g, '')
const rows = readFileSync(process.env.CREDS_FILE, 'utf8').split(/\r?\n/).map((l) => l.split('\t').map((c) => c.trim()))
const rowOf = (u) => rows.find((r) => r[0] === u)

async function api(path, opts = {}, token) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
  const res = await fetch(BASE + path, { ...opts, headers })
  const txt = await res.text()
  let body = null
  try { body = JSON.parse(txt) } catch { /* */ }
  return { status: res.status, body, head: txt.slice(0, 200) }
}
async function login(u) {
  const [name, pw] = [rowOf(u)[0], rowOf(u)[1]]
  const d = (await api('/api/v1/auth/sm2-public-key')).body.data
  const env = JSON.stringify({ username: name, password: pw, challenge: d.challenge, issuedAtMs: Date.now(), nonce: randomBytes(18).toString('hex') })
  const r = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: name, algorithm: 'SM2', keyId: d.keyId, challenge: d.challenge, cipherMode: 'C1C3C2', ciphertextEncoding: 'c1c3c2-hex', ciphertext: sm2.doEncrypt(env, d.publicKey, 1) }) })
  const tk = r.body?.data?.token
  if (!tk) throw new Error('login failed ' + u + ' ' + JSON.stringify(r.body?.msg))
  return tk
}
const log = (o) => console.log(JSON.stringify(o))
const brief = (label, r) => log({
  step: label, http: r.status, code: r.body?.code, msg: r.body?.msg,
  data: r.body?.data === undefined ? undefined : JSON.stringify(r.body.data).slice(0, 400),
  head: r.body ? undefined : r.head,
})

const tok = await login(USER)
const lst = await api('/api/v1/meetings/list?pageNum=1&pageSize=100', {}, tok)
const all = lst.body?.rows ?? lst.body?.data?.rows ?? []
const hit = all.filter((m) => String(m.meetingNo || '').replace(/\s/g, '') === NO)
log({ step: 'listLookup', no: NO, total: all.length, hits: hit.map((m) => ({ id: m.id, status: m.status, title: m.title, start: m.startTime, end: m.endTime })) })
const j = await api('/api/v1/meetings/join', { method: 'POST', body: JSON.stringify({ meetingNo: NO, displayName: '系统管理员', recordingConsent: true }) }, tok)
brief('join', j)
const mid = j.body?.data?.meetingId ?? hit[0]?.id
if (mid) {
  brief('state', await api(`/api/v1/meetings/${mid}/state`, {}, tok))
  await api('/api/v1/meetings/leave', { method: 'POST', body: JSON.stringify({ meetingId: mid }) }, tok)
}
