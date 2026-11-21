// 第38项取证：按前端入会后的真实调用顺序逐个走一遍，打印每一步的 code/msg/reason。
// 目的是定位"提示会议已结束 + 多条重复提示"到底是哪几个接口在报错。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
const BASE = process.env.BASE || 'http://localhost:5176'
const WS = process.env.WS || 'ws://localhost:8082/ws/v1/meeting'
const USER = process.env.PROBE_USER || 'admin'
const NO = (process.env.PROBE_NO || '92323537').replace(/\s/g, '')
const HOLD = Number(process.env.HOLD || 20)
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
  if (!tk) throw new Error('login failed ' + JSON.stringify(r.body?.msg))
  return tk
}
const log = (o) => console.log(JSON.stringify(o))
const show = async (label, path, opts, tok) => {
  const r = await api(path, opts, tok)
  log({ step: label, http: r.status, code: r.body?.code, msg: r.body?.msg, reason: r.body?.reason, data: r.body?.data === undefined ? undefined : JSON.stringify(r.body.data).slice(0, 200), raw: r.body ? undefined : r.head })
  return r.body?.data
}

const tok = await login(USER)
const joined = await show('join', '/api/v1/meetings/join', { method: 'POST', body: JSON.stringify({ meetingNo: NO, displayName: '系统管理员', recordingConsent: true }) }, tok)
const id = joined?.meetingId
if (!id) process.exit(1)
await show('state#1', `/api/v1/meetings/${id}/state`, {}, tok)
const t = await show('wsTicket', '/api/v1/meetings/ws-ticket', { method: 'POST', body: JSON.stringify({ meetingId: id }) }, tok)

const ws = new WebSocket(`${WS}?meetingId=${id}&ticket=${encodeURIComponent(t?.ticket || '')}`)
const got = []
ws.onmessage = (e) => { try { got.push(JSON.parse(e.data)) } catch { /* */ } }
await new Promise((r) => { ws.onopen = r; setTimeout(r, 3000) })

// 发布：摄像头 / 麦克风（前端 attachSelfMedia 会做这两件事）
const sdp = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=mid:0\r\na=sendonly\r\na=rtpmap:96 VP8/90000\r\n'
await show('pub.camera', `/api/v1/meetings/${id}/publications`, { method: 'POST', body: JSON.stringify({ kind: 'camera', sdp }) }, tok)
await show('pub.mic', `/api/v1/meetings/${id}/publications`, { method: 'POST', body: JSON.stringify({ kind: 'microphone', sdp }) }, tok)
await show('mediaState', `/api/v1/meetings/${id}/media-state`, { method: 'POST', body: JSON.stringify({ cameraEnabled: true, microphoneEnabled: true, screenShareEnabled: false }) }, tok)
await show('chat.list', '/api/v1/chat/messages?meetingId=' + id + '&afterId=0&limit=100', {}, tok)
await show('recording.start', `/api/v1/meetings/${id}/recording/start`, { method: 'POST', body: JSON.stringify({ id }) }, tok)

for (let s = 0; s < HOLD; s += 5) {
  await new Promise((r) => setTimeout(r, 5000))
  await show('state#' + (s + 5), `/api/v1/meetings/${id}/state`, {}, tok)
}
log({
  step: 'wsMessages', total: got.length, types: [...new Set(got.map((m) => m?.type))],
  meetingStatuses: got.filter((m) => m?.type === 'meeting').map((m) => m?.data?.status),
  lastMeeting: got.filter((m) => m?.type === 'meeting').slice(-1).map((m) => JSON.stringify(m?.data).slice(0, 260)),
})
ws.close()
await show('leave', '/api/v1/meetings/leave', { method: 'POST', body: JSON.stringify({ meetingId: id }) }, tok)
