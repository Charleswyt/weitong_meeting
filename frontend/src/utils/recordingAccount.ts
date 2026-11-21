import { useUserStore } from '@/store/user'

/**
 * 录制归属的唯一账号取处。
 *
 * 原先 `trackRecorder.loginAccountForDir()` 与 `localRecorder.currentLoginAccount()` 是
 * 逐字符相同的两份实现（后者注释自承"为躲循环依赖复制一份"）—— 同一表达式两处实现必然漂移，
 * 而"归属"漂一次就把别人的录制算成自己的。放叶子模块（只依赖 user store）两边共 import。
 */
export function loginAccount(): string {
  try {
    return useUserStore().userInfo?.username?.trim() || ''
  } catch {
    // store 还没挂上（纯 Node 用例、极早期启动）：按"拿不到"处理，不猜一个
    return ''
  }
}

/**
 * 一条录制相对**当前登录者**的归属。三态各有不同下场，不许合并：
 * - `mine`：正常显示、可删、可合成。
 * - `others`：**完全隐形**，连条数都不报 —— 把"这里有 7 条别人的录制"显示出来本身就是泄漏。
 * - `unknown`：既没记账号、`dirPath` 里也取不出账号（本轮字段之前又从没落过盘的那批、
 *   崩溃重建时会话头也没带上账号的那批）。界面同样不报数（用户口径："别人的录制我看不到也不需要
 *   提示，因为本来就不应该看到"），只在控制台留一行 —— 对排查的人才是必要事实。
 *
 * 目录段（`hxt/{账号}/…`）是硬证据，所以"没记账号"不等于"判不出归属"：回填见
 * `localRecorder.planLocalRecordingSync`，它不依赖授权目录也不依赖用户手势。
 */
export type OwnerState = 'mine' | 'others' | 'unknown'

/**
 * 判定归属。**返回 null 表示"现在还不能判"**（我自己的身份还没就绪），
 * 这跟"不是我的"是两件事：把身份未就绪当成不匹配，会一次隐藏掉全部本机录制。
 * 调用方要先 `await useUserStore().ensureIdentity()`。
 */
export function ownerStateOf(recorderAccount: string | undefined | null): OwnerState | null {
  const current = loginAccount()
  if (!current) return null
  const stored = (recorderAccount || '').trim()
  if (!stored) return 'unknown'
  return stored === current ? 'mine' : 'others'
}
