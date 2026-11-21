// 第26项取证 C 轮：把 publication 的**键名形状**钉死，供后端结构体照抄。
// 只打印键名与计数，绝不打印值/ID/令牌/URL。全程只读 GET。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const BASE = process.env.TP_BASE || 'https://47.114.83.151'
const row = readFileSync(process.env.CREDS_FILE, 'utf8').split(/\r?\n/).find((l) => l.split('\t')[0] === (process.env.WHO || 'admin'))
const cols = row.split('\t').map((c) => c.trim())

async function j(path, opts = {}) {
  const res = await fetch(BASE + path, opts)
  const txt = await res.text()
  let body = null
  try { body = JSON.parse(txt) } catch { /* */ }
  return { status: res.status, body }
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
if (!token) { console.log('login failed'); process.exit(1) }
const H = { Authorization: 'Bearer ' + token }

function findPubArrays(node, out, depth = 0) {
  if (depth > 7 || node == null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const x of node) findPubArrays(x, out, depth + 1); return }
  if (node.publications && Array.isArray(node.publications)) out.push(node)
  for (const v of Object.values(node)) findPubArrays(v, out, depth + 1)
}
const st = await j('/api/frontend/conference-management/state?detail=full', { headers: H })
const arrs = []
findPubArrays(st.body, arrs)
const seen = new Set()
const all = []
for (const m of arrs) for (const p of (m.publications || [])) {
  const k = String(p.publicationId)
  if (!seen.has(k)) { seen.add(k); all.push(p) }
}

const keys = new Set()
const tmKeys = new Set()
let withTm = 0, topNonZero = 0, tmNonZero = 0, videoOnly = 0, videoWithTm = 0, videoTmNonZero = 0
const typeCount = {}
for (const p of all) {
  for (const k of Object.keys(p)) keys.add(k)
  const tm = p.transportMetrics
  if (tm && typeof tm === 'object') {
    withTm++
    for (const k of Object.keys(tm)) tmKeys.add(k)
    if (Number(tm.sourceVideoBitrateKbps) > 0) tmNonZero++
  }
  if (Number(p.sourceVideoBitrateKbps) > 0) topNonZero++
  typeCount[p.sourceType] = (typeCount[p.sourceType] || 0) + 1
  if (p.hasVideo || p.mediaKind === 'camera' || p.mediaKind === 'screen') {
    videoOnly++
    if (tm) videoWithTm++
    if (tm && Number(tm.sourceVideoBitrateKbps) > 0) videoTmNonZero++
  }
}
console.log(JSON.stringify({
  publications: all.length,
  withTransportMetrics: withTm,
  topFieldNonZero: topNonZero,
  tmFieldNonZero: tmNonZero,
  videoLanes: videoOnly,
  videoLanesWithTm: videoWithTm,
  videoTmNonZero,
  sourceTypes: typeCount,
  publicationKeys: [...keys].sort(),
  transportMetricsKeys: [...tmKeys].sort(),
}, null, 1))
