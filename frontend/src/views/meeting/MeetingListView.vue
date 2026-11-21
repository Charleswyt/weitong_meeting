<template>
  <div class="main-layout-wrap" style="flex:1">
    <div class="content-scroll">
      <div class="main-content" style="padding:16px 20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
          <div>
            <h2 style="font-size:22px;font-weight:700;">会议管理</h2>
            <p style="font-size:13px;color:var(--text-muted);margin-top:4px;">管理和组织你的所有会议</p>
          </div>
          <!-- 原型 顶部操作按钮组：gap 12、h44、r11、pad 0 20、14/Medium，次按钮白底主色描边、主按钮实心 -->
          <div class="ml-top-actions">
            <button class="ml-btn ml-btn-ghost" :disabled="starting" @click="startNow"><i class="ri-flashlight-line" /> {{ starting ? '正在开始…' : '开始会议' }}</button>
            <button class="ml-btn ml-btn-solid" @click="showScheduleDialog = true"><i class="ri-calendar-schedule-line" /> 预约会议</button>
          </div>
        </div>

        <div class="mm-stats-grid">
          <div class="mm-stat-card">
            <div class="mm-stat-label">本周会议</div>
            <div class="mm-stat-row"><span class="mm-stat-value">{{ stats.weekCount }}</span></div>
          </div>
          <div class="mm-stat-card">
            <div class="mm-stat-label">待开始</div>
            <div class="mm-stat-row"><span class="mm-stat-value">{{ stats.pendingCount }}</span><span class="mm-stat-unit">场会议</span></div>
          </div>
          <div class="mm-stat-card">
            <div class="mm-stat-label">我发起的</div>
            <div class="mm-stat-row"><span class="mm-stat-value">{{ stats.myCount }}</span><span class="mm-stat-unit">场会议</span></div>
          </div>
          <div class="mm-stat-card">
            <div class="mm-stat-label">会议时长</div>
            <div class="mm-stat-row"><span class="mm-stat-value">{{ (stats.totalMinutes / 60).toFixed(1) }}</span><span class="mm-stat-unit">小时</span></div>
          </div>
        </div>

        <div class="mm-tab-row">
          <div style="display:flex;gap:0;">
            <div v-for="t in tabs" :key="t.key" class="mtab" :class="{ active: activeTab === t.key }" @click="activeTab = t.key">
              {{ t.label }}
              <span class="mtab-count">{{ countOf(t.key) }}</span>
            </div>
          </div>
          <div class="mm-search-box">
            <input v-model="keyword" class="mm-search-input" placeholder="搜索会议主题或发起人" @input="load">
          </div>
        </div>

        <div class="mm-filter-row">
          <span class="mm-record-count">共 {{ filtered.length }} 条记录</span>
        </div>

        <div class="mtab-content">
          <div v-for="m in filtered" :key="m.id" class="meeting-card meeting-card-lg">
            <div class="ml-row-status">
              <span class="ml-chip" :class="chipClass(m)">
                <i v-if="isRunning(m)" class="ml-chip-dot"></i>
                <i v-else class="ml-chip-icon" :class="chipGlyph(m)" />
                {{ statusLabel(m.status) }}
              </span>
            </div>
            <div class="meeting-info" style="flex:1;">
              <div class="meeting-topic" style="font-size:16px;">
                <!-- 原型的历史行没有「查看详情」按钮，详情入口挂在标题上 -->
                <span class="ml-title" title="查看会议详情" @click="goDetail(m)">{{ m.title }}</span>
              </div>
              <div class="meeting-meta" style="margin-top:6px;">
                <span><i class="ri-calendar-line" /> {{ timeRange(m) }}</span>
                <span>会议号 {{ m.meetingNo || '尚未同步' }}</span>
                <span>{{ m.creatorName || m.hostName }}<template v-if="m.creatorPositionName"> · {{ m.creatorPositionName }}</template></span>
                <span v-if="m.cloudRecord"><i class="ri-vidicon-line" /> {{ m.status === 'running' ? '录制中' : '有录制' }}</span>
              </div>
            </div>
            <!-- 原型 操作按钮组：待开始=修改/取消+入会；已结束=查看录制；契约只允许 managed 且本端是主持人的才给改/取消 -->
            <div class="ml-row-actions">
              <template v-if="isRunning(m)">
                <button v-if="m.managed && m.isHost" class="ml-btn-line" @click="handleStop(m)">结束会议</button>
                <button v-if="isSelfIn(m)" class="ml-btn-chip"><i class="ml-btn-icon ri-check-line" />已入会</button>
                <button v-else class="ml-btn-solid sm" @click="handleJoin(m)">入会</button>
              </template>
              <template v-else-if="m.status === 'scheduled'">
                <button v-if="m.managed && m.isHost" class="ml-btn-line" @click="handleEdit(m)">修改会议</button>
                <button v-if="m.managed && m.isHost" class="ml-btn-line ml-btn-danger" @click="handleCancel(m)">取消会议</button>
                <button v-if="isSelfIn(m)" class="ml-btn-chip"><i class="ml-btn-icon ri-check-line" />已入会</button>
                <button v-else class="ml-btn-solid sm" @click="handleJoin(m)">入会</button>
              </template>
              <template v-else>
                <button class="ml-btn-line" @click="handleRecord(m)"><i class="ml-btn-icon ri-play-line" />查看录制</button>
              </template>
            </div>
          </div>
          <div v-if="!filtered.length" class="mm-empty">没有匹配的会议</div>
        </div>
      </div>
    </div>

    <div class="right-sidebar">
      <div class="calendar-title">
        <span>{{ calTitle }}</span>
      </div>
      <div class="calendar-grid">
        <div v-for="w in ['日','一','二','三','四','五','六']" :key="'h'+w" class="cal-header">{{ w }}</div>
        <div
          v-for="cell in calCells"
          :key="cell.key"
          class="cal-day"
          :class="{ 'other-month': !cell.inMonth, today: cell.isToday, 'has-meeting': cell.hasMeeting }"
        >{{ cell.day }}</div>
      </div>
      <div style="margin-top:24px;">
        <div style="font-size:13px;font-weight:600;margin-bottom:12px;color:var(--text-secondary);">今日日程</div>
        <div v-for="m in todayItems" :key="m.id" class="today-sched" :class="chipClass(m)">
          <div style="font-size:13px;font-weight:500;">{{ m.title }}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">{{ clockRange(m) }} · {{ statusLabel(m.status) }}</div>
        </div>
        <div v-if="!todayItems.length" style="font-size:12px;color:var(--text-muted);">今日无日程</div>
      </div>
    </div>

    <ScheduleMeetingDialog v-model="showScheduleDialog" :meeting="editingMeeting" @created="load" />
    <MeetingDetailDialog v-model="showDetail" :meeting="detailMeeting" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import ScheduleMeetingDialog from '@/components/dialogs/ScheduleMeetingDialog.vue'
import MeetingDetailDialog from '@/components/dialogs/MeetingDetailDialog.vue'
import { getMeetingList, getMeetingStats, cancelMeeting, stopMeeting, precheckMeeting, type MeetingVo } from '@/api/meeting'
import { useMeetingStore } from '@/store/meeting'
import { getDict, dictLabelSync, dictTagTypeSync, DICT } from '@/api/dict'
import { formatDate, formatTime } from '@/utils/time'
import { preJoinPath } from '@/utils/joinFlow'
import { startQuickMeeting } from '@/utils/startMeeting'

const router = useRouter()
const meetingStore = useMeetingStore()
const list = ref<MeetingVo[]>([])
const stats = ref({ weekCount: 0, pendingCount: 0, myCount: 0, totalMinutes: 0 })
const keyword = ref('')
const activeTab = ref('all')
const showScheduleDialog = ref(false)
const showDetail = ref(false)
const detailMeeting = ref<MeetingVo | null>(null)
const editingMeeting = ref<MeetingVo | null>(null)
const starting = ref(false)

const tabs = [
  { key: 'all', label: '全部会议' },
  { key: 'running', label: '进行中' },
  { key: 'scheduled', label: '已预约' },
  { key: 'ended', label: '已结束' },
]

const filtered = computed(() => {
  let arr = list.value
  if (activeTab.value !== 'all') arr = arr.filter((m) => m.status === activeTab.value)
  const k = keyword.value.trim().toLowerCase()
  if (k) arr = arr.filter((m) => (m.title + ' ' + (m.creatorName || '') + ' ' + m.meetingNo).toLowerCase().includes(k))
  return arr
})

function countOf(key: string) {
  if (key === 'all') return list.value.length
  return list.value.filter((m) => m.status === key).length
}

function statusLabel(s: string) {
  return dictLabelSync(DICT.meetingStatus, s) || s
}

function isRunning(m: MeetingVo) {
  return m.status === 'running' || m.status === 'starting'
}

// 与「所有会议」同一把尺子：画布画了 待开始/进行中/已结束 三态的取色，其余状态按 tag_type 落色。
const CANVAS_CHIP_STATUS = ['scheduled', 'running', 'ended']

function chipClass(m: MeetingVo) {
  if (CANVAS_CHIP_STATUS.includes(m.status)) return 'chip-' + m.status
  return 'chip-' + (dictTagTypeSync(DICT.meetingStatus, m.status) || 'ended')
}

function chipGlyph(m: MeetingVo) {
  if (CANVAS_CHIP_STATUS.includes(m.status)) return m.status === 'scheduled' ? 'ri-time-line' : 'ri-check-line'
  const tag = dictTagTypeSync(DICT.meetingStatus, m.status)
  if (tag === 'warning') return 'ri-time-line'
  if (tag === 'danger') return 'ri-error-warning-line'
  return 'ri-check-line'
}

function isSelfIn(m: MeetingVo) {
  return meetingStore.inMeeting && String(meetingStore.meetingNo) === String(m.meetingNo)
}

function endTimeIso(m: MeetingVo) {
  const s = new Date(m.startTime).getTime()
  return isNaN(s) ? '' : new Date(s + m.durationMinutes * 60000).toISOString()
}

// 时间显示只走 utils/time 的既有函数，不再自己拼 HH:mm。
function timeRange(m: MeetingVo) {
  if (!m.startTime || isNaN(new Date(m.startTime).getTime())) return ''
  return `${formatDate(m.startTime)} ${formatTime(m.startTime)} - ${formatTime(endTimeIso(m))}`
}

function clockRange(m: MeetingVo) {
  if (!m.startTime || isNaN(new Date(m.startTime).getTime())) return ''
  return `${formatTime(m.startTime)} - ${formatTime(endTimeIso(m))}`
}

const now = new Date()
const calTitle = `${now.getFullYear()}年${now.getMonth() + 1}月`
const todayItems = computed(() => list.value.filter((m) => new Date(m.startTime).toDateString() === now.toDateString()))

const calCells = computed(() => {
  const year = now.getFullYear()
  const month = now.getMonth()
  const first = new Date(year, month, 1)
  const startWeekday = first.getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const meetingDays = new Set(list.value.map((m) => new Date(m.startTime).getDate()))
  const cells: { key: string; day: number; inMonth: boolean; isToday: boolean; hasMeeting: boolean }[] = []
  const prevMonthDays = new Date(year, month, 0).getDate()
  for (let i = startWeekday - 1; i >= 0; i--) {
    cells.push({ key: `p${i}`, day: prevMonthDays - i, inMonth: false, isToday: false, hasMeeting: false })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ key: `c${d}`, day: d, inMonth: true, isToday: d === now.getDate(), hasMeeting: meetingDays.has(d) })
  }
  let next = 1
  while (cells.length % 7 !== 0) {
    cells.push({ key: `n${next}`, day: next, inMonth: false, isToday: false, hasMeeting: false })
    next++
  }
  return cells
})

async function load() {
  try {
    const [l, st] = await Promise.all([getMeetingList({ pageNum: 1, pageSize: 100 }), getMeetingStats()])
    list.value = l.rows || []
    stats.value = st.data || stats.value
  } catch {
    /* 拦截器处理 */
  }
}

async function handleJoin(m: MeetingVo) {
  if (m.meetingNo) {
    const res = await precheckMeeting(m.meetingNo)
    if (res.data && !res.data.joinable) {
      ElMessage.error(res.data.message || '会议不可加入')
      return
    }
  }
  router.push(preJoinPath(m))
}

async function startNow() {
  if (starting.value) return
  starting.value = true
  try {
    await startQuickMeeting(router)
  } catch {
    /* 建会失败由拦截器提示 */
  } finally {
    starting.value = false
  }
}

function goDetail(m: MeetingVo) {
  detailMeeting.value = m
  showDetail.value = true
}

function handleEdit(m: MeetingVo) {
  editingMeeting.value = m
  showScheduleDialog.value = true
}

// 取消 = 保留行的状态变更，契约只放行 scheduled
async function handleCancel(m: MeetingVo) {
  try {
    await ElMessageBox.confirm(`确定取消会议「${m.title}」？取消后仍保留这条记录。`, '取消会议', { type: 'warning', confirmButtonText: '确定取消', cancelButtonText: '返回' })
  } catch {
    return
  }
  try {
    await cancelMeeting(m.id)
    ElMessage.success('会议已取消')
    await load()
  } catch {
    /* 提示由 request 拦截器统一给出 */
  }
}

// 删除会议已随后端 DELETE 接口下线（取消保留行、状态置已取消，就是唯一的移除方式）。
async function handleStop(m: MeetingVo) {
  try {
    await ElMessageBox.confirm(`确定结束会议「${m.title}」？所有参会者会被移出。`, '结束会议', { type: 'warning' })
  } catch {
    return
  }
  try {
    await stopMeeting(m.id)
    ElMessage.success('会议已结束')
    await load()
  } catch {
    /* 提示由 request 拦截器统一给出 */
  }
}

// 原型每行都有「查看录制」；有没有货取决于真实的 cloudRecord，没有就如实说，不跳空页面装样子。
function handleRecord(m: MeetingVo) {
  if (!m.cloudRecord) {
    ElMessage.info('这场会议没有开启云端录制；本地录制可在「录制管理」查看')
    return
  }
  router.push('/recordings')
}

onMounted(() => {
  getDict(DICT.meetingStatus)
  load()
})
</script>

<style scoped>
/* 顶部两颗按钮：画布 顶部操作按钮组 h44 / r11 / pad 0 20 / 14 Medium / gap 12 */
.ml-top-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ml-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 44px;
  padding: 0 20px;
  border-radius: var(--radius);
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
}
.ml-btn-ghost {
  background: var(--bg-card);
  border: 1px solid var(--primary);
  color: var(--primary-text);
}
.ml-btn-ghost:hover {
  background: var(--primary-soft);
}
.ml-btn-solid {
  background: var(--primary);
  border: none;
  color: #fff;
}
.ml-btn-solid:hover {
  background: var(--primary-dark);
}

.ml-row-status {
  display: flex;
  align-items: center;
  min-width: 96px;
  flex-shrink: 0;
}
.ml-title {
  cursor: pointer;
}
.ml-title:hover {
  color: var(--primary-text);
}

/* 状态徽标：与「所有会议」同一套画布 token */
.ml-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 9px;
  border-radius: 7px;
  font-size: 12px;
  white-space: nowrap;
}
.ml-chip-dot {
  width: 8px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: currentColor;
}
.ml-chip-icon {
  font-size: 12px;
  line-height: 1;
}
.ml-chip.chip-running {
  background: var(--primary-soft);
  color: var(--primary-text);
}
.ml-chip.chip-scheduled,
.ml-chip.chip-warning {
  background: var(--warning-bg);
  color: var(--warning-text);
}
.ml-chip.chip-ended,
.ml-chip.chip-info {
  background: var(--bg-hover);
  color: var(--text-tertiary);
}
.ml-chip.chip-danger {
  background: var(--danger-bg);
  color: var(--danger-text);
}
.ml-chip.chip-success {
  background: var(--bg-hover);
  color: var(--success-text);
}

/* 会议行操作组：h38 / r10 / pad 0 16 / 13 Medium / gap 8 */
.ml-row-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.ml-btn-line,
.ml-btn-solid.sm,
.ml-btn-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-family: inherit;
  font-size: 13px;
  white-space: nowrap;
  border-radius: 10px;
}
.ml-btn-line {
  height: 38px;
  padding: 0 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  font-weight: 500;
  cursor: pointer;
}
.ml-btn-line:hover {
  border-color: var(--primary);
  color: var(--primary-text);
}
.ml-btn-danger {
  border-color: var(--danger-border);
  color: var(--danger-text);
}
.ml-btn-danger:hover {
  border-color: var(--danger);
  color: var(--danger-text);
}
.ml-btn-solid.sm {
  height: 38px;
  padding: 0 20px;
  background: var(--primary);
  border: none;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}
.ml-btn-solid.sm:hover {
  background: var(--primary-dark);
}
.ml-btn-chip {
  height: 38px;
  padding: 0 18px;
  border: none;
  background: var(--primary-soft);
  color: var(--primary-text);
  font-weight: 600;
  cursor: default;
}
.ml-btn-icon {
  font-size: 15px;
  font-style: normal;
  line-height: 1;
}

.mtab-count { background: var(--bg-hover); padding: 2px 8px; border-radius: 10px; font-size: 11px; margin-left: 4px; }
.mm-empty { padding: 40px; text-align: center; color: var(--text-muted); }
.today-sched { padding: 10px; background: var(--bg-card); border-radius: 6px; margin-bottom: 8px; border-left: 3px solid var(--primary); }
/* 今日日程的左侧色条跟着状态徽标走，取值与上面的徽标同源 */
.today-sched.chip-scheduled,
.today-sched.chip-warning { border-left-color: var(--warning); }
.today-sched.chip-running { border-left-color: var(--primary); }
.today-sched.chip-ended,
.today-sched.chip-info { border-left-color: var(--text-tertiary); }
.today-sched.chip-danger { border-left-color: var(--danger); }
.today-sched.chip-success { border-left-color: var(--success); }
</style>
