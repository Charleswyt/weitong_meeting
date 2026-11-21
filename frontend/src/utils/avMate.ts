// 「同一个人那一路**纯音频**发布」的查找判据 —— 音画差只有找到它才能算。
//
// 为什么单独抽出来：这行查找原先写在会中页里，且搜的是 `remoteStreams`，而那份列表的定义是
// `streams.filter(s => s.video && s.ownerId !== myId)` —— **只装视频瓦片**。纯音频发布不是瓦片，
// 永远不在里面，于是 `focusAudioMate` 恒为空，音画差恒显示"没有独立音频路"。
// 这不是取舍问题，是搜错了集合：2026-11-05 同会实测，会里明明有 `kind=audio / audio=true / active=true`
// 的那一路，界面却说没有。
//
// 判据照三方那条（participantId 相同、有音、无画、活跃），不拿 mediaKind 猜：
// 画面自带音轨的那种发布没有任何音频标记，此时就是"算不出"，该照实说而不是编一个数。

import type { StreamVo } from '@/api/meeting'

/** 在**全部**流里找同一发布者的纯音频路；找不到返回空串。 */
export function findAudioMateId(streams: readonly StreamVo[], ownerId: string, excludeId: string): string {
  if (!ownerId) return ''
  const mate = streams.find(
    (s) => s.ownerId === ownerId && s.id !== excludeId && s.audio && !s.video && s.active,
  )
  return mate?.id ?? ''
}
