// 第37项取证：两个账号在**同一场会**里各自开 WS，看各自收到的参会者名单。
// 口令只从 CREDS_FILE 读；结束时会 leave + end 做清理。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
const BASE = process.env.BASE || 'http://localhost:5176'
const WS = process.env.WS || 'ws://localhost:8082/ws/v1/meeting'
const rows = readFileSync(process.env.CREDS_FILE, 'utf8').split(/\r?\n/).map((l) => l.split('\t').map((c) => c.trim()))
const rowOf = (u) => rows.find((r) => r[0] === u)

async function api(path, opts, token) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
  const res = await fetch(BASE + path, { ...opts, headers })
  const txt = await res.text()
  let body = null
  try { body = JSON.parse(txt) } catch { /* */ }
  return { status: res.status, body, head: txt.slice(0, 140) }
}

async function login(u) {
  const [name, pw] = [rowOf(u)[0], rowOf(u)[1]]
  const pk = (await api('/api/v1/auth/sm2-public-key')).body
  const d = pk.data
  const env = JSON.stringify({ username: name, password: pw, challenge: d.challenge, issuedAtMs: Date.now(), nonce: randomBytes(18).toString('hex') })
  const r = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: name, algorithm: 'SM2', keyId: d.keyId, challenge: d.challenge, cipherMode: 'C1C3C2', ciphertextEncoding: 'c1c3c2-hex', ciphertext: sm2.doEncrypt(env, d.publicKey, 1) }) })
  const token = r.body?.data?.token
  if (!token) throw new Error('login failed ' + u + ' ' + JSON.stringify(r.body?.msg) + r.head)
  return token
}

const openWs = (meetingId, ticket) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${WS}?meetingId=${meetingId}&ticket=${encodeURIComponent(ticket)}`)
  const seen = []
  ws.onmessage = (e) => { try { seen.push(JSON.parse(e.data)) } catch { /* */ } }
  ws.onerror = (e) => reject(new Error('ws error ' + (e.message || '')))
  ws.onopen = () => resolve({ ws, seen })
  setTimeout(() => resolve({ ws, seen }), 1500)
})

const pickStates = (seen) => seen.filter((m) => m?.type === 'state' || m?.data?.participants || m?.participants)
const summaryOf = (m) => {
  const d = m?.data ?? m ?? {}
  const parts = d.participants ?? []
  return {
    type: m?.type, count: d.participantCount, parts: parts.map((p) => ({ id: String(p.id).slice(-8), name: p.name, host: p.isHost, node: p.nodeType, cam: p.cameraOn, mic: p.micOn })),
    streams: (d.streams ?? []).length,
  }
}

const [tokA, tokB] = [await login('zhangming'), await login('liwei')]
const quick = await api('/api/v1/meetings/quick-start', { method: 'POST', body: JSON.stringify({ title: 'ROSTER-37-双账号取证', durationMinutes: 10, cloudRecord: false }) }, tokA)
const qd = quick.body?.data ?? {}
const q = (qd.meeting && (qd.meeting.id || qd.meeting.meetingNo)) ? qd.meeting : qd
console.log(JSON.stringify({ step: 'quickStart', status: quick.status, code: quick.body?.code, msg: quick.body?.msg, dataKeys: Object.keys(qd), meetingId: q.id ?? q.meetingId, meetingNo: q.meetingNo }))
const meetingNo = q.meetingNo, meetingId = q.id ?? q.meetingId
if (!meetingNo || !meetingId) process.exit(1)

const joinA = await api('/api/v1/meetings/join', { method: 'POST', body: JSON.stringify({ meetingNo, displayName: '张明', recordingConsent: true }) }, tokA)
const joinB = await api('/api/v1/meetings/join', { method: 'POST', body: JSON.stringify({ meetingNo, displayName: '李伟', recordingConsent: true }) }, tokB)
console.log(JSON.stringify({ step: 'join', a: { code: joinA.body?.code, msg: joinA.body?.msg, pid: joinA.body?.data?.participantId?.slice(-8) }, b: { code: joinB.body?.code, msg: joinB.body?.msg, pid: joinB.body?.data?.participantId?.slice(-8) } }))

const tA = (await api('/api/v1/meetings/ws-ticket', { method: 'POST', body: JSON.stringify({ meetingId }) }, tokA)).body?.data
const tB = (await api('/api/v1/meetings/ws-ticket', { method: 'POST', body: JSON.stringify({ meetingId }) }, tokB)).body?.data
const wA = await openWs(meetingId, tA.ticket)
const wB = await openWs(meetingId, tB.ticket)
await new Promise(r => setTimeout(r, 6000))

const lastA = pickStates(wA.seen).slice(-1)[0], lastB = pickStates(wB.seen).slice(-1)[0]
console.log(JSON.stringify({
  step: 'roster',
  msgTypesA: [...new Set(wA.seen.map(m => m?.type))], msgTypesB: [...new Set(wB.seen.map(m => m?.type))],
  A_张明_sees: lastA ? summaryOf(lastA) : { err: 'no state msg' },
  B_李伟_sees: lastB ? summaryOf(lastB) : { err: 'no state msg' },
}))

wA.ws.close(); wB.ws.close()
await api('/api/v1/meetings/leave', { method: 'POST', body: JSON.stringify({ meetingId }) }, tokB)
await api('/api/v1/meetings/leave', { method: 'POST', body: JSON.stringify({ meetingId }) }, tokA)
const ended = await api(`/api/v1/meetings/${meetingId}/end`, { method: 'POST', body: JSON.stringify({}) }, tokA)
console.log(JSON.stringify({ step: 'cleanup', endedCode: ended.body?.code, endedMsg: ended.body?.msg }))

// 上一轮崩溃留下的同标题会议一并收掉，不在三方留野会。
const lst = await api('/api/v1/meetings/list?pageNum=1&pageSize=50', {}, tokA)
for (const m of (lst.body?.rows ?? [])) {
  if (String(m.title || '').startsWith('ROSTER-37') && m.status === 'running' && m.id !== meetingId) {
    const r = await api(`/api/v1/meetings/${m.id}/end`, { method: 'POST', body: JSON.stringify({}) }, tokA)
    console.log(JSON.stringify({ step: 'cleanupLeftover', id: m.id, no: m.meetingNo, code: r.body?.code }))
  }
}
