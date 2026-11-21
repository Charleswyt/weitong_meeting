// 第37项取证（建立会议 + 对端 WS）：本脚本只负责"对端"那一侧（默认 wangqiang），
// 浏览器侧由受控浏览器真实入会，这样两端的名单可以互相对照。
// 用法：node probe-peer.mjs create   → 建一场 PROBE-37 会议并打印 meetingNo
//       node probe-peer.mjs peer <meetingNo> <meetingId> → 对端入会、开 WS、打印名单、停留 PEER_HOLD 秒
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
const BASE = process.env.BASE || 'http://localhost:5176'
const WS = process.env.WS || 'ws://localhost:8082/ws/v1/meeting'
const USER = process.env.PEER_USER || 'wangqiang'
const NAME = process.env.PEER_NAME || '王强'
const HOLD = Number(process.env.PEER_HOLD || 45)
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
  const tk = r.body?.data?.token
  if (!tk) throw new Error('login failed ' + u + ' ' + JSON.stringify(r.body?.msg))
  return tk
}
const log = (o) => console.log(JSON.stringify(o))
const summaryOf = (m) => {
  const d = m?.data ?? m ?? {}
  return {
    count: d.participantCount,
    parts: (d.participants ?? []).map((p) => ({ id: String(p.id).slice(-8), name: p.name, host: p.isHost, node: p.nodeType, cam: p.cameraOn, mic: p.micOn, rec: p.recording })),
    invited: (d.invited ?? []).map((i) => ({ name: i.name, joined: i.joined })),
    streams: (d.streams ?? []).length,
  }
}

const tok = await login(USER)
const mode = process.argv[2]

if (mode === 'create') {
  const r = await api('/api/v1/meetings/quick-start', { method: 'POST', body: JSON.stringify({ title: 'PROBE-37-成员名单取证', durationMinutes: 10, cloudRecord: false }) }, tok)
  const d = r.body?.data ?? {}
  const q = (d.meeting && (d.meeting.id || d.meeting.meetingNo)) ? d.meeting : d
  log({ step: 'create', user: USER, code: r.body?.code, msg: r.body?.msg, meetingId: q.id ?? q.meetingId, meetingNo: q.meetingNo })
  process.exit(0)
}

const meetingNo = process.argv[3]
const meetingId = Number(process.argv[4])
if (!meetingNo || !meetingId) { log({ step: 'usage', hint: 'peer <meetingNo> <meetingId>' }); process.exit(1) }

const j = await api('/api/v1/meetings/join', { method: 'POST', body: JSON.stringify({ meetingNo, displayName: NAME, recordingConsent: true }) }, tok)
const pid = j.body?.data?.participantId
log({ step: 'peerJoin', user: USER, code: j.body?.code, msg: j.body?.msg, pid: pid?.slice(-8) })
if (!pid) process.exit(1)

const tk2 = (await api('/api/v1/meetings/ws-ticket', { method: 'POST', body: JSON.stringify({ meetingId }) }, tok)).body?.data
const ws = new WebSocket(`${WS}?meetingId=${meetingId}&ticket=${encodeURIComponent(tk2.ticket)}`)
const seen = []
ws.onmessage = (e) => { try { seen.push(JSON.parse(e.data)) } catch { /* */ } }
await new Promise((r) => { ws.onopen = r; setTimeout(r, 3000) })
log({ step: 'open', types: [...new Set(seen.map((m) => m?.type))] })

for (let i = 0; i < HOLD; i += 5) {
  await new Promise((r) => setTimeout(r, 5000))
  const last = seen.filter((m) => m?.type === 'state' || (m?.data?.participants)).slice(-1)[0]
  log({ step: 'peerRoster', atSec: i + 5, msgType: last?.type, seen: last ? summaryOf(last) : 'no-state-msg', totalMsgs: seen.length })
}

ws.close()
await api('/api/v1/meetings/leave', { method: 'POST', body: JSON.stringify({ meetingId }) }, tok)
const stop = await api(`/api/v1/meetings/${meetingId}/stop`, { method: 'POST', body: JSON.stringify({ id: meetingId }) }, tok)
log({ step: 'peerDone', leaveOk: true, stopCode: stop.body?.code, stopMsg: stop.body?.msg })
