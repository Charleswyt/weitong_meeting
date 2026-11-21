<template>
  <div class="empty-meeting-page">
    <div class="empty-center">
      <div class="empty-icon">
        <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
          <rect x="10" y="20" width="60" height="40" rx="4" stroke="var(--text-muted)" stroke-width="2" fill="none" />
          <circle cx="40" cy="40" r="12" stroke="var(--text-muted)" stroke-width="2" fill="none" />
          <path d="M36 40 L44 40 M40 36 L40 44" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round" />
        </svg>
      </div>
      <div class="empty-title">您还未进入会议</div>
      <div class="empty-sub">输入会议号，快速加入正在进行的会议</div>

      <div class="empty-join-row">
        <input
          type="text"
          class="empty-join-input"
          v-model="meetingNumber"
          placeholder="请输入会议号"
          maxlength="12"
          @input="onNumberInput"
          @keyup.enter="handleJoin"
        />
        <button class="empty-join-btn" :disabled="!meetingNumber || joining" @click="handleJoin">
          {{ joining ? '加入中…' : '进入会议' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { precheckMeeting } from '@/api/meeting'
import { preJoinPathByNumber } from '@/utils/joinFlow'

const router = useRouter()

const meetingNumber = ref('')
const joining = ref(false)

function onNumberInput() {
  meetingNumber.value = meetingNumber.value.replace(/\D/g, '').slice(0, 12)
}

async function handleJoin() {
  const number = meetingNumber.value.trim()
  if (!/^\d{6,12}$/.test(number)) {
    ElMessage.warning('请输入正确的会议号（6-12 位数字）')
    return
  }
  const res = await precheckMeeting(number)
  if (res.data && !res.data.joinable) {
    ElMessage.error(res.data.message || '会议不可加入')
    return
  }
  // 交给过渡页直接进入。设备用已保存的设置，这里不再打开第二套确认页。
  router.push(preJoinPathByNumber(number))
}
</script>

<style scoped>
.empty-meeting-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: calc(100vh - 80px);
  position: relative;
}

.empty-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.empty-icon {
  margin-bottom: 8px;
}

.empty-title {
  font-size: 22px;
  font-weight: 600;
  color: var(--text-primary);
}

.empty-sub {
  font-size: 14px;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.empty-join-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.empty-join-input {
  width: 260px;
  padding: 10px 16px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 15px;
  outline: none;
}

.empty-join-input:focus {
  border-color: var(--primary);
}

.empty-join-btn {
  padding: 10px 24px;
  background: var(--primary);
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
}

.empty-join-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
