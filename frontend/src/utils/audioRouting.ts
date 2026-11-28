/**
 * 本机音频输出 / 麦克风自动路由工具：
 * 解决插入 HDMI/DP 显示器后系统默认切到无喇叭显示口导致会议无声，
 * 或拔插音频设备后麦克风/扬声器失效的问题。
 */
import { clientPrefs, onClientPrefsChange, updateClientPrefs } from '@/utils/clientPrefs'

const DISPLAY_AUDIO_RE =
  /\b(hdmi|displayport|dp\b|nvidia\s+high\s+definition|amd\s+high\s+definition|intel\(r\)\s+display|digital\s+audio\s*\(hdmi\)|monitor\s+audio)/i

const BUILTIN_SPEAKER_RE =
  /(扬声器|耳机|speaker|headphone|headset|realtek|built-?in|internal|macbook|conexant|synaptics|alc\d+)/i

const VIRTUAL_MIC_RE =
  /(立体声混音|stereo\s+mix|virtual|vb-?cable|voicemeeter|obs\b|hdmi|displayport)/i

export function isDisplayAudioDevice(label: string): boolean {
  return DISPLAY_AUDIO_RE.test(label || '')
}

export function isVirtualOrInvalidMic(label: string): boolean {
  return VIRTUAL_MIC_RE.test(label || '')
}

/**
 * 选出本机实际生效的扬声器 deviceId：
 * 1. 若用户手动选定了一个仍在列表里且非 HDMI 显示口的设备，尊重它；
 * 2. 否则优先挑选本机自带扬声器/耳机（避开 HDMI / DisplayPort 无喇叭口）；
 * 3. 若全都是 HDMI 或无标签，退回 default。
 */
export function pickPreferredSpeakerId(
  devices: MediaDeviceInfo[],
  preferredId?: string,
): { deviceId: string; label: string; avoidedHdmi: boolean } {
  const outputs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId)
  if (!outputs.length) return { deviceId: '', label: '', avoidedHdmi: false }

  const defaultDev = outputs.find((d) => d.deviceId === 'default')
  const defaultLooksHdmi = !!defaultDev && isDisplayAudioDevice(defaultDev.label)

  if (preferredId && preferredId !== 'default') {
    const matched = outputs.find((d) => d.deviceId === preferredId)
    if (matched && !isDisplayAudioDevice(matched.label)) {
      return { deviceId: matched.deviceId, label: matched.label, avoidedHdmi: false }
    }
  }

  const concrete = outputs.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
  const builtin = concrete.find((d) => BUILTIN_SPEAKER_RE.test(d.label) && !isDisplayAudioDevice(d.label))
  if (builtin) {
    return { deviceId: builtin.deviceId, label: builtin.label, avoidedHdmi: defaultLooksHdmi }
  }

  const nonHdmi = concrete.find((d) => !isDisplayAudioDevice(d.label))
  if (nonHdmi) {
    return { deviceId: nonHdmi.deviceId, label: nonHdmi.label, avoidedHdmi: defaultLooksHdmi }
  }

  return { deviceId: defaultDev?.deviceId || outputs[0].deviceId, label: defaultDev?.label || outputs[0].label, avoidedHdmi: false }
}

/**
 * 选出本机实际生效的麦克风 deviceId：
 * 1. 若用户手动指定的麦克风仍在列表且非虚拟口，保留；
 * 2. 否则优先挑选本机真实麦克风（排除立体声混音/虚拟声卡/HDMI）。
 */
export function pickPreferredMicId(
  devices: MediaDeviceInfo[],
  preferredId?: string,
): { deviceId: string; label: string } {
  const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId)
  if (!inputs.length) return { deviceId: '', label: '' }

  if (preferredId && preferredId !== 'default') {
    const matched = inputs.find((d) => d.deviceId === preferredId)
    if (matched && !isVirtualOrInvalidMic(matched.label)) {
      return { deviceId: matched.deviceId, label: matched.label }
    }
  }

  const concrete = inputs.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
  const realMic = concrete.find((d) => !isVirtualOrInvalidMic(d.label))
  if (realMic) return { deviceId: realMic.deviceId, label: realMic.label }

  return { deviceId: inputs[0].deviceId, label: inputs[0].label }
}

type SinkMediaElement = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }

export async function applySinkIdToElement(el: HTMLMediaElement, sinkId: string): Promise<void> {
  const sinkEl = el as SinkMediaElement
  if (!sinkId || typeof sinkEl.setSinkId !== 'function') return
  try {
    await sinkEl.setSinkId(sinkId)
  } catch {
    // 浏览器不支持或权限未放行时静默降级到系统默认
  }
}

export function getSpeakerVolume(): number {
  const n = Number(clientPrefs.speakerVolume)
  if (!Number.isFinite(n)) return 80
  return Math.min(100, Math.max(0, Math.round(n)))
}

function applySpeakerVolume(clamped: number) {
  for (const el of Array.from(document.querySelectorAll('audio'))) {
    el.volume = clamped / 100
  }
}

export function setSpeakerVolume(vol: number): number {
  const clamped = Math.min(100, Math.max(0, Math.round(vol)))
  void updateClientPrefs({ speakerVolume: clamped })
  applySpeakerVolume(clamped)
  return clamped
}

onClientPrefsChange((p) => {
  if (typeof document !== 'undefined') applySpeakerVolume(p.speakerVolume)
})

export async function syncAllRemoteAudioElements(muted: boolean, sinkId: string): Promise<void> {
  const els = Array.from(document.querySelectorAll('audio'))
  const vol = getSpeakerVolume() / 100
  for (const el of els) {
    el.muted = muted
    el.volume = vol
    if (sinkId) await applySinkIdToElement(el, sinkId)
  }
}
