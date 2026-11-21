// 第33项决定性取证：本账号在三方目录里可见的**全部**录制，按状态/模式/源设备/localPaths 分桶，
// 判断"本地(板卡)录制"在真源里究竟有没有一条，以及我们的判据能不能落在真实数据上。
// 账号口令只从 CREDS_FILE 读，绝不打印；输出只含聚合统计。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const BASE = process.env.TP_BASE || 'https://47.114.83.151'
const file = process.env.CREDS_FILE
if (!file) throw new Error('CREDS_FILE not set')
const who = process.env.WHO || 'liwei'
const row = readFileSync(file, 'utf8').split(/\r?\n/).find((l) => l.split('\t')[0] === who)
if (!row) throw new Error('no row for ' + who)
const cols = row.split('\t').map((c) => c.trim())
const [tpAccount, tpPassword] = [cols[2], cols[3]]
if (!tpAccount || !tpPassword) { console.log('ABORT: third-party pair missing'); process.exit(1) }

async function j(path, opts = {}) {
  const t0 = Date.now()
  const res = await fetch(BASE + path, opts)
  const txt = await res.text()
  let body = null
  try { body = JSON.parse(txt) } catch { /* not json */ }
  return { ms: Date.now() - t0, status: res.status, body, head: txt.slice(0, 160) }
}

const pk = await j('/api/frontend/auth/sm2-public-key')
const desc = pk.body?.data ?? pk.body
const envelope = JSON.stringify({
  username: tpAccount,
  password: tpPassword,
  challenge: desc.challenge,
  issuedAtMs: Date.now(),
  nonce: randomBytes(18).toString('hex'),
})
const login = await j('/api/frontend/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: tpAccount,
    algorithm: 'SM2',
    keyId: desc.keyId,
    challenge: desc.challenge,
    cipherMode: 'C1C3C2',
    ciphertextEncoding: 'c1c3c2-hex',
    ciphertext: sm2.doEncrypt(envelope, desc.publicKey, 1),
  }),
})
const token = login.body?.token ?? login.body?.data?.token ?? login.body?.accessToken
if (!token) { console.log(JSON.stringify({ step: 'tpLogin', status: login.status, head: login.head })); process.exit(1) }
const H = { Authorization: 'Bearer ' + token }

const bump = (m, k) => { m[k] = (m[k] ?? 0) + 1 }

// 1) 翻页取全量组
const all = []
let groups = 0, pages = 0, totalRows = null, deviceIds = null, groupTotal = null
for (let offset = 0; offset <= 1000; offset += 50) {
  const r = await j(`/api/frontend/conference-management/recordings?limit=50&offset=${offset}`, { headers: H })
  if (r.status !== 200) { console.log(JSON.stringify({ step: 'pages', offset, status: r.status, head: r.head })); break }
  const b = r.body ?? {}
  const g = Array.isArray(b.groups) ? b.groups : []
  groups += g.length
  pages++
  totalRows = b.totalRecordings ?? totalRows
  groupTotal = b.pagination?.recordings?.total ?? b.pagination?.groups?.total ?? b.pagination?.total ?? groupTotal
  if (Array.isArray(b.deviceIds)) deviceIds = b.deviceIds
  for (const grp of g) for (const rec of (grp.recordings ?? [])) all.push({ grp: grp.key, meeting: grp.meeting?.title, rec })
  if (!g.length) break
  const paging = b.pagination ?? {}
  const hasMore = paging.recordings?.hasMore ?? paging.groups?.hasMore ?? paging.hasMore
  if (hasMore === false) break
  if (hasMore === undefined) break
}

// 2) 分桶
const byStatus = {}, byMode = {}, bySource = {}
const localPathHits = []
const noCloudPath = []
const canDelete = {}
for (const { rec, grp, meeting } of all) {
  bump(byStatus, rec.status ?? '-')
  bump(byMode, rec.mode ?? '-')
  bump(bySource, rec.sourceDeviceId ?? '-')
  bump(canDelete, String(rec.access?.canDelete))
  const lp = Array.isArray(rec.localPaths) ? rec.localPaths : []
  if (lp.length > 0) localPathHits.push({ grp, meeting, status: rec.status, mode: rec.mode, src: rec.sourceDeviceId, paths: lp, size: rec.sizeBytes ?? rec.size })
  if (!rec.cloudPath) noCloudPath.push({ grp, meeting, status: rec.status, mode: rec.mode, src: rec.sourceDeviceId, lp: lp.length })
}

console.log(JSON.stringify({
  step: 'universe',
  pages, groups, rows: all.length, totalRows, groupTotal,
  deviceIds,
  byStatus, byMode, bySource,
  accessCanDelete: canDelete,
  localPathHitsCount: localPathHits.length,
  localPathHits: localPathHits.slice(0, 5),
  noCloudPathCount: noCloudPath.length,
  noCloudPath: noCloudPath.slice(0, 5),
}, null, 1))

// 3) 单状态过滤是否服务端生效（对照计数）
const sweep = []
for (const st of ['captured', 'pending', 'interrupted', 'finalizing', 'recording', 'stopped', 'failed', 'ready']) {
  const r = await j(`/api/frontend/conference-management/recordings?status=${st}&limit=50&offset=0`, { headers: H })
  const b = r.body ?? {}
  const rows = (Array.isArray(b.groups) ? b.groups : []).reduce((n, g) => n + (g.recordings?.length ?? 0), 0)
  sweep.push({ st, http: r.status, ms: r.ms, groups: b.groups?.length, rows, totalRecordings: b.totalRecordings })
}
console.log(JSON.stringify({ step: 'statusSweep', sweep }))

// 4) 按设备过滤：板卡设备有没有录制
if (Array.isArray(deviceIds) && deviceIds.length) {
  const per = []
  for (const d of deviceIds.slice(0, 8)) {
    const r = await j(`/api/frontend/conference-management/recordings?deviceId=${encodeURIComponent(d)}&limit=50&offset=0`, { headers: H })
    const b = r.body ?? {}
    const rows = (Array.isArray(b.groups) ? b.groups : []).reduce((n, g) => n + (g.recordings?.length ?? 0), 0)
    const withLocal = (Array.isArray(b.groups) ? b.groups : [])
      .flatMap((g) => g.recordings ?? [])
      .filter((x) => Array.isArray(x.localPaths) && x.localPaths.length > 0).length
    per.push({ d, http: r.status, ms: r.ms, groups: b.groups?.length, rows, totalRecordings: b.totalRecordings, withLocal })
  }
  console.log(JSON.stringify({ step: 'deviceSweep', per }))
}
