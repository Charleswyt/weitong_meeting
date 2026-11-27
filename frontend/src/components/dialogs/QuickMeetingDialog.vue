<template>
  <Teleport to="body">
    <div class="modal-overlay" :class="{ show: modelValue }" @click.self="close">
      <div class="modal-box qm-modal-box">
        <div class="modal-header">
          <div class="wt-dlg-head-left">
            <i class="wt-dlg-icon ri-flashlight-line" />
            <h3>快速会议</h3>
          </div>
          <button class="modal-close" type="button" aria-label="关闭" @click="close">
            <i class="ri-close-line" />
          </button>
        </div>

        <div class="quick-meeting-preview">
          <!-- 预览必须是真实取到的摄像头画面：开关只有作用在它身上，用户才看得见反馈。 -->
          <video
            v-show="cameraOn && previewReady"
            ref="previewRef"
            class="qm-preview-video"
            autoplay
            muted
            playsinline
          />
          <div v-if="!cameraOn || !previewReady" class="qm-avatar">
            <img v-if="avatarSrc" :src="avatarSrc" alt="头像" @error="avatarBroken = true" />
            <template v-else>{{ avatarChar }}</template>
          </div>
          <div class="qm-name">{{ displayName }}</div>
          <button class="qm-cam-toggle" type="button" :class="{ off: !cameraOn }" @click="toggleCamera">
            <i :class="cameraOn ? 'ri-vidicon-line' : 'ri-video-off-line'" />
            {{ cameraOn ? '关闭摄像头' : '开启摄像头' }}
          </button>
        </div>
        <div class="modal-body qm-body-compact">
          <div class="qm-topic-row">
            <label class="qm-label">会议主题</label>
            <input type="text" class="qm-topic-input" v-model="title" placeholder="请输入会议主题（可选）" />
          </div>
          <div class="qm-device-row">
            <!-- 两个按钮都要给出可感知的结果：麦克风改的是真实采集轨并换图标文案，
                 扬声器点是真放一段测试音（原来它只翻一个没人读的变量，等于没反应）。 -->
            <button class="qm-device-btn" type="button" :class="{ active: micOn }" @click="toggleMic">
              <i :class="micOn ? 'ri-mic-line' : 'ri-mic-off-line'" /> {{ micOn ? '麦克风已开' : '麦克风已静音' }}
            </button>
            <button class="qm-device-btn" type="button" :class="{ active: speakerOk }" @click="testSpeaker">
              <i class="ri-volume-up-line" /> {{ speakerTesting ? '试听中…' : '扬声器试听' }}
            </button>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" type="button" @click="close">取消</button>
          <button class="btn-confirm" type="button" :disabled="submitting" @click="submit">
            <i v-if="!submitting" class="ri-video-add-line" />
            {{ submitting ? '连接中…' : '立即开始' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { assetUrl } from '@/utils/request'
import { useMediaSettings } from '@/composables/useMediaSettings'
import { quickJoinPath } from '@/utils/joinFlow'
import { playToneToSink } from '@/utils/mediaTest'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'started'): void
}>()

const router = useRouter()
const userStore = useUserStore()

const submitting = ref(false)
const title = ref('')
const micOn = ref(true)
const speakerOk = ref(false)
const speakerTesting = ref(false)
const cameraOn = ref(true)

const { localStream, startPreview, stopPreview, error: mediaError, sessionDevices, loadPreferences } = useMediaSettings()
const previewRef = ref<HTMLVideoElement | null>(null)
const previewReady = ref(false)

// 开关作用到真实轨道上：画面立刻停/走，用户才看得到这次点击生效了。
function applyTrackFlags() {
  const stream = localStream.value
  if (!stream) return
  stream.getVideoTracks().forEach((t) => { t.enabled = cameraOn.value })
  stream.getAudioTracks().forEach((t) => { t.enabled = micOn.value })
}

async function openPreview() {
  const stream = await startPreview()
  if (!stream) {
    previewReady.value = false
    // 取不到画面要说得出为什么取不到，不能静默留一张头像冒充预览正常。
    ElMessage.warning(mediaError.value || '摄像头暂时开不了，可会中再开')
    return
  }
  previewReady.value = true
  await nextTick()
  if (previewRef.value) {
    previewRef.value.srcObject = stream
  }
  applyTrackFlags()
}

function toggleCamera() {
  cameraOn.value = !cameraOn.value
  applyTrackFlags()
}

function toggleMic() {
  micOn.value = !micOn.value
  applyTrackFlags()
}

async function testSpeaker() {
  if (speakerTesting.value) return
  speakerTesting.value = true
  try {
    // 第 34 项：试听必须打到用户在「设置」里点名那台扬声器上。不传 deviceId 就只走
    // AudioContext.destination = 系统默认输出，等于拿另一台设备去验证这台设备，用户听到的仍是"没声音"。
    const sink = sessionDevices.value.speaker || (await loadPreferences())?.speakerDeviceId || ''
    const res = await playToneToSink(sink)
    speakerOk.value = res.ok
    if (res.ok) ElMessage.success('已放测试音，没听到就换扬声器')
    else ElMessage.warning(res.reason || '测试音没放出，请换扬声器')
  } finally {
    speakerTesting.value = false
  }
}

watch([cameraOn, micOn, localStream], applyTrackFlags)

const displayName = computed(() => userStore.userInfo?.displayName || '我')
const avatarChar = computed(() => (displayName.value || '我').charAt(0))

const avatarBroken = ref(false)
const avatarSrc = computed(() => {
  const a = userStore.userInfo?.avatar
  return a && !avatarBroken.value ? assetUrl(a) : ''
})

async function reset() {
  const now = new Date()
  title.value = `临时会议 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  micOn.value = true
  speakerOk.value = false
  cameraOn.value = true

}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      reset()
      openPreview()
    } else {
      stopPreview()
      previewReady.value = false
    }
  },
)

onBeforeUnmount(() => stopPreview())

function close() {
  emit('update:modelValue', false)
}

function submit() {
  // 弹窗不再自己建会入会：把意图交给预检页，由那里点「发起会议」时才 quick-start + 入会。
  stopPreview()
  previewReady.value = false
  router.push(quickJoinPath({
    title: title.value.trim(),
    cloudRecord: false,
    micOn: micOn.value,
    cameraOn: cameraOn.value,
    displayName: displayName.value,
  }))
  emit('started')
  close()
}
</script>

<style scoped>
.qm-modal-box {
  width: min(440px, 94vw);
}
.qm-body-compact {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.qm-avatar { overflow: hidden; }
.qm-avatar img { width: 100%; height: 100%; object-fit: cover; }

/* 预览画面铺满，头像/名字浮在前层；关摄像头时画面撤掉、头像回到正中。 */
.qm-preview-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.quick-meeting-preview > .qm-avatar,
.quick-meeting-preview > .qm-name {
  position: relative;
  z-index: 1;
}
.quick-meeting-preview > .qm-name {
  padding: 2px 10px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.45);
}
.qm-cam-toggle.off {
  background: rgba(239, 68, 68, 0.85);
}
.qm-cam-toggle i {
  margin-right: 4px;
  vertical-align: -1px;
}
</style>
