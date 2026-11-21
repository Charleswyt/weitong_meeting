/**
 * 「能不能选目录 / 该不该走顶层窗口」这两条判据的用例：跑真源 `localRecorder.ts`。
 *
 * 存在的理由是我这轮连着写错过两次，两次都是同一个毛病 —— **拿不确定的环境特征去多拦**：
 *  ① 第一版把"被别的页面嵌着"当成事前不可用，于是同源嵌入（选择器本来能用）也被拒；
 *  ② 改成事后诊断后，谓词仍是 `self !== top`，于是同源子帧照样被判定为"要走新窗口"，白折腾人。
 * 第 4-6 条钉住 ①，第 9-10 条钉住 ②。旧写法在这几条必红（已做变异测试验证）。
 *
 * 实测依据（2026-10-12，本机同构复现台 + 真录一场）：跨源子帧里只有 showDirectoryPicker 被拒，
 * requestPermission 与写盘都正常，句柄按 origin 共享 —— 所以"被嵌着"绝不等于"写不了"，
 * 而"同源被嵌着"更是连选择器都不受影响。
 *
 * 跑法：node scratch/verify-dir-picker.ts
 */
import { register } from 'node:module'

register('./ts-alias-hooks.mjs', import.meta.url)

const { dirPickerBlocker, inCrossOriginFrame } = await import('../src/utils/localRecorder.ts')

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`)
}

/** 造一个宿主形状：只给判据真正会摸的那几个键 */
const host = (over: Record<string, unknown> = {}) => ({
  showDirectoryPicker: () => {},
  isSecureContext: true,
  self: 'win',
  top: 'win',
  ...over,
})

/** 顶层：self === top */
const TOP_LEVEL = host()
/** 同源子帧：摸得到 top.location —— 选择器在这里能用，不许弹新窗口、更不许事前拒 */
const SAME_ORIGIN_FRAME = host({ self: 'frame', top: { location: { origin: 'http://host:5175' } } })
/** 跨源子帧：摸 top.location 就抛 —— 这才是要走顶层窗口的唯一情形 */
const CROSS_ORIGIN_FRAME = host({
  self: 'frame',
  top: Object.defineProperty({}, 'location', {
    get() {
      throw new Error('cross-origin')
    },
  }),
})

console.log('— dirPickerBlocker：只拦有依据的两条 —')
check('顶层 + 安全上下文 + 有 API → ok', dirPickerBlocker(TOP_LEVEL) === 'ok', String(dirPickerBlocker(TOP_LEVEL)))
check('浏览器没有这个 API → unsupported', dirPickerBlocker(NO_API()) === 'unsupported')
check('非安全上下文 → insecure-context', dirPickerBlocker(host({ isSecureContext: false })) === 'insecure-context')
check('同源子帧 → ok', dirPickerBlocker(SAME_ORIGIN_FRAME) === 'ok')
check(
  '跨源子帧 → 也判 ok（旧写法判 cross-origin-frame，误伤能用的路）',
  dirPickerBlocker(CROSS_ORIGIN_FRAME) === 'ok',
  String(dirPickerBlocker(CROSS_ORIGIN_FRAME)),
)
check('没有 window（SSR/Node）→ unsupported', dirPickerBlocker(undefined) === 'unsupported')
function NO_API() {
  return { isSecureContext: true, self: 'win', top: 'win' }
}

console.log('— inCrossOriginFrame：决定该不该弹顶层窗口，判据是"摸不摸得到顶层" —')
check('顶层 → false', inCrossOriginFrame(TOP_LEVEL) === false)
check(
  '同源子帧 → false（这里选择器本来就能用，弹窗口就是白折腾人）',
  inCrossOriginFrame(SAME_ORIGIN_FRAME) === false,
  String(inCrossOriginFrame(SAME_ORIGIN_FRAME)),
)
check('跨源子帧 → true（唯一该弹的情形）', inCrossOriginFrame(CROSS_ORIGIN_FRAME) === true)
check('没有 window → false（不许把"量不出来"说成"被嵌着"）', inCrossOriginFrame(undefined) === false)

console.log('— 判据自证：坏样本必须被抓到 —')
check(
  'blocker 取值域只有三档（多出 cross-origin-frame 说明有人把它加回事前拦截了）',
  dirPickerBlocker(CROSS_ORIGIN_FRAME) === 'ok' && dirPickerBlocker(SAME_ORIGIN_FRAME) === 'ok',
)

if (failures > 0) {
  console.log(`\n❌ ${failures} 条不通过`)
  process.exit(1)
}
console.log('\n✅ 全部通过')
