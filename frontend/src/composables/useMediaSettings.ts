import { ref, computed } from 'vue'
import type { UserSettingsVo } from '@/api/settings'
import { getPreferences, updatePreferences } from '@/api/settings'
import { createBgBlurTrack, type BgBlurSession } from '@/utils/bgBlur'
import { BG_BLUR_AVAILABLE } from '@/utils/virtualBackground'

// 全局共享的偏好与设备状态：设置页写入、会议页读取，只此一处枚举设备。
const prefs = ref<UserSettingsVo | null>(null)
const devices = ref<{
  cameras: MediaDeviceInfo[]
  microphones: MediaDeviceInfo[]
  speakers: MediaDeviceInfo[]
}>({ cameras: [], microphones: [], speakers: [] })
const permissionGranted = ref(false)
const error = ref('')
// 最近一次**实际采集**的结论（按设备分开，短词，给侧栏设备状态卡用）。
// 枚举到设备不等于采得到：实测 2026-09-28 Edge 上预览区报「被其它程序占用」，
// 而侧栏同时显示"正常"，两处自相矛盾 —— 面板那侧原先只看枚举结果，没有采集这个真源。
const captureIssue = ref<{ camera: string; mic: string }>({ camera: '', mic: '' })
/** 侧栏设备卡用：区分「浏览器已拒」与「尚未询问 / 已授但本页还没拿到 label」。 */
const mediaAccess = ref<{ camera: 'unknown' | 'granted' | 'denied' | 'prompt'; mic: 'unknown' | 'granted' | 'denied' | 'prompt' }>({
  camera: 'unknown',
  mic: 'unknown',
})
let loadInFlight: Promise<UserSettingsVo | null> | null = null

function isInsecureMediaContext(): boolean {
  if (typeof window === 'undefined') return false
  if (window.isSecureContext) return false
  const h = location.hostname
  return h !== 'localhost' && h !== '127.0.0.1' && h !== '[::1]'
}

async function queryMediaPermission(name: 'camera' | 'microphone'): Promise<'granted' | 'denied' | 'prompt' | 'unknown'> {
  try {
    const perms = navigator.permissions
    if (!perms?.query) return 'unknown'
    const status = await perms.query({ name } as PermissionDescriptor)
    if (status.state === 'granted' || status.state === 'denied' || status.state === 'prompt') return status.state
    return 'unknown'
  } catch {
    // Firefox 等对 camera/microphone 的 query 会抛错
    return 'unknown'
  }
}

/** 短暂 getUserMedia 再立刻停轨：刷新设备 label；已授权时不弹框，未授权时仅在 interactive 时弹。 */
async function probeTrack(kind: 'video' | 'audio'): Promise<'ok' | 'denied' | 'missing' | 'busy' | 'fail'> {
  if (!navigator.mediaDevices?.getUserMedia) return 'fail'
  try {
    const stream = await navigator.mediaDevices.getUserMedia(
      kind === 'video' ? { video: true, audio: false } : { video: false, audio: true },
    )
    stream.getTracks().forEach((t) => t.stop())
    return 'ok'
  } catch (e: any) {
    const name = e?.name as string
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing'
    if (name === 'NotReadableError' || name === 'AbortError') return 'busy'
    return 'fail'
  }
}

// 本场临时设备：只对这一场会议生效，不写 prefs、不进库（第 33 项）。
// 必须是模块级 —— 过渡页写入、会中页读取。留空表示沿用设置页保存的设备。
const sessionDevices = ref<{ camera: string; mic: string; speaker: string }>({ camera: '', mic: '', speaker: '' })

// 采集/播放真正该用的那份偏好 = 落库偏好。会话里某台设备留空，表示这次没另选，沿用设置页的值。
function effectivePrefs(): UserSettingsVo | null {
  if (!prefs.value) return null
  return {
    ...prefs.value,
    cameraDeviceId: sessionDevices.value.camera || prefs.value.cameraDeviceId,
    microphoneDeviceId: sessionDevices.value.mic || prefs.value.microphoneDeviceId,
    speakerDeviceId: sessionDevices.value.speaker || prefs.value.speakerDeviceId,
  }
}

export function useMediaSettings() {
  const localStream = ref<MediaStream | null>(null)
  // 背景虚化降级时的中文原因，由页面就近展示；成功处理时保持为空。
  const bgBlurNotice = ref('')
  let captureTrack: MediaStreamTrack | undefined
  let blurSession: BgBlurSession | null = null
  const mirrorStyle = computed(() => (prefs.value?.mirrorVideo ? 'row-reverse' : 'row'))

  async function loadPreferences(force = false) {
    if (prefs.value && !force) return prefs.value
    if (loadInFlight) return loadInFlight
    loadInFlight = getPreferences()
      .then((res) => {
        prefs.value = res.data || null
        // 旧版设置页只写 bgBlur；读到它而 vbMode 还是 off 时按 blur 迁移一次。
        // 只改内存：下次保存由 savePreferences 把镜像同步回库。
        if (prefs.value && prefs.value.bgBlur && prefs.value.vbMode === 'off') {
          prefs.value.vbMode = 'blur'
        }
        return prefs.value
      })
      .catch(() => {
        prefs.value = null
        return null
      })
      .finally(() => {
        loadInFlight = null
      })
    return loadInFlight
  }

  async function savePreferences(next: UserSettingsVo, alignSessionDevices = true) {
    // bgBlur 是旧开关的兼容镜像：判生效只看 vbMode，落库时把镜像同步过去。
    const payload = { ...next, bgBlur: next.vbMode === 'blur' }
    await updatePreferences(payload)
    prefs.value = payload
    // 显式保存过一次就把临时设备对齐到刚落库的值：否则会中设置弹层存的设备会被预检页的临时选择盖掉。
    // 只改非设备项时传 false，别把预检页的临时设备覆盖掉。
    if (alignSessionDevices) {
      sessionDevices.value = {
        camera: payload.cameraDeviceId,
        mic: payload.microphoneDeviceId,
        speaker: payload.speakerDeviceId,
      }
    }
  }

  // 标签与 deviceId 只有在拿到过一次采集权限后才可信，所以先探一次再枚举。
  async function enumerateDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      error.value = '浏览器不支持设备枚举'
      return
    }
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      devices.value = {
        cameras: list.filter((d) => d.kind === 'videoinput'),
        microphones: list.filter((d) => d.kind === 'audioinput'),
        speakers: list.filter((d) => d.kind === 'audiooutput'),
      }
      error.value = ''
    } catch (e: any) {
      permissionGranted.value = false
      // 只映射到本域中文：DOMException 原文（如 "Permission denied"）对用户没有可操作性。
      if (e?.name === 'NotAllowedError') {
        error.value = '未获得摄像头/麦克风权限'
      } else {
        console.warn('[media] 设备枚举失败', e?.name, e?.message)
        error.value = '读不到设备列表，稍后重试'
      }
    }
  }

  // refreshDeviceCounts 只数设备、不请求权限（不 getUserMedia），供侧栏设备状态面板静默展示。
  // 未授权时 enumerateDevices 仍返回设备条目（label 为空），足以判断"有没有"这类设备。
  async function refreshDeviceCounts() {
    if (!navigator.mediaDevices?.enumerateDevices) {
      error.value = '浏览器不支持设备枚举'
      return
    }
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      devices.value = {
        cameras: list.filter((d) => d.kind === 'videoinput'),
        microphones: list.filter((d) => d.kind === 'audioinput'),
        speakers: list.filter((d) => d.kind === 'audiooutput'),
      }
    } catch {
      /* 静默失败：面板保持"未检测到"，不打扰用户 */
    }
  }

  /**
   * 侧栏设备状态检测。
   * - interactive=false（进页）：已授权则静默取流刷新 label；未询问不弹框，文案用「待授权」而非误报「未授权」。
   * - interactive=true（点检测）：主动请求权限，用户可在地址栏放行后变成「正常」。
   */
  async function checkDeviceAccess(opts?: { interactive?: boolean }) {
    const interactive = !!opts?.interactive
    if (isInsecureMediaContext()) {
      mediaAccess.value = { camera: 'denied', mic: 'denied' }
      captureIssue.value = { camera: '需加密连接', mic: '需加密连接' }
      await refreshDeviceCounts()
      return
    }

    const camQ = await queryMediaPermission('camera')
    const micQ = await queryMediaPermission('microphone')
    mediaAccess.value = {
      camera: camQ === 'unknown' ? 'prompt' : camQ,
      mic: micQ === 'unknown' ? 'prompt' : micQ,
    }

    // 仅「已授权」或用户点检测时取流：未询问时进页不弹框；Permissions API 不可用时也等用户点检测。
    const probeCam = interactive || camQ === 'granted'
    const probeMic = interactive || micQ === 'granted'

    // 串行探两路：并发时一路 NotAllowed 会把另一路也带坏（见 startPreview 注释）。
    if (probeCam) {
      const r = await probeTrack('video')
      if (r === 'ok') mediaAccess.value = { ...mediaAccess.value, camera: 'granted' }
      else if (r === 'denied') mediaAccess.value = { ...mediaAccess.value, camera: 'denied' }
      else if (r === 'busy') captureIssue.value = { ...captureIssue.value, camera: '被占用' }
      else if (r === 'missing') captureIssue.value = { ...captureIssue.value, camera: '未检测到' }
    }
    if (probeMic) {
      const r = await probeTrack('audio')
      if (r === 'ok') mediaAccess.value = { ...mediaAccess.value, mic: 'granted' }
      else if (r === 'denied') mediaAccess.value = { ...mediaAccess.value, mic: 'denied' }
      else if (r === 'busy') captureIssue.value = { ...captureIssue.value, mic: '被占用' }
      else if (r === 'missing') captureIssue.value = { ...captureIssue.value, mic: '未检测到' }
    }

    if (mediaAccess.value.camera === 'granted' || mediaAccess.value.mic === 'granted') {
      permissionGranted.value = true
    }
    // 清掉「需加密连接」这类仅上下文导致的旧文案（真正占用/缺失上面已写入）
    if (mediaAccess.value.camera === 'granted' && captureIssue.value.camera === '需加密连接') {
      captureIssue.value = { ...captureIssue.value, camera: '' }
    }
    if (mediaAccess.value.mic === 'granted' && captureIssue.value.mic === '需加密连接') {
      captureIssue.value = { ...captureIssue.value, mic: '' }
    }

    await enumerateDevices()
    // 有的浏览器 Permissions 报 unknown，但 enumerate 已带回 label → 视为已授权。
    if (devices.value.cameras.some((d) => d.label)) {
      mediaAccess.value = { ...mediaAccess.value, camera: 'granted' }
      permissionGranted.value = true
    }
    if (devices.value.microphones.some((d) => d.label)) {
      mediaAccess.value = { ...mediaAccess.value, mic: 'granted' }
      permissionGranted.value = true
    }
  }

  async function startPreview(opts?: { audioOnly?: boolean }): Promise<MediaStream | null> {
    if (!navigator.mediaDevices?.getUserMedia) {
      error.value = '该浏览器不支持采集，请换 Edge 或 Chrome'
      captureIssue.value = { camera: '不支持', mic: '不支持' }
      return null
    }
    stopPreview()
    bgBlurNotice.value = ''
    const audioOnly = !!opts?.audioOnly
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: buildAudioConstraints(effectivePrefs()),
        video: audioOnly ? false : buildVideoConstraints(effectivePrefs()),
      })
      permissionGranted.value = true
      // 成功一次就要把上一次的失败文案清掉：error 是跨页面复用的单例，
      // 预检页失败、换个设备重试成功后，会中页还会把那句「未获得摄像头/麦克风权限」当成现状显示出来。
      error.value = ''
      captureIssue.value = { camera: audioOnly ? '未开启' : '', mic: '' }
      await enumerateDevices()

      // 虚化在轨道级做：替换 startPreview 这一个出口，预览与发布（都从这里取流）自然走同一条链路。
      // 判生效只看 vbMode；bgBlur 已在 loadPreferences 里迁移成兼容镜像。
      captureTrack = stream.getVideoTracks()[0]
      let outStream = stream
      const wantBlur = !audioOnly && BG_BLUR_AVAILABLE && prefs.value?.vbMode === 'blur'
      if (wantBlur) {
        const sourceVideo = stream.getVideoTracks()[0]
        if (sourceVideo) {
          try {
            const session = await createBgBlurTrack(sourceVideo, {
              fps: prefs.value?.videoMaxFps,
              onDegrade: (reason) => { bgBlurNotice.value = reason },
            })
            if (session) {
              blurSession = session
              // 源视频轨道由 session 独吞消费并负责停止，这里只把音频轨原样带过去。
              outStream = new MediaStream([session.track, ...stream.getAudioTracks()])
            } else if (!bgBlurNotice.value) {
              // 内部已停掉自己开的管线；这里把源轨道放回可用状态即可（session=null 时源轨道仍活着）
              bgBlurNotice.value = '背景虚化未生效，已按原始画面继续'
            }
          } catch {
            // 处理链构建期的意外失败绝不能拖垮整条预览：退回原始流。
            bgBlurNotice.value = '背景虚化初始化异常，已按原始画面继续'
          }
        }
      }
      localStream.value = outStream
      return outStream
    } catch (e: any) {
      // 合并请求失败说明不了是哪一台设备坏：逐台**串行**各采一次，采得到的那一路就留下来用。
      // 串行不是保守写法：实测并发采两路时，摄像头那路失败会把麦克风那路一起带成 NotAllowedError，
      // 于是侧栏写「麦克风 未授权」—— 而单独采麦克风 41ms 就出流（09-29 Edge，权限其实是 granted）。
      const legs = await captureAvailableLegs(effectivePrefs())
      if (!legs.stream) {
        error.value =
          typeof window !== 'undefined' && !window.isSecureContext
            ? '当前是 http 局域网地址，浏览器可能禁止麦克风/摄像头；请改用 https 或本机 localhost'
            : describeMediaError(e)
        captureIssue.value = legs.issue
        return null
      }
      // 只有一台设备可用也要能入会：这不是"进不去"，所以 error 留空；
      // 缺的那一路由调用方按轨道实有无关掉意图位，并把 legs.issue 说给用户听。
      error.value = ''
      permissionGranted.value = true
      captureIssue.value = legs.issue
      captureTrack = legs.stream.getVideoTracks()[0]
      localStream.value = legs.stream
      await enumerateDevices()
      return legs.stream
    }
  }

  function stopPreview(stream?: MediaStream | null) {
    // 先停处理会话（帧循环 + segmenter + 源轨道），再停对外可见的轨道。
    blurSession?.dispose()
    blurSession = null
    captureTrack = undefined
    const target = stream || localStream.value
    target?.getTracks().forEach((t) => t.stop())
    if (!stream || stream === localStream.value) localStream.value = null
  }

  // applyAudioGraph 把 micVolume/autoGain/noiseSuppression 真正接到链路上：
  // 采集 → 降噪由浏览器做，音量走 GainNode，输出经 AnalyserNode 供讲话检测复用。
  function applyAudioGraph(stream: MediaStream, ctx: AudioContext): { source: MediaStreamAudioSourceNode; gain: GainNode; analyser: AnalyserNode } {
    const source = ctx.createMediaStreamSource(stream)
    const gain = ctx.createGain()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    gain.gain.value = (prefs.value?.micVolume ?? 80) / 100
    source.connect(gain)
    gain.connect(analyser)
    return { source, gain, analyser }
  }

  // setElementSink 切换远端播放元素的输出设备（Chrome/Edge 支持 setSinkId）。
  async function setElementSink(els: (HTMLMediaElement | null | undefined)[], deviceId: string) {
    for (const el of els) {
      if (!el) continue
      const withSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }
      if (typeof withSink.setSinkId !== 'function') continue
      try {
        await withSink.setSinkId(deviceId)
      } catch {
        /* 设备可能已拔出，保持默认输出 */
      }
    }
  }

  // applyVirtualBackground 只负责镜像 —— 虚化已是轨道级处理，叠在元素上反而会把人一起糊掉。
  function applyVirtualBackground(el: HTMLVideoElement | null) {
    if (!el) return
    el.style.transform = prefs.value?.mirrorVideo ? 'scaleX(-1)' : ''
  }

  return {
    prefs,
    localStream,
    devices,
    permissionGranted,
    mediaAccess,
    error,
    captureIssue,
    bgBlurNotice,
    // Undefined selects the unprocessed sender’s media-source counter.
    capturedCameraTrack: () => captureTrack,
    physicalCameraFrames: () => blurSession?.sourceFrames(),
    mirrorStyle,
    loadPreferences,
    savePreferences,
    enumerateDevices,
    refreshDeviceCounts,
    checkDeviceAccess,
    startPreview,
    stopPreview,
    applyVirtualBackground,
    applyAudioGraph,
    setElementSink,
    sessionDevices,
    effectivePrefs,
  }
}

// describeMediaError 把 getUserMedia 的 DOMException 翻成可操作的中文提示。
// 关键区分：NotAllowedError=权限被拒；NotReadableError=权限已给但设备被其它应用/标签占用。
function describeMediaError(e: any): string {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '没有摄像头/麦克风权限，请在地址栏放行'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '没有可用的摄像头/麦克风，请在设置里更换'
    case 'NotReadableError':
      return '摄像头/麦克风被占用，关掉占用它的软件或标签页'
    default:
      // 原始 name/message 只进控制台：DOMException 的英文原文对用户不可操作（第 34 项）。
      console.warn('[media] 未识别的采集错误', e?.name, e?.message)
      return '摄像头/麦克风开不了，请重试'
  }
}

// shortCaptureIssue 是同一件事的短词版：侧栏设备状态卡那一行放不下长句，
// 但必须和预览区的结论同源 —— 否则会出现"预览说被占用、侧栏说正常"的自相矛盾。
function shortCaptureIssue(e: any): string {
  switch (e?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '未授权'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '不可用'
    case 'NotReadableError':
      return '被占用'
    default:
      return '采集失败'
  }
}

/**
 * 合并采集失败后的逐台补救：**串行**各采一路，采到的留下、采不到的记下短词原因。
 * 返回的流里只有真正采到的那些轨 —— 调用方要按轨道实有与否决定意图位，不能假设两路都在。
 * 偏好里的 deviceId 只作 ideal；失败再退到「系统默认设备」，避免换机/手机上 exact 钉死旧 id。
 */
async function captureAvailableLegs(p: UserSettingsVo | null): Promise<{
  stream: MediaStream | null
  issue: { camera: string; mic: string }
}> {
  const issue = { camera: '', mic: '' }
  const tracks: MediaStreamTrack[] = []
  const one = async (
    label: 'camera' | 'mic',
    preferred: MediaStreamConstraints,
    fallback: MediaStreamConstraints,
  ) => {
    try {
      const s = await navigator.mediaDevices.getUserMedia(preferred)
      tracks.push(...s.getTracks())
      return
    } catch (e: any) {
      try {
        const s = await navigator.mediaDevices.getUserMedia(fallback)
        tracks.push(...s.getTracks())
      } catch (e2: any) {
        issue[label] = shortCaptureIssue(e2?.name ? e2 : e)
      }
    }
  }
  await one('camera', { video: true }, { video: true })
  await one(
    'mic',
    { audio: buildAudioConstraints(p) },
    { audio: buildAudioConstraints(null) },
  )
  return { stream: tracks.length ? new MediaStream(tracks) : null, issue }
}

function buildAudioConstraints(p: UserSettingsVo | null): MediaTrackConstraints {
  // deviceId 用 ideal 不用 exact：换浏览器/手机/拔插耳机后旧 id 会让整路麦采不到，
  // 开麦时只能看到「没有可推的音频」—— 同网 PC/手机同时复现就是这条。
  return {
    ...(p?.microphoneDeviceId ? { deviceId: { ideal: p.microphoneDeviceId } } : {}),
    echoCancellation: true,
    noiseSuppression: p?.noiseSuppression ?? true,
    autoGainControl: p?.autoGain ?? true,
  }
}

function buildVideoConstraints(p: UserSettingsVo | null): MediaTrackConstraints {
  const video: MediaTrackConstraints = {}
  if (p?.cameraDeviceId) video.deviceId = { ideal: p.cameraDeviceId }
  if (p) {
    const r = p.videoResolution
    if (r === '1080p') {
      video.width = { ideal: 1920 }
      video.height = { ideal: 1080 }
    } else if (r === '720p') {
      video.width = { ideal: 1280 }
      video.height = { ideal: 720 }
    } else if (r === '480p') {
      video.width = { ideal: 854 }
      video.height = { ideal: 480 }
    }
    video.frameRate = { ideal: p.videoMaxFps, max: p.videoMaxFps }
  }
  return video
}

/** 仅补采麦克风（开麦时若流里没有 live 音轨）。不碰已有画面轨。 */
export async function acquireMicrophoneTrack(
  p: UserSettingsVo | null,
): Promise<MediaStreamTrack | null> {
  if (!navigator.mediaDevices?.getUserMedia) return null
  const tryOnce = async (constraints: MediaTrackConstraints) => {
    const s = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false })
    const t = s.getAudioTracks()[0]
    if (!t) {
      s.getTracks().forEach((x) => x.stop())
      return null
    }
    // 其它轨（若有）停掉，只交出这一条给调用方挂进现有流。
    s.getTracks().forEach((x) => {
      if (x !== t) x.stop()
    })
    return t
  }
  try {
    return await tryOnce(buildAudioConstraints(p))
  } catch {
    try {
      return await tryOnce(buildAudioConstraints(null))
    } catch (e: any) {
      console.warn('[media] 补采麦克风失败', e?.name, e?.message)
      return null
    }
  }
}
