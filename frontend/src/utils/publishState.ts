/**
 * 本端推流状态的分类：徽标和它的悬浮说明必须从这一处取数。
 *
 * 判据只吃播放器/WHIP 交出来的状态词，不吃中文文案。三组的边界是"这句话该不该吓人"：
 * - `ok` 在推；
 * - `starting` 还没开始或正在建立 —— **含从没回调过一次**（`''`）。把它算成故障，
 *   等于在正常入会的一两秒里先给用户挂一块"本端发布异常"，而同一状态下悬浮说明写的
 *   却是"未推流"，两块文字互相打脸；
 * - `fault` 曾经连上而现在不行了，或明确失败/关闭。
 *
 * 没见过的状态词一律落 `starting`（宁可漏喊一次故障，不许误伤正常会话）；
 * 真出问题时 `publishLabel` 仍会回"未推流"，不会假装一切正常。
 */
export type PublishClass = 'ok' | 'starting' | 'fault'

const LABELS: Record<string, string> = {
  '': '未推流',
  new: '发布待建立',
  connecting: '发布连接中',
  connected: '推流中',
  disconnected: '推流中断',
  failed: '推流失败',
  closed: '推流已关闭',
}

const FAULT = ['disconnected', 'failed', 'closed']

export function classifyPublish(state: string): PublishClass {
  if (state === 'connected') return 'ok'
  if (FAULT.includes(state)) return 'fault'
  return 'starting'
}

export function publishLabel(state: string): string {
  return LABELS[state] ?? '未推流'
}
