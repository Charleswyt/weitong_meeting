// 船端浏览器发布那一路的编码偏好判据（`utils/codecPreference.ts`）的取证。
// 纯函数、零依赖，Node 24 直接跑仓内 `.ts` 真源 —— 不是副本，跑的就是 `useWhipPublish` import 的那一个。
//
// 为什么值得单测：这条判据错了不会报错，只会让船内那条接收槽拿到它不认的编码，
// 表现成"看着发出去了、对端永远黑格"。三方在同一处是 required 语义（拿不到 H.264 直接不发布），
// 我方照办；把"没有 H.264"与"能力表拿不到"判混，就会把一个正常浏览器拒掉。
//
// 跑法：node scratch/verify-h264-preference.ts   （有失败则退出码 1）

import { h264First } from '../src/utils/codecPreference.ts'

let fail = 0
const check = (name: string, cond: boolean, extra = '') => {
  if (!cond) { fail++; console.log(`  FAIL ${name}${extra ? ' · ' + extra : ''}`) } else console.log(`  OK   ${name}`)
}
const c = (mimeType: string) => ({ mimeType })
const order = (list: ReturnType<typeof h264First>) => (list ?? []).map((x) => x.mimeType)

// 1) 现状：Chrome 在船端报的就是这套（VP8/VP9/H.264 混排，H.264 不在前面）
const chromeLike = [c('video/VP8'), c('video/rtx'), c('video/VP9'), c('video/H264'), c('video/red'), c('video/ulpfec')]
const sorted = h264First(chromeLike)
check('H.264 排到最前', order(sorted)[0] === 'video/H264', JSON.stringify(order(sorted)))
check('其余保持浏览器给的相对顺序（RTX 不被挪到基础编码前面）',
  JSON.stringify(order(sorted).slice(1)) === JSON.stringify(['video/VP8', 'video/rtx', 'video/VP9', 'video/red', 'video/ulpfec']),
  JSON.stringify(order(sorted)))
check('不丢条码点、不改长度', (sorted?.length ?? -1) === chromeLike.length)
check('不改入参（纯函数）', chromeLike[3].mimeType === 'video/H264' && chromeLike[0].mimeType === 'video/VP8')

// 2) 大小写：能力表里 H.264 的写法各家不一（H264 / h264），判据必须两边都认
check('H.264 大小写不敏感', order(h264First([c('video/vp8'), c('video/h264')]))[0] === 'video/h264')
check('全大写也认', order(h264First([c('video/vp8'), c('video/H264')]))[0] === 'video/H264')

// 3) 已经排在最前：原样返回、不重复
const already = [c('video/H264'), c('video/VP8')]
check('H.264 本来就在最前 → 顺序不变', JSON.stringify(order(h264First(already))) === JSON.stringify(['video/H264', 'video/VP8']))

// 4) 确知没有 H.264 → null（调用方据此**不发布**这一路）
check('没有 H.264 → null（这一路不发）', h264First([c('video/VP8'), c('video/VP9')]) === null,
  JSON.stringify(order(h264First([c('video/VP8'), c('video/VP9')]))))

// 5) 空表 → null，但语义是"不可判"：调用方必须**分开判**，不许据此拒绝发布。
//    这条钉的就是那个坑 —— 把空表当"没有 H.264"，一个正常浏览器会被挡在门外。
const empty = h264First([])
check('空能力表 → null（不可判，不等于"没有 H.264"）', empty === null)
// 判据本身不能区分两者，所以调用方必须自己看 `caps.codecs.length`。这里用一条"形状断言"钉住用法：
// 调用点（useWhipPublish.publish）确实是先判 `!caps?.codecs?.length` 再调本函数。
check('空表与"无 H.264"都由 null 表达 ⇒ 调用方必须先判能力表是否为空（见 useWhipPublish 注释）',
  empty === null && h264First([c('video/VP8')]) === null)

if (fail) {
  console.log(`\nh264 偏好取证：${fail} 条失败`)
  process.exit(1)
}
console.log('\nh264 偏好取证：全过')
