import type { Router } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { quickStartMeeting } from '@/api/meeting'
import { useMediaSettings } from '@/composables/useMediaSettings'
import { useMeetingStore } from '@/store/meeting'
import { preJoinPathByNumber } from '@/utils/joinFlow'

export type LaunchKind = 'quick' | 'share' | 'voice'

/**
 * 防止同一时间重复开多个会：
 * 若当前已在会议中，阻止继续新建会议并引导用户返回当前会议。
 */
export async function guardSingleActiveMeeting(router: Router): Promise<boolean> {
  const store = useMeetingStore()
  if (!store.inMeeting || !store.meetingId) return true
  try {
    await ElMessageBox.confirm(
      `您当前正在会议「${store.title || store.meetingNo || '进行中会议'}」中，同一时间只能参与一场会议。是否返回当前会议？`,
      '已在会议中',
      {
        confirmButtonText: '返回当前会议',
        cancelButtonText: '留在当前页',
        type: 'warning',
      },
    )
    await router.push(`/meeting/${store.meetingId}`)
  } catch {
    /* 用户选择留在当前页 */
  }
  return false
}

function defaultTitle(kind: LaunchKind): string {
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  if (kind === 'share') return `屏幕共享 ${hh}:${mm}`
  if (kind === 'voice') return `语音对讲 ${hh}:${mm}`
  return `临时会议 ${hh}:${mm}`
}

// 开始会议：用已保存的录制偏好建会，然后进入过渡页。过渡页不再询问设备。
// 先拿到会议号再跳转，这样刷新过渡页只会再次进入这一场，不会另开一场。
export async function startQuickMeeting(
  router: Router,
  opts: { launchKind?: LaunchKind } = {},
): Promise<boolean> {
  if (!(await guardSingleActiveMeeting(router))) return false
  const launchKind = opts.launchKind || 'quick'
  // 预加载过渡页与会中页代码块，缩短跳转白屏等待
  void import('@/views/meeting/PreMeetingView.vue')
  void import('@/views/meeting/InMeetingView.vue')

  let cloudRecord = true
  try {
    const prefs = await useMediaSettings().loadPreferences()
    if (prefs) cloudRecord = !!prefs.cloudRecordDefault
  } catch {
    /* 读不到偏好就按默认开云端录制，不拦住开会 */
  }
  const created = await quickStartMeeting({
    title: defaultTitle(launchKind),
    cloudRecord,
    launchKind,
  })
  const no = created.data?.meetingNo
  if (!no) {
    ElMessage.error('这场会还没准备好，暂时无法入会')
    return false
  }
  // 刚建好的会，过渡页不再做一次「能不能加入」的预检：三方有时还没进入可入会态，
  // 预检会把人挡在门外。进入本身会等待主持人。刷新页面不会带着这个标记，该预检还是预检。
  sessionStorage.setItem('conference.skipPrecheck', no)
  // 会中页按这个意图区分：语音默认关摄像、共享入会后立刻拉起屏幕采集。
  sessionStorage.setItem('conference.launchKind', launchKind)
  await router.push(preJoinPathByNumber(no))
  return true
}
