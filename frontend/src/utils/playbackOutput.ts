/**
 * 远端声音从哪只喇叭出来。这是本机的事：后端看不到这台手机的听筒和外放，
 * 也改不了浏览器的自动播放限制。
 *
 * 手机上只要 getUserMedia 开过麦，Chrome/Android 会切到通话模式，
 * <audio> 的声音进听筒。手机放在桌上就等于没声音。这里把手持设备默认改回外放。
 */
import { getSpeakerVolume } from '@/utils/audioRouting'

export type OutputRoute = 'loudspeaker' | 'earpiece'

type AudioSessionNav = Navigator & { audioSession?: { type: string } }

let route: OutputRoute = 'loudspeaker'
const blocked = new Set<HTMLMediaElement>()
const listeners = new Set<(blocked: boolean) => void>()

/** 没有悬停、主指针是触摸：手机和平板。触屏笔记本同时有精细指针，不走这条。 */
export function isHandheld(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(hover: none) and (pointer: coarse)').matches
}

export function outputRoute(): OutputRoute {
  return route
}

function emit() {
  const blockedNow = blocked.size > 0
  for (const fn of listeners) fn(blockedNow)
}

export function onPlaybackBlocked(fn: (blocked: boolean) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function applySession(next: OutputRoute) {
  const session = (navigator as AudioSessionNav).audioSession
  if (!session) return
  // playback = 媒体外放；play-and-record = 通话听筒。只有手持设备需要显式指定。
  session.type = next === 'earpiece' ? 'play-and-record' : 'playback'
}

export function setOutputRoute(next: OutputRoute) {
  route = next
  if (isHandheld()) applySession(next)
}

/** 开麦会把系统音频模式打回听筒，手持设备上每次采集后都要把外放再设回去。 */
export function keepLoudspeakerOnHandheld() {
  if (!isHandheld() || route !== 'loudspeaker') return
  applySession('loudspeaker')
}

export function releaseRemoteAudio(el: HTMLMediaElement) {
  if (!blocked.delete(el)) return
  emit()
}

/** 把一路远端声音挂上播放。自动播放被拦时记下来，等用户点一下再试。 */
export function armRemoteAudio(el: HTMLMediaElement) {
  el.autoplay = true
  el.setAttribute('playsinline', '')
  const vol = getSpeakerVolume() / 100
  if (Number.isFinite(vol)) el.volume = vol
  void el.play().then(() => {
    blocked.delete(el)
    emit()
  }).catch(() => {
    blocked.add(el)
    emit()
  })
}

/** 必须在用户点击的调用栈里执行，iOS 才放行。返回是否仍有被拦住的声音。 */
export async function resumeRemotePlayback(): Promise<boolean> {
  if (isHandheld()) applySession(route)
  const els = Array.from(document.querySelectorAll('audio'))
  for (const el of els) {
    if (!(el instanceof HTMLMediaElement)) continue
    if (!el.srcObject && !el.src) continue
    if (!el.paused && el.readyState > 0) {
      blocked.delete(el)
      continue
    }
    try {
      await el.play()
      blocked.delete(el)
    } catch {
      blocked.add(el)
    }
  }
  emit()
  return blocked.size > 0
}

let unlockInstalled = false

/** 页面上任意一次点击都再试着把被拦住的声音放出来，不要求用户找对那个按钮。 */
export function installPlaybackUnlock() {
  if (unlockInstalled || typeof window === 'undefined') return
  unlockInstalled = true
  const retry = () => { void resumeRemotePlayback() }
  window.addEventListener('pointerdown', retry, true)
  window.addEventListener('keydown', retry, true)
}
