<template>
  <div class="pick-root">
    <h1 class="pick-title">选择本地录制保存位置</h1>
    <p class="pick-desc">这个窗口只负责选文件夹。选完会自动关闭，回到原来的页面就能看到新位置。</p>

    <button class="pick-btn" :disabled="!!picked" @click="choose">
      {{ picked ? '已选择' : (hasDir ? '重新选择文件夹' : '选择文件夹') }}
    </button>

    <p v-if="picked" class="pick-done">已选「{{ picked }}」，窗口马上关闭</p>
    <p v-else-if="error" class="pick-err">{{ error }}</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { DirPickerBlockedError, dirPickerBlocker, getRecordingDirName, pickRecordingDir } from '@/utils/localRecorder'

const picked = ref('')
const hasDir = ref(false)
const error = ref('')

onMounted(async () => {
  hasDir.value = !!(await getRecordingDirName())
  const blocker = dirPickerBlocker()
  if (blocker !== 'ok') error.value = BLOCKER_HINT[blocker]
})

/** 这里不自动弹选择器：showDirectoryPicker 要瞬时用户手势，而手势不随新窗口带过来，自动调必被拒。 */
async function choose() {
  error.value = ''
  try {
    picked.value = await pickRecordingDir()
    window.setTimeout(() => window.close(), 1200)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return
    error.value = e instanceof DirPickerBlockedError ? BLOCKER_HINT[e.blocker] : '没能打开选择器，请再试一次'
  }
}

const BLOCKER_HINT: Record<Exclude<ReturnType<typeof dirPickerBlocker>, 'ok'>, string> = {
  unsupported: '这台设备的浏览器不能直接选文件夹，请改用下载保存录制',
  'insecure-context': '当前地址不是加密连接，浏览器不允许选文件夹；请用加密地址或本机地址打开本系统',
}
</script>

<style scoped>
.pick-root {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  box-sizing: border-box;
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 13px;
}
.pick-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.pick-desc {
  margin: 0;
  color: var(--text-muted);
  line-height: 1.6;
}
.pick-btn {
  padding: 8px 18px;
  border: 0;
  border-radius: 6px;
  background: var(--primary);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
}
.pick-btn:disabled {
  background: var(--border-color);
  color: var(--text-muted);
  cursor: default;
}
.pick-done {
  margin: 0;
  color: var(--success-text);
}
.pick-err {
  margin: 0;
  color: var(--danger);
  line-height: 1.6;
}
</style>
