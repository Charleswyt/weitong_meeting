// 视频编码偏好的**唯一判据**：船端浏览器发布那一路要求 H.264，其余不动浏览器默认协商。
//
// 为什么单独一个文件：这条判据要能**在 Node 里直跑**（`scratch/verify-h264-preference.ts`），
// 而 `composables/useWhipPublish.ts` 一被 import 就会拖进 axios 与浏览器全局 —— 纯函数被那种依赖
// 绑住，就只能在真机上手点，判据也就退化成"我记得是这样"。这里不 import 任何东西。

/** 能力表里一条编解码器的最小形状（RTCRtpCodec 的子集，只为能单测）。 */
export interface CodecLike {
  mimeType: string
}

/**
 * 把 H.264 排到最前，其余保持浏览器给的相对顺序（一条 RTX 码点跟着自己的基础编码走）。
 *
 * 返回 `null` 有且只有一种含义：**这套能力表里没有 H.264**。调用方据此决定"这一路不发"。
 * 空表**不**归到这一类 —— "表是空的"是"不可判"，与"确知没有"处置相反，由调用方分开判。
 *
 * 语义出处：三方 `preferH264ForSender(pc, sender, sourceType === "rk_browser_roi")`，
 * 第三参为真时是 required —— 拿不到 H.264 直接不发布（`tp-meeting.js`，副本哈希
 * 9f519d23a7358482）。我方照这一条走，理由在契约 §6.3.1 第 7 条。
 */
export function h264First<T extends CodecLike>(codecs: readonly T[]): T[] | null {
  if (!codecs.length) return null
  const isH264 = (c: T) => c.mimeType.toLowerCase() === 'video/h264'
  if (!codecs.some(isH264)) return null
  // 稳定：sort 在 V8/Node 上是稳定排序，同 rank 的两条保持浏览器给的先后。
  return [...codecs].sort((a, b) => Number(isH264(b)) - Number(isH264(a)))
}
