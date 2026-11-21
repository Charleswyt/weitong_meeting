import { readFileSync, writeFileSync } from 'node:fs'
const j = JSON.parse(readFileSync(new URL('./token.json', import.meta.url), 'utf8'))
writeFileSync(new URL('./token_value.txt', import.meta.url), j.token, { mode: 0o600 })
const H = { Authorization: 'Bearer ' + j.token, 'Content-Type': 'application/json' }
const post = async (p, body) => (await (await fetch('http://localhost:8082' + p, { method: 'POST', headers: H, body: JSON.stringify(body) })).json())
const get = async (p) => (await (await fetch('http://localhost:8082' + p, { headers: H })).json())
const r = await post('/api/v1/meetings/quick-start', { title: '同刻读数-压缩比', durationMinutes: 20, cloudRecord: false })
const l = await get('/api/v1/meetings/list?pageSize=10')
const run = (l.rows || []).find((x) => x.status === 'running')
console.log(JSON.stringify({ created: r.code, id: run?.id, title: run?.title }))
