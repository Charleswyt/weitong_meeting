// 验证第32/33项修复后的列表字段：mediaKind/mediaLabel/participant/deletable 是否真有值，
// title 是否已是我方语义（会议名，不含三方拼接分隔符）。口令只从 CREDS_FILE 读。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
const BASE = process.env.BASE || 'http://localhost:5176'
const who = process.env.WHO || 'liwei'
const lines = readFileSync(process.env.CREDS_FILE, 'utf8').split(/\r?\n/)
const hit = lines.find((l) => l.split(/[\t,]/)[0].trim() === who)
const cols = hit.split(/[\t,]/).map((c) => c.trim())

const pk = await (await fetch(BASE + '/api/v1/auth/sm2-public-key')).json()
const d = pk.data
const env = JSON.stringify({ username: cols[0], password: cols[1], challenge: d.challenge, issuedAtMs: Date.now(), nonce: randomBytes(18).toString('hex') })
const login = await (await fetch(BASE + '/api/v1/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: cols[0], algorithm: 'SM2', keyId: d.keyId, challenge: d.challenge, cipherMode: 1, ciphertextEncoding: 'c1c3c2-hex', ciphertext: sm2.doEncrypt(env, d.publicKey, 1) }),
})).json()
const token = login.data?.token
if (!token) { console.log(JSON.stringify({ step: 'login', msg: login.msg })); process.exit(1) }

const res = await (await fetch(BASE + '/api/v1/recordings/list?pageNum=1&pageSize=60', { headers: { Authorization: 'Bearer ' + token } })).json()
const rows = res.rows ?? []
const kinds = {}, labels = {}, participants = new Set(), titles = new Set()
let separatorLeak = 0, deletableTrue = 0
for (const r of rows) {
  kinds[r.mediaKind] = (kinds[r.mediaKind] ?? 0) + 1
  labels[r.mediaLabel] = (r.mediaLabel ?? 0) + 1
  if (r.participant) participants.add(r.participant)
  titles.add(r.title)
  if (String(r.title).includes(' · ')) separatorLeak++
  if (r.deletable) deletableTrue++
}
console.log(JSON.stringify({
  code: res.code, total: res.total, rows: rows.length,
  kinds, labels, participantCount: participants.size, distinctTitles: [...titles].slice(0, 6),
  titleSeparatorLeak: separatorLeak, deletableTrue,
  sample: rows[0],
}, null, 1))
