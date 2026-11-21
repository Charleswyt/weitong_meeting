import { sitePath } from '@/utils/sitePath'
import { createPublication, stopPublication, type PublicationCreateBody } from '@/api/meeting'
import { h264First } from '@/utils/codecPreference'
import { videoSampler, type BrowserVideoSample } from '@/utils/videoObservations'
import { normalizeVideoSpec, publicVideoSpec } from '@/utils/videoSpec'
import { ApiError } from '@/utils/request'

/**
 * 这条发布链路上"已经写成用户能照着做的一句话"的错。
 * 与 ApiError（后端信封 msg）一起构成唯一允许进弹窗的两类错误 ——
 * 其余（浏览器抛的 DOMException、网关原文）一律只进控制台。
 */
class PublishError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublishError'
  }
}

/**
 * 给页面用的取词器：能展示的照展示（后端 msg 不由我方改写），不能展示的一律换成可行动的一句。
 * 返回 null 表示"这条根本不该弹"—— reason=not_in_meeting 是本端已经不在这场会里的正常收尾信号
 * （刚离会/被顶号/会散了），按第 1 项口径不该换来一句报错。
 */
export function describePublishError(e: unknown, fallback: string): string | null {
  if (e instanceof ApiError && e.reason === 'not_in_meeting') {
    console.warn('[whip] 本端已不在会中，发布失败按正常收尾处理:', e.message)
    return null
  }
  if (e instanceof ApiError || e instanceof PublishError) return e.message
  console.warn('[whip] 未识别的发布错误', (e as Error)?.name, (e as Error)?.message, e)
  return fallback
}

// 三方要求 offer 里带齐 candidate（无 trickle），所以等 ICE 收集完成再 POST；
// 但收集可能因纯 host 候选而迟迟不 complete，给一个上限避免卡住入会。
const ICE_GATHER_LIMIT_MS = 2000

function waitForIceComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', onChange)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', onChange)
    setTimeout(resolve, ICE_GATHER_LIMIT_MS)
  })
}

/**
 * 把偏好设到承载视频的 transceiver 上（三方的写法是对 sender 设，效果相同：偏好表就挂在
 * transceiver），必须在 `createOffer()` 之前。音频 transceiver 设视频编解码表会抛，所以只挑视频那条。
 *
 * **只对船端浏览器那一路调**：browser_whip 保持浏览器默认协商，云端的编码选择不该被这条顺带改掉。
 * 排序与"有没有 H.264"的判据在 `utils/codecPreference.ts`（那一个是纯函数，能在 Node 里直跑）。
 */
function applyH264Preference(pc: RTCPeerConnection, preferred: RTCRtpCapabilities['codecs'][number][]): void {
  for (const t of pc.getTransceivers()) {
    if (t.sender?.track?.kind !== 'video' && t.receiver?.track?.kind !== 'video') continue
    try {
      t.setCodecPreferences(preferred)
    } catch (e) {
      console.warn('[whip] 视频编码偏好没设进去，这路按浏览器默认协商', e)
    }
  }
}

export interface PublishOptions {
  mediaKind: PublicationCreateBody['mediaKind']
  targetBitrateKbps?: number
  delivery?: import('@/utils/videoDelivery').VideoDelivery
  mediaLabel?: string
  onState?: (state: RTCPeerConnectionState) => void
  /**
   * 上行实测码率（kbps，SI）、编码器目标码率（kbps，取不到为 0）与实测帧率（取不到为 0）。
   * 三方无码率端点，只能本地 getStats 采样。帧率取 outbound-rtp 的 `framesPerSecond`
   * （三方同源取法），要随码率一起上报给三方当"压缩前"那一组量。
   */
  onRate?: (kbps: number, targetKbps: number, fps: number) => void
  /** 只在还没产出码率增量时单独回吐目标码率。 */
  onTarget?: (kbps: number) => void
  preferredFps?: number
  physicalFrames?: () => number | null | undefined
  onVideoSample?: (sample: BrowserVideoSample | null) => void
  /** 上行累计发送字节（getStats bytesSent 累计值）。 */
  onBytes?: (bytes: number) => void
}

// 三方只接受固定档位的视频规格（见 meeting.html 的分辨率/帧率下拉），
// 裸 getSettings() 可能报出整屏 DPI 缩放后的非标值（实测 2561x1601@30）被拒。
// **归一口径只有一处**：`utils/videoSpec.ts`。界面显示「本端这一格的分辨率/帧率」也读它 ——
// 否则同一格里「原始速率」说的是归一后的流、「分辨率」说的却是采集侧，两个数不是同一条流。

/**
 * 把本地 MediaStream 经后端代理发布到三方（WHIP）。
 *
 * 信令走我方后端 `/publications` + `/whip`，因为参会令牌与三方地址都不能进浏览器；
 * RTP 媒体面是浏览器与媒体服务直连，后端不转发。
 */
export function useWhipPublish(getMeetingId: () => number) {
  let pc: RTCPeerConnection | null = null
  let publicationId = ''
  let options: PublishOptions | undefined
  let publishedSpec: ReturnType<typeof publicVideoSpec> | undefined
  let rateTimer: ReturnType<typeof setInterval> | null = null

  async function unpublish() {
    const id = getMeetingId()
    const conn = pc
    const pub = publicationId
    if (rateTimer !== null) {
      clearInterval(rateTimer)
      rateTimer = null
    }
    options?.onVideoSample?.(null)
    options = undefined
    publishedSpec = undefined
    pc = null
    publicationId = ''
    if (conn) conn.close()
    if (!pub) return
    const token = localStorage.getItem('weitong.token') || ''
    // 收尾清理是尽力而为：这条发布可能已经被上游收走了。失败只留日志，
    // 不要在用户已经离开的路上弹一句"发布不存在或已结束"（第 42 项）。
    const res = await fetch(sitePath(`/api/v1/meetings/${id}/publications/${pub}/whip`), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + token },
    }).catch((e) => { console.warn('[whip] 拆发布通道失败', e); return null })
    if (res && !res.ok) console.warn('[whip] 拆发布通道被拒', res.status, await res.text().catch(() => ''))
    await stopPublication(id, pub, true).catch((e) => console.warn('[whip] 停发布失败', e))
  }

  async function publish(stream: MediaStream, opts: PublishOptions): Promise<RTCPeerConnection> {
    await unpublish()
    const videoTrack = stream.getVideoTracks()[0]
    const hasAudio = stream.getAudioTracks().length > 0
    const settings = videoTrack?.getSettings()
    // 三方只接受固定档位的视频规格（分辨率 1920x1080/1280x720、帧率 ≤25），
    // 裸 getSettings() 可能报出整屏 DPI 缩放后的 2561x1601@30 → 被 bad_publication_video_spec 拒。
    // 对齐三方 ocean-meeting.js：发布前把 spec 归一化到允许档位。
    const spec = opts.delivery ? publicVideoSpec(settings, opts.preferredFps) : normalizeVideoSpec(settings?.width ?? 0, settings?.height ?? 0, settings?.frameRate ?? 0)
    const created = await createPublication(getMeetingId(), {
      mediaKind: opts.mediaKind,
      hasVideo: !!videoTrack,
      hasAudio,
      width: opts.delivery && settings?.width ? settings.width : spec.width,
      height: opts.delivery && settings?.height ? settings.height : spec.height,
      fps: spec.fps,
      targetBitrateKbps: opts.delivery?.transportMode === 'cloud' ? opts.delivery.targetBitrateKbps : (opts.targetBitrateKbps ?? 0),
      ...(opts.delivery && { transportMode: opts.delivery.transportMode, encodingStrategy: opts.delivery.encodingStrategy }),
      mediaLabel: opts.mediaLabel ?? '',
    })
    const { publicationId: newPubId, whipPath, sourceType } = created.data ?? {}
    if (!newPubId || !whipPath) {
      console.error('[whip] 后端创建发布成功但没回地址', created)
      throw new PublishError('没能拿到这路媒体的推流地址，请重试')
    }
    const conn = new RTCPeerConnection()
    stream.getTracks().forEach((t) => conn.addTrack(t, stream))
    // 来源由后端定（按本实例端别与媒体类型），前端只照它决定编码偏好，别按"是不是边端"自己猜。
    if (sourceType === 'rk_browser_roi') {
      const caps = RTCRtpSender.getCapabilities?.('video')
      if (!caps?.codecs?.length) {
        // 不可判，不是"没有 H.264"：照默认协商继续发（与三方的 required 语义有一处差异，
        // 记在契约 §6.3.1 第 7 条）。拒绝发这一路必须是"确知没有"，不能是"我没查到"。
        console.warn('[whip] 浏览器没有视频编码能力表，这路按默认协商')
      } else {
        const preferred = h264First(caps.codecs)
        if (!preferred) {
          // 确知没有 H.264：船内 RK 接收槽只吃浏览器 H.264，发出去也只会是对端永远黑格。
          // 三方在同一处直接不发布，我方照办 —— 但要把刚建出的那条发布清掉，别在平台上留僵尸。
          conn.close()
          console.error('[whip] 这一路要求浏览器 H.264，本机没有该编码能力，已取消这次发布')
          await stopPublication(getMeetingId(), newPubId, true)
            .catch((e) => console.warn('[whip] 清理本次发布失败', e))
          throw new PublishError('这台设备的浏览器不支持当前画面的发布方式，请换用其他浏览器后重试')
        }
        applyH264Preference(conn, preferred)
      }
    }
    // 目标码率只能在这里落进编码器。两条别改回去：① 发布请求里那个 `targetBitrateKbps` 只是**上报**给
    // 会议平台，它改不了本页浏览器的编码（编码发生在发送端）；② 会中那一格「目标码率」显示的是
    // `getStats` 里编码器自己的实时 targetBitrate，与上报值是两个量 —— 不在这里落，用户改了设置
    // 会发现那一格纹丝不动，只能以为"是网络问题"。
    // 被拒时只进控制台：宁可这一路不限码率，也不因一次 setParameters 失败就整路发不出去。
    const capKbps = opts.targetBitrateKbps ?? 0
    const videoSender = conn.getSenders().find((s) => s.track?.kind === 'video')
    if (videoSender) {
      try {
        const params = videoSender.getParameters()
        const encodings = params.encodings?.length ? params.encodings : [{}]
        if (capKbps > 0) encodings[0] = { ...encodings[0], maxBitrate: capKbps * 1000 }
        // 对齐三方 setFocused：显式给编码器帧时钟与降级偏好，
        // CanvasCaptureMediaStreamTrack 没有硬件帧率，不设 maxFramerate 编码器可能判轨道不活跃。
        encodings[0] = { ...encodings[0], maxFramerate: spec.fps, scaleResolutionDownBy: 1 }
        params.encodings = encodings
        params.degradationPreference = opts.delivery ? 'maintain-framerate' : 'maintain-resolution'
        await videoSender.setParameters(params)
      } catch (e) {
        console.warn('[whip] 编码器参数没设进去，这路按浏览器默认走', e)
      }
    }
    // 浏览器在这一步抛的是 DOMException（英文 name/message，如 InvalidStateError），
    // 直接冒到弹窗就是技术细节外泄（第 7 项）：原文只进控制台，对外给能行动的一句。
    try {
      const offer = await conn.createOffer()
      await conn.setLocalDescription(offer)
      await waitForIceComplete(conn)
    } catch (e) {
      conn.close()
      console.error('[whip] 本端协商没准备好', e)
      throw new PublishError('这路媒体没准备好，请重试')
    }

    const token = localStorage.getItem('weitong.token') || ''
    const res = await fetch(sitePath(whipPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', Authorization: 'Bearer ' + token },
      body: conn.localDescription?.sdp ?? '',
    })
    if (!res.ok) {
      conn.close()
      // 后端在这条非信封响应里回的是我方中文原因（controller 的 thirdPartyUserMessage），能用就用；
      // HTTP 状态与响应原文只进控制台。但反向代理/网关可能把这段正文顶成自己的 HTML 错误页，
      // 那种原文进弹窗就是技术细节外泄（第 7 项），所以只收"一行、短、不含标记"的正文。
      const raw = (await res.text().catch(() => '')).trim()
      const why = raw && raw.length <= 120 && !raw.includes('<') ? raw : ''
      console.error('[whip] 发布被拒', res.status, raw)
      throw new PublishError(why || '这路画面或声音没推出去，请重试')
    }
    const sdp = await res.text()
    try {
      await conn.setRemoteDescription({ type: 'answer', sdp })
    } catch (e) {
      conn.close()
      console.error('[whip] 协商应答无法应用', e, sdp.slice(0, 400))
      throw new PublishError('媒体协商未完成，请重试')
    }
    // 发布"被接受"不等于"通了"：ICE/DTLS 没起来时上游只会挂着一条 not-ready 的发布，
    // 别人既看不到画面也听不到声音。状态必须报出来，不能静默。
    conn.addEventListener('connectionstatechange', () => {
      opts.onState?.(conn.connectionState)
    })
    // 上行码率/字节只能本地测：累计 outbound-rtp 的字节增量 / 时间差（≥250ms 基线）。
    if (opts.onRate || opts.onBytes || opts.onVideoSample) {
      const sampleVideo = videoSampler()
      let prevBytes = 0
      let prevAt = 0
      rateTimer = setInterval(() => {
        conn.getStats().then((report) => {
          if (pc !== conn) return
          const trackId = videoSender?.track?.id
          if (trackId) opts.onVideoSample?.(sampleVideo(report, trackId, opts.physicalFrames?.()))
          let bytes = 0
          // 编码器当前目标码率：浏览器按带宽估计实时调，只有发送端自己知道，链路不回吐。
          let targetKbps = 0
          // 实测帧率取 max（照三方 `samplePeerRates` 的取法）：音频那条 outbound-rtp 没有这个键，取 max 天然把它滤掉。
          let fps = 0
          report.forEach((s) => {
            if (s.type === 'outbound-rtp' && !s.isRemote) {
              const s2 = s as RTCOutboundRtpStreamStats
              bytes += s2.bytesSent || 0
              if (s2.targetBitrate) targetKbps = Math.round(s2.targetBitrate / 1000)
              fps = Math.max(fps, Number(s2.framesPerSecond) || 0)
            }
          })
          opts.onBytes?.(bytes)
          const now = performance.now()
          if (prevAt && bytes >= prevBytes && opts.onRate) {
            const dt = (now - prevAt) / 1000
            if (dt > 0) opts.onRate(((bytes - prevBytes) * 8) / 1000 / dt, targetKbps, fps)
          } else if (targetKbps) {
            opts.onTarget?.(targetKbps)
          }
          prevBytes = bytes
          prevAt = now
        }).catch(() => undefined)
      }, 1000)
    }
    options = opts
    publishedSpec = spec
    pc = conn
    publicationId = newPubId
    return conn
  }

  // 对齐三方 replaceVideoTrack：原地换轨，不拆连接、不重新协商、不新建 publication。
  // 虚化开关/换摄像头只换 sender 背后的轨道，WHIP session 与跨侧转发保持不变。
  async function replaceVideoTrack(track: MediaStreamTrack): Promise<void> {
    if (!track || track.readyState !== 'live') throw new PublishError('替换轨道已失效')
    if (!pc || pc.connectionState === 'closed') throw new PublishError('发布通道不可用')
    const sender = pc.getSenders().find((s) => s.track?.kind === 'video' || s.track === null)
    if (!sender) throw new PublishError('找不到视频发送器')
    await sender.replaceTrack(track)
    // 换轨后重置编码器参数（对齐三方 setFocused + refreshVideoEncoder）
    try {
      const params = sender.getParameters()
      if (!Array.isArray(params.encodings) || !params.encodings.length) params.encodings = [{}]
      params.encodings[0].maxFramerate = options?.delivery ? publicVideoSpec(track.getSettings(), options.preferredFps).fps : 25
      params.degradationPreference = options?.delivery ? 'maintain-framerate' : 'maintain-resolution'
      await sender.setParameters(params)
    } catch { /* best-effort */ }
    // 生成关键帧让对端/RK 接收侧能立即解码新轨
    try {
      await (sender as RTCRtpSender & { generateKeyFrame?: () => Promise<void> }).generateKeyFrame?.()
    } catch { /* 浏览器不支持时静默 */ }
  }

  function canReplaceVideoTrack(track: MediaStreamTrack) {
    if (!options?.delivery) return true
    const next = publicVideoSpec(track.getSettings(), options.preferredFps)
    return publishedSpec?.fps === next.fps && publishedSpec.width === next.width && publishedSpec.height === next.height
  }

  return { publish, unpublish, canReplaceVideoTrack, published: () => !!publicationId, publicationIdOf: () => publicationId, replaceVideoTrack }
}
