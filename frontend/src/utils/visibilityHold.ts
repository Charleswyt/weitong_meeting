// 合成期间的"按住"状态机：切走 = 按住（暂停编码器与时钟）、回来 = 继续。
//
// 为什么单独抽出来：2026-09-30 出过一个真错 —— 把"此刻不可见"与"我正在按住"混成**一个谓词**，
// 还拿它当 `setHeld` 的入参：
//
//   const isHeld = () => holding || document.hidden
//   const onVisibility = () => setHeld(isHeld())     // ← 回来时 isHeld() 仍为真，setHeld 直接 return
//
// 切走把 `holding` 置真之后，回来时 `held === holding` 命中、直接返回，`holding` 永远解不开：
// 时钟与编码器都不恢复（现场表现就是"回来没有自动播放"）。
//
// 所以这里把两件事分开：**唯一的输入**是 `isHidden()` 的当前返回值，**状态**由本机维护。
// 不依赖 DOM 与 Vue，纯逻辑，可以在 node 里直接验（`scratch/verify-hold.ts`）。

export interface HoldHandlers {
  /** 页面此刻是否不可见（生产环境传 `() => document.hidden`） */
  isHidden: () => boolean
  /** 开始按住：暂停编码器与时钟 */
  onHold: () => void
  /** 解除按住：续上编码器与时钟 */
  onResume: () => void
  /** 取当前时刻（毫秒），只为统计按住时长；测试可注入假时钟 */
  now?: () => number
}

export interface HoldController {
  /** 重新读一次可见性并按需切换（`visibilitychange` 与开局各调一次） */
  sync: () => void
  /** 此刻该不该按住 —— 给 `composeGrid` 的 `isHolding` 用（"刚刚被切走"也要算按住） */
  isHeld: () => boolean
  /** 累计按住次数与毫秒数（收尾时如实告诉用户"那几段没进文件"） */
  stats: () => { count: number; ms: number }
}

export function createHoldController(handlers: HoldHandlers): HoldController {
  const now = handlers.now ?? (() => Date.now())
  let holding = false
  let since = 0
  let count = 0
  let ms = 0

  const sync = () => {
    const want = handlers.isHidden()
    if (want === holding) return
    holding = want
    if (want) {
      since = now()
      count++
      handlers.onHold()
    } else {
      ms += now() - since
      handlers.onResume()
    }
  }

  return {
    sync,
    isHeld: () => holding || handlers.isHidden(),
    stats: () => ({ count, ms }),
  }
}
