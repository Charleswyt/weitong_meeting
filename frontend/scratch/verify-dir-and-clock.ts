// 第 14 项（目录层级形状）与第 15 项时钟格式：**真源直跑，零浏览器**。
// 之前这些用例是在受限实例里 import 仓内模块跑的，现在换成 Node 执行同一份源码。
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

const { recordingDirParts } = await import('@/utils/trackRecorder')
const { formatClock } = await import('@/utils/replayEngine')
const { businessDirStamp } = await import('@/utils/time')

const say = (o) => console.log(JSON.stringify(o))

const cases = [
  { label: '普通时刻', t: '2026-09-29T14:07:03+08:00', user: '李伟', no: '15296669' },
  { label: '午夜整点（不能出 24 时）', t: '2026-09-30T00:00:00+08:00', user: 'liwei', no: '1' },
  { label: '跨日进位（UTC 16:00 = 北京次日 00:00）', t: '2026-09-29T16:00:00Z', user: 'liwei', no: '2' },
  { label: 'Windows 非法字符', t: '2026-09-29T10:00:00+08:00', user: 'a/b:c*d?"e<f>g|h', no: 'm/1:2' },
  { label: '用户名空值兜底', t: '2026-09-29T10:00:00+08:00', user: '', no: '' },
  { label: 'CJK 用户名不丢字', t: '2026-09-29T23:59:59+08:00', user: '郑晓凯', no: '9' },
]
for (const c of cases) {
  const parts = recordingDirParts(new Date(c.t).getTime(), c.user, c.no)
  say({
    step: 'dir_parts',
    label: c.label,
    hxtFirst: parts[0] === 'hxt',
    stamp: parts[1],
    stampIs14Digits: /^\d{14}$/.test(parts[1]),
    userSeg: parts[2],
    meetingSeg: parts[3],
    depth: parts.length,
    joined: parts.join('/'),
  })
}

// 第 15 项时间轴读数：倍速/进度条显示的挂钟格式不能有 NaN
for (const sec of [0, 9.4, 65, 3599.6, 41.308, NaN, -1]) {
  say({ step: 'format_clock', sec: String(sec), out: formatClock(sec) })
}
say({ step: 'business_dir_stamp', sample: businessDirStamp(new Date('2026-09-29T14:07:03+08:00')) })
