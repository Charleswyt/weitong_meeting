// 场次聚合字段的 HTTP 级取证：证明"卡片那两个数"不再依赖翻页，且与回放页同一个跨度。
// 跑法：node scratch/probe-session-span.mjs  （后端 8082 在跑）
const BASE = process.env.BASE || 'http://localhost:8082'

const login = await fetch(`${BASE}/api/v1/auth/auto-login`, { method: 'POST' }).then((r) => r.json())
const token = login?.data?.token || login?.token
if (!token) { console.error('拿不到令牌：', JSON.stringify(login)?.slice(0, 120)); process.exit(1) }
const H = { Authorization: `Bearer ${token}` }

async function list(pageSize, pageNum) {
  const j = await fetch(`${BASE}/api/v1/recordings/list?pageSize=${pageSize}&pageNum=${pageNum}`, { headers: H }).then((r) => r.json())
  if (j.code !== 0 && j.code !== 200) throw new Error(`列表失败 code=${j.code} msg=${String(j.msg).slice(0, 40)}`)
  return j.data ?? j
}

const spanOf = (rows) => {
  let min = Infinity, max = -Infinity
  for (const r of rows) {
    const s = Date.parse(r.startedAt)
    if (!Number.isFinite(s)) continue
    min = Math.min(min, s)
    max = Math.max(max, s + Math.max(0, r.durationSec || 0) * 1000)
  }
  return min === Infinity ? 0 : Math.round((max - min) / 1000)
}

const full = await list(200, 1)
const rows = full.rows || []
console.log(`字段是否上桌：${Object.prototype.hasOwnProperty.call(rows[0] || {}, 'meetingSpanSec') ? 'Y' : 'N'}`)
console.log(`整目录：${rows.length} 行 / total ${full.total}`)

const byMeeting = new Map()
for (const r of rows) {
  if (!r.meetingId) continue
  const a = byMeeting.get(r.meetingId) || []
  a.push(r)
  byMeeting.set(r.meetingId, a)
}

let bad = 0
for (const [id, ms] of byMeeting) {
  const agg = new Set(ms.map((r) => `${r.meetingSpanSec}|${r.meetingStartedAt}`))
  if (agg.size !== 1) { console.log(`  ✗ ${id} 同一场每行带的聚合不一致：${[...agg].join(' , ')}`); bad++ }
  const s = Math.round(ms[0].meetingSpanSec)
  const local = spanOf(ms)
  if (Math.abs(s - local) > 1) { console.log(`  ✗ ${id} 聚合 ${s} 与全集重算 ${local} 不符`); bad++ }
}
console.log(bad ? `✗ 聚合一致性 ${bad} 处不符` : '✓ 同一场每一行同一个数，且等于全集重算值')

// 这一场会只给第一页（两行）时，聚合是否仍是全集那个数 —— 用户报的就是这个
const focus = process.argv[2] || [...byMeeting.keys()].find((id) => byMeeting.get(id).length >= 6)
const p1 = await list(2, 1)
const aggFromPage = (p1.rows || []).filter((r) => r.meetingId).map((r) => `${r.meetingId}=${Math.round(r.meetingSpanSec)}`)
console.log(`第 1 页（pageSize=2）每行的聚合值：${aggFromPage.join(' , ') || '(空)'}`)
const page1Rows = (p1.rows || []).filter((r) => r.meetingId === focus)
if (page1Rows.length) {
  console.log(`focus=${focus}：第 1 页里只有 ${page1Rows.length} 行，已加载行跨度 ${spanOf(page1Rows)} s，聚合仍给 ${Math.round(page1Rows[0].meetingSpanSec)} s`)
}

// 与回放页对表：回放页那个数是 max(offsetSeconds + durationSeconds)
const pb = await fetch(`${BASE}/api/v1/recordings/${focus}/playback`, { headers: H }).then((r) => r.json())
const d = pb.data ?? pb ?? {}
const streamEnd = Math.max(0, ...(d.streams || []).map((s) => (s.offsetSeconds || 0) + (s.durationSeconds || 0)))
const timeline = d.timeline?.durationSeconds ?? null
const meetingRows = byMeeting.get(focus) || []
const agg = meetingRows.length ? Math.round(meetingRows[0].meetingSpanSec) : NaN
console.log(`focus=${focus}：目录 ${meetingRows.length} 行 / 聚合 ${agg} s / 回放清单 ${new Set((d.streams || []).map((s) => s.recordingId)).size} 路 末端 ${streamEnd.toFixed(1)} s / timeline ${timeline === null ? '无' : Number(timeline).toFixed(1)} s`)
const drift = Math.abs(streamEnd - agg)
console.log(drift <= 0.5 ? `✓ 卡片跨度与回放页末端差 ${drift.toFixed(2)} s（漂移门 0.14 s 量级，容 0.5 s）` : `✗ 差 ${drift.toFixed(2)} s`)
