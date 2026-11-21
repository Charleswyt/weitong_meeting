import { readFileSync } from 'node:fs'
const BASE = 'http://localhost:5176'
const who = 'liwei'
const row = readFileSync(process.env.CREDS_FILE, 'utf8').split(/\r?\n/).find((l) => l.split('\t')[0] === who)
const { sm2 } = (await import('node:module')).createRequire(import.meta.url)('sm-crypto')
const d = await (await fetch(BASE + '/api/v1/auth/sm2-public-key')).json()
const desc = d.data
const env = JSON.stringify({ username: who, password: row.split('\t')[1], challenge: desc.challenge, issuedAtMs: Date.now(), nonce: 'a1b2c3' })
const lg = await (await fetch(BASE + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: who, algorithm: desc.algorithm, keyId: desc.keyId, challenge: desc.challenge, cipherMode: desc.cipherMode, ciphertextEncoding: desc.ciphertextEncoding, ciphertext: sm2.doEncrypt(env, desc.publicKey, 1) }) })).json()
const tk = lg.data.token
const get = async (u) => (await (await fetch(BASE + u, { headers: { Authorization: 'Bearer ' + tk } })).json())
const p1 = await get('/api/v1/recordings/list?pageNum=1&pageSize=100')
const p2 = await get('/api/v1/recordings/list?pageNum=2&pageSize=100')
const ids = (p) => (p.rows || []).map((r) => r.id ?? r.recordingId)
const a = ids(p1), b = ids(p2)
console.log(JSON.stringify({ total1: p1.total, total2: p2.total, n1: a.length, n2: b.length, overlap: a.filter((x) => b.includes(x)).length, dupWithinP1: a.length - new Set(a).size, sample2: b.slice(0, 2) }))
