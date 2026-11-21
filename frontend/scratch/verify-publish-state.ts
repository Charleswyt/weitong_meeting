// 本端推流徽标的判据层真源断言：node 直接跑（纯相对导入，不需别名）。
//
// 缺陷形状（2026-10-13 代码定性）：原先 `publishOk = publishState === 'connected'`，
// 于是「从没回调过一次」(`''`) 与「正在建立」(`new`/`connecting`) 都被判成异常，
// 而**同一状态下 tooltip 写的是「未推流」** —— 一块徽章和它自己的悬浮说明互相打脸。
import { classifyPublish, publishLabel } from '../src/utils/publishState.ts'

const ok = (name: string, got: string, want: string) => {
  console.log(`${got === want ? 'PASS' : 'FAIL'} ${name} -> ${got}（期望 ${want}）`)
  return got === want
}

const cases = [
  ok('从没报过状态 → 不算故障', classifyPublish(''), 'starting'),
  ok('发布待建立 → 不算故障', classifyPublish('new'), 'starting'),
  ok('连接中 → 不算故障', classifyPublish('connecting'), 'starting'),
  ok('推流中 → 正常', classifyPublish('connected'), 'ok'),
  ok('推流中断 → 故障', classifyPublish('disconnected'), 'fault'),
  ok('推流失败 → 故障', classifyPublish('failed'), 'fault'),
  ok('推流已关闭 → 故障', classifyPublish('closed'), 'fault'),
  // 上游/播放器哪天多吐一个没见过的词，宁可漏喊一次故障，不许误伤正常会话。
  ok('未知词 → 不喊故障（保守方向）', classifyPublish('renegotiating'), 'starting'),
]

// 不变量：徽标喊"异常" ⇔ 它的 title 说的也是故障词。这条才是那次缺陷的正身 ——
// 两处各写一套判据，改一处就分叉。
const FAULT_WORDS = /中断|失败|已关闭/
for (const s of ['', 'new', 'connecting', 'connected', 'disconnected', 'failed', 'closed', 'renegotiating']) {
  const contradicts = (classifyPublish(s) === 'fault') !== FAULT_WORDS.test(publishLabel(s))
  console.log(`${contradicts ? 'FAIL' : 'PASS'} 徽标与 title 不打脸：state=${JSON.stringify(s)} label=${publishLabel(s)}`)
  cases.push(!contradicts)
}

// title 不许把英文状态词端给用户（check:copy 的同一条纪律，这里钉判据层）。
for (const s of ['disconnected', 'failed', 'closed', 'renegotiating']) {
  const leak = /[a-zA-Z]/.test(publishLabel(s))
  console.log(`${leak ? 'FAIL' : 'PASS'} title 不泄漏英文状态词：${s} -> ${publishLabel(s)}`)
  cases.push(!leak)
}

console.log(`\n${cases.filter(Boolean).length}/${cases.length} 断言通过`)
process.exit(cases.every(Boolean) ? 0 : 1)
