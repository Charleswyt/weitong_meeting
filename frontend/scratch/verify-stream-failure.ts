// 第 7 项判据层的真源断言：分类只吃机器输入。node 直接跑（要带 .ts 后缀，纯相对导入不需别名）。
import { classifyStreamFailure as C } from '../src/utils/streamFailure.ts'

type I = Parameters<typeof C>[0]
const ok = (name: string, input: I, want: string) => {
  const got = C(input)
  console.log(`${got === want ? 'PASS' : 'FAIL'} ${name} -> ${got}（期望 ${want}）`)
  return got === want
}

const base: I = { inLatestState: true, meetingOver: false, playable: true }
const cases = [
  ok('会已终态 → 不再重订', { ...base, meetingOver: true, reason: 'warming' }, 'terminal'),
  ok('这条流已不在本轮名单 → 终态', { ...base, inLatestState: false }, 'terminal'),
  ok('reason=not_found → 终态', { ...base, reason: 'not_found' }, 'terminal'),
  ok('reason=gone → 终态', { ...base, reason: 'gone' }, 'terminal'),
  ok('reason=not_in_meeting → 终态（正常收尾，不弹错）', { ...base, reason: 'not_in_meeting' }, 'terminal'),
  ok('404 → 终态', { ...base, status: 404 }, 'terminal'),
  ok('410 → 终态', { ...base, status: 410 }, 'terminal'),
  // 这条断言原先写的是「401 → 终态」，2026-10-13 按实测翻案：音频腿的 401 全发生在发布号刚翻新的
  // 窗口，票据当场新签、绑定正确、有效期还剩 12 小时 —— 判终态等于一次瞬时竞争就把这条腿永久放弃
  // 且不回落直连，表现是声音间歇性掉而界面一句不说。旧断言不是测错，是把"没见过成功"当成了"不会成功"。
  ok('401 → 冷却后重试（票此刻不被认，不是这路没了）', { ...base, status: 401 }, 'retry'),
  ok('401 且已拿到可订地址 → 仍不判终态', { ...base, status: 401, playable: true }, 'retry'),
  ok('reason=warming → 短间隔重试', { ...base, reason: 'warming' }, 'warming'),
  ok('503 → 短间隔重试', { ...base, status: 503 }, 'warming'),
  ok('还没拿到可订地址 → 短间隔重试', { ...base, playable: false }, 'warming'),
  ok('上游接不通 → 冷却后重试', { ...base, reason: 'upstream_unreachable' }, 'retry'),
  ok('这路没有该通道(501) → 交回调用方换通路，这里是 retry', { ...base, reason: 'no_channel' }, 'retry'),
  ok('未知错 → retry', { ...base, reason: 'whatever', playable: true }, 'retry'),
  ok('终态优先于"还没地址"', { ...base, inLatestState: false, playable: false }, 'terminal'),
]
// 上一条写的是"playable:false + 明确终态 reason"应判终态；这里补一条真·接不通的可播流
cases.push(ok('有可订地址但 502 → retry', { ...base, status: 502 }, 'retry'))

console.log(`\n${cases.filter(Boolean).length}/${cases.length} 断言通过`)
process.exit(cases.every(Boolean) ? 0 : 1)
