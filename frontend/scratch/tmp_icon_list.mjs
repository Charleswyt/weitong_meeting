import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
const files = []
;(function walk(d){for(const f of readdirSync(d)){const p=join(d,f);const s=statSync(p)
 if(s.isDirectory()){if(f!=='node_modules')walk(p)}else if(/\.(vue|ts|js|css|html)$/.test(f))files.push(p)}})('src')
const set = new Set()
for (const f of files) for (const m of readFileSync(f,'utf8').matchAll(/ri-([a-z0-9-]+)/g)) set.add(m[1])
console.log(JSON.stringify([...set].sort()))
