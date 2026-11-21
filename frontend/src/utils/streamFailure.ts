/**
 * 会中页「这一路订不上」的分类：只读机器输入（信封 `reason`、HTTP 状态、本轮 state 的事实），
 * 不比对后端中文文案 —— 那是契约 §1 明令禁止的（`reason` 一度被填成 msg，前端只能猜文案）。
 *
 * 音频腿走自己的 fetch，`reason`/`status` 都拿得到；视频腿走托管播放器，两者都不回吐，
 * 于是改读已经轮询到的事实：这条流还在不在本轮名单、有没有可订地址、会还在不在 running。
 */
export type StreamFailure = 'terminal' | 'warming' | 'retry'

export interface StreamFailureInput {
  reason?: string
  status?: number
  /** 最近一轮 state 里还有没有这一路 */
  inLatestState: boolean
  /** 会议本身是否已进终态（ended / cancelled / failed） */
  meetingOver: boolean
  /** 这一路是否已经拿到可订地址（对端刚发布、上游还没给地址时为空） */
  playable: boolean
}

const TERMINAL_REASONS = ['not_in_meeting', 'not_found', 'gone']
// 401 不在这里：实测（2026-10-13 本地双实例）音频腿的 401 全部发生在**发布号刚翻新**的窗口里，
// 票据是当场新签、绑定正确、有效期还剩 12 小时 —— 它是"这张票此刻不被认"，不是"这路已经没了"。
// 判成终态等于一次瞬时竞争就把这条腿永久放弃、还不回落，表现是声音间歇性掉而界面一句不说。
const TERMINAL_STATUS = [404, 410]

export function classifyStreamFailure(i: StreamFailureInput): StreamFailure {
  if (i.meetingOver || !i.inLatestState) return 'terminal'
  if (i.reason && TERMINAL_REASONS.includes(i.reason)) return 'terminal'
  if (i.status && TERMINAL_STATUS.includes(i.status)) return 'terminal'
  if (i.reason === 'warming' || i.status === 503) return 'warming'
  if (!i.playable) return 'warming'
  return 'retry'
}
