// 第32/7项根因取证：一场会议下的所有录制通路（lane）形状 + playbackUrl 的真实 content-type 与首字节。
// 只读 GET。口令只从 CREDS_FILE 读。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const BASE = process.env.TP_BASE || 'https://47.114.83.151'
const row = readFileSync(process.env.CREDS_FILE, 'utf8').split(/\r?\n/).find((l) => l.split('\t')[0] === (process.env.WHO || 'liwei'))
const cols = row.split('\t').map((c) => c.trim())

async function j(path, opts = {}) {
  const res = await fetch(BASE + path, opts)
  const txt = await res.text()
  let body = null
  try { body = JSON.parse(txt) } catch { /* */ }
  return { status: res.status, body, head: txt.slice(0, 160) }
}
const pk = await j('/api/frontend/auth/sm2-public-key')
const desc = pk.body?.data ?? pk.body
const login = await j('/api/frontend/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: cols[2], algorithm: 'SM2', keyId: desc.keyId, challenge: desc.challenge,
    cipherMode: 'C1C3C2', ciphertextEncoding: 'c1c3c2-hex',
    ciphertext: sm2.doEncrypt(JSON.stringify({ username: cols[2], password: cols[3], challenge: desc.challenge, issuedAtMs: Date.now(), nonce: randomBytes(18).toString('hex') }), desc.publicKey, 1),
  }),
})
const token = login.body?.token ?? login.body?.data?.token ?? login.body?.accessToken
if (!token) { console.log('login failed', login.head); process.exit(1) }
const H = { Authorization: 'Bearer ' + token }

// 取一场同时含摄像头+麦克风 ready 通路的会议
const r = await j('/api/frontend/conference-management/recordings?limit=50&offset=0', { headers: H })
const groups = (r.body?.groups ?? [])
const picked = []
for (const g of groups) {
  const lanes = (g.recordings ?? []).filter((x) => x.status === 'ready')
  if (!lanes.length) continue
  picked.push({ key: g.key, meeting: g.meeting?.title, lanes })
  if (picked.length >= 2) break
}
for (const p of picked) {
  console.log('=== group ' + p.key + ' meeting=' + p.meeting + ' readyLanes=' + p.lanes.length)
  for (const l of p.lanes) {
    console.log('  ' + JSON.stringify({
      id: l.recordingId.slice(-24), kind: (l.title ?? '').split(' · ')[2], status: l.status,
      mode: l.mode, lane: l.sourceLaneId, bytes: l.fileSizeBytes, dur: l.durationSeconds,
      src: l.sourceDeviceId, play: (l.playbackUrl ?? '').slice(0, 80), dl: (l.downloadUrl ?? '').slice(0, 60),
    }))
  }
  // 逐通路探播放 URL 的媒体类型
  for (const l of p.lanes.slice(0, 4)) {
    if (!l.playbackUrl) continue
    const url = l.playbackUrl.startsWith('http') ? l.playbackUrl : BASE + l.playbackUrl
    const t0 = Date.now()
    const res = await fetch(url, { headers: H })
    const buf = await res.arrayBuffer()
    const bytes = new Uint8Array(buf.slice(0, 24))
    console.log('  PROBE ' + JSON.stringify({
      kind: (l.title ?? '').split(' · ')[2], status: res.status, ms: Date.now() - t0,
      ctype: res.headers.get('content-type'), clen: res.headers.get('content-length'), got: buf.byteLength,
      head: Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' '),
      ascii: Array.from(bytes).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join(''),
    }))
  }
}
