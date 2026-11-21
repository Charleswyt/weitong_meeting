import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
const css = readFileSync('node_modules/remixicon/fonts/remixicon.css', 'utf8')
const have = new Set([...css.matchAll(/\.ri-([a-z0-9-]+):before/g)].map(m => m[1]))
const files = []
;(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p)
  if (s.isDirectory()) { if (f !== 'node_modules') walk(p) } else if (/\.(vue|ts|js|css|html)$/.test(f)) files.push(p) } })('src')
const used = new Map()
for (const f of files) { const t = readFileSync(f, 'utf8')
  for (const m of t.matchAll(/ri-([a-z0-9-]+)/g)) if (!used.has(m[1])) used.set(m[1], f) }
const bad = [...used].filter(([n]) => !have.has(n))
console.log('total used:', used.size, '| missing:', bad.length)
for (const [n, f] of bad) console.log('MISSING ri-' + n, '->', f)
