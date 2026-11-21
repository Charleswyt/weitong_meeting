// 第33项续查：把每个 source 设备下的录制条目**整条**打出来，找"板卡本地录制"的真实判别字段。
// 只读 GET，不碰任何写接口。口令只从 CREDS_FILE 读。
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

for (const d of ['RK3588-BJ', 'RK3588-BJ3', 'rk3588-001', 'browser']) {
  const r = await j(`/api/frontend/conference-management/recordings?deviceId=${encodeURIComponent(d)}&limit=50&offset=0`, { headers: H })
  const groups = r.body?.groups ?? []
  const recs = groups.flatMap((g) => g.recordings ?? [])
  // 每种 mode 取一条整条打印，看字段差异
  const seen = new Set()
  const samples = []
  for (const rec of recs) {
    const k = `${rec.mode}|${rec.status}`
    if (seen.has(k)) continue
    seen.add(k)
    samples.push(rec)
  }
  console.log(JSON.stringify({ deviceId: d, rows: recs.length, combos: [...seen], samples }, null, 1))
}
