// 第13/38项收口取证：翻页取全量，交叉计数"外部来源(managed=false)"的会，
// 以及其中开始时刻早已超过时长却仍是 running/scheduled 的野会。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
const BASE = process.env.BASE || 'http://localhost:5176'
const rows = readFileSync(process.env.CREDS_FILE, 'utf8').split(/\r?\n/).map((l) => l.split('\t').map((c) => c.trim()))

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
  if (!tk) throw new Error('login failed ' + name)
  return tk
}

const now = Math.floor(Date.now() / 1000)
const deleted = new Set(JSON.parse(readFileSync(process.env.DELETED_FILE, 'utf8')).map((r) => String(r.NO)))
for (const [name] of rows) {
  let tok
  try { tok = await login(name, rows.find((r) => r[0] === name)[1]) } catch (e) { console.log(JSON.stringify({ acct: name, err: String(e.message) })); continue }
  const all = []
  for (let p = 1; p <= 20; p++) {
    const r = await api(`/api/v1/meetings/list?pageNum=${p}&pageSize=100`, {}, tok)
    const rowsP = r.body?.rows ?? r.body?.data?.rows ?? []
    all.push(...rowsP)
    const total = r.body?.total ?? r.body?.data?.total ?? all.length
    if (all.length >= total || rowsP.length === 0) break
  }
  const ext = all.filter((m) => m.managed === false)
  const phantom = ext.filter((m) => deleted.has(String(m.meetingNo || '').replace(/\s/g, '')))
  const stale = ext.filter((m) => {
    const st = m.status
    if (st !== 'running' && st !== 'scheduled') return false
    const start = Math.floor(new Date(String(m.startTime).replace(' ', 'T')).getTime() / 1000)
    if (!Number.isFinite(start)) return false
    const dur = (m.durationMin || m.durationMinutes || 60) * 60
    return now - start > dur + 600
  })
  const dupOf = {}
  for (const m of all) {
    const k = String(m.meetingNo || '').replace(/\s/g, '')
    ;(dupOf[k] ||= []).push(m.id)
  }
  const dups = Object.entries(dupOf).filter(([, v]) => v.length > 1)
  console.log(JSON.stringify({
    acct: name, total: all.length, external: ext.length, staleRunning: stale.length,
    phantom: phantom.map((m) => ({ no: m.meetingNo, title: m.title, status: m.status })), phantoms: phantom.length, dupNumbers: dups,
    managed: all.filter((m) => m.managed === true).length,
    undecided: all.filter((m) => typeof m.managed !== 'boolean').length,
    staleSample: stale.slice(0, 6).map((m) => ({ id: m.id, no: m.meetingNo, title: m.title, status: m.status, start: m.startTime, dur: m.durationMin ?? m.durationMinutes })),
  }))
}
