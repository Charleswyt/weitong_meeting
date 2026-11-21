// 第2/37项取证：对端（默认 wangqiang）入会，看能不能在 state 里看到这路的流，
// 并真的从后端把字节取出来（看帧头与吞吐），这比"前端有没有报错"更接近用户要的结论。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
const BASE = process.env.BASE || 'http://localhost:5176'
const USER = process.env.PEER_USER || 'wangqiang'
const HOLD = Number(process.env.HOLD || 12)
const rows = readFileSync(process.env.CREDS_FILE, 'utf8').split(/\r?\n/).map((l) => l.split('\t').map((c) => c.trim()))
const rowOf = (u) => rows.find((r) => r[0] === u)

async function raw(path, opts = {}, token) {
  const headers = { ...(token ? { Authorization: 'Bearer ' + token } : {}) }
  return fetch(BASE + path, { ...opts, headers })
}
async function api(path, opts, token) {
  const res = await raw(path, opts, token)
  const txt = await res.text()
  try { return JSON.parse(txt) } catch { return { raw: txt.slice(0, 160) } }
}
async function login(u) {
  const [name, pw] = [rowOf(u)[0], rowOf(u)[1]]
  const d = (await api('/api/v1/auth/sm2-public-key')).data
  const env = JSON.stringify({ username: name, password: pw, challenge: d.challenge, issuedAtMs: Date.now(), nonce: randomBytes(18).toString('hex') })
  const r = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: name, algorithm: 'SM2', keyId: d.keyId, challenge: d.challenge, cipherMode: 'C1C3C2', ciphertextEncoding: 'c1c3c2-hex', ciphertext: sm2.doEncrypt(env, d.publicKey, 1) }) })
  return r.data?.token
}
const log = (o) => console.log(JSON.stringify(o))

const tok = await login(USER)
// 会议号不从列表反查：日程列表按"主持人=本账号"过滤，别人主持的会根本不在这里。
const no = (process.env.PEER_NO || '').replace(/\s/g, '')
if (!no) { log({ step: 'usage', hint: 'PEER_NO=<会议号> node probe-peer-media.mjs' }); process.exit(1) }
const j = await api('/api/v1/meetings/join', { method: 'POST', body: JSON.stringify({ meetingNo: no, displayName: '王强', recordingConsent: true }) }, tok)
if (j.code !== 200) { log({ step: 'peerJoin', code: j.code, msg: j.msg }); process.exit(1) }
const MEETING_ID = j.data.meetingId
log({ step: 'peerJoin', id: MEETING_ID, pid: j.data.participantId?.slice(-8) })

const st = await api(`/api/v1/meetings/${MEETING_ID}/state`, {}, tok)
const d = st.data || {}
log({
  step: 'peerState', status: d.status, count: d.participantCount,
  parts: (d.participants || []).map((p) => ({ n: p.name, id: String(p.id).slice(-8), cam: p.cameraOn, mic: p.micOn, share: p.sharing })),
  streams: (d.streams || []).map((s) => ({ id: s.id, owner: s.ownerName, kind: s.kind, v: s.video, a: s.audio, w: s.width, h: s.height, fps: s.fps, active: s.active, videoEp: s.endpoints?.video, audioEp: s.endpoints?.audio })),
})

for (const s of (d.streams || [])) {
  const ep = s.endpoints?.video || s.endpoints?.audio
  if (!ep) { log({ step: 'openStream', stream: s.id, err: 'no endpoint' }); continue }
  for (let round = 0; round < 2; round++) {
    const t0 = Date.now()
    const res = await raw(ep, {}, tok)
    if (!res.ok) { log({ step: 'openStream', stream: s.id, kind: round === 0 ? 'video' : 'audio', http: res.status, body: (await res.text()).slice(0, 160) }); break }
    const reader = res.body.getReader()
    let bytes = 0
    let head = null
    while (Date.now() - t0 < HOLD * 1000) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) { bytes += value.length; if (!head) head = Buffer.from(value.slice(0, 12)).toString('latin1') }
    }
    try { await reader.cancel() } catch { /* */ }
    log({ step: 'openStream', stream: s.id, ep: ep.slice(-40), http: res.status, ct: res.headers.get('content-type'), bytes, kbps: Math.round(bytes * 8 / ((Date.now() - t0) / 1000) / 1000), headMagic: head?.slice(0, 4) })
  }
}
await api('/api/v1/meetings/leave', { method: 'POST', body: JSON.stringify({ meetingId: MEETING_ID }) }, tok)
log({ step: 'peerLeft' })
