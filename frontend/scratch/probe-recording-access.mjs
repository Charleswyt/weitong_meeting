// 录制代理端点的越权读与路径遍历取证（第 15/19 项依赖的通路）。
// 只看状态码与"清单里有没有漏令牌/漏三方主机名"，绝不打印 JWT。
import sm from 'sm-crypto'
import { readFileSync } from 'node:fs'

const { sm2 } = sm
const BASE = process.env.BASE || 'http://localhost:8082'
const creds = readFileSync(process.env.TEMP + '/creds.tsv', 'utf8').split('\n').map((l) => l.split('\t'))
const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (x) => x.toString(16).padStart(2, '0')).join('')
const say = (o) => console.log(JSON.stringify(o))

async function session(who) {
  const cred = creds.find((r) => r[0] === who)
  if (!cred) throw new Error('no creds row for ' + who)
  const desc = await fetch(BASE + '/api/v1/auth/sm2-public-key').then((r) => r.json())
  const d = desc.data
  const envelope = JSON.stringify({ username: cred[0], password: cred[1], challenge: d.challenge, issuedAtMs: Date.now(), nonce: nonce() })
  const res = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: cred[0], algorithm: d.algorithm, keyId: d.keyId, challenge: d.challenge, cipherMode: d.cipherMode, ciphertextEncoding: d.ciphertextEncoding, ciphertext: sm2.doEncrypt(envelope, d.publicKey, 1) })
  }).then((r) => r.json())
  if (!res.data?.token) throw new Error(who + ' 登录失败 msg=' + res.msg)
  return res.data.token
}

// 只取状态与头几百字符；二进制响应不读体
async function get(path, tk, opts = {}) {
  const r = await fetch(BASE + path, { headers: tk ? { Authorization: 'Bearer ' + tk } : {}, redirect: 'manual' })
  let text = ''
  if (!opts.binary) text = await r.text().catch(() => '')
  else r.body?.cancel?.()
  return { http: r.status, text }
}

const owner = await session('liwei')
const list = await get('/api/v1/recordings/list?pageSize=50', owner)
const j = JSON.parse(list.text)
const rows = j.rows || []
// 代理通路只对云端录制有意义（本地录制的真源在浏览器 IndexedDB，不在三方）
const first = rows.find((f) => f.recordingType === 'cloud') || rows[0]
const rid = String(first?.recordingId ?? '')
const mid = String(first?.meetingId ?? '')
say({ step: 'owner_list', http: list.http, code: j.code, total: j.total, rowCount: rows.length,
  picked: { recordingType: first?.recordingType, status: first?.status, ridLen: rid.length, midLen: mid.length } })

// 1) 属主自己的清单：必须 200，且改写后不含令牌、不泄漏三方主机
const own = await get(`/api/v1/recordings/${rid}/playlist.m3u8`, owner)
say({ step: 'owner_playlist', http: own.http, ct: 'm3u8',
  hasTokenParam: /token=/.test(own.text), hasTpHost: /47\.114\.83\.151/.test(own.text),
  looksLikeM3u8: own.text.startsWith('#EXTM3U'), rewrittenProxy: own.text.includes('/api/v1/recordings/'),
  bytes: own.text.length, head: own.text.slice(0, 120).replace(/\n/g, '|') })

// 他人读同一份清单/下载/回放元数据 —— 期望被拒（404 或 403），绝不能 200
// download 是二进制端点：先看 Content-Type 再决定读不读体，别把整段录像拉下来
const other = await session('chenfang')
for (const [label, path] of [['playlist', `/api/v1/recordings/${rid}/playlist.m3u8`],
                             ['download', `/api/v1/recordings/${rid}/download`],
                             ...(mid ? [['playback', `/api/v1/recordings/${mid}/playback`]] : [])]) {
  const r = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + other } })
  const ct = r.headers.get('content-type') || ''
  const cd = r.headers.get('content-disposition') || ''
  let msg = ''
  let bytesPeeked = 0
  if (ct.includes('json')) {
    const t = await r.text()
    bytesPeeked = t.length
    try { msg = (JSON.parse(t).msg ?? '') + ' / code=' + JSON.parse(t).code } catch { msg = t.slice(0, 60) }
  } else if (label === 'download') {
    // 是媒体流就只读第一个 chunk 再取消 —— 真拿到字节才叫越权成功
    const reader = r.body?.getReader?.()
    if (reader) {
      const { value, done } = await reader.read()
      bytesPeeked = done ? 0 : (value?.byteLength ?? 0)
      await reader.cancel().catch(() => {})
    }
    msg = '(媒体流，未解析)'
  } else {
    const t = await r.text()
    bytesPeeked = t.length
    msg = t.slice(0, 80)
  }
  say({ step: 'cross_user_' + label, http: r.status, contentType: ct.slice(0, 60),
    contentDisposition: cd.slice(0, 80), firstChunkBytes: bytesPeeked, msg })
}

// 3) 路径遍历：.. 段必须被 safeAssetRel 拒掉（400），不能拼到别的目录去
for (const bad of ['../../recordings/' + rid + '/playlist.m3u8', '..%2F..%2Fetc%2Fpasswd', 'http://127.0.0.1:8082/x', '/abs/playlist.m3u8']) {
  const r = await get(`/api/v1/recordings/${rid}/hls/` + bad, owner, { binary: true })
  say({ step: 'traversal', input: bad, http: r.http })
}

// 4) 不带 JWT 直接打代理端点：必须在中间件层就拦掉。
//    关键不只是"拦没拦"，还有"怎么拦" —— 媒体端点回 HTTP 200 + JSON 错误体的话，
//    hls.js 会把那段错误体当分片数据往下喂（openAsset 的注释里写了这条原则，这里是它的反面用例）。
const anon = await fetch(BASE + `/api/v1/recordings/${rid}/playlist.m3u8`)
const anonText = await anon.text()
say({ step: 'anonymous_playlist', http: anon.status, contentType: (anon.headers.get('content-type') || '').slice(0, 60),
  body: anonText.slice(0, 80) })

// 5) 属主自己的下载：拿到真媒体字节才说明这条通路是通的（只读第一个 chunk 就取消）
const ownDl = await fetch(BASE + `/api/v1/recordings/${rid}/download`, { headers: { Authorization: 'Bearer ' + owner } })
const dlCt = ownDl.headers.get('content-type') || ''
let dlPeek = 0
if (!dlCt.includes('json') && ownDl.body) {
  const reader = ownDl.body.getReader()
  const { value, done } = await reader.read()
  dlPeek = done ? 0 : (value?.byteLength ?? 0)
  await reader.cancel().catch(() => {})
} else {
  dlPeek = (await ownDl.text()).length
}
say({ step: 'owner_download', http: ownDl.status, contentType: dlCt.slice(0, 60),
  contentDisposition: (ownDl.headers.get('content-disposition') || '').slice(0, 90), firstChunkBytes: dlPeek })
