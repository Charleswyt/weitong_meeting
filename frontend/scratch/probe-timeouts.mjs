// 计时 + 字段泄漏探针：验证第 35 项（请求路径超时上限）与第 10 项（前端不见三方细节）。
// 口令只从 CREDS_FILE 读，绝不打印。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const require = createRequire(import.meta.url)
const { sm2 } = require('sm-crypto')

const BASE = process.env.BASE || 'http://localhost:5176'
const USER = process.env.WHO || 'liwei'

function passwordOf(username) {
  const file = process.env.CREDS_FILE
  if (!file) throw new Error('CREDS_FILE not set')
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const hit = lines.find((l) => l.split('\t')[0] === username || l.split(',')[0] === username)
  if (!hit) throw new Error(`no creds row for ${username}`)
  const cols = hit.split(/[\t,]/).map((c) => c.trim())
  if (cols.length < 2) throw new Error(`creds row has ${cols.length} columns, expected >=2`)
  return cols[1]
}

async function timed(method, path, token, body) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body) headers['Content-Type'] = 'application/json'
  const t0 = Date.now()
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const ms = Date.now() - t0
  const txt = await res.text()
  let json = null
  try { json = JSON.parse(txt) } catch { /* non-json */ }
  return {
    path,
    http: res.status,
    ms,
    code: json?.code,
    msg: json?.msg,
    // 第 10 项：响应体里不该再出现三方账号字段
    leaksThirdParty: /thirdPartyAccount|"account"\s*:/.test(txt),
    rows: Array.isArray(json?.rows) ? json.rows.length : Array.isArray(json?.data?.rows) ? json.data.rows.length : undefined,
    total: json?.total ?? json?.data?.total,
    firstTitle: Array.isArray(json?.rows) ? (json.rows[0]?.title ?? json.rows[0]?.meetingTitle ?? json.rows[0]?.displayName ?? json.rows[0]?.recordingId ?? json.rows[0]?.id) : undefined,
    dataKeys: json?.data && !Array.isArray(json.data) ? Object.keys(json.data).join(',') : undefined,
  }
}

async function main() {
  const desc = (await (await fetch(`${BASE}/api/v1/auth/sm2-public-key`)).json()).data
  const envelope = JSON.stringify({
    username: USER,
    password: passwordOf(USER),
    challenge: desc.challenge,
    issuedAtMs: Date.now(),
    nonce: randomBytes(18).toString('hex'),
  })
  const loginRes = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: USER,
      algorithm: desc.algorithm,
      keyId: desc.keyId,
      challenge: desc.challenge,
      cipherMode: desc.cipherMode,
      ciphertextEncoding: desc.ciphertextEncoding,
      ciphertext: sm2.doEncrypt(envelope, desc.publicKey, 1),
    }),
  })
  const loginTxt = await loginRes.text()
  const login = JSON.parse(loginTxt)
  const token = login?.data?.token
  console.log(JSON.stringify({
    step: 'login',
    http: loginRes.status,
    code: login.code,
    msg: login.msg,
    dataKeys: token ? Object.keys(login.data).join(',') : undefined,
    leaksThirdParty: /thirdParty/i.test(loginTxt),
  }))
  if (!token) return
  // UI 实测要用浏览器会话：把 token 交给同源文件，避免口令/令牌出现在终端输出里。
  if (process.env.TOKEN_OUT) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(process.env.TOKEN_OUT, JSON.stringify({ token }))
    console.log('TOKEN_WRITTEN')
  }
  console.log(JSON.stringify(await timed('GET', '/api/v1/auth/me', token)))
  console.log(JSON.stringify(await timed('GET', '/api/v1/users?keyword=', token)))
  console.log(JSON.stringify(await timed('POST', '/api/v1/meetings/schedule', token, { days: 7 })))
  console.log(JSON.stringify(await timed('GET', '/api/v1/meetings/list?pageNum=1&pageSize=5', token)))
  for (const t of ['all', 'cloud', 'local']) {
    const qs = t === 'all' ? 'pageNum=1&pageSize=20' : `pageNum=1&pageSize=20&type=${t}`
    console.log(JSON.stringify(await timed('GET', `/api/v1/recordings/list?${qs}`, token)))
  }
  console.log(JSON.stringify(await timed('GET', '/api/v1/recordings/list?pageNum=1&pageSize=20&keyword=媒体', token)))
}

main().catch((e) => { console.error('FAILED', e.message); process.exit(1) })
