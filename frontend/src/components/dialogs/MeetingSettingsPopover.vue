<template>
  <el-dialog
    :model-value="modelValue"
    title="会议中设置"
    width="min(460px, calc(100vw - 28px))"
    @update:model-value="$emit('update:modelValue', $event)"
    @open="syncFromPrefs"
  >
    <el-alert v-if="error" type="error" :closable="false" show-icon style="margin-bottom: 16px">
      <template #title>{{ error }}</template>
    </el-alert>
    <div class="msp-body">
      <el-tabs v-model="tab">
        <el-tab-pane label="设备" name="devices">
      <el-form label-position="top">
        <el-form-item label="摄像头">
          <el-select v-model="cameraDevice" style="width: 100%" placeholder="默认" @change="apply">
            <el-option value="" label="默认摄像头" />
            <el-option v-for="d in devices.cameras" :key="d.deviceId" :label="labelOf(d, '摄像头')" :value="d.deviceId" />
          </el-select>
        </el-form-item>
        <el-form-item label="麦克风">
          <el-select v-model="micDevice" style="width: 100%" placeholder="默认" @change="apply">
            <el-option value="" label="默认麦克风" />
            <el-option v-for="d in devices.microphones" :key="d.deviceId" :label="labelOf(d, '麦克风')" :value="d.deviceId" />
          </el-select>
        </el-form-item>
        <el-form-item label="扬声器">
          <el-select v-model="speakerDevice" style="width: 100%" placeholder="默认" @change="apply">
            <el-option value="" label="默认扬声器" />
            <el-option v-for="d in devices.speakers" :key="d.deviceId" :label="labelOf(d, '扬声器')" :value="d.deviceId" />
          </el-select>
        </el-form-item>
        <el-form-item label="麦克风音量">
          <el-slider v-model="micVolume" :min="0" :max="100" @change="apply" />
        </el-form-item>
        <el-form-item label="背景虚化">
          <el-switch v-model="bgBlur" @change="apply" />
        </el-form-item>
        <el-form-item label="人脸增强">
          <el-switch v-model="faceEnabled" :disabled="!faceSupported" @change="applyFace" />
        </el-form-item>
      </el-form>
      <div v-if="statusText" class="msp-status" :class="statusClass">{{ statusText }}</div>
      <div v-if="bgBlurNotice" class="msp-note">{{ bgBlurNotice }}</div>
      <div v-if="faceNotice" class="msp-note">{{ faceNotice }}</div>
      <div class="msp-note">切换设备会重启采集。人脸增强作用于发给其他成员的画面。</div>
        </el-tab-pane>
        <el-tab-pane label="视频传输" name="delivery"><VideoDeliverySettings :apply-live="applyLive" /></el-tab-pane>
      </el-tabs>
    </div>
    <template #footer>
      <el-button @click="$emit('update:modelValue', false)">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import VideoDeliverySettings from '@/components/VideoDeliverySettings.vue'
import type { VideoKind, VideoDelivery } from '@/utils/videoDelivery'
import { ref } from 'vue'
import { useMediaSettings } from '@/composables/useMediaSettings'
import { useFaceEnhancement } from '@/composables/useFaceEnhancement'

defineProps<{ modelValue: boolean; applyLive?: (kind: VideoKind, value: VideoDelivery) => Promise<boolean> }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void; (e: 'changed'): void }>()

const { prefs, devices, error, bgBlurNotice, loadPreferences, savePreferences, enumerateDevices } = useMediaSettings()
const { supported: faceSupported, enabled: faceEnabled, notice: faceNotice, loadSupport: loadFaceSupport, setEnabled: setFaceEnabled } = useFaceEnhancement()

const tab = ref('devices')
const cameraDevice = ref('')
const micDevice = ref('')
const speakerDevice = ref('')
const micVolume = ref(80)
const bgBlur = ref(false)
const statusText = ref('')
const statusClass = ref('')
let statusTimer: number | null = null
let applyTimer: number | null = null

function showStatus(text: string, kind: 'ok' | 'err' | 'info' = 'ok') {
  statusText.value = text
  statusClass.value = kind === 'err' ? 'is-err' : kind === 'info' ? 'is-info' : 'is-ok'
  if (statusTimer) window.clearTimeout(statusTimer)
  statusTimer = window.setTimeout(() => {
    statusText.value = ''
    statusClass.value = ''
  }, 2400)
}

async function syncFromPrefs() {
  tab.value = 'devices'
  statusText.value = ''
  statusClass.value = ''
  const p = await loadPreferences()
  cameraDevice.value = p?.cameraDeviceId || ''
  micDevice.value = p?.microphoneDeviceId || ''
  speakerDevice.value = p?.speakerDeviceId || ''
  micVolume.value = p?.micVolume ?? 80
  bgBlur.value = p?.vbMode === 'blur'
  await loadFaceSupport()
  faceEnabled.value = p?.faceEnhancement === 1 && faceSupported.value
  await enumerateDevices()
}

function labelOf(d: MediaDeviceInfo, fallback: string) {
  return d.label || `${fallback} ${d.deviceId.slice(0, 6)}`
}

async function apply() {
  // 滑块连续拖动会连发 change：合并到一次保存，状态文案写在弹窗内，避免全局 Toast 刷屏。
  if (applyTimer) window.clearTimeout(applyTimer)
  applyTimer = window.setTimeout(() => {
    void doApply()
  }, 180)
}

async function doApply() {
  if (!prefs.value) await loadPreferences()
  if (!prefs.value) {
    showStatus('偏好加载失败，无法保存', 'err')
    return
  }
  try {
    await savePreferences({
      ...prefs.value,
      cameraDeviceId: cameraDevice.value,
      microphoneDeviceId: micDevice.value,
      speakerDeviceId: speakerDevice.value,
      micVolume: micVolume.value,
      vbMode: bgBlur.value ? 'blur' : 'off',
    })
    emit('changed')
    showStatus('已应用')
  } catch {
    // 失败提示由 request.ts 拦截器统一弹后端 msg（第 7 项），这里不再叠第二条、也不自造文案
    showStatus('保存失败，请稍后重试', 'err')
  }
}

async function applyFace() {
  // 人脸增强只启停检测，不重建采集 —— 与设备类改动分开。
  try {
    await setFaceEnabled(faceEnabled.value)
    showStatus(faceEnabled.value ? '人脸增强已开启' : '人脸增强已关闭', 'info')
  } catch {
    showStatus('人脸增强切换失败', 'err')
  }
}
</script>

<style scoped>
.msp-note {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}
.msp-status {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
  line-height: 1.4;
}
.msp-status.is-ok {
  background: rgba(34, 197, 94, 0.12);
  color: var(--success-text, #15803d);
}
.msp-status.is-err {
  background: var(--danger-bg, rgba(239, 68, 68, 0.12));
  color: var(--danger-text, #b91c1c);
}
.msp-status.is-info {
  background: var(--primary-soft, rgba(22, 93, 255, 0.1));
  color: var(--primary-text, #165dff);
}
/* 项数变多后正文会顶出弹窗；el-dialog 是 teleport 到 body 的，:deep 打不到它，
   所以限高落在自己这层容器上 —— 不然就是"开关存在但看不见"。 */
.msp-body {
  max-height: 58vh;
  overflow-y: auto;
}
</style>
