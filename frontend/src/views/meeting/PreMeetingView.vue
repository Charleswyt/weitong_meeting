<template>
  <div class="gate-root">
    <div class="gate-card">
      <div class="gate-kicker">{{ isQuick ? '开始会议' : '进入会议' }}</div>
      <h1 class="gate-title">{{ heading }}</h1>
      <p class="gate-sub">{{ subline }}</p>
      <form v-if="needPassword" class="gate-pwd-form" @submit.prevent="submitPassword">
        <input
          v-model="joinPassword"
          type="password"
          class="gate-pwd-input"
          placeholder="请输入会议密码"
          autocomplete="off"
          autofocus
        />
        <p v-if="pwdError" class="gate-pwd-err">{{ pwdError }}</p>
        <div class="gate-pwd-actions">
          <button type="button" class="gate-btn gate-btn-quiet" @click="goBack">返回</button>
          <button type="submit" class="gate-btn" :disabled="!joinPassword.trim() || pwdSubmitting">
            {{ pwdSubmitting ? '验证中…' : '验证并入会' }}
          </button>
        </div>
      </form>
      <button v-else-if="waitingForHost" class="gate-btn" @click="cancelWait = true">取消等待</button>
      <button v-else-if="failed" class="gate-btn gate-btn-quiet" @click="goBack">返回</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { getMeetingDetail, quickStartMeeting, precheckMeeting, type JoinResult, type MeetingVo } from '@/api/meeting'
import { useMediaSettings } from '@/composables/useMediaSettings'
import { useUserStore } from '@/store/user'
import { useMeetingStore } from '@/store/meeting'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const meetingStore = useMeetingStore()
const { prefs, sessionDevices, loadPreferences } = useMediaSettings()

const meeting = ref<MeetingVo | null>(null)
const failed = ref(false)
const failText = ref('')
const displayName = ref('')
const needPassword = ref(false)
const joinPassword = ref('')
const pwdError = ref('')
const pwdSubmitting = ref(false)

const isQuick = computed(() => route.params.id === 'quick' || route.query.quick === '1')
const joinName = computed(() =>
  (displayName.value.trim() || userStore.userInfo?.displayName || '').slice(0, 32),
)

const heading = computed(() => {
  if (needPassword.value) return '请输入入会密码'
  if (waitingForHost.value) return '正在等待主持人'
  if (failed.value) return '没能进入会议'
  return meeting.value?.title || (isQuick.value ? '正在开始' : '正在进入')
})
const subline = computed(() => {
  if (needPassword.value) return '该会议已开启密码保护，请输入主持人提供的入会密码'
  if (waitingForHost.value) return '主持人进入后会自动带你进去'
  if (failed.value) return failText.value || '请返回后重试'
  const no = meeting.value?.meetingNo
  return no ? `会议号 ${no}` : '使用已保存的摄像头和麦克风'
})

// 链接里明确带了开关才覆盖预约里的入会设置；页面上不再提供这些开关。
const micTouched = ref(false)
const cameraTouched = ref(false)
const micOn = ref(true)
const cameraOn = ref(true)

onMounted(async () => {
  // 过渡页启动同时后台预加载会中页 chunk，入会接口返回后秒进会中
  void import('@/views/meeting/InMeetingView.vue')
  // 偏好加载与会议详情/预检并行，不再串行干等
  const prefsPromise = loadPreferences().catch(() => null)

  displayName.value = String(route.query.name || userStore.userInfo?.displayName || '')
  if (route.query.micOn !== undefined) {
    micOn.value = route.query.micOn !== '0'
    micTouched.value = true
  }
  if (route.query.cameraOn !== undefined) {
    cameraOn.value = route.query.cameraOn !== '0'
    cameraTouched.value = true
  }
  // 不自动连音频：不开麦，并记一笔给会中页跳过麦采集。
  if (route.query.autoAudio === '0') {
    micOn.value = false
    micTouched.value = true
    sessionStorage.setItem('conference.autoAudio', '0')
  } else {
    sessionStorage.removeItem('conference.autoAudio')
  }
  const byNumber = String(route.params.meetingNo || '')
  if (byNumber) {
    meeting.value = { meetingNo: byNumber } as MeetingVo
  } else if (!isQuick.value) {
    const id = Number(route.params.id)
    if (id) {
      try {
        const detail = await getMeetingDetail(id)
        meeting.value = detail.data!
      } catch {
        fail('这场会还没准备好，暂时无法入会', false)
        return
      }
    }
  }
  const skipPrecheck = sessionStorage.getItem('conference.skipPrecheck')
  if (skipPrecheck && skipPrecheck === meeting.value?.meetingNo) {
    sessionStorage.removeItem('conference.skipPrecheck')
  } else if (!isQuick.value && meeting.value?.meetingNo) {
    try {
      const pc = await precheckMeeting(meeting.value.meetingNo)
      if (pc.data && !pc.data.joinable) {
        fail(pc.data.message || '会议不可加入')
        return
      }
      if (pc.data?.requiresPassword) {
        await prefsPromise
        sessionDevices.value = {
          camera: prefs.value?.cameraDeviceId || '',
          mic: prefs.value?.microphoneDeviceId || '',
          speaker: prefs.value?.speakerDeviceId || '',
        }
        needPassword.value = true
        return
      }
    } catch {
      fail('会议暂时无法确认，请稍后重试', false)
      return
    }
  }
  await prefsPromise
  sessionDevices.value = {
    camera: prefs.value?.cameraDeviceId || '',
    mic: prefs.value?.microphoneDeviceId || '',
    speaker: prefs.value?.speakerDeviceId || '',
  }
  await handleJoin()
})

onUnmounted(() => {
  disposed = true
  cancelWait.value = true
})

function fail(text: string, toast = true) {
  failed.value = true
  failText.value = text
  if (toast) ElMessage.error(text)
}

function goBack() {
  if (window.history.length > 1) router.back()
  else router.replace('/')
}

const HOST_WAIT_RETRY_MS = 3000
const HOST_WAIT_LIMIT_MS = 10 * 60 * 1000
const waitingForHost = ref(false)
const cancelWait = ref(false)
let disposed = false

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function waitOrCancel(ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cancelWait.value) return true
    await sleep(Math.max(0, Math.min(200, end - Date.now())))
  }
  return cancelWait.value
}

async function submitPassword() {
  if (!joinPassword.value.trim() || pwdSubmitting.value) return
  pwdError.value = ''
  pwdSubmitting.value = true
  try {
    await handleJoin(joinPassword.value.trim())
  } finally {
    pwdSubmitting.value = false
  }
}

async function handleJoin(password?: string) {
  cancelWait.value = false
  try {
    if (isQuick.value && !meeting.value) {
      let cloudRecord = true
      if (route.query.cloudRecord === '0') cloudRecord = false
      else if (route.query.cloudRecord === '1') cloudRecord = true
      else if (prefs.value) cloudRecord = Number(prefs.value.cloudRecordDefault) !== 0
      const now = new Date()
      const title = String(route.query.title || '').trim()
        || `临时会议 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const created = await quickStartMeeting({ title, cloudRecord })
      meeting.value = created.data!
    }
    if (!meeting.value?.meetingNo) {
      fail('这场会还没准备好，暂时无法入会')
      return
    }
    let joined: JoinResult | null = null
    const deadline = Date.now() + HOST_WAIT_LIMIT_MS
    while (!joined) {
      const res = await meetingStore.enter(meeting.value.meetingNo, joinName.value, true, password)
      if (!res.waiting) {
        joined = res
        break
      }
      needPassword.value = false
      waitingForHost.value = true
      if (Date.now() + HOST_WAIT_RETRY_MS > deadline) {
        fail('主持人尚未入会，请稍后再试')
        return
      }
      if (await waitOrCancel(HOST_WAIT_RETRY_MS)) {
        if (!disposed) goBack()
        return
      }
    }
    if (disposed || !joined) return
    needPassword.value = false
    if (micTouched.value || cameraTouched.value) {
      const booked = { ...meetingStore.initialMedia }
      meetingStore.initialMedia = {
        micOff: micTouched.value ? !micOn.value : booked.micOff,
        cameraOff: cameraTouched.value ? !cameraOn.value : booked.cameraOff,
      }
    }
    router.replace(`/meeting/${joined.meetingId}?name=${encodeURIComponent(joinName.value)}`)
  } catch (e: any) {
    const msg = String(e?.message || '')
    if (msg.includes('密码')) {
      needPassword.value = true
      pwdError.value = msg
      return
    }
    if (!disposed) fail('没能进入会议，请返回后重试', false)
  } finally {
    waitingForHost.value = false
  }
}
</script>

<style scoped>
.gate-root {
  min-height: calc(100vh - 80px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px 20px;
}
.gate-card {
  width: min(420px, 100%);
  padding: 36px 32px;
  border-radius: 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  text-align: center;
}
.gate-kicker {
  font-size: 12px;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}
.gate-title {
  margin: 10px 0 0;
  font-size: 22px;
  font-weight: 600;
  color: var(--text-primary);
}
.gate-sub {
  margin: 10px 0 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-muted);
}
.gate-btn {
  margin-top: 22px;
  min-width: 140px;
  height: 40px;
  padding: 0 18px;
  border: none;
  border-radius: 10px;
  background: var(--primary);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.gate-btn-quiet {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
}
.gate-pwd-form {
  margin-top: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.gate-pwd-input {
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border-radius: 10px;
  border: 1px solid var(--border-color);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  box-sizing: border-box;
}
.gate-pwd-input:focus {
  border-color: var(--primary);
}
.gate-pwd-err {
  margin: 0;
  font-size: 12px;
  color: var(--danger-text);
  text-align: left;
}
.gate-pwd-actions {
  display: flex;
  justify-content: center;
  gap: 10px;
}
.gate-pwd-actions .gate-btn {
  margin-top: 6px;
  min-width: 120px;
}
</style>
