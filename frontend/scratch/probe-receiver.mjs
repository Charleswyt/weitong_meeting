// 探针结果接收器：探针页 POST 上来，落成文件。
// 起因：这台机器上 user-browser-use 的 evaluate_script 恒定返回 {}（扩展侧故障），
// take_snapshot 又读不到 <pre> 的文本，所以自开一条文本出口。
// /result 收 JSON（文本），/file/<名字> 收二进制（用来把探针产出的文件 dump 到盘上直接验）。
import { createServer } from 'node:http'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUTDIR = join(HERE, 'out')
mkdirSync(OUTDIR, { recursive: true })

function collect(req) {
  return new Promise((resolve) => {
    const bufs = []
    req.on('data', (c) => bufs.push(c))
    req.on('end', () => resolve(Buffer.concat(bufs)))
  })
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  if (req.method === 'POST' && req.url.startsWith('/result')) {
    // 按探针分文件：曾经用同一个 /result，结果被"vite HMR 重载后重跑的陈旧页面"抢写覆盖过。
    const label = req.url.slice('/result'.length).replace(/[^\w.\-]/g, '_').replace(/^_/, '') || 'default'
    const body = (await collect(req)).toString('utf8')
    writeFileSync(join(OUTDIR, label + '.json'), body, 'utf8')
    console.log(`[receiver] result ${label} ${body.length} bytes`)
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return
  }

  if (req.method === 'POST' && req.url.startsWith('/file/')) {
    const name = decodeURIComponent(req.url.slice('/file/'.length)).replace(/[^\w.\-]/g, '_')
    const buf = await collect(req)
    writeFileSync(join(OUTDIR, name), buf)
    console.log(`[receiver] file ${name} ${buf.length} bytes`)
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return
  }

  // 取回 dump 出来的文件（给探针页复用，省得每次重造源）
  if (req.method === 'GET' && req.url.startsWith('/file/')) {
    const name = decodeURIComponent(req.url.slice('/file/'.length)).replace(/[^\w.\-]/g, '_')
    try {
      const b = readFileSync(join(OUTDIR, name))
      res.writeHead(200, { 'content-type': name.endsWith('.webm') ? 'video/webm' : 'application/octet-stream' })
      res.end(b)
    } catch { res.writeHead(404); res.end('no such file') }
    return
  }

  // 播放验证页：把结论写进 document.title（唯一稳定读得到的通道 ——
  // evaluate_script 恒回 {}，take_snapshot 读不到 <pre> 文本）。
  // 页面由本服务自己发、视频也是同源 HTTP，绕开 blob URL 与跨源。
  if (req.method === 'GET' && req.url.startsWith('/p/')) {
    const name = decodeURIComponent(req.url.slice('/p/'.length)).replace(/[^\w.\-]/g, '_')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><meta charset="utf-8"><title>PLAY loading</title>
<body style="background:#111;color:#ddd;font:14px ui-monospace,monospace;padding:12px">
<video id="v" playsinline preload="auto" style="max-width:92vw;max-height:70vh"></video>
<pre id="o"></pre>
<script>
const v = document.getElementById('v'), o = document.getElementById('o');
const name = ${JSON.stringify(name)};
let done = false;
const fin = (s) => { if (done) return; done = true; document.title = 'PLAY ' + s;
  o.textContent += '\\n' + s;
  fetch('/result/play', {method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify({file:name,result:s})}).catch(()=>{}); };
v.onloadedmetadata = async () => { o.textContent = 'metadata ok';
  try { v.muted = true; await v.play(); o.textContent += ' playing'; } catch (e) { o.textContent += ' playErr=' + e.name; } };
v.onerror = () => fin('ERROR code=' + (v.error && v.error.code) + ' msg=' + (v.error && v.error.message));
v.src = '/file/' + name;
// 后台标签页的定时器会被压到 ~1 次/秒，阈值放宽
const t0 = Date.now();
const tick = () => {
  if (done) return;
  const dt = Date.now() - t0;
  if (dt > 20000) return fin('TIMEOUT rs=' + v.readyState);
  if (v.readyState >= 1 && dt > 6000) {
    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    return fin('OK dur=' + (isFinite(v.duration) ? v.duration.toFixed(2) : v.duration)
      + ' ' + v.videoWidth + 'x' + v.videoHeight + ' t=' + v.currentTime.toFixed(2)
      + ' frames=' + (q ? q.totalVideoFrames : '?') + ' rs=' + v.readyState + ' paused=' + v.paused);
  }
  setTimeout(tick, 400);
};
tick();
</script>`)
    return
  }

  res.writeHead(404); res.end()
})

server.listen(5199, '127.0.0.1', () => console.log('[receiver] listening on http://127.0.0.1:5199'))
