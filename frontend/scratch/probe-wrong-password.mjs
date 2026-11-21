// 定性探针：**错的本地口令**能不能换来令牌。只打印 code/msg/是否拿到令牌，不打印任何口令与令牌。
// 起因：在真实 Edge 里用错口令点登录后页面跳进了工作台，必须先排除"后端接受错口令"这种安全事故。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const { sm2 } = createRequire(import.meta.url)('sm-crypto')
const BASE = process.env.BASE || 'http://localhost:5175'
const USER = process.env.PROBE_USER || 'admin'

async function api(path, opts = {}, token) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
  const res = await fetch(BASE + path, { ...opts, headers })
  const txt = await res.text()
  try { return JSON.parse(txt) } catch { return { raw: txt.slice(0, 120) } }
}

// 真口令只用来确认"账号本身是能登进去的"，不作为对照组的输入。
const realRow = readFileSync(process.env.CREDS_FILE, 'utf8').split(/\r?\n/).map(l => l.split('\t'))
  .find(r => r[0] === USER)

async function tryLogin(password, label) {
  const d = await api('/api/v1/auth/sm2-public-key')
  const env = JSON.stringify({
    username: USER, password,
    challenge: d.data.challenge, issuedAtMs: Date.now(), nonce: randomBytes(18).toString('hex'),
  })
  const r = await api('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      username: USER, algorithm: 'SM2', keyId: d.data.keyId, challenge: d.data.challenge,
      cipherMode: 'C1C3C2', ciphertextEncoding: 'c1c3c2-hex',
      ciphertext: sm2.doEncrypt(env, d.data.publicKey, 1),
    }),
  })
  console.log(`${label}: code=${r.code} msg=${r.msg} 拿到令牌=${!!r.data?.token}`)
  return r
}

// 空串走的是"表单没同步上"这条真实怀疑路径；乱码走的是"用户输错"这条。
await tryLogin('', '空口令')
await tryLogin('wrong-password-hxt-0929', '错口令')
await tryLogin('admin123-but-wrong-length-check', '另一组错口令')
console.log('（对照组：账号存在=', !!realRow, '，不打印其口令）')
