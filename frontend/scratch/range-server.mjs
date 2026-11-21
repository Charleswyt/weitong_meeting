/**
 * 给离线合成探针用的 Range 静态服务。
 *
 * 为什么要有它：探针必须跑在**真实产物**上，而本地录制的字节在两个地方 ——
 * IndexedDB（按 origin 隔离，worktree 的 dev server 起在别的端口就读不到）与
 * 授权目录 `Videos/hxt/`（每路一个已拼好的 .webm，字节与 IndexedDB 里那些片拼起来同源）。
 * 为了不去动用户正在用的 :5175 检出，这里把授权目录只读地挂成 HTTP，
 * 并**如实支持 Range** —— 探针要验的正是"mediabunny 是不是按字节范围懒读，而不是整份拉进内存"。
 *
 * 只读、只绑 127.0.0.1、不列目录、路径必须落在 ROOT 内（防穿越）。
 * 跑法：node scratch/range-server.mjs [端口]
 */
import { createServer } from 'node:http'
import { statSync, existsSync, readFileSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { resolve, sep, normalize } from 'node:path'
import { homedir } from 'node:os'

const PORT = Number(process.argv[2] || 5200)
const ROOT = resolve(process.env.HXT_ROOT || resolve(homedir(), 'Videos', 'hxt'))
// 探针要挑件，但不许它列目录：目标清单由 list-intake-targets.mjs 生成后走这一条固定路由给。
const TARGETS_FILE = process.env.TARGETS_FILE || null

function readTargets() {
  if (!TARGETS_FILE || !existsSync(TARGETS_FILE)) return null
  return readFileSync(TARGETS_FILE)
}

function safePath(urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\/+/, ''))
  const abs = normalize(resolve(ROOT, rel))
  // 前缀必须带分隔符，否则 /Videos/hxt-evil 会当成 /Videos/hxt 里面
  if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null
  return abs
}

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, X-Total-Bytes')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end('only GET'); return }

  const urlPath = new URL(req.url, 'http://127.0.0.1').pathname
  if (urlPath === '/__targets__.json') {
    const buf = readTargets()
    if (!buf) { res.writeHead(404); res.end('targets not built'); return }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(buf.length) })
    res.end(req.method === 'HEAD' ? undefined : buf)
    return
  }

  const abs = safePath(urlPath)
  if (!abs || !existsSync(abs)) { res.writeHead(404); res.end('no such file'); return }
  let st
  try { st = statSync(abs) } catch { res.writeHead(404); res.end('no such file'); return }
  if (!st.isFile()) { res.writeHead(403); res.end('files only'); return }

  const total = st.size
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1
    if (Number.isNaN(start) || start > end || end >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` }); res.end(); return
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Content-Type': 'video/webm',
      'X-Total-Bytes': String(total),
    })
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(abs, { start, end }).pipe(res)
    return
  }

  res.writeHead(200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': String(total),
    'Content-Type': 'video/webm',
    'X-Total-Bytes': String(total),
  })
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(abs).pipe(res)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[range] http://127.0.0.1:${PORT}/  root=${ROOT}`)
})
