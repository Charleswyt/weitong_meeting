/**
 * 合成失败码 → 一句人话。唯一一处：进度浮标、回放页、列表页都从这里取词。
 *
 * 为什么单独一个文件：`ComposeOutcome.failureCode` 是机器码，错误原文（异常名、库名、码流术语）
 * 按本仓口径不许上桌；映射散在三处就会三份措辞，现场报"提示看不懂"时没人知道改哪个。
 * 每条只写**成因 + 一个可执行动作**，不叠第二子句。
 */
const TEXT: Record<string, string> = {
  no_video_encoder: '这台电脑当前不能后台合成，换个浏览器或再点一次',
  no_lane_selected: '没有可选中的画面或声音，先勾几条再试',
  all_lanes_anomalous: '这几路的录制内容结构对不上，先删掉这一场重新录',
  intake_failed: '有一段录制读不出画面，勾掉它或换一场再试',
  encode_failed: '这台电脑把这场的画面编不完，少勾几路或换小一点的格子',
  mux_failed: '合成写到一半停了，重开一次这场合成',
  out_of_budget: '这场太大，先少勾几路画面或分段合成',
  no_decodable_video_track: '这几路录制在本机解不出画面，换一台电脑或重新录制',
  layout_empty: '这一组排不出画面格，换布局或重选画面路',
  no_canvas_context: '这台浏览器画不出画面，换 Chrome 或 Edge 再试',
  finalize_failed: '合成收尾失败，重开一次这场合成',
  no_output_bytes: '这次没写出任何内容，重新合成一次',
  task_body_missing: '这个任务已经过期，重新点一次合成',
  no_realtime_runner: '这场需要先进这一场再点合成',
}

const GENERIC = '合成没跑完，重新点一次；反复失败就换一台电脑'

/**
 * 成功之后仍要如实补一句的那些事（机器码 → 一句话）。
 * 为什么单列一张表：这些不是失败，是"文件给了你，但有件事你得知道"——
 * 混进失败表就会得到一句"没跑完"的错误结论，用户以为白等了。
 */
const NOTICE: Record<string, string> = {
  remux_failed: '成品已生成，但它在部分播放器里可能拖不动进度条',
  no_audio_samples: '这份合成件没有采到声音：先确认各路声音都在播放、没有被静音，再点一次',
  realtime_grid_only: '这一场改用前台陪放，只按宫格排列（主画面那种排法后台合成才有）',
  layout_degraded: '为控制体积已降低单格尺寸',
  exceeds_encoder_limit: '这场画面太多，单格已降到最小仍偏大；只勾需要的画面路会清楚些',
}

export function composeFailureText(code: string): string {  if (!code) return GENERIC
  const hit = TEXT[code]
  if (hit) return hit
  // task_error:<异常名> 之类带后缀的机器码：只认前缀，异常名不上桌
  const prefix = code.split(':')[0] ?? code
  return TEXT[prefix] ?? GENERIC
}

/**
 * 引擎选择的如实说明。**只有退回前台陪放时才出声** —— 走后台合成是用户点按钮时期望的默认行为，
 * 每次都说一句反而成噪音；而"这场你得守着这一页"恰恰是他会按预期去做、结果落空的那件事。
 */
export function composeEngineNote(reasons: string[], engine: 'offline' | 'realtime'): string {
  if (engine !== 'realtime') return ''
  if (reasons.includes('no_offline_capability')) return '这台电脑当前不能后台合成，这场要留在这一页陪着放完'
  // 从前这里还有一条"超预算/未标定 ⇒ 改用陪放更快出件"的话，2026-10-09 默认引擎翻到离线后
  // 那条分支已经不会再走到 realtime，留着就是一句永远不会说、但会让人以为还在兜底的话。
  return '这场改用这一页陪着放'
}

/** 结果之外还要补的那一句（最多一条，多了就是噪音） */
export function composeNotice(reasons: string[]): string {
  for (const r of reasons) {
    const hit = NOTICE[r.split(':')[0] ?? r]
    if (hit) return hit
  }
  return ''
}
