// 逆向实测：三方新集合查询端点是否真的存在、耗时多少、返回什么形状。
// 账号口令只从 CREDS_FILE 读，绝不打印。
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
console.log(JSON.stringify({ step: 'creds', who, colCount: cols.length, hasThirdPartyPair: !!tpAccount && !!tpPassword }))
if (!tpAccount || !tpPassword) { console.log('ABORT: third-party pair missing'); process.exit(1) }

async function j(path, opts = {}) {
  const t0 = Date.now()
  const res = await fetch(BASE + path, opts)
  const txt = await res.text()
  let body = null
  try { body = JSON.parse(txt) } catch { /* not json */ }
  return { ms: Date.now() - t0, status: res.status, body, head: txt.slice(0, 200) }
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
console.log(JSON.stringify({ step: 'tpLogin', status: login.status, ms: login.ms, ok: !!token, head: token ? undefined : login.head }))
if (!token) process.exit(1)

const H = { Authorization: 'Bearer ' + token }
const probe = async (label, path) => {
  const r = await j(path, { headers: H })
  const b = r.body ?? {}
  console.log(JSON.stringify({
    label,
    status: r.status,
    ms: r.ms,
    topKeys: Object.keys(b).slice(0, 10),
    count: Array.isArray(b.meetings) ? b.meetings.length : Array.isArray(b.recordings) ? b.recordings.length : Array.isArray(b.groups) ? b.groups.length : undefined,
    pagination: b.pagination,
    totalRecordings: b.totalRecordings,
    deviceIds: b.deviceIds,
    error: b.error ?? b.message,
    first: Array.isArray(b.meetings) ? b.meetings[0] : Array.isArray(b.recordings) ? b.recordings[0] : Array.isArray(b.groups) ? b.groups[0] : undefined,
    groupKeys: Array.isArray(b.groups) && b.groups[0] ? Object.keys(b.groups[0]) : undefined,
    head: r.status !== 200 ? r.head : undefined,
  }))
}

await probe('meetings-status3-limit8', '/api/frontend/conference-management/meetings?status=scheduled,starting,running&limit=8&offset=0&order=asc')
await probe('meetings-owner-mine', '/api/frontend/conference-management/meetings?owner=mine&limit=8&offset=0')
await probe('meetings-ended', '/api/frontend/conference-management/meetings?status=ended&limit=8&offset=0&detail=summary')
await probe('recordings-limit5', '/api/frontend/conference-management/recordings?limit=5&offset=0')
await probe('summary', '/api/frontend/conference-management/summary')
const now = Math.floor(Date.now() / 1000)
await probe('calendar-week', `/api/frontend/conference-management/calendar?startFrom=${now - 86400}&startTo=${now + 6 * 86400}`)
await probe('state-summary-no-include', '/api/frontend/conference-management/state?detail=summary')
