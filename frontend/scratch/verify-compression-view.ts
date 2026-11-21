// 第 8 项「原始速率 / 压缩比 / 节省带宽」三项派生数值的边界形状取证。
// 不进浏览器、不复制代码 —— Node 24 直接执行仓内 .ts 真源，跑的就是 MainLayout / InMeetingView import 的那一个文件。
//
// 2026-10-10 重写：原用例的主体 `rawKbpsFromSpec`（分辨率×帧率×YUV420 当原始速率）已在第 26 项
// 被判为量纲错误并删除（未压缩基线不是编码码率，"节省带宽 99.x%" 就是这么来的）。
// 同时原用例只 say 不 assert，坏值也照样"跑过"。这一版改成真断言并钉住现行口径。
//
// 2026-10-13 再锚：把"这一路没有这组量"与"数还没到"拆开了 —— 旧版一律写 `—`，用户分不清
// 是坏了还是本来就没有。所以下面"缺数"那几条的期望值从 `—` 改成 `统计中`，并新增 applicable
// 与上报倍率退路两组。改的是行为，测试跟着重锚，不是挂豁免。
//
// 2026-11-05 再锚：口径从 5 个位置参数改成 `CompressionInput` 对象，多一个必填的 `basis`
// （分母量在哪条腿）。**算术一个字节没动**，所以下面七组断言的期望值全部原样保留，只换调用形状；
// 分腿的新规矩在 §8 单独钉。
import * as mod from '../src/utils/compression.ts'
import { pickTransmittedKbps, type RateBasis } from '../src/utils/compression.ts'

let fail = 0
const check = (name: string, cond: boolean, extra = '') => {
  if (!cond) { fail++; console.log(`  FAIL ${name}${extra ? ' · ' + extra : ''}`) } else console.log(`  OK   ${name}`)
}
const flat = (v: { rawText: string; ratioText: string; savedText: string }) => v.rawText + v.ratioText + v.savedText

// 位置参数 → 对象签名。basis 默认 'egress'：与这些断言在改动前所处的口径一致（跨腿），
// 让"只换了调用形状"这件事在下面一眼可见。同侧那条腿的差异见 §8。
const cv = (src: number, tr: number, kind = 'unknown', ratio = 0, est = false, basis: RateBasis = 'egress') =>
  mod.compressionView({
    sourceKbps: src, transmittedKbps: tr, basis,
    compressionKind: kind, reportedRatio: ratio, reportedEstimate: est,
  })

// 1) 现行口径的钉子：原始速率来自上报的**编码码率**，不许再有"按分辨率算基线"的第二真源
check('原始速率只能由调用方传入', !('rawKbpsFromSpec' in mod) && !('rawKbpsFromResolution' in mod),
  `导出=${Object.keys(mod).join(',')}`)

// 2) 数没到 → 写"统计中"（不是 —），且绝不出现 NaN·Infinity
for (const [label, src, tr] of [
  ['缺原始码率', 0, 521], ['缺实传速率', 2400, 0], ['两个都缺', 0, 0],
  ['原始是 NaN', NaN, 521], ['实传是 NaN', 2400, NaN], ['负数码率', -1, 521],
] as Array<[string, number, number]>) {
  const v = cv(src, tr)
  check(`${label} → 不报倍率、不出现 NaN·Infinity`,
    !/NaN|Infinity/.test(flat(v)) && v.compressed === false && v.ratioText === '直传',
    JSON.stringify(v))
}
check('缺原始码率时写"统计中"而不是 —（— 留给"本端拿不到"）',
  cv(0, 521, 'edgeRoi').rawText === '统计中',
  JSON.stringify(cv(0, 521, 'edgeRoi')))

// 3) compressionKind 说了算：判了"没有额外压缩"的那一路即使数值上有差异也不报倍率
const none = cv(2400, 521, 'none')
check("kind='none' 时即使原始远高于实传也说直传", none.ratioText === '直传' && none.compressed === false)
check("kind='none' 标为不适用（界面该合成一句，不是摆三格）",
  none.applicable === false && none.summaryText === '直传（没有额外压缩）', JSON.stringify(none))
check("kind='none' 时三格不出现「统计中」（它不是缺数，是没有这组量）",
  !flat(none).includes('统计中'), JSON.stringify(none))
const roi = cv(2400, 521, 'edgeRoi')
check("kind 明确判了有压缩时报倍率", roi.ratioText !== '直传' && roi.compressed === true, roi.ratioText)

// 4) kind 未知时保守：原始不高于实传就当直传，倒挂不许显示负 Mbps
const below = cv(521, 2400, 'unknown')
check('kind 未知且原始低于实传 → 直传', below.ratioText === '直传' && below.compressed === false)
const flip = cv(1000, 2000, 'edgeRoi')
check('倒挂时不报负值、倍率与节省都写统计中',
  !flat(flip).includes('-') && flip.savedText === '统计中' && flip.ratioText === '统计中', JSON.stringify(flip))

// 5) 三方上报倍率的退路：本端两个数凑不出倍率时才用，且"估算"要标出来
const viaReport = cv(0, 521, 'edgeRoi', 2.31)
check('本端缺原始码率时退回三方上报的倍率', viaReport.ratioText === '压缩 2.31:1' && viaReport.compressed === true, JSON.stringify(viaReport))
check('上报值标了估算就带"估算"前缀',
  cv(0, 521, 'edgeRoi', 2.31, true).ratioText === '估算 2.31:1')
check('上报倍率不得越过 kind 的判定（none 仍是直传）',
  cv(0, 521, 'none', 2.31).ratioText === '直传')
check('本端两个数够用时无视上报值（本端实测优先）',
  cv(2400, 521, 'edgeRoi', 9.99).ratioText === '压缩 4.61:1')
check('上报值为 0（三方没给）不冒充数据',
  cv(0, 521, 'edgeRoi', 0).ratioText === '统计中')

// 6) 正常形状：09-29 真机读数的形状（1080p 上报 2400 kbps、本端实传 521 kbps）
const ok = cv(2400, 521, 'edgeRoi')
check('三项都成形：原始 Mbps、倍率 x:1、节省百分比',
  ok.rawText === '2.40 Mbps' && ok.ratioText === '压缩 4.61:1' && ok.savedText === '节省 78.29%' && ok.applicable === true,
  JSON.stringify(ok))

// 7) 2026-11-04 重锚三方口径后新增的钉子。每条都先对改前的实现跑过、确认是红的：
//    - 节省带宽改成**百分比**（三方看板 `compressionFieldsFrom` 的 `clamp((1-processed/reference)*100,0,100)`、
//      `formatCompressionEffect` 的 `toFixed(2)` 与「估算节省/节省」前缀）；改前我方给的是 Mbps 差值。
//    - 退回上报倍率时百分比按 `1-1/ratio` 反推（纯代数，不引入新信息）；改前那一格写"统计中"。
//    - 速率一律 SI（三方 `formatKbpsAsMbps` `/1000`、`formatTrafficMegabytes` `/1000000`、
//      `formatTransportRate` `/1000`）并按量级切换单位（`formatTransportRate`：`>=1000 出 Mbps，否则 kbps`）；
//      改前一律 `/1024` 出 Mbps，74 kbps 显示成 0.07 Mbps。
//    - 倍率前缀「估算/压缩」适用于**任何来源**（三方 `compressionText`）；改前只在退回上报值那条分支加。
//    引用三方一律用符号名不用行号：那两份副本由门禁 G11 按哈希锁着，三方改版行号就全漂。
check('节省带宽是百分比而不是 Mbps 差值',
  cv(2400, 521, 'edgeRoi').savedText === '节省 78.29%',
  cv(2400, 521, 'edgeRoi').savedText)
check('三方标了估算时前缀是「估算节省」（与倍率那套「估算/压缩」不是同一对词）',
  cv(2400, 521, 'edgeRoi', 0, true).savedText === '估算节省 78.29%',
  cv(2400, 521, 'edgeRoi', 0, true).savedText)
check('只有上报倍率时按 1-1/ratio 反推百分比，不再写"统计中"',
  cv(0, 521, 'edgeRoi', 2.31).savedText === '节省 56.71%',
  cv(0, 521, 'edgeRoi', 2.31).savedText)
check('反推出的百分比同样照估算位加前缀',
  cv(0, 521, 'edgeRoi', 2.31, true).savedText === '估算节省 56.71%',
  cv(0, 521, 'edgeRoi', 2.31, true).savedText)
check('倒挂时不给百分比（0.00% 是假数，三方 formatCompressionEffect 对 ratio<=1 直接不出）',
  cv(1000, 2000, 'edgeRoi').savedText === '统计中',
  JSON.stringify(cv(1000, 2000, 'edgeRoi')))
check('kbps→Mbps 用 SI 除数 1000（改前 /1024 会把 1000 kbps 说成 0.98 Mbps）',
  cv(1000, 500, 'edgeRoi').rawText === '1.00 Mbps',
  cv(1000, 500, 'edgeRoi').rawText)
check('低于 1000 kbps 按量级切回 kbps（实测有 74 kbps 的轨，改前显示 0.07 Mbps）',
  cv(74, 50, 'edgeRoi').rawText === '74.00 kbps',
  cv(74, 50, 'edgeRoi').rawText)
check('自算出来的倍率也带前缀（三方 compressionText 的前缀适用于任何来源）',
  cv(2400, 521, 'edgeRoi').ratioText === '压缩 4.61:1',
  cv(2400, 521, 'edgeRoi').ratioText)
check('上报倍率 ≤1 时不给数（看板 formatCompressionEffect 对 ratio<=1 直接不出；改前会显示 0.50:1）',
  cv(0, 521, 'edgeRoi', 0.5).ratioText === '统计中'
  && cv(0, 521, 'edgeRoi', 0.5).savedText === '统计中',
  JSON.stringify(cv(0, 521, 'edgeRoi', 0.5)))
check('上报倍率恰为 1（没省）时也不给数',
  cv(0, 521, 'edgeRoi', 1).ratioText === '统计中',
  JSON.stringify(cv(0, 521, 'edgeRoi', 1)))

// 8) 2026-11-05 分母来源（同侧 / 跨腿）。三方自己就分两套：本端那一路（ownRows）用
//    `upstreamVideoBitrateKbps`、与分子在同一条腿；远端那一路（remoteRows）传裸的本机接收速率。
//    我方此前本端那一路也拿本机接收速率当分母 —— 那是另一条腿的数，等于两个不同测量点相除。
// 8.1 分母的唯一取处（A5）
const selfZero = pickTransmittedKbps({ isSelfPublished: true, ingressBitrateKbps: 0, localReceivedKbps: 521 })
check('本端发布那一路：出站实测为 0 时绝不回落成本机接收速率',
  selfZero.transmittedKbps === 0 && selfZero.basis === 'ingress', JSON.stringify(selfZero))
const selfOk = pickTransmittedKbps({ isSelfPublished: true, ingressBitrateKbps: 612, localReceivedKbps: 521 })
check('本端发布那一路取同侧分母，本机接收速率不参与',
  selfOk.transmittedKbps === 612 && selfOk.basis === 'ingress', JSON.stringify(selfOk))
const remoteOk = pickTransmittedKbps({ isSelfPublished: false, ingressBitrateKbps: 612, localReceivedKbps: 521 })
check('远端那一路取本机接收速率（跨腿），ingress 不参与',
  remoteOk.transmittedKbps === 521 && remoteOk.basis === 'egress', JSON.stringify(remoteOk))
const selfNeg = pickTransmittedKbps({ isSelfPublished: true, ingressBitrateKbps: -3, localReceivedKbps: 521 })
check('负数收敛到 0，不把负值送进除法',
  selfNeg.transmittedKbps === 0 && selfNeg.basis === 'ingress', JSON.stringify(selfNeg))

// 8.2 kind 优先于 basis（A3）：直传那一路没有"两个数"可谈论，换哪种分母都不出倍率
const noneIngress = cv(2400, 521, 'none', 0, false, 'ingress')
check("kind='none' 优先于 basis：同侧分母也不让直传那一路出倍率",
  noneIngress.ratioText === '直传' && noneIngress.applicable === false, JSON.stringify(noneIngress))
check('直传那一路不带分母说明（没有两个数可谈论）', noneIngress.basisText === '')

// 8.3 分母来源决定**报不报**倍率（2026-11-05 按实测重锚）
//
// 原断言是"同一对数字两种 basis 下倍率与百分比完全相同（分母来源不进算术）"。那条在
// "两种分母都是可信量"的前提下成立；2026-11-05 的云边对拍证明**不成立**：
// 同侧分母是平台的瞬时出站量，30 s 内中位 1.39、最小 0.74（倒挂）、最大 1.84，1 s 粒度下
// 同一秒能得出 0% 与 43% 两个"节省"（evidence/2026-11-05-同侧分母配对-云边对拍.md）。
// 所以判据改成：**跨腿那一路照常算；同侧那一路不给倍率、不给百分比**。
// 这不是"放宽断言"，是把一条被实测推翻的口径换掉 —— 期望值变了，行为也变了。
const egressView = cv(2400, 521, 'edgeRoi', 0, false, 'egress')
const ingressView = cv(2400, 521, 'edgeRoi', 0, false, 'ingress')
check('跨腿那一路照常给倍率与百分比（egress 一支不许被本轮改动波及）',
  egressView.ratioText === '压缩 4.61:1' && egressView.savedText === '节省 78.29%'
  && egressView.compressed === true, JSON.stringify(egressView))
check('同侧那一路不给倍率也不给节省百分比（两个瞬时量相除不是压缩收益）',
  ingressView.ratioText === '—' && ingressView.savedText === '—'
  && ingressView.compressed === false && ingressView.applicable === true,
  JSON.stringify(ingressView))
check('同侧那一路仍然给出原始速率（量是真的，只是不拿它做除法）',
  ingressView.rawText === egressView.rawText, JSON.stringify([ingressView.rawText, egressView.rawText]))
check('两种 basis 的说明文字不同且都非空（只影响 tooltip）',
  egressView.basisText !== ingressView.basisText
  && egressView.basisText.length > 0 && ingressView.basisText.length > 0,
  JSON.stringify([egressView.basisText, ingressView.basisText]))
check('同侧说明文字点明"不是压缩收益"（文案与结论一致，不只是不给数）',
  ingressView.basisText.includes('不是压缩收益'), ingressView.basisText)

// 8.3b 倒挂也不许变成 0%：这是"同侧不给数"最直接的动机
const inverted = cv(200, 280, 'cloudSoftwareRoi', 0, false, 'ingress')
check('同侧分母大于分子（倒挂）时同样不给数，绝不写"节省 0%"',
  inverted.ratioText === '—' && inverted.savedText === '—', JSON.stringify(inverted))

// 8.3c 三方上报的 compressionRatio 在同侧也不采用：实测它就是同一对瞬时量的商
//      （读 A 204/221=0.92 对上上报 0.92；读 B 215/94=2.29 对上上报 2.28），用它等于换个来源再报一次抖动。
const ingressReported = cv(215, 94, 'cloudSoftwareRoi', 2.28, false, 'ingress')
check('同侧那一路连三方上报的倍率也不用（同一个抖动的另一个写法）',
  ingressReported.ratioText === '—' && ingressReported.savedText === '—',
  JSON.stringify(ingressReported))

// 8.4 本端出站码率还没到时：这一格仍写 `—`，**不许**回落成本机接收速率，也**不许**写成"统计中"
//     ——「统计中」承诺的是"再等等就有"，而本端这一格按口径永远不会有数（承诺一个不会到的数，
//     比空着更坏）。"不许回落"那一半由 8.1 的 pickTransmittedKbps 用例钉着。
const selfWaiting = cv(1072, 0, 'cloudSoftwareRoi', 0, false, 'ingress')
check('本端出站码率还没到时：倍率与节省都写 —（不是"统计中"，也不是回落的接收速率）',
  selfWaiting.ratioText === '—' && selfWaiting.savedText === '—'
  && selfWaiting.compressed === false, JSON.stringify(selfWaiting))

const publicStream = { sourceKbps: 0, transmittedKbps: 0, basis: 'ingress' as const, compressionKind: 'cloudSoftwareRoi',
  videoStats: { decodedFrameKbps: 100000, publishKbps: 600, cloudOutputKbps: 100 } }
const solo = mod.compressionView(publicStream)
check('解码后原始速率单独计量', solo.rawText === '100.00 Mbps')
check('单人压缩按发布上行与云端输出计量', solo.ratioText === '6.00×')
check('观看端按本路视频实收计量', mod.compressionView({...publicStream, basis: 'egress', receivedVideoKbps: 75}).ratioText === '8.00×')
check('观看端缺样时沿用云端输出', mod.compressionView({...publicStream, basis: 'egress', receivedVideoKbps: null}).ratioText === solo.ratioText)
check('原始转发显示直传', mod.compressionView({...publicStream, compressionKind: 'none'}).ratioText === '直传')
check('缺发布上行时不以原始像素速率替代', mod.compressionView({...publicStream,
  videoStats: {...publicStream.videoStats, publishKbps: null}}).ratioText === '—')

console.log(fail === 0 ? `compressionView 取证：全过` : `compressionView 取证：${fail} FAIL`)
process.exit(fail === 0 ? 0 : 1)
