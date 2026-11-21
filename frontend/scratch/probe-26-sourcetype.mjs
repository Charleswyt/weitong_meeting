// 第26项取证：三方 publications 记录里 sourceType / cloudSoftwareRoi 是否为服务端字段、取值域、
// 以及与 mediaKind/rkDeliveryMode/directDeliveryMode/rkReceiverLaneId/rkReceiverPath 的对应关系。
// 全程只读 GET（列会议 + 全租户 state），口令只从 CREDS_FILE 读，绝不打印任何令牌/URL/ID。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const BASE = process.env.TP_BASE || 'https://47.114.83.151'
const WHO = process.env.WHO || 'admin'
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
  return { ms: Date.now() - t0, status: res.status, body, head: txt.slice(0, 160) }
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

// 1) 当前 running 会议数量（只取状态计数）
const list = await j('/api/frontend/conference-management/meetings?status=scheduled,starting,running&limit=50&offset=0', { headers: H })
const meetings = list.body?.meetings ?? []
console.log(JSON.stringify({ step: 'list', status: list.status, ms: list.ms, count: meetings.length, statusCounts: meetings.reduce((a, m) => (a[m.status] = (a[m.status] || 0) + 1, a), {}) }))

// 2) 全租户 state（detail=full 含媒体详情；实测可能慢，耐心等）。递归找 publications 数组。
function findPublicationArrays(node, out, depth = 0) {
  if (depth > 6 || node == null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const x of node) findPublicationArrays(x, out, depth + 1); return }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'publications' && Array.isArray(v)) out.push(v)
    else findPublicationArrays(v, out, depth + 1)
  }
}
const allPubs = []
for (const detail of ['full', 'summary']) {
  const st = await j('/api/frontend/conference-management/state?detail=' + detail, { headers: H })
  console.log(JSON.stringify({ step: 'state-' + detail, status: st.status, ms: st.ms, topKeys: st.body ? Object.keys(st.body).slice(0, 12) : undefined, err: st.status !== 200 ? st.head : undefined }))
  if (st.status === 200) { const arr = []; findPublicationArrays(st.body, arr); for (const a of arr) allPubs.push(...a) }
  if (allPubs.length) break
}
console.log(JSON.stringify({ step: 'pubs', total: allPubs.length }))

const keyUnion = new Set()
const enumOf = (field) => { const m = {}; for (const p of allPubs) { const v = p[field]; const k = v === undefined ? '<absent>' : typeof v === 'object' ? '<obj>' : String(v); m[k] = (m[k] || 0) + 1 } return m }
for (const p of allPubs) Object.keys(p).forEach((k) => keyUnion.add(k))
console.log(JSON.stringify({ step: 'keys', keys: [...keyUnion].sort() }))
for (const f of ['sourceType', 'cloudSoftwareRoi', 'mediaKind', 'rkDeliveryMode', 'directDeliveryMode', 'rkReceiverPath', 'status', 'hasVideo', 'hasAudio', 'hdReady', 'rkReceiverLaneId', 'sourceDeviceId']) {
  const vals = enumOf(f)
  // rkReceiverPath 可能是含签名的 URL：只报 空/非空
  if (f === 'rkReceiverPath' || f === 'sourceDeviceId') {
    const counts = {}
    for (const p of allPubs) { const v = p[f]; const k = v === undefined ? '<absent>' : (v === '' ? '<empty>' : '<nonempty>'); counts[k] = (counts[k] || 0) + 1 }
    console.log(JSON.stringify({ field: f, counts }))
  } else {
    console.log(JSON.stringify({ field: f, values: vals }))
  }
}
// transportMetrics 内部键 + sourceVideoBitrateKbps 是否在其中
const tmKeys = new Set()
let tmCount = 0, tmSrcCount = 0
for (const p of allPubs) {
  if (p.transportMetrics && typeof p.transportMetrics === 'object') {
    tmCount++; Object.keys(p.transportMetrics).forEach((k) => tmKeys.add(k))
    if ('sourceVideoBitrateKbps' in p.transportMetrics) tmSrcCount++
  }
}
console.log(JSON.stringify({ step: 'transportMetrics', present: tmCount, of: allPubs.length, withSourceBitrate: tmSrcCount, keys: [...tmKeys].sort() }))
const svb = { absent: 0, zero: 0, positive: 0 }
for (const p of allPubs) { const v = p.sourceVideoBitrateKbps; if (v === undefined) svb.absent++; else if (Number(v) > 0) svb.positive++; else svb.zero++ }
console.log(JSON.stringify({ step: 'topLevelSourceVideoBitrateKbps', svb }))

// 3) 交叉表：sourceType × 判定字段组合（等价判定依据）
const cross = {}
for (const p of allPubs) {
  const t = JSON.stringify({
    sourceType: p.sourceType ?? '<absent>', mediaKind: p.mediaKind,
    rkDeliveryMode: p.rkDeliveryMode ?? '<absent>', directDeliveryMode: p.directDeliveryMode ?? '<absent>',
    lane: Number(p.rkReceiverLaneId) > 0, rkPath: p.rkReceiverPath ? 'ne' : '',
    cloudSoftwareRoi: 'cloudSoftwareRoi' in p ? Boolean(p.cloudSoftwareRoi) : '<absent>',
  })
  cross[t] = (cross[t] || 0) + 1
}
console.log(JSON.stringify({ step: 'cross', combos: cross }, null, 1))

// 4) 顺带：不用 participantToken、仅管理员 Bearer 能否 GET 单场 /state（记录状态码即可）
const running = meetings.find((m) => m.status === 'running')
if (running?.meetingNumber) {
  const one = await j('/api/conference/meetings/' + encodeURIComponent(running.meetingNumber) + '/state', { headers: H })
  const arr = []; if (one.status === 200) findPublicationArrays(one.body, arr)
  console.log(JSON.stringify({ step: 'singleStateBearerOnly', status: one.status, ms: one.ms, pubArrays: arr.length, pubs: arr.flat().length, err: one.status !== 200 ? one.head : undefined }))
} else {
  console.log(JSON.stringify({ step: 'singleStateBearerOnly', skipped: 'no running meeting' }))
}
