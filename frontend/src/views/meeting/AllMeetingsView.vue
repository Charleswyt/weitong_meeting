<template>
  <div class="am-page">
    <!-- 原型顶部栏只有「页签 + 搜索」，预约/快速会议的入口在首页三卡 -->
    <div class="am-topbar">
      <div class="am-tabs" role="tablist">
        <button class="am-tab" role="tab" :class="{ active: activeTab === 'upcoming' }" :aria-selected="activeTab === 'upcoming'" @click="switchTab('upcoming')">待开始会议</button>
        <button class="am-tab" role="tab" :class="{ active: activeTab === 'history' }" :aria-selected="activeTab === 'history'" @click="switchTab('history')">历史会议</button>
      </div>
      <div class="am-search-group">
        <div class="am-search-wrap">
          <i class="am-search-icon ri-search-line" />
          <input v-model="keyword" class="am-search" type="text" placeholder="搜索会议主题、发起人或会议号" @input="onSearch" @keyup.enter="load">
        </div>
        <button class="am-search-btn" @click="load">搜索</button>
      </div>
    </div>
    <div class="am-tab-divider"></div>

    <div class="am-content">
      <div v-if="loading" class="am-loading">
        <div class="am-spinner"></div>
        <span>加载中...</span>
      </div>

      <div v-else-if="groups.length" class="am-panel">
        <div v-for="g in groups" :key="g.label" class="am-group">
          <div class="am-group-head">
            <span class="am-group-label">{{ g.label }}</span>
            <span class="am-group-line"></span>
          </div>
          <div
            v-for="m in g.items"
            :key="`${m.managed ? 'db' : 'up'}-${m.id}`"
            class="am-row"
          >
            <div class="am-row-time">
              <span class="am-time-start">{{ clock(m.startTime) }}</span>
              <span class="am-time-end">— {{ endTime(m) }}</span>
            </div>
            <div class="am-row-info">
              <div class="am-row-title-line">
                <!-- 原型的历史行只有「查看录制」一颗动作按钮，详情入口挂在标题上 -->
                <span class="am-row-title" title="查看会议详情" @click="goDetail(m)">{{ m.title }}</span>
                <span class="am-status-chip" :class="chipClass(m)">
                  <i v-if="isRunning(m)" class="am-chip-dot"></i>
                  <i v-else class="am-chip-icon" :class="chipGlyph(m)" />
                  {{ statusLabel(m.status) }}
                </span>
              </div>
              <div class="am-row-no"><span class="am-no-icon">#</span> 会议号 {{ m.meetingNo ? formatMeetingNo(m.meetingNo) : '尚未同步' }}</div>
            </div>
            <div class="am-row-actions">
              <template v-if="isRunning(m)">
                <button v-if="m.managed && m.isHost" class="am-btn-line" @click="handleStop(m)">结束会议</button>
                <button v-if="isSelfIn(m)" class="am-btn-chip am-btn-joined"><i class="am-btn-icon ri-check-line" />已入会</button>
                <button v-else class="am-btn-solid" @click="handleJoin(m)">入会</button>
              </template>
              <template v-else-if="isScheduled(m)">
                <button v-if="m.managed && m.isHost" class="am-btn-line" @click="handleEdit(m)">修改会议</button>
                <button v-if="m.managed && m.isHost" class="am-btn-line am-btn-danger" @click="handleCancel(m)">取消会议</button>
                <button v-if="isSelfIn(m)" class="am-btn-chip am-btn-joined"><i class="am-btn-icon ri-check-line" />已入会</button>
                <button v-else class="am-btn-solid" @click="handleJoin(m)">入会</button>
              </template>
              <template v-else>
                <button class="am-btn-line" @click="handleRecord(m)"><i class="am-btn-icon ri-play-line" />查看录制</button>
              </template>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="am-empty">
        <div class="am-empty-icon ri-clipboard-line" />
        <div class="am-empty-text">{{ activeTab === 'upcoming' ? '暂无待开始的会议' : '暂无历史会议' }}</div>
        <div class="am-empty-sub">{{ activeTab === 'upcoming' ? '在首页点击「预约」安排新的日程' : '结束会议后将自动归档到此处' }}</div>
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
import { getMeetingList, cancelMeeting, stopMeeting, precheckMeeting, type MeetingVo } from '@/api/meeting'
import { useMeetingStore } from '@/store/meeting'
import { getDict, dictLabelSync, dictTagTypeSync, DICT } from '@/api/dict'
import { formatTime } from '@/utils/time'
import { preJoinPath } from '@/utils/joinFlow'
import { formatMeetingNo } from '@/utils/meetingNo'

const router = useRouter()
const meetingStore = useMeetingStore()
const activeTab = ref<'upcoming' | 'history'>('upcoming')
const keyword = ref('')
const loading = ref(false)
const upcomingList = ref<MeetingVo[]>([])
const historyList = ref<MeetingVo[]>([])
const showScheduleDialog = ref(false)
const showDetail = ref(false)
const detailMeeting = ref<MeetingVo | null>(null)
const editingMeeting = ref<MeetingVo | null>(null)

let searchTimer: ReturnType<typeof setTimeout> | null = null

const displayList = computed(() => (activeTab.value === 'upcoming' ? upcomingList.value : historyList.value))

// 原型按日期分组（今天 / 明天 / 周X），组的先后随时刻走：待开始从近到远，历史从新到旧。
const groups = computed(() => {
  const map = new Map<string, MeetingVo[]>()
  for (const m of displayList.value) {
    const label = groupLabel(m.startTime)
    if (!map.has(label)) map.set(label, [])
    map.get(label)!.push(m)
  }
  const earliest = (items: MeetingVo[]) => {
    const ts = items.map((m) => new Date(m.startTime).getTime()).filter((t) => !isNaN(t))
    return ts.length ? Math.min(...ts) : Number.MAX_SAFE_INTEGER
  }
  const dir = activeTab.value === 'upcoming' ? 1 : -1
  return [...map.entries()]
    .map(([label, items]) => ({ label, items }))
    .sort((a, b) => dir * (earliest(a.items) - earliest(b.items)))
})

function groupLabel(iso: string) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '时间待定'
  const today = new Date()
  const dayOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = (dayOf(d) - dayOf(today)) / 86400000
  if (diff === 0) return '今天'
  if (diff === 1) return '明天'
  if (diff === -1) return '昨天'
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return `${week} ${d.getMonth() + 1}月${d.getDate()}日`
}

// 原型的时间列两行：起始 HH:mm（18/Bold）+「— 结束 HH:mm」（13/Regular）。格式化只走 utils/time。
function clock(iso: string) {
  return isNaN(new Date(iso).getTime()) ? '--:--' : formatTime(iso)
}

function endTime(m: MeetingVo) {
  const s = new Date(m.startTime).getTime()
  if (isNaN(s)) return '--:--'
  return formatTime(new Date(s + m.durationMinutes * 60000).toISOString())
}

function isSelfIn(m: MeetingVo) {
  return meetingStore.inMeeting && String(meetingStore.meetingNo) === String(m.meetingNo)
}

function switchTab(tab: 'upcoming' | 'history') {
  activeTab.value = tab
  keyword.value = ''
  void load()
}

// 关键字交给后端过滤（主题/本地号/三方号三列 LIKE），不是本地截断当前页。
function onSearch() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => load(), 300)
}

function statusLabel(s: string) {
  return dictLabelSync(DICT.meetingStatus, s) || s
}

function isRunning(m: MeetingVo) {
  return m.status === 'running' || m.status === 'starting'
}

function isScheduled(m: MeetingVo) {
  return m.status === 'scheduled'
}

// 画布只给了 待开始=橙 / 进行中=蓝 / 已结束=灰 三态的取色；其余状态（启动中/失败/已取消）
// 按 sys_dict_data.tag_type 落色，不再新写状态 switch。
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

async function load() {
  loading.value = true
  const kw = keyword.value.trim()
  try {
    const [upcoming, history] = await Promise.all([
      getMeetingList({ pageNum: 1, pageSize: 100, status: 'scheduled', keyword: kw }),
      getMeetingList({ pageNum: 1, pageSize: 100, status: 'ended', keyword: kw }),
    ])
    upcomingList.value = upcoming.rows || []
    historyList.value = history.rows || []

    const running = await getMeetingList({ pageNum: 1, pageSize: 100, status: 'running', keyword: kw })
    if (running.rows?.length) {
      upcomingList.value = [...running.rows, ...upcomingList.value]
    }
  } catch {
    /* 提示由 request 拦截器统一给出 */
  } finally {
    loading.value = false
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

function handleEdit(m: MeetingVo) {
  editingMeeting.value = m
  showScheduleDialog.value = true
}

async function handleCancel(m: MeetingVo) {
  try {
    await ElMessageBox.confirm(`确定取消会议「${m.title}」？取消后仍保留这条记录。`, '取消会议', { type: 'warning', confirmButtonText: '确定取消', cancelButtonText: '返回' })
  } catch {
    return
  }
  try {
    await cancelMeeting(m.id)
    ElMessage.success('会议已取消')
    load()
  } catch {
    /* 后端 msg 由 request 拦截器统一弹一次，这里只收尾、不再二次加工 */
  }
}

// 删除会议已随后端 DELETE 接口下线（取消保留行，就是唯一的移除方式）。
async function handleStop(m: MeetingVo) {
  try {
    await ElMessageBox.confirm(`确定结束会议「${m.title}」？所有参会者会被移出。`, '结束会议', { type: 'warning' })
  } catch {
    return
  }
  try {
    await stopMeeting(m.id)
    ElMessage.success('会议已结束')
    load()
  } catch {
    /* 后端 msg 由 request 拦截器统一弹一次，这里只收尾、不再二次加工 */
  }
}

function goDetail(m: MeetingVo) {
  detailMeeting.value = m
  showDetail.value = true
}

// 画布上每场历史会议都有「查看录制」，但录制是否有货取决于这场会到底建没建成：
// 没有云端录制时如实告知并留在本页，不跳去一个空的录制页装作有内容。
function handleRecord(m: MeetingVo) {
  // 三方从没建起这场会（预约/快速会议时同步失败，或同步没回填上三方 id）：它既进不去也没录到。
  // 这不是"还在同步"，是终局 —— 说"稍后再试"就是替系统许一个不会兑现的诺。
  if (m.localStatus === 'failed' || !m.thirdPartyMeetingId) {
    ElMessage.info('这场会议没能在会议平台上创建，没有云端录制；本地录制可在「录制管理」查看')
    return
  }
  if (!m.cloudRecord) {
    ElMessage.info('这场会议没有开启云端录制；本地录制可在「录制管理」查看')
    return
  }
  router.push({ name: 'RecordingPlayback', params: { meetingId: m.thirdPartyMeetingId } })
}

onMounted(() => {
  void getDict(DICT.meetingStatus)
  void load()
})
</script>

<style scoped>
.am-page {
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.am-topbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px 0;
  flex-wrap: wrap;
}

.am-tabs {
  display: flex;
  gap: 32px;
}

/* 画布 页签-待开始会议：15/SemiBold #165DFF + 3px 下划线；未选中 15/Medium #64748B */
.am-tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 500;
  font-family: inherit;
  color: var(--text-tertiary);
  background: none;
  border: none;
  padding: 0 0 10px;
  cursor: pointer;
}

.am-tab::after {
  content: '';
  width: 100%;
  height: 3px;
  border-radius: 2px;
  background: transparent;
}

.am-tab.active {
  color: var(--primary-text);
  font-weight: 600;
}

.am-tab.active::after {
  background: var(--primary);
}

.am-search-group {
  display: flex;
  align-items: center;
  gap: 12px;
}

.am-search-wrap {
  position: relative;
  width: 320px;
}

/* 画布 搜索框：320×42、白底、#E2E8F0 描边、r11，图标 16 + gap 8 */
.am-search-icon {
  position: absolute;
  left: 16px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 16px;
  color: var(--text-muted);
  pointer-events: none;
}

.am-search {
  width: 100%;
  height: 42px;
  padding: 0 16px 0 40px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 11px;
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
}

.am-search:focus {
  border-color: var(--primary);
}

.am-search-btn {
  height: 42px;
  padding: 0 20px;
  background: var(--primary);
  border: none;
  border-radius: 11px;
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}

.am-tab-divider {
  height: 1px;
  background: var(--border-color);
  margin: 4px 0 0;
}

.am-content {
  padding: 24px 40px;
}

.am-panel {
  background: var(--bg-card);
  border: 1px solid var(--border-soft);
  border-radius: 18px;
  padding: 16px 18px;
}

.am-group + .am-group {
  margin-top: 18px;
}

.am-group-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 画布 分组-昨天：14/SemiBold #334155 */
.am-group-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.am-group-line {
  flex: 1;
  height: 1px;
  background: var(--border-soft);
}

/* 画布 会议行：列间 gap 16、行高 pad [18,20]、r14；行与行 gap 12，分组标题到首行 16 */
.am-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 12px;
  padding: 18px 20px;
  background: var(--bg-input);
  border: 1px solid var(--border-soft);
  border-radius: 14px;
}

.am-group-head + .am-row {
  margin-top: 16px;
}

.am-row-time {
  display: flex;
  flex-direction: column;
  width: 112px;
  flex-shrink: 0;
}

.am-time-start {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.am-time-end {
  font-size: 13px;
  color: var(--text-muted);
}

.am-row-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 画布 标题行：gap 12；标题 16/SemiBold #0F172A */
.am-row-title-line {
  display: flex;
  align-items: center;
  gap: 12px;
}

.am-row-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.am-row-title:hover {
  color: var(--primary-text);
}

.am-status-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 9px;
  border-radius: 7px;
  font-size: 12px;
  flex-shrink: 0;
}

.am-chip-dot {
  width: 8px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: currentColor;
}

.am-chip-icon {
  font-size: 12px;
  line-height: 1;
}

/* 画布给定的三态：进行中 #E8F0FF/#165DFF、待开始 #FFF7E8/#D97706、已结束 #F1F5F9/#64748B */
.chip-running {
  background: var(--primary-soft);
  color: var(--primary-text);
}

.chip-scheduled,
.chip-warning {
  background: var(--warning-bg);
  color: var(--warning-text);
}

.chip-ended,
.chip-cancelled,
.chip-info {
  background: var(--bg-hover);
  color: var(--text-tertiary);
}

/* 画布没画的状态（启动失败等）按字典 tag_type 落色 */
.chip-danger {
  background: var(--danger-bg);
  color: var(--danger-text);
}

.chip-success {
  background: var(--bg-hover);
  color: var(--success-text);
}

/* 画布 会议号行：gap 8、13/Regular #64748B，图标是 ri-hashtag */
.am-row-no {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-tertiary);
}

.am-no-icon {
  font-weight: 700;
}

/* 画布 操作按钮组：gap 8，行尾右侧 */
.am-row-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}

/* 按钮 token：h38、r10、pad 0 16、13/Medium #334155、白底 #E2E8F0 描边 */
.am-btn-line,
.am-btn-solid,
.am-btn-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font-family: inherit;
  white-space: nowrap;
}

.am-btn-line {
  height: 38px;
  padding: 0 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.am-btn-line:hover {
  border-color: var(--primary);
  color: var(--primary-text);
}

.am-btn-danger {
  border-color: var(--danger-border);
  color: var(--danger-text);
}

.am-btn-danger:hover {
  border-color: var(--danger);
  color: var(--danger-text);
}

/* 入会：pad 0 20、实心主色、13/SemiBold */
.am-btn-solid {
  height: 38px;
  padding: 0 20px;
  background: var(--primary);
  border: none;
  border-radius: 10px;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

/* 已入会：pad 0 18、#E8F0FF 底 + 15 图标，是状态回执不是动作，故不可点 */
.am-btn-chip {
  height: 38px;
  padding: 0 18px;
  border: none;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  cursor: default;
}

.am-btn-joined {
  background: var(--primary-soft);
  color: var(--primary-text);
}

.am-btn-icon {
  font-size: 15px;
  font-style: normal;
  line-height: 1;
}

.am-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 80px 0;
  color: var(--text-muted);
}

.am-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--border-color);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: am-spin 0.8s linear infinite;
}

@keyframes am-spin {
  to { transform: rotate(360deg); }
}

.am-empty {
  padding: 72px 0;
  text-align: center;
}

.am-empty-icon {
  font-size: 40px;
  opacity: 0.5;
}

.am-empty-text {
  margin-top: 12px;
  font-size: 15px;
  color: var(--text-secondary);
}

.am-empty-sub {
  margin-top: 6px;
  font-size: 13px;
  color: var(--text-muted);
}
</style>
