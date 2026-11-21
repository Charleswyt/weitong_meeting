// 帧时刻表解析与"帧对帧"匹配的用例：Node 直跑 src 真源（带 .ts 后缀），不复制副本。
// 跑法：node scratch/verify-frame-times-match.ts
//
// 样本用 2026-10-13 从船端网关实取的那份响应（evidence/thirdparty-frame-times-lane1-20261013.json），
// 不自己编 —— 编出来的形状只会验证我的想象，验不到三方真正给的东西。

import { readFileSync } from 'node:fs'
import { parseFrameTimes, captureEpochMsFor, sourceClocksShared } from '../src/utils/frameTimes.ts'

let fail = 0
const check = (name: string, cond: boolean, extra = '') => {
  if (!cond) { fail++; console.log(`  FAIL ${name}${extra ? ' · ' + extra : ''}`) } else console.log(`  OK   ${name}`)
}

const raw = JSON.parse(readFileSync(new URL('../../evidence/thirdparty-frame-times-lane1-20261013.json', import.meta.url), 'utf8'))
const snap = parseFrameTimes(raw)

// 1) 真实响应能解析，且逐帧的采集时刻换算成毫秒后落在合理区间
check('真实响应解析成功', snap !== null)
check('帧条数与表一致', (snap?.entries.length ?? 0) === raw.frames.length, `${snap?.entries.length} vs ${raw.frames.length}`)
{
  const first = snap!.entries[0]
  // Unix 毫秒量级：1.7e12 ~ 2.1e12。纳秒直接当毫秒用会大六个数量级，一眼就该红。
  check('采集时刻换算成毫秒（不是纳秒）', first.captureEpochMs > 1.7e12 && first.captureEpochMs < 2.1e12,
    String(first.captureEpochMs))
  check('源钟标识已转成字符串', typeof snap!.sourceClockId === 'string' && snap!.sourceClockId.length > 0)
  check('现场这份的源钟未与服务器同步', snap!.sourceClockSynchronized === false)
}

// 2) 精确命中：拿表里某一条的 rtp 去查，必须回到它自己的采集时刻
{
  const e = snap!.entries[10]
  check('rtp 精确命中自己那一帧', captureEpochMsFor(snap, e.rtp, 90000) === e.captureEpochMs)
  check('差 1 个 tick 仍在容差内', captureEpochMsFor(snap, e.rtp + 1, 90000) === e.captureEpochMs)
}

// 3) 只认同一帧：那张表是稠密的（256 帧覆盖 10.28 秒、帧间隔约 40ms），
//    所以"最近邻 + 容差"挡不住命中邻近的别的帧 —— 偏移哪怕 2 个 tick 也必须回 0。
{
  const e = snap!.entries[10]
  const last = snap!.entries[snap!.entries.length - 1]
  check('偏移 2 个 tick 就不采信（不许命中邻近那帧）', captureEpochMsFor(snap, e.rtp + 2, 90000) === 0)
  {
    // 相邻两帧的**中点**不属于任何一帧 —— 用它测"不采信"才成立。
    // （先前我拿"偏移 20 个帧间隔"当测法，结果那个值正好落在表内某一帧上，命中它是对的。）
    const next = snap!.entries[11]
    const mid = Math.floor((e.rtp + next.rtp) / 2)
    check('相邻两帧的中点不属于任何一帧 → 回 0', captureEpochMsFor(snap, mid, 90000) === 0,
      `mid=${mid} a=${e.rtp} b=${next.rtp}`)
  }
  check('表覆盖范围外不采信', captureEpochMsFor(snap, last.rtp + 180000, 90000) === 0)
  check('rtp 缺失（NaN）不采信', captureEpochMsFor(snap, NaN, 90000) === 0)
  check('rtp 为负不采信', captureEpochMsFor(snap, -1, 90000) === 0)
  check('没有表就回 0', captureEpochMsFor(null, 123, 90000) === 0)
}

// 4) 32 位回绕：回绕点两侧相邻的两帧必须认得出"相邻"，而不是差着 2^32
{
  const wrap = parseFrameTimes({
    ok: true,
    sourceClockId: '1',
    frames: [
      { rtpTimestamp: 4294967295, sourceEncodeUnixNs: 1791859747932627500 }, // 2^32-1
      { rtpTimestamp: 1000, sourceEncodeUnixNs: 1791859748032627500 },
    ],
  })!
  // 查 0：与 2^32-1 的有符号差是 +1（回绕相邻），与 1000 的差是 -1000 → 必须命中第一条。
  check('回绕点相邻的两帧认得彼此', captureEpochMsFor(wrap, 0, 90000) === wrap.entries[0].captureEpochMs)
  check('回绕另一侧同样精确命中', captureEpochMsFor(wrap, 1000, 90000) === wrap.entries[1].captureEpochMs)
  check('回绕表里查不相干的 rtp 回 0', captureEpochMsFor(wrap, 500, 90000) === 0)
}

// 5) 坏形状一律 null：不认识的就当没取到，不许猜
for (const [label, bad] of [
  ['null', null], ['非对象', 'x'], ['ok=false', { ok: false, frames: [] }],
  ['没有 frames', { ok: true }], ['frames 空数组', { ok: true, frames: [] }],
  ['帧缺采集时刻', { ok: true, frames: [{ rtpTimestamp: 1 }] }],
  ['采集时刻为 0', { ok: true, frames: [{ rtpTimestamp: 1, sourceEncodeUnixNs: 0 }] }],
] as Array<[string, unknown]>) {
  check(`${label} → 解析为 null`, parseFrameTimes(bad) === null)
}

// 6) 时钟域：两个标识不同就别算"源音画差"
{
  const same = parseFrameTimes({ ok: true, sourceClockId: '7', audioSourceClockId: '7', frames: [{ rtpTimestamp: 1, sourceEncodeUnixNs: 1791859747932627500 }] })!
  const diff = parseFrameTimes({ ok: true, sourceClockId: '7', audioSourceClockId: '8', frames: [{ rtpTimestamp: 1, sourceEncodeUnixNs: 1791859747932627500 }] })!
  check('同标识判为同时钟域', sourceClocksShared(same) === true)
  check('不同标识判为不同时钟域（源音画差该留空）', sourceClocksShared(diff) === false)
  check('缺标识不谎称同域', sourceClocksShared(parseFrameTimes({ ok: true, frames: [{ rtpTimestamp: 1, sourceEncodeUnixNs: 1 }] })) === false)
  check('空表也判不同域', sourceClocksShared(null) === false)
}

// 7) 匹配只认"是不是同一帧"，与时基无关：clockRate 传什么都不该改变结论
{
  const e = snap!.entries[0]
  check('clockRate=0 也精确命中自己', captureEpochMsFor(snap, e.rtp, 0) === e.captureEpochMs)
  check('clockRate 换值结论一致', captureEpochMsFor(snap, e.rtp, 90000) === captureEpochMsFor(snap, e.rtp, 0))
  check('clockRate=0 时偏移 2 tick 仍不采信', captureEpochMsFor(snap, e.rtp + 2, 0) === 0)
}

console.log(fail === 0 ? '帧时刻匹配取证：全过' : `帧时刻匹配取证：${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
