// 现场取证：船端(pad_edge)那路画面为什么一直 425 direct_video_not_ready。
// 只读 GET 一场会的事实，打印每条发布的**通道有无**（布尔）与投递模式 —— 不打印任何 URL/令牌/口令。
// 跑法：CREDS_FILE=<creds.tsv> node scratch/probe-pad-video.mjs [会议号]
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const BASE = process.env.TP_BASE || 'https://47.114.83.151'
const WHO = process.env.WHO || 'admin'
const MEETING = process.argv[2] || '49659119'
const row = readFileSync(process.env.CREDS_FILE, 'utf8').split(/\r?\n/).find((l) => l.split('\t')[0] === WHO)
if (!row) { console.log('no creds row'); process.exit(1) }
const cols = row.split('\t').map((c) => c.trim())
const [tpAccount, tpPassword] = [cols[2], cols[3]]

async function j(path, opts = {}) {
  const t0 = Date.now()
  const res = await fetch(BASE + path, opts)
  const txt = await res.text()
  let body = null
  try { body = JSON.parse(txt) } catch { /* */ }
  return { ms: Date.now() - t0, status: res.status, body, head: txt.slice(0, 120) }
}

const pk = await j('/api/frontend/auth/sm2-public-key')
const desc = pk.body?.data ?? pk.body
const login = await j('/api/frontend/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: tpAccount, algorithm: 'SM2', keyId: desc.keyId, challenge: desc.challenge,
    cipherMode: 'C1C3C2', ciphertextEncoding: 'c1c3c2-hex',
    ciphertext: sm2.doEncrypt(JSON.stringify({ username: tpAccount, password: tpPassword, challenge: desc.challenge, issuedAtMs: Date.now(), nonce: randomBytes(18).toString('hex') }), desc.publicKey, 1),
  }),
})
const token = login.body?.token ?? login.body?.data?.token ?? login.body?.accessToken
console.log(JSON.stringify({ step: 'login', status: login.status, ok: !!token }))
if (!token) process.exit(1)
const H = { Authorization: 'Bearer ' + token }

const has = (o, k) => (o?.[k] === undefined ? '<absent>' : o[k] === '' ? '<empty>' : 'yes')
const tail = (s) => (s ? String(s).slice(-8) : '-')

for (const path of [
  `/api/conference/meetings/${MEETING}`,
  `/api/conference/meetings/${MEETING}/state`,
]) {
  const r = await j(path, { headers: H })
  console.log(JSON.stringify({ step: 'get', path: path.replace(MEETING, '{号}'), status: r.status, ms: r.ms, err: r.status !== 200 ? r.head : undefined }))
  if (r.status !== 200) continue
  const found = []
  const walk = (n, d = 0) => {
    if (d > 6 || n == null || typeof n !== 'object') return
    if (Array.isArray(n)) { for (const x of n) walk(x, d + 1); return }
    for (const [k, v] of Object.entries(n)) {
      if ((k === 'publications' || k === 'participants') && Array.isArray(v)) found.push([k, v])
      else walk(v, d + 1)
    }
  }
  walk(r.body)
  for (const [k, arr] of found) {
    if (k === 'participants') {
      for (const p of arr) console.log(JSON.stringify({ kind: 'participant', id: tail(p.participantId), name: p.displayName, endpoint: p.endpointType, userId: p.userId ?? null, cameraOn: p.cameraOn ?? null, micOn: p.micOn ?? null }))
    } else {
      for (const p of arr) console.log(JSON.stringify({
        kind: 'publication', id: tail(p.publicationId), part: tail(p.participantId), media: p.mediaKind, status: p.Status || p.status,
        hdReady: p.hdReady, directVideo: has(p, 'directVideoUrl'), videoWhep: has(p, 'videoWhepUrl'),
        directAudio: has(p, 'directAudioUrl'), audioWhep: has(p, 'audioWhepUrl'),
        rkWhep: has(p, 'rkReceiverWhepUrl'), rkAudioWhep: has(p, 'rkReceiverAudioWhepUrl'),
        directMode: p.directDeliveryMode ?? null, rkMode: p.rkDeliveryMode ?? null, sourceType: p.sourceType ?? null,
      }))
    }
  }
  if (found.length) break
}
