// "续看上次那条录制"的入口地址（左侧菜单「录制会议」用它）。
//
// 为什么**不能**只记 meetingId（2026-09-30 现场那个 bug）：
// 本机录制的回放地址是 `/recordings/play/local?local=<清单 id>` —— 路由参数 `meetingId` 恰好是
// 字符串 `local`，**真正的目标在那个查询串里**。只记 id、再拼回 `/recordings/play/${id}`，
// 点进去就成了"查会议 local 的云端归档"，后端只能如实回一句「没有找到这场会议的录制归档」。
// 所以这里记的是**整条路由地址（含查询串）**，读的时候还要校验它确实是一条回放地址
// （旧键值、脏数据一律当没有，落回列表页 —— 宁可少一个续看入口，也不要一个必然报错的入口）。

/** 只用到这三个方法，便于在 node 里注入假存储做回归（`scratch/verify-resume-path.ts`）。 */
export interface PlaybackPathStore {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

const KEY = 'recordingPlaybackPath'
const PREFIX = '/recordings/play/'

function defaultStore(): PlaybackPathStore | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null
  } catch {
    // 隐私模式/被策略禁用时访问会抛：续看入口失效，但不该影响回放本身
    return null
  }
}

export function rememberPlaybackPath(fullPath: string, store: PlaybackPathStore | null = defaultStore()): void {
  if (!store || !isPlaybackPath(fullPath)) return
  try {
    store.setItem(KEY, fullPath)
  } catch {
    /* 写不进去就算了：续看是便利功能，不是回放的前提 */
  }
}

export function forgetPlaybackPath(store: PlaybackPathStore | null = defaultStore()): void {
  try {
    store?.removeItem(KEY)
  } catch {
    /* 同上 */
  }
}

/** 上次那条回放的**完整地址**；不是回放地址（旧键值、脏数据）就返回空串，让菜单落回列表页。 */
export function playbackResumePath(store: PlaybackPathStore | null = defaultStore()): string {
  try {
    const v = store?.getItem(KEY) || ''
    return isPlaybackPath(v) ? v : ''
  } catch {
    return ''
  }
}

/** 判据只有一条：它必须是本应用的**回放**路由（查询串爱有没有，由它自己带）。 */
export function isPlaybackPath(v: string): boolean {
  return typeof v === 'string' && v.startsWith(PREFIX)
}
