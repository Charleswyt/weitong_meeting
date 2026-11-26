<template>
  <Teleport to="body">
    <div class="modal-overlay" :class="{ show: modelValue }" @click.self="close">
      <div class="schedule-modal">
        <div class="schedule-header">
          <div class="schedule-head-left">
            <i class="schedule-head-icon ri-calendar-schedule-line" />
            <h3>{{ isEdit ? '修改会议' : '预约会议' }}</h3>
          </div>
          <button class="modal-close" @click="close"><i class="ri-close-line" /></button>
        </div>
        <div class="schedule-body">
          <div class="form-group-modal">
            <label>会议主题 <span class="required">*</span></label>
            <input type="text" v-model="form.title" placeholder="请输入会议主题" maxlength="64" />
          </div>

          <div class="form-group-modal">
            <label>开始时间</label>
            <div class="form-row-2">
              <el-date-picker
                v-model="form.date"
                type="date"
                placeholder="选择日期"
                format="YYYY-MM-DD"
                value-format="YYYY-MM-DD"
                style="width: 100%"
              />
              <el-time-picker
                v-model="form.time"
                placeholder="选择时间"
                format="HH:mm"
                value-format="HH:mm"
                style="width: 100%"
              />
            </div>
          </div>

          <div class="form-group-modal">
            <label>会议时长</label>
            <select v-model="durationPreset" class="form-select">
              <option value="15">15 分钟</option>
              <option value="30">30 分钟</option>
              <option value="45">45 分钟</option>
              <option value="60">1 小时</option>
              <option value="120">2 小时</option>
              <option value="custom">自定义</option>
            </select>
            <input
              v-if="durationPreset === 'custom'"
              class="custom-duration"
              type="number"
              v-model.number="form.durationMinutes"
              min="1"
              max="120"
              placeholder="分钟"
            />
          </div>

          <div class="form-group-modal">
            <label>时区</label>
            <select v-model="tzOffset" class="form-select">
              <option value="+08:00">(GMT+08:00) 北京时间</option>
              <option value="+09:00">(GMT+09:00) 东京时间</option>
              <option value="Z">(GMT+00:00) 协调世界时 / 伦敦</option>
              <option value="-05:00">(GMT-05:00) 纽约时间</option>
            </select>
          </div>

          <div class="settings-section">
            <div class="settings-title"><i class="ri-settings-3-line settings-title-icon" />会议设置</div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label"><i class="ri-mic-off-line row-icon" />成员入会时静音</span>
              </div>
              <div class="toggle-switch" :class="{ on: muteOnJoin }" @click="muteOnJoin = !muteOnJoin"></div>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label"><i class="ri-video-off-line row-icon" />成员入会时关闭摄像头</span>
              </div>
              <div class="toggle-switch" :class="{ on: cameraOff }" @click="cameraOff = !cameraOff"></div>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label">允许成员在主持人入会前等待</span>
                <span class="setting-desc">主持人入会前，先到的成员进等候页</span>
              </div>
              <div class="toggle-switch" :class="{ on: allowWaiting }" @click="allowWaiting = !allowWaiting"></div>
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label"><i class="ri-lock-password-line row-icon" />入会密码</span>
                <span class="setting-desc">可选，留空表示无需密码；主持人免密进入</span>
              </div>
              <input
                v-model="meetingPassword"
                type="text"
                maxlength="32"
                class="pwd-input"
                :placeholder="isEdit && props.meeting?.hasPassword ? '已设密码（留空保持不变）' : '选填，如 6 位数字'"
              />
            </div>

            <div class="setting-row">
              <div class="setting-info">
                <span class="setting-label"><i class="ri-cloud-line row-icon" />云端录制</span>
                <span class="setting-desc">主持人在会中开启，成员同意后录制。回放由主持人分发。</span>
              </div>
            </div>
          </div>

          <!-- 原型（03_schedule_dlg.png）到「会议设置」三颗开关为止，弹窗里没有受邀成员区；
               第 39 项也明确"受邀成员相关功能暂时不要"，所以这里不放人员勾选。
               后端 participantIds 仍是可选字段（历史预约的名单照旧可读），只是不由这个弹窗录入。 -->
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" @click="close">取消</button>
          <button class="btn-confirm" :disabled="submitting || !canSubmit" @click="submit">
            <i v-if="!submitting" class="ri-check-line" />
            {{ submitting ? '提交中…' : (isEdit ? '保存修改' : '确定预约') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { scheduleMeeting, updateMeeting, type MeetingVo } from '@/api/meeting'

const props = defineProps<{ modelValue: boolean; presetTitle?: string; meeting?: MeetingVo | null }>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'created'): void
}>()

const isEdit = computed(() => !!props.meeting)
const submitting = ref(false)
const tzOffset = ref('+08:00')
const muteOnJoin = ref(true)
const cameraOff = ref(false)
const allowWaiting = ref(true)
const meetingPassword = ref('')
const durationPreset = ref('60')

const form = reactive({
  title: '',
  date: '',
  time: '',
  durationMinutes: 60,
})

const canSubmit = computed(() => {
  return form.title.trim() && form.date && form.time
})

function reset() {
  form.title = ''
  form.date = ''
  form.time = ''
  form.durationMinutes = 60
  durationPreset.value = '60'
  tzOffset.value = '+08:00'
  muteOnJoin.value = true
  cameraOff.value = false
  allowWaiting.value = true
}

function pad(n: number) {
  return String(n).padStart(2, '0')
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      reset()
      const m = props.meeting
      if (m) {
        const d = new Date(m.startTime)
        if (!isNaN(d.getTime())) {
          form.date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
          form.time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
        }
        form.title = m.title
        form.durationMinutes = m.durationMinutes
        durationPreset.value = ['15', '30', '45', '60'].includes(String(m.durationMinutes)) ? String(m.durationMinutes) : 'custom'
        muteOnJoin.value = m.muteOnJoin
        cameraOff.value = m.cameraOffOnJoin
        allowWaiting.value = m.allowWaiting
      } else if (props.presetTitle) {
        form.title = props.presetTitle
      }
    }
  },
)

watch(durationPreset, (val) => {
  if (val !== 'custom') {
    form.durationMinutes = Number(val)
  }
})

function close() {
  emit('update:modelValue', false)
}

async function submit() {
  if (!form.title.trim()) {
    ElMessage.warning('请输入会议主题')
    return
  }
  if (!form.date || !form.time) {
    ElMessage.warning('请选择日期和时间')
    return
  }
  submitting.value = true
  try {
    // 墙钟时间 + 所选偏移直发，不做浏览器时区往返，避免跨时区预定被换算错。
    const startISO = `${form.date}T${form.time}:00${tzOffset.value === 'Z' ? 'Z' : tzOffset.value}`
    const payload: Record<string, any> = {
      title: form.title.trim(),
      startTime: startISO,
      durationMinutes: form.durationMinutes,
      cloudRecord: props.meeting?.cloudRecord ?? false,
      muteOnJoin: muteOnJoin.value,
      cameraOff: cameraOff.value,
      allowWaiting: allowWaiting.value,
    }
    const pwd = meetingPassword.value.trim()
    if (!isEdit.value) {
      if (pwd) payload.password = pwd
    } else if (pwd) {
      payload.password = pwd
    }
    if (isEdit.value && props.meeting) {
      await updateMeeting(props.meeting.id, payload as any)
      ElMessage.success('会议已修改')
    } else {
      await scheduleMeeting(payload as any)
      ElMessage.success('预约成功')
    }
    meetingPassword.value = ''
    emit('created')
    close()
  } catch {
    // 由 request 拦截器统一提示
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.schedule-modal {
  width: 560px;
  max-height: 90vh;
  overflow-y: auto;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15);
}

.schedule-head-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.schedule-head-icon {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: var(--primary-soft);
  color: var(--primary-text);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
}

.settings-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.settings-title-icon {
  color: var(--primary-text);
  font-size: 14px;
}

.row-icon {
  font-size: 14px;
  margin-right: 6px;
}

.custom-duration {
  width: 100%;
  height: 38px;
  margin-top: 8px;
  padding: 0 12px;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
}

.todo-tag {
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 400;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  gap: 16px;
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.setting-label {
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 500;
}

.setting-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
}

.toggle-switch {
  width: 44px;
  height: 26px;
  border-radius: 9999px;
  background: var(--border-color);
  position: relative;
  cursor: pointer;
  transition: background 0.2s;
  flex-shrink: 0;
}

.toggle-switch::after {
  content: '';
  position: absolute;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fff;
  top: 3px;
  left: 3px;
  transition: transform 0.2s;
}

.toggle-switch.on {
  background: var(--primary);
}

.toggle-switch.on::after {
  transform: translateX(18px);
}
.pwd-input {
  width: 170px;
  height: 32px;
  padding: 0 10px;
  font-size: 12.5px;
  border-radius: 7px;
  border: 1px solid var(--border-color);
  background: var(--bg-input);
  color: var(--text-primary);
  outline: none;
}
.pwd-input:focus {
  border-color: var(--primary);
}

.toggle-switch.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.schedule-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px 16px;
  border-bottom: 1px solid var(--border-color);
}

.schedule-header h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.schedule-body {
  padding: 20px 24px;
}

.required {
  color: #e53935;
  font-weight: 400;
}

.form-select {
  width: 100%;
  padding: 8px 12px;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
}

.settings-section {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.settings-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 16px;
}

.setting-row + .setting-row {
  border-top: 1px solid var(--border-color);
}
</style>
