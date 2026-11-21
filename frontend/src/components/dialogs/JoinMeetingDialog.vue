<template>
  <Teleport to="body">
    <div class="join-meeting-modal" :class="{ active: modelValue }" @click.self="close">
      <div class="join-meeting-dialog">
        <div class="jm-title">加入会议</div>
        <div class="jm-subtitle">请输入会议号，或粘贴完整邀请信息。</div>
        <div class="jm-input-wrap">
          <input
            type="text"
            class="jm-input"
            :class="{ error: !!errorMsg }"
            v-model="rawNumber"
            placeholder="会议号或粘贴邀请信息"
            @input="onInput"
            @paste="onPaste"
          />
          <div class="jm-error-msg" :class="{ show: !!errorMsg }">{{ errorMsg }}</div>
        </div>
        <div class="jm-input-wrap">
          <input
            type="text"
            class="jm-input jm-input-name"
            v-model="displayName"
            maxlength="32"
            placeholder="输入您的名称"
          />
        </div>
        <div class="jm-checkbox-row">
          <input type="checkbox" id="jmMicOnCheckbox" v-model="micOn" :disabled="!autoConnectAudio" />
          <label for="jmMicOnCheckbox">入会开启麦克风</label>
        </div>
        <div class="jm-checkbox-row">
          <input type="checkbox" id="jmCameraOnCheckbox" v-model="cameraOn" />
          <label for="jmCameraOnCheckbox">入会开启摄像头</label>
        </div>
        <div class="jm-checkbox-row">
          <input type="checkbox" id="jmAutoAudioCheckbox" v-model="autoConnectAudio" />
          <label for="jmAutoAudioCheckbox">自动连接音频</label>
        </div>
        <div class="jm-actions">
          <button class="jm-join-btn" type="button" :disabled="submitting" @click="submit">
            {{ submitting ? '加入中…' : '进入会议' }}
          </button>
          <button class="jm-cancel-btn" type="button" @click="close">取消</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { precheckMeeting } from '@/api/meeting'
import { useUserStore } from '@/store/user'
import { formatJoinInputMeetingNo, parseMeetingNoFromText, preJoinPathByNumber } from '@/utils/joinFlow'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const router = useRouter()
const userStore = useUserStore()

const rawNumber = ref('')
const displayName = ref('')
const errorMsg = ref('')
/** 默认不勾选：入会不开麦 */
const micOn = ref(false)
/** 默认不勾选：入会不开摄像头 */
const cameraOn = ref(false)
/** 默认勾选：自动连接音频；关掉则不开麦、不采麦 */
const autoConnectAudio = ref(true)
const submitting = ref(false)

function applyInviteOrNumber(raw: string) {
  const parsed = parseMeetingNoFromText(raw)
  if (parsed) {
    rawNumber.value = formatJoinInputMeetingNo(parsed)
    if (errorMsg.value) errorMsg.value = ''
    return
  }
  rawNumber.value = formatJoinInputMeetingNo(raw)
  if (errorMsg.value && rawNumber.value.replace(/\D/g, '').length >= 6) errorMsg.value = ''
}

function onInput() {
  applyInviteOrNumber(rawNumber.value)
}

function onPaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData('text') || ''
  if (!text || text.length < 6) return
  if (/会议|http|卫通|#/.test(text) || text.length > 16) {
    e.preventDefault()
    applyInviteOrNumber(text)
  }
}

watch(autoConnectAudio, (on) => {
  if (!on) micOn.value = false
})

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      rawNumber.value = ''
      errorMsg.value = ''
      micOn.value = false
      cameraOn.value = false
      autoConnectAudio.value = true
      displayName.value = (userStore.userInfo?.displayName || '').slice(0, 32)
    }
  },
)

function close() {
  emit('update:modelValue', false)
}

async function submit() {
  const number = rawNumber.value.replace(/\D/g, '')
  if (!/^\d{6,12}$/.test(number)) {
    errorMsg.value = '请输入正确的会议号（6-12 位数字）'
    return
  }
  submitting.value = true
  try {
    const res = await precheckMeeting(number)
    if (res.data && !res.data.joinable) {
      errorMsg.value = res.data.message || '会议不可加入'
      return
    }
    const name = displayName.value.trim().slice(0, 32)
    const wantMic = autoConnectAudio.value && micOn.value
    close()
    router.push(
      preJoinPathByNumber(number, {
        micOn: wantMic,
        cameraOn: cameraOn.value,
        autoAudio: autoConnectAudio.value,
        name: name || undefined,
      }),
    )
  } finally {
    submitting.value = false
  }
}
</script>
