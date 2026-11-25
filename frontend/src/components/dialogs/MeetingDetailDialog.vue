<template>
  <Teleport to="body">
    <div class="modal-overlay" :class="{ show: modelValue }" @click.self="close">
      <div class="modal-box" v-if="meeting">
        <div class="modal-header">
          <h3>会议详情</h3>
          <button class="modal-close" @click="close"><i class="ri-close-line" /></button>
        </div>
        <div class="modal-body">
          <div class="detail-title">{{ meeting.title }}</div>
          <div class="detail-grid">
            <div class="detail-row"><span class="dk">会议号</span><span class="dv">{{ meeting.meetingNo || '尚未同步' }}</span></div>
            <div class="detail-row"><span class="dk">开始时间</span><span class="dv">{{ formatDateTime(meeting.startTime) }}</span></div>
            <div class="detail-row"><span class="dk">时长</span><span class="dv">{{ meeting.durationMinutes }} 分钟</span></div>
            <div class="detail-row">
              <span class="dk">创建人</span>
              <span class="dv">{{ meeting.creatorName || meeting.hostName }}<template v-if="meeting.creatorPositionName"> · {{ meeting.creatorPositionName }}</template></span>
            </div>
            <div class="detail-row">
              <span class="dk">状态</span>
              <span class="dv"><span class="pill" :class="'pill-' + meeting.status">{{ statusText(meeting.status) }}</span></span>
            </div>
            <div class="detail-row">
              <span class="dk">同步态</span>
              <span class="dv"><span class="pill pill-plain">{{ localText(meeting.localStatus) }}</span></span>
            </div>
            <div class="detail-row"><span class="dk">录制</span><span class="dv">{{ meeting.cloudRecord ? '云端录制' : '不录制' }}</span></div>
          </div>

          <div class="link-block" v-if="joinLink">
            <div class="link-label">会议入口链接</div>
            <div class="link-row"><span class="link-text">{{ joinLink }}</span><button class="link-copy" @click="copy(joinLink)">复制</button></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="link-copy" @click="assistantOpen=true">材料与会议助手</button>
          <button class="btn-cancel" @click="close">关闭</button>
        </div>
      </div>
    </div>
  </Teleport>
  <MeetingAssistant v-if="meeting && modelValue" v-model="assistantOpen" :meeting-id="Number(meeting.id)" :number="String(meeting.meetingNo || '')" initial-tab="materials" />
</template>

<script setup lang="ts">
import MeetingAssistant from '@/components/meeting/MeetingAssistant.vue'
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { MeetingVo } from '@/api/meeting'
import { dictLabelSync, getDict, DICT } from '@/api/dict'
import { formatDateTime } from '@/utils/time'
import { ensureShareOrigin, joinUrlFor } from '@/utils/joinFlow'
import { copyText } from '@/utils/clipboard'

const props = defineProps<{ modelValue: boolean; meeting: MeetingVo | null }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>()

const assistantOpen = ref(false)
const originTick = ref(0)
// 链接用可分享 origin（localhost → 局域网 IP），不再由后端下发。
const joinLink = computed(() => {
  void originTick.value
  return joinUrlFor(props.meeting?.meetingNo || '')
})

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return
    await ensureShareOrigin()
    originTick.value += 1
  },
)

getDict(DICT.meetingStatus)
getDict(DICT.localSyncStatus)

function close() {
  assistantOpen.value=false
  emit('update:modelValue', false)
}
function statusText(s: string) {
  return dictLabelSync(DICT.meetingStatus, s) || s
}
function localText(s: string) {
  return dictLabelSync(DICT.localSyncStatus, s) || s
}
async function copy(text: string) {
  await ensureShareOrigin()
  originTick.value += 1
  const url = joinUrlFor(props.meeting?.meetingNo || '') || text
  const ok = await copyText(url)
  if (ok) ElMessage.success('已复制')
  else ElMessage.error('复制失败，请长按选中后手动复制')
}
</script>

<style scoped>
.detail-title { font-size: 18px; font-weight: 600; color: var(--text-primary, #fff); margin-bottom: 16px; }
.detail-grid { display: flex; flex-direction: column; gap: 10px; }
.detail-row { display: flex; align-items: center; gap: 12px; font-size: 14px; }
.detail-row .dk { width: 72px; color: var(--text-secondary); flex-shrink: 0; }
.detail-row .dv { color: var(--text-primary, #fff); }
.pill { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 12px; background: rgba(22,93,255,0.15); color: var(--primary, #165DFF); }
.pill-running { background: rgba(34,197,94,0.15); color: var(--success, #22C55E); }
.pill-ended { background: rgba(120,120,140,0.18); color: var(--text-secondary); }
.pill-plain { background: var(--bg-input); color: var(--text-secondary); }
.link-block { margin-top: 16px; }
.link-label { font-size: 13px; color: var(--text-secondary); margin-bottom: 6px; }
.link-row { display: flex; align-items: center; gap: 8px; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 8px; padding: 8px 12px; }
.link-text { flex: 1; font-size: 13px; color: var(--text-primary, #fff); word-break: break-all; }
.link-copy { padding: 4px 12px; border: none; border-radius: 6px; background: var(--primary, #165DFF); color: #fff; font-size: 13px; cursor: pointer; }
</style>
