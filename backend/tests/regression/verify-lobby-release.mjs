// 等候室的另一半：主持人到场后必须放行（否则门禁就成了把人永久关在门外）
// 与 verify-0929-round2.mjs 同一套取依赖/取凭据的方式：sm-crypto 在前端仓，裸 import 解析不到。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { sm2 } = require(fileURLToPath(new URL('../../../frontend/node_modules/sm-crypto', import.meta.url)))
const BASE = 'http://localhost:8082'
const creds = readFileSync(process.env.CREDS_FILE || tmpdir() + '/creds.tsv', 'utf8')
  .split(/\r?\n/).filter(Boolean).map((l) => l.split('\t'))
const cred = (n) => creds.find((r) => r[0] === n)
function nonce() { const b = new Uint8Array(18); crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') }
async function session(user) {
  const [login, pass] = cred(user)
  const d = (await fetch(BASE + '/api/v1/auth/sm2-public-key').then((r) => r.json())).data
  const envelope = JSON.stringify({ username: login, password: pass, challenge: d.challenge, issuedAtMs: Date.now(), nonce: nonce() })
  const res = await fetch(BASE + '/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: login, algorithm: d.algorithm, keyId: d.keyId, challenge: d.challenge, cipherMode: d.cipherMode, ciphertextEncoding: d.ciphertextEncoding, ciphertext: sm2.doEncrypt(envelope, d.publicKey, 1) }) }).then((r) => r.json())
  const tk = res.data?.token; if (!tk) throw new Error(user + ' 登录失败')
  return async (m, p, b) => { const r = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = { raw: t.slice(0, 60) } } return { http: r.status, ...j } }
}
const out = []; const check = (n, ok, d) => out.push((ok ? 'PASS ' : 'FAIL ') + n + '  ' + (d || ''))
const pad = (n) => String(n).padStart(2, '0')
const at = (min) => { const s = new Date(Date.now() + min * 60000); return `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())} ${pad(s.getHours())}:${pad(s.getMinutes())}:00` }

const host = await session('zhangming'), member = await session('liwei')
const stamp = Date.now().toString().slice(-6)
const m = await host('POST', '/api/v1/meetings/schedule', { title: `等候放行${stamp}`, startTime: at(60), durationMinutes: 15, cloudRecord: false, allowWaiting: true })
const id = m.data?.id, no = m.data?.meetingNo
const w = await member('POST', '/api/v1/meetings/join', { meetingNo: no, recordingConsent: true })
check('主持人不在场 → waiting=true（拦住）', w.code === 200 && w.data?.waiting === true, 'waiting=' + w.data?.waiting + ' msg=' + w.msg)
const st = await host('POST', `/api/v1/meetings/${id}/start`, {})
check('主持人提前开始会议', st.code === 200, 'code=' + st.code + ' msg=' + st.msg + ' status=' + st.data?.status)
const hj = await host('POST', '/api/v1/meetings/join', { meetingNo: no, recordingConsent: true })
check('主持人入会', hj.code === 200, 'code=' + hj.code + ' msg=' + hj.msg)
const w2 = await member('POST', '/api/v1/meetings/join', { meetingNo: no, recordingConsent: true })
check('主持人到场后成员被放行（waiting=false）', w2.code === 200 && w2.data?.waiting === false, 'code=' + w2.code + ' waiting=' + w2.data?.waiting + ' msg=' + w2.msg)
const mj = await member('POST', '/api/v1/meetings/leave', { meetingId: w2.data?.meetingId })
check('成员离会收尾', mj.code === 200, 'msg=' + mj.msg)
const en = await host('POST', `/api/v1/meetings/${id}/end`, {})
check('主持人结束会议（清理）', en.code === 200, 'code=' + en.code + ' msg=' + en.msg)
console.log(out.join('\n')); console.log('MEETING ' + JSON.stringify({ id, no }))
