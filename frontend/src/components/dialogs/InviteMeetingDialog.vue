<template>
  <el-dialog
    :model-value="modelValue"
    width="600px"
    class="inv-dialog"
    :show-close="false"
    align-center
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <template #header>
      <div class="wt-dlg-head-left">
        <i class="wt-dlg-icon ri-group-line" />
        <h3 class="el-dialog__title">邀请参会人</h3>
      </div>
      <button class="modal-close" type="button" aria-label="关闭" @click="$emit('update:modelValue', false)">
        <i class="ri-close-line" />
      </button>
    </template>

    <div class="inv-body">
      <div class="inv-field">
        <label>会议链接</label>
        <div class="inv-input">
          <span class="inv-value inv-link" :title="joinUrl">{{ joinUrl || '–' }}</span>
          <button class="inv-copy" :disabled="!joinUrl" @click="copy(joinUrl, '会议链接')">复制</button>
        </div>
      </div>

      <div v-if="qrDataUrl" class="inv-qr">
        <img :src="qrDataUrl" alt="入会二维码" width="168" height="168" />
        <p>扫码入会（内容即上方会议链接）</p>
      </div>
    </div>

    <template #footer>
      <button class="btn-cancel" type="button" @click="$emit('update:modelValue', false)">取消</button>
      <button class="btn-confirm" type="button" :disabled="!inviteText" @click="copy(inviteText, '邀请信息')">
        <i class="ri-file-copy-line" />复制邀请信息
      </button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import QRCode from 'qrcode'
import { getMeetingDetail } from '@/api/meeting'
import { ensureShareOrigin, inviteTextFor, joinUrlFor } from '@/utils/joinFlow'
import { copyText } from '@/utils/clipboard'

const props = defineProps<{ modelValue: boolean; meetingId: number; meetingNo: string; title: string }>()

defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

// 链接用可分享 origin（localhost → 局域网 IP）；会议号只嵌在路径里，弹层不再单独展示。
const originTick = ref(0)
const joinUrl = computed(() => {
  void originTick.value
  return props.meetingNo ? joinUrlFor(props.meetingNo) : ''
})
const qrDataUrl = ref('')
const hostName = ref('')
const startTime = ref('')
const durationMinutes = ref(0)

const inviteText = computed(() => {
  void originTick.value
  return inviteTextFor({
    hostName: hostName.value,
    title: props.title,
    meetingNo: props.meetingNo,
    startTime: startTime.value,
    durationMinutes: durationMinutes.value,
  })
})

async function load() {
  if (!props.meetingId) return
  try {
    const m = (await getMeetingDetail(props.meetingId)).data
    hostName.value = m?.hostName || m?.creatorName || ''
    startTime.value = m?.startTime || m?.startedAt || ''
    durationMinutes.value = m?.durationMinutes || 0
  } catch {
    /* 后端 msg 由 request 拦截器统一弹一次 */
  }
}

async function refreshShareSurface() {
  await ensureShareOrigin()
  originTick.value += 1
  const url = props.meetingNo ? joinUrlFor(props.meetingNo) : ''
  if (!url) {
    qrDataUrl.value = ''
    return
  }
  try {
    qrDataUrl.value = await QRCode.toDataURL(url, { margin: 1, width: 336 })
  } catch {
    /* 二维码生成失败不影响复制链接 */
  }
}

watch(() => props.modelValue, async (v) => {
  if (!v) return
  load()
  await refreshShareSurface()
})

watch(
  () => props.meetingNo,
  async () => {
    if (!props.modelValue) return
    await refreshShareSurface()
  },
)

async function copy(text: string, what: string) {
  await refreshShareSurface()
  const payload =
    what === '会议链接'
      ? joinUrlFor(props.meetingNo)
      : what === '邀请信息'
        ? inviteTextFor({
            hostName: hostName.value,
            title: props.title,
            meetingNo: props.meetingNo,
            startTime: startTime.value,
            durationMinutes: durationMinutes.value,
          })
        : text
  if (!payload) {
    ElMessage.warning(`${what}尚未就绪`)
    return
  }
  const ok = await copyText(payload)
  if (ok) ElMessage.success(`${what}已复制`)
  else ElMessage.error('复制失败，请长按选中后手动复制')
}
</script>

<style scoped>
.inv-head { display: flex; align-items: center; gap: 10px; }
.inv-head-icon {
  width: 34px; height: 34px; border-radius: 10px; background: var(--primary-soft);
  display: flex; align-items: center; justify-content: center; font-size: 16px;
}
.inv-head-title { font-size: 17px; font-weight: 600; color: var(--text-primary); }
.inv-close {
  margin-left: auto; border: 0; background: transparent; cursor: pointer;
  color: var(--text-muted); font-size: 16px; width: 28px; height: 28px; border-radius: 8px;
}
.inv-close:hover { background: var(--bg-hover); color: var(--text-primary); }

.inv-body { display: flex; flex-direction: column; gap: 18px; }
.inv-field label { display: block; margin-bottom: 8px; font-size: 13px; color: var(--text-tertiary); }
.inv-input {
  display: flex; align-items: center; height: 46px; padding: 0 6px 0 15px;
  background: var(--bg-input); border: 1px solid var(--border-color); border-radius: var(--radius);
}
.inv-value { flex: 1; min-width: 0; font-size: 14px; color: var(--text-primary); font-weight: 500; }
.inv-link { font-weight: 400; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.inv-copy {
  flex-shrink: 0; height: 32px; padding: 0 12px; border: 1px solid var(--border-color);
  background: #fff; border-radius: 8px; font-size: 12px; color: var(--text-secondary); cursor: pointer;
}
.inv-copy:hover:not(:disabled) { border-color: var(--primary); color: var(--primary-text); }
.inv-copy:disabled { color: var(--text-muted); cursor: not-allowed; }

.inv-qr { display: flex; flex-direction: column; align-items: center; gap: 8px; padding-top: 4px; }
.inv-qr img { border: 1px solid var(--border-soft); border-radius: var(--radius); }
.inv-qr p { margin: 0; font-size: 12px; color: var(--text-tertiary); }

.inv-foot { display: flex; justify-content: flex-end; gap: 12px; }
.inv-cancel, .inv-confirm { height: 44px; padding: 0 24px; border-radius: var(--radius); font-size: 14px; cursor: pointer; }
.inv-cancel { border: 1px solid var(--border-color); background: #fff; color: var(--text-secondary); }
.inv-cancel:hover { background: var(--bg-hover); }
.inv-confirm { border: 0; background: var(--primary); color: #fff; }
.inv-confirm:hover:not(:disabled) { background: var(--primary-dark); }
.inv-confirm:disabled { background: var(--border-color); color: var(--text-muted); cursor: not-allowed; }
</style>
