// 2026-09-29 本轮后端改动验收：第 1/5/6/10 项（凭据从 creds.tsv 读，不落盘不回显）
// sm-crypto 只装在前端那个仓的 node_modules 里（两仓不共享依赖），所以按路径 require ——
// 裸 import 在这里解析不到，整套验收脚本会直接跑不起来（而"跑不起来"最容易被误当成"没问题"）。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { sm2 } = require(fileURLToPath(new URL('../../../frontend/node_modules/sm-crypto', import.meta.url)))
const BASE = process.env.BASE || 'http://localhost:8082'
// Git Bash 起的 node 里 process.env.TEMP 常常是空的；CREDS_FILE 优先，退回 os.tmpdir()。
// 按 \r?\n 切：Windows 的 CRLF 会把 \r 留在最后一列，三方口令就带着一个看不见的字符去登录。
const creds = readFileSync(process.env.CREDS_FILE || tmpdir() + '/creds.tsv', 'utf8')
  .split(/\r?\n/).filter(Boolean).map((l) => l.split('\t'))
const cred = (name) => creds.find((r) => r[0] === name)
if (!cred('liwei') || !cred('zhangming')) throw new Error('探针账号不在 creds.tsv 里')

function nonce() { const b = new Uint8Array(18); crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') }

async function session(user) {
  const [login, pass] = cred(user)
  const desc = await fetch(BASE + '/api/v1/auth/sm2-public-key').then((r) => r.json())
  const d = desc.data
  const envelope = JSON.stringify({ username: login, password: pass, challenge: d.challenge, issuedAtMs: Date.now(), nonce: nonce() })
  const res = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: login, algorithm: d.algorithm, keyId: d.keyId, challenge: d.challenge, cipherMode: d.cipherMode, ciphertextEncoding: d.ciphertextEncoding, ciphertext: sm2.doEncrypt(envelope, d.publicKey, 1) })
  }).then((r) => r.json())
  if (!res.data?.token) throw new Error(user + ' 登录失败 code=' + res.code + ' msg=' + res.msg)
  const tk = res.data.token
  return async (method, path, body) => {
    const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: body ? JSON.stringify(body) : undefined })
    const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = { raw: t.slice(0, 80) } }
    return { http: r.status, ...j }
  }
}

const out = []
const check = (n, ok, d) => out.push((ok ? 'PASS ' : 'FAIL ') + n + '  ' + (d || ''))
const pad = (n) => String(n).padStart(2, '0')
const at = (min) => { const s = new Date(Date.now() + min * 60000); return `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())} ${pad(s.getHours())}:${pad(s.getMinutes())}:00` }

async function main() {
  const host = await session('zhangming')   // 主持人
  const member = await session('liwei')     // 成员（非主持人）
  const stamp = Date.now().toString().slice(-6)

  // ---- 第 6 项：主持人门禁 + 删除已下线；第 10 项：allowWaiting 落库回显
  const m1 = await host('POST', '/api/v1/meetings/schedule', { title: `门禁验证${stamp}`, startTime: at(120), durationMinutes: 30, cloudRecord: false, allowWaiting: true })
  const id1 = m1.data?.id
  check('预约（allowWaiting=true）成功', m1.code === 200 && !!id1, 'msg=' + m1.msg)
  const h1 = await host('GET', `/api/v1/meetings/${id1}`)
  check('主持人视角 isHost=true', h1.data?.isHost === true, 'isHost=' + h1.data?.isHost)
  check('allowWaiting 回显 true', h1.data?.allowWaiting === true, 'allowWaiting=' + h1.data?.allowWaiting)
  const g1 = await member('GET', `/api/v1/meetings/${id1}`)
  check('成员视角 isHost=false', g1.data?.isHost === false, 'isHost=' + g1.data?.isHost)

  const put1 = await member('PUT', `/api/v1/meetings/${id1}`, { title: `成员改${stamp}`, startTime: at(120), durationMinutes: 30 })
  check('非主持人修改被拒', put1.code !== 200 && String(put1.msg).includes('主持人'), 'code=' + put1.code + ' msg=' + put1.msg)
  const can1 = await member('POST', `/api/v1/meetings/${id1}/cancel`)
  check('非主持人取消被拒', can1.code !== 200 && String(can1.msg).includes('主持人'), 'code=' + can1.code + ' msg=' + can1.msg)
  const del = await member('DELETE', `/api/v1/meetings/${id1}`)
  check('DELETE /:id 已下线（404）', del.http === 404, 'http=' + del.http)
  const put2 = await host('PUT', `/api/v1/meetings/${id1}`, { title: `主持人改${stamp}`, startTime: at(121), durationMinutes: 30, allowWaiting: true })
  check('主持人修改通过', put2.code === 200, 'code=' + put2.code + ' msg=' + put2.msg)
  check('修改后 allowWaiting 仍为 true', put2.data?.allowWaiting === true, 'allowWaiting=' + put2.data?.allowWaiting)
  const stByMember = await member('POST', `/api/v1/meetings/${id1}/start`, {})
  check('非主持人提前开始被拒', stByMember.code !== 200 && String(stByMember.msg).includes('主持人'), 'code=' + stByMember.code + ' msg=' + stByMember.msg)

  // ---- 第 10 项：主持人不在场 → waiting=true，且不真的加入三方
  const j1 = await member('POST', '/api/v1/meetings/join', { meetingNo: h1.data.meetingNo, recordingConsent: true })
  check('开等候室的会：主持人不在场回 waiting=true', j1.code === 200 && j1.data?.waiting === true, 'code=' + j1.code + ' waiting=' + j1.data?.waiting + ' msg=' + j1.msg + ' no=' + h1.data.meetingNo)

  // ---- 第 5 项：加入过的会进列表（用一场我没主持、也没受邀、但我进去过的会验证）
  const q = await host('POST', '/api/v1/meetings/quick-start', { title: `参会历史${stamp}`, durationMinutes: 15, cloudRecord: false })
  const id2 = q.data?.id, no2 = q.data?.meetingNo
  check('主持人快速会议已建（running）', q.code === 200 && !!no2, 'code=' + q.code + ' msg=' + q.msg + ' status=' + q.data?.status)
  const jh = await host('POST', '/api/v1/meetings/join', { meetingNo: no2, recordingConsent: true })
  check('主持人入会成功', jh.code === 200 && !!jh.data?.participantId, 'code=' + jh.code + ' msg=' + jh.msg)
  const j2 = await member('POST', '/api/v1/meetings/join', { meetingNo: no2, recordingConsent: true })
  check('成员入会成功（未开等候室）', j2.code === 200 && j2.data?.waiting !== true, 'code=' + j2.code + ' waiting=' + j2.data?.waiting + ' msg=' + j2.msg)

  // 离会 + 离会后收尾请求（第 1 项）
  const lv = await member('POST', '/api/v1/meetings/leave', { meetingId: j2.data?.meetingId })
  check('成员离会成功', lv.code === 200, 'msg=' + lv.msg)
  const after = await member('POST', `/api/v1/meetings/${id2}/media-state`, { cameraOn: false })
  check('离会后收尾请求带 reason=not_in_meeting', after.code !== 200 && after.reason === 'not_in_meeting', 'code=' + after.code + ' reason=' + after.reason + ' msg=' + after.msg)

  const list = await member('GET', '/api/v1/meetings/list?pageSize=50&pageNum=1')
  const row = (list.rows || []).find((x) => x.meetingNo === no2)
  check('加入过的会在成员列表里（非主持非受邀）', !!row, '命中=' + !!row + ' 列表数=' + (list.rows || []).length + ' no2=' + no2)
  const hostRow = row && (list.rows || []).find((x) => x.meetingNo === no2)
  check('成员在这场会里 isHost=false', hostRow?.isHost === false, 'isHost=' + hostRow?.isHost)

  // 收尾：主持人结束这场快速会议，别把会挂在台上
  const en = await host('POST', `/api/v1/meetings/${id2}/end`, {})
  check('主持人结束会议', en.code === 200, 'code=' + en.code + ' msg=' + en.msg)
  const c1 = await host('POST', `/api/v1/meetings/${id1}/cancel`)
  check('主持人取消验证用的预约', c1.code === 200, 'code=' + c1.code + ' msg=' + c1.msg)
  const ids = { id1, id2, no2 }
  console.log(out.join('\n'))
  console.log('IDS ' + JSON.stringify(ids))
}
main().catch((e) => { console.log(out.join('\n')); console.log('FATAL ' + e.message) })
