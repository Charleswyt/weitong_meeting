// 第26项取证 B 轮：扩样本 + 交叉表（sourceType × endpointType/cloudSoftwareRoi/lanes/sourceDeviceId）。
// 全程只读 GET。不打印令牌/URL/ID。
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
if (!token) { console.log('login failed'); process.exit(1) }
const H = { Authorization: 'Bearer ' + token }

function findPubArrays(node, out, depth = 0) {
  if (depth > 7 || node == null || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const x of node) findPubArrays(x, out, depth + 1); return }
  if (node.publications && Array.isArray(node.publications)) out.push(node)
  for (const v of Object.values(node)) findPubArrays(v, out, depth + 1)
}
const all = []
const seenIds = new Set()
const collect = (arrs) => {
  for (const m of arrs) for (const p of (m.publications || [])) {
    const key = String(p.publicationId)
    if (!seenIds.has(key)) { seenIds.add(key); all.push(p) }
  }
}

// 样本源1：全租户聚合 state
const st = await j('/api/frontend/conference-management/state?detail=full', { headers: H })
const arrs1 = []; findPubArrays(st.body, arrs1)
collect(arrs1)
console.log(JSON.stringify({ step: 'aggState', status: st.status, meetingGroupsWithPubs: arrs1.length, included: st.body?.included, pagination: st.body?.pagination, runningStatusOfMeetings: arrs1.map((m) => m.meeting?.status ?? m.status ?? '?').slice(0, 10) }))

// 样本源2：最近 ended 会议（list detail=full 是否带 publications）
const ended = await j('/api/frontend/conference-management/meetings?status=ended&limit=30&offset=0&order=desc&detail=full', { headers: H })
const em = ended.body?.meetings ?? []
const arrs2 = []; findPubArrays(ended.body, arrs2)
collect(arrs2)
console.log(JSON.stringify({ step: 'endedListFull', status: ended.status, meetings: em.length, meetingKeysWithPubs: arrs2.length, firstMeetingKeys: em[0] ? Object.keys(em[0]).sort() : undefined }))

// 逐场 ended 会议详情（若列表 detail=full 不带 pubs，试单场 GET）
if (!arrs2.length && em[0]?.meetingNumber) {
  const one = await j('/api/frontend/conference-management/meetings/' + encodeURIComponent(em[0].meetingNumber) + '?detail=full', { headers: H })
  const arrs3 = []; findPubArrays(one.body, arrs3)
  collect(arrs3)
  console.log(JSON.stringify({ step: 'singleEndedDetail', status: one.status, groups: arrs3.length }))
}

const enumOf = (f) => { const m = {}; for (const p of all) { const v = p[f]; const k = v === undefined ? '<absent>' : typeof v === 'object' ? '<obj>' : String(v); m[k] = (m[k] || 0) + 1 } return m }
console.log(JSON.stringify({ step: 'total', n: all.length }))
for (const f of ['sourceType', 'cloudSoftwareRoi', 'cloudSoftwareRoiMode', 'endpointType', 'encodingStrategy', 'status', 'mediaKind']) {
  console.log(JSON.stringify({ field: f, values: enumOf(f) }))
}
// 交叉表：sourceType × 我方已有/候选字段
const cross = {}
for (const p of all) {
  const t = JSON.stringify({
    st: p.sourceType ?? '?', ep: p.endpointType ?? '?', kind: p.mediaKind,
    roi: p.cloudSoftwareRoi === undefined ? '?' : Boolean(p.cloudSoftwareRoi),
    mode: p.cloudSoftwareRoiMode ?? '?',
    srcLane: Number(p.sourceLaneId) > 0 ? '>0' : String(p.sourceLaneId ?? 'abs'),
    cloudLane: Number(p.cloudLaneId) > 0 ? '>0' : String(p.cloudLaneId ?? 'abs'),
    srcDev: p.sourceDeviceId ? 'ne' : 'e', vid: Boolean(p.hasVideo),
  })
  cross[t] = (cross[t] || 0) + 1
}
console.log(JSON.stringify({ step: 'cross', combos: cross }, null, 1))
