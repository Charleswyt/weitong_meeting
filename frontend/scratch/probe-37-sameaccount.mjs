// 第37项取证：同账号两设备（两个会话）+ 一个第三方观察者，看名单里到底剩几个身份。
// 假设：会话按 userId 键控，第二台设备入会会顶掉第一台的心跳持有者，第一台在上游被判 participant_not_joined
// 后从名单消失 —— 用户看到的就是"我入会了但名单里没有我/别人看不到我"。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
const BASE = process.env.BASE || 'http://localhost:5176'
const USER = process.env.PROBE_USER || 'liwei'
const OBSERVER = process.env.PROBE_OBSERVER || 'wangqiang'
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
  if (!tk) throw new Error('login failed ' + u)
  return tk
}
const log = (o) => console.log(JSON.stringify(o))

const tokA = await login(USER)
const tokObs = await login(OBSERVER)
const qs = await api('/api/v1/meetings/quick-start', { method: 'POST', body: JSON.stringify({ title: 'PROBE-37-同账号顶号', durationMinutes: 10, cloudRecord: false }) }, tokA)
const q = qs.body?.data || {}
const meetingId = q.id ?? q.meetingId
const meetingNo = q.meetingNo
log({ step: 'quickStart', code: qs.body?.code, meetingId, meetingNo })

const joinA = await api('/api/v1/meetings/join', { method: 'POST', body: JSON.stringify({ meetingNo, displayName: '李伟·设备A', recordingConsent: true }) }, tokA)
log({ step: 'joinA', code: joinA.body?.code, pid: joinA.body?.data?.participantId?.slice(-8) })
const pidA = joinA.body?.data?.participantId

// 观察者入场，先确认"只有 A"时名单
await api('/api/v1/meetings/join', { method: 'POST', body: JSON.stringify({ meetingNo, displayName: '王强', recordingConsent: true }) }, tokObs)
const roster1 = await api(`/api/v1/meetings/${meetingId}/state`, {}, tokObs)
log({ step: 'rosterAfterA', parts: (roster1.body?.data?.participants || []).map(p => ({ n: p.name, id: String(p.id).slice(-8) })), count: roster1.body?.data?.participantCount })

// 第二台设备：同一个账号再 join 一次（这里模拟用户手机/另一台机器用同账号入会）
const joinA2 = await api('/api/v1/meetings/join', { method: 'POST', body: JSON.stringify({ meetingNo, displayName: '李伟·设备B', recordingConsent: true }) }, tokA)
log({ step: 'joinA2', code: joinA2.body?.code, pid: joinA2.body?.data?.participantId?.slice(-8), samePid: joinA2.body?.data?.participantId === pidA })
await new Promise((r) => setTimeout(r, 12000))
const roster2 = await api(`/api/v1/meetings/${meetingId}/state`, {}, tokObs)
log({ step: 'rosterAfterA2', parts: (roster2.body?.data?.participants || []).map(p => ({ n: p.name, id: String(p.id).slice(-8) })), count: roster2.body?.data?.participantCount })

await api('/api/v1/meetings/leave', { method: 'POST', body: JSON.stringify({ meetingId }) }, tokObs)
await api('/api/v1/meetings/leave', { method: 'POST', body: JSON.stringify({ meetingId }) }, tokA)
const stop = await api(`/api/v1/meetings/${meetingId}/stop`, { method: 'POST', body: JSON.stringify({ id: meetingId }) }, tokA)
log({ step: 'cleanup', stopCode: stop.body?.code, stopMsg: stop.body?.msg })
