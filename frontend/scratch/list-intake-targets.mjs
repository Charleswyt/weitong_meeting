/**
 * 生成离线合成探针的目标清单（从授权目录的 manifest 里挑真件，不猜）。
 *
 * 挑法要覆盖的是**成本模型的两个自变量**：源像素与源帧率。盘上这份 `manifest.json` 是
 * **交给桌面端**的形状（顶层 `streams[]`，片里是 `durationSeconds`/`bytes`），它**不含**宽高与帧率 ——
 * 那两个数只在 IndexedDB 的 `RecordedTrack`（D9，来自 `track.getSettings()`）里。
 * 所以这里刻意留 null，由探针直接读容器元数据补上：容器比清单的二手数更硬。
 *
 * 片时长**两种口径都留着**（末片 offset+片长 vs Σ 片长），因为探针要量的正是
 * "墙钟与容器时钟差多少" —— 只留一个就没法比了（正本 §7 第六轮欠的就是这个）。
 *
 * 跑法：node scratch/list-intake-targets.mjs > scratch/probe-targets.json
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { homedir } from 'node:os'

const ROOT = resolve(process.env.HXT_ROOT || join(homedir(), 'Videos', 'hxt'))
const MIN_SEC = Number(process.env.MIN_SEC || 60)

function walk(dir, depth, out) {
  if (depth > 5) return
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, depth + 1, out)
    else if (e.name === 'manifest.json') out.push(p)
  }
}

const manifests = []
if (existsSync(ROOT)) walk(ROOT, 0, manifests)

const rows = []
for (const m of manifests) {
  let j
  try { j = JSON.parse(readFileSync(m, 'utf8')) } catch { continue }
  const dirRel = relative(ROOT, join(m, '..')).split(sep).join('/')
  const streams = Array.isArray(j.streams) ? j.streams : []
  for (const t of streams) {
    const segs = Array.isArray(t.segments) ? t.segments : []
    if (!t.fileName || !segs.length) continue
    const bytes = segs.reduce((s, x) => s + (x.bytes || 0), 0)
    const last = segs[segs.length - 1]
    const wallEndSec = (last.offsetSeconds || 0) + (last.durationSeconds || 0)
    const segSecSum = segs.reduce((s, x) => s + (x.durationSeconds || 0), 0)
    if (wallEndSec < MIN_SEC) continue
    rows.push({
      group: dirRel,
      file: `${dirRel}/${t.fileName}`,
      kind: t.kind,
      hasVideo: !!t.hasVideo,
      hasAudio: !!t.hasAudio,
      mime: t.mime ?? null,
      width: null,
      height: null,
      frameRate: null,
      durationSec: Math.round(wallEndSec * 10) / 10,
      segmentSecSum: Math.round(segSecSum * 10) / 10,
      bytes,
      segmentCount: segs.length,
      kbps: wallEndSec > 0 ? Math.round((bytes * 8) / wallEndSec / 1000) : null,
    })
  }
}

// 分组键 = 通路类型 + 容器 + 时长档（分钟）；每组留最长的一条
const byShape = new Map()
for (const r of rows) {
  const key = `${r.kind}|${r.mime}|${Math.floor(r.durationSec / 60)}min`
  const best = byShape.get(key)
  if (!best || r.durationSec > best.durationSec) byShape.set(key, r)
}

const groupCount = new Map()
for (const r of rows) groupCount.set(r.group, (groupCount.get(r.group) || 0) + 1)
const multiLaneGroups = [...groupCount.entries()]
  .filter(([, n]) => n >= 3)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 3)
  .map(([g]) => g)

const picked = [...byShape.values()].sort((a, b) => b.durationSec - a.durationSec)
const out = {
  root: ROOT,
  generatedAt: new Date().toISOString(),
  scannedManifests: manifests.length,
  lanesTotal: rows.length,
  shapes: [...byShape.keys()],
  singles: picked.slice(0, 10),
  groups: multiLaneGroups.map((g) => {
    const ls = rows.filter((r) => r.group === g)
    return { group: g, lanes: ls.length, totalBytes: ls.reduce((s, r) => s + r.bytes, 0), files: ls.map((r) => r.file) }
  }),
  heaviest: rows.reduce((a, b) => (b.bytes > (a?.bytes ?? 0) ? b : a), null),
}
console.log(JSON.stringify(out, null, 2))
process.stderr.write(
  `清单 ${manifests.length} 份 / 路 ${rows.length} 条 / 形状 ${byShape.size} 种 / 多路组 ${out.groups.length} 个\n`,
)
