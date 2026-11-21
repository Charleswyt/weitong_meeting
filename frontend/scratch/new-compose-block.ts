// —— 实时合成：陪时间轴在屏幕上完整放一遍（`composeGrid` 出帧 + Web Audio 混音）——
//
// 这是「离线合成之前」那套实时合成的口径，三条都经现场验证过，别再单方面改：
//   ① **时钟按住**：页面切走就 `pause()`、回来原位 `play()` 续上 —— 那几段既不进文件也不占时长，
//      产物仍是整场。判据同时看事件与 `document.hidden`（只认事件会在"一进来就在后台"时漏判）。
//   ② 陪放期间**钉死 1× 且不静音**：这是陪着时间轴放一遍，倍速只会把内容压成快放视频。
//   ③ **半截也照给，但绝不冒充完整**：文件名与提示里都写清"只到第几秒"。
// 在它之上只加两件 2026-09-30 实测得来的事：
//   · 声音：`ensureAudioBus()` 必须在**点击的同步段**唤醒（弹窗 `await` 之后手势就没了，
//     那样混出来的是一条静音轨 —— 旧合成件实测是数字静音）。`composeGrid` 用的就是这条共用总线。
//   · 容器：收尾把 MediaRecorder 的**分片 MP4** remux 成**渐进 MP4**（`utils/mp4/remuxFmp4.ts`）——
//     分片 MP4 的 `moov` 样本表是空的，不少播放器读不到时长/索引；这一步不改码流、只重排容器。
async function startCompose() {
  if (composing.value) return
  const eng = engine.value
  if (!eng) return
  if (!selectedVideoIds.value.size) {
    ElMessage.warning('至少选一条画面轨道')
    return
  }
  // 一进来就在后台的话，第一帧都画不出来，等于白等一场（陪放要占满整段时长）：先说清动作。
  if (document.hidden) {
    ElMessage.warning('这一页在后台，切回来再点一次即可开始合成')
    return
  }
  // 音频总线在点击的同步段创建并唤醒（三条硬约束见 `utils/audioBus.ts`）
  const bus = ensureAudioBus()
  if (!bus) ElMessage.warning('本浏览器不支持音频混流，这次合成只会有画面')

  try {
    await ElMessageBox.confirm(
      `合成要完整放一遍，约 ${fmtClock(Math.max(1, Math.round(eng.duration)))}；中途切走会自动暂停，回来接着放。`
      + '跑完即下载到浏览器下载目录；只要单路用旁边的「下载当前这一路」。',
      '开始合成？',
      { confirmButtonText: '开始', cancelButtonText: '先不等', type: 'warning' },
    )
  } catch {
    return
  }

  // 选中的路才进合成：画面看勾选，声音也看勾选（静音的那路 gain=0，仍然占位不出声）
  const panes: ComposePane[] = []
  for (const row of eng.rows) {
    if (!row.media) continue
    panes.push({
      id: row.recordingId,
      label: `${row.ownerName} · ${row.streamLabel}`,
      hasVideo: row.hasVideo && row.visible,
      hasAudio: row.hasAudio && selectedAudioIds.value.has(row.recordingId),
      muted: row.muted || eng.muted,
      media: row.media,
    })
  }
  if (!panes.some((p) => p.hasVideo)) {
    ElMessage.warning('这一组没有可合成的画面：先点播放让画面加载出来，或换布局后再试')
    return
  }

  let cancelled = false
  let holding = false
  let heldMs = 0
  let heldFrom = 0
  let heldCount = 0
  let stopped = false
  const isHeld = () => holding || document.hidden
  const setHeld = (held: boolean) => {
    if (held === holding) return
    holding = held
    if (held) {
      heldFrom = Date.now()
      heldCount++
      composeHeld.value = true
      eng.pause()
    } else {
      heldMs += Date.now() - heldFrom
      composeHeld.value = false
      // 到点了就别再 play()：引擎的 play() 会把播到头的时钟重新从 0 起
      if (eng.time < eng.duration - 0.05) eng.play()
    }
  }
  const onVisibility = () => {
    if (!stopped) setHeld(isHeld())
  }
  document.addEventListener('visibilitychange', onVisibility)
  composeCancel = () => {
    cancelled = true
  }

  composing.value = true
  composeRatio.value = 0
  composeLeftSec.value = eng.duration
  composeWriting.value = false

  let res: ComposeResult | null = null
  try {
    // 陪放期间钉死 1× 与不静音
    eng.setRate(1)
    eng.setMuted(false)
    // 合成期所有选中的路都要装载（离屏也要）——引擎的 shouldLoad 认这个开关
    eng.composeMode = true
    eng.seek(0)
    eng.play()
    res = await composeGrid({
      panes,
      cells: sLayout.value,
      getTime: () => eng.time,
      durationSec: eng.duration,
      onProgress: (ratio, t) => {
        composeRatio.value = ratio
        composeLeftSec.value = Math.max(0, eng.duration - t)
      },
      shouldCancel: () => cancelled,
      isHolding: isHeld,
    })
  } catch (e) {
    console.warn('[compose] 合成过程中出错', e)
  } finally {
    stopped = true
    document.removeEventListener('visibilitychange', onVisibility)
    composeHeld.value = false
    eng.composeMode = false
    eng.pause()
    composing.value = false
  }

  if (!res || !res.blob.size) {
    ElMessage.error('合成没产出文件：这些片段在本浏览器里播不出来')
    return
  }
  if (res.cancelled) {
    ElMessage.info('已取消合成，没有生成文件')
    return
  }

  // 收尾：分片 MP4 → 渐进 MP4；顺带把"到底有没有画面/声音"核一遍
  composeWriting.value = true
  let out = res.blob
  let samples: { video: number; audio: number } | null = null
  let remuxFailed = false
  if (res.ext === 'mp4') {
    const remuxed = await remuxFmp4ToProgressive(res.blob)
    if (remuxed) {
      out = remuxed.blob
      samples = { video: remuxed.videoSamples, audio: remuxed.audioSamples }
    } else {
      remuxFailed = true
      console.warn('[compose] remux 没成，交出的仍是分片 MP4（部分播放器会拖不动进度条）')
    }
  } else {
    out = await finalizeWebmDuration(res.blob, Math.round(eng.duration * 1000))
  }

  // 半截判据用**产物自己的时长**（时长由样本自己决定，骗不了进度文案）
  const madeSec = await probeBlobDurationSec(out)
  const timelineSec = Math.max(1, Math.round(eng.duration))
  const partial = !!res.stalled || (madeSec != null && madeSec < timelineSec - 2)
  if (partial) console.warn('[compose] 产物未覆盖整条时间轴', { madeSec, timelineSec, stalled: !!res.stalled })
  const report = (msg: string) => (partial ? ElMessage.warning(msg) : ElMessage.success(msg))
  const name = `合成-${sLayout.value}列-${businessDirStamp(Date.now())}${
    partial ? (madeSec != null ? `-只有前${madeSec}秒` : '-不完整') : ''
  }.${res.ext}`
  const partialNote = partial
    ? `。这条只到 ${madeSec != null ? fmtClock(madeSec) : '未知'}，整场是 ${fmtClock(eng.duration)}`
      + (res.stalled ? '（页面被系统挂起、画面输出停了）' : '')
      + '；文件按实际内容给出，名字里已标注。要完整一条请回本页再点一次'
    : ''
  downloadBlob(name, out)
  composeWriting.value = false
  report(`合成视频已下载到浏览器下载目录：${name}${partialNote}`)
  // 按住过就要说清楚：那几段既没进文件也没占时长，产物仍是整场
  if (heldCount && !partial) {
    ElMessage.info(`期间切走 ${heldCount} 次共约 ${Math.round(heldMs / 1000)} 秒；那几段没进文件，长度仍是整场。`)
  }
  if (res.droppedAudioPanes.length) {
    ElMessage.info(`其中 ${res.droppedAudioPanes.length} 路的声音没能并入合成：${res.droppedAudioPanes.join('、')}`)
  }
  if (samples && samples.audio === 0) {
    ElMessage.warning('这份合成件没有采到声音（画面已在）：先确认各路声音都在播放、没有被静音，再点一次')
  }
  if (remuxFailed) {
    ElMessage.warning('文件已生成，但它在部分播放器里可能拖不动进度条')
  }
}
