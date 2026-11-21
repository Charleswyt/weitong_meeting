// 第32项定判：录制条目的"通路类型"判别位在哪、一场会议里是否同时存在摄像头+麦克风 ready 通路、
// 以及两者的 m3u8 播放列表有什么差别（音频轨/视频轨）。只读 GET。
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
  return { status: res.status, body, head: txt.slice(0, 160), res }
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

const r = await j('/api/frontend/conference-management/recordings?limit=50&offset=0', { headers: H })
const groups = r.body?.groups ?? []
const kindOf = (t) => {
  const seg = String(t ?? '').split(' · ')
  return { segCount: seg.length, kind: seg[2] ?? '-', who: seg[1] ?? '-', dev: seg[3] ?? '-' }
}
const tally = {}
const segCounts = {}
for (const g of groups) for (const rec of (g.recordings ?? [])) {
  const { segCount, kind } = kindOf(rec.title)
  segCounts[segCount] = (segCounts[segCount] ?? 0) + 1
  const key = kind + ' | ' + (rec.status ?? '-')
  tally[key] = (tally[key] ?? 0) + 1
}
console.log(JSON.stringify({ titleSegmentCounts: segCounts, kindByStatus: tally }, null, 1))

// 找同时有"摄像头 ready"与"麦克风 ready"的组
let found = null
for (const g of groups) {
  const ready = (g.recordings ?? []).filter((x) => x.status === 'ready')
  const kinds = new Set(ready.map((x) => kindOf(x.title).kind))
  if (kinds.has('摄像头') && kinds.has('麦克风')) { found = { key: g.key, meeting: g.meeting?.title, ready }; break }
}
if (!found) {
  const anyVideo = []
  for (const g of groups) for (const rec of (g.recordings ?? [])) {
    const k = kindOf(rec.title)
    if (k.kind === '摄像头') anyVideo.push({ kind: k.kind, status: rec.status, bytes: rec.fileSizeBytes, play: !!rec.playbackUrl, meeting: g.meeting?.title })
  }
  console.log(JSON.stringify({ bothKindsReadyGroup: null, cameraLanesAnywhere: anyVideo.slice(0, 12), cameraLaneTotal: anyVideo.length }))
} else {
  console.log('=== group ' + found.key + ' ready=' + found.ready.length)
  for (const l of found.ready) {
    const k = kindOf(l.title)
    const url = l.playbackUrl.startsWith('http') ? l.playbackUrl : BASE + l.playbackUrl
    const p = await fetch(url, { headers: H })
    const txt = await p.text()
    const lines = txt.split(/\r?\n/).filter((x) => x.startsWith('#'))
    console.log(JSON.stringify({
      kind: k.kind, who: k.who, lane: l.sourceLaneId, bytes: l.fileSizeBytes, dur: l.durationSeconds,
      tagLines: lines.filter((x) => !x.startsWith('#EXTINF')).slice(0, 6),
      extinfCount: txt.split(/\r?\n/).filter((x) => x.startsWith('#EXTINF')).length,
      firstSeg: txt.split(/\r?\n/).find((x) => x && !x.startsWith('#')),
    }))
  }
}
