// 把 rec-shape.json（多段 JSON 拼接）解析后压成对照表：每条样本的字段值，找本地/云端的真判别位。
import { readFileSync } from 'node:fs'
const txt = readFileSync(new URL('./rec-shape.json', import.meta.url), 'utf8')
const objs = []
let depth = 0, start = -1
for (let i = 0; i < txt.length; i++) {
  const ch = txt[i]
  if (ch === '{') { if (depth === 0) start = i; depth++ }
  else if (ch === '}') { depth--; if (depth === 0) objs.push(JSON.parse(txt.slice(start, i + 1))) }
}
for (const o of objs) {
  console.log('=== deviceId=' + o.deviceId + ' rows=' + o.rows + ' combos=' + o.combos.join(' , '))
  for (const s of o.samples) {
    const flat = {}
    for (const [k, v] of Object.entries(s)) {
      flat[k] = Array.isArray(v) ? (v.length ? JSON.stringify(v).slice(0, 90) : '[]')
        : (v && typeof v === 'object' ? JSON.stringify(v).slice(0, 90) : String(v ?? '').slice(0, 60))
    }
    console.log('  [' + (s.mode || '-') + ' | ' + (s.status || '-') + ']')
    for (const [k, v] of Object.entries(flat)) console.log('    ' + k + ' = ' + v)
  }
}
