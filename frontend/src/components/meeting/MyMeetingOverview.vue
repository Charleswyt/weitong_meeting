<template>
  <section class="ov-board" aria-label="我的会议统计概览">
    <!-- 顶部标题与维度切换 -->
    <header class="ov-header">
      <div class="ov-title-group">
        <span class="ov-accent-dot" aria-hidden="true" />
        <h2 class="ov-title">{{ dimensionTitle }}</h2>
      </div>
      <div class="ov-seg" role="tablist" aria-label="统计维度">
        <button
          v-for="tab in DIMENSION_TABS"
          :key="tab.value"
          type="button"
          role="tab"
          class="ov-seg-btn"
          :class="{ active: dimension === tab.value }"
          :aria-selected="dimension === tab.value"
          @click="selectDimension(tab.value)"
        >
          {{ tab.label }}
        </button>
      </div>
    </header>

    <div v-if="loading && !stats" class="ov-loading">
      <div class="ov-spinner" />
      <span>正在同步数据</span>
    </div>

    <!-- 新用户 / 当前维度无会议记录时的静默页 -->
    <div v-else-if="isEmpty" class="ov-empty-state">
      <div class="ov-empty-orb" aria-hidden="true">
        <i class="ri-video-chat-line" />
      </div>
      <h3 class="ov-empty-title">{{ emptyTitle }}</h3>
      <p class="ov-empty-desc">{{ emptyDesc }}</p>
      <button type="button" class="ov-empty-btn" @click="goHome">
        <i class="ri-add-circle-line" />
        <span>发起或预约会议</span>
      </button>
    </div>

    <div v-else class="ov-body" :class="{ 'is-refreshing': loading }">
      <!-- 主视窗：左 A.会议量 / 右 C.录制 -->
      <div class="ov-hero-row">
        <!-- A. 会议量（丰富指标 + 主持/参与占比条 + 底部 3 项关联速览） -->
        <section class="ov-card ov-card-volume">
          <div class="ov-sec-head">
            <span class="ov-sec-bar is-blue" />
            <h3 class="ov-sec-title">会议量</h3>
          </div>

          <div class="ov-vol-top">
            <div class="ov-kpi-main">
              <span class="ov-label">会议总数</span>
              <div class="ov-num-line">
                <strong class="ov-num ov-num-hero">{{ intVal(volume.total) }}</strong>
                <span class="ov-unit">场</span>
              </div>
            </div>

            <div class="ov-kpi-split">
              <div class="ov-sub-cell">
                <span class="ov-label">主持次数</span>
                <div class="ov-num-line">
                  <strong class="ov-num ov-num-lg is-blue">{{ intVal(volume.hosted) }}</strong>
                  <span class="ov-unit">次</span>
                </div>
              </div>
              <div class="ov-sub-divider" aria-hidden="true" />
              <div class="ov-sub-cell">
                <span class="ov-label">参与次数</span>
                <div class="ov-num-line">
                  <strong class="ov-num ov-num-lg is-indigo">{{ intVal(volume.participated) }}</strong>
                  <span class="ov-unit">次</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 主持 / 参与占比条 -->
          <div class="ov-ratio-block">
            <div class="ov-ratio-labels">
              <span class="ov-ratio-item"><i class="ov-dot is-blue" />主持占比 <strong>{{ hostedPercentText }}</strong></span>
              <span class="ov-ratio-item"><i class="ov-dot is-indigo" />参与占比 <strong>{{ participatedPercentText }}</strong></span>
            </div>
            <div class="ov-stack-track" aria-hidden="true">
              <span class="ov-stack-seg is-blue" :style="{ width: `${hostedPercent}%` }" />
              <span class="ov-stack-seg is-indigo" :style="{ width: `${participatedPercent}%` }" />
            </div>
          </div>

          <!-- 底部四项不重复的新维度（会议形态与活跃天数） -->
          <div class="ov-vol-dims">
            <div class="ov-dim-box">
              <span class="ov-meta-k">预约会议</span>
              <strong class="ov-dim-v">{{ intVal(volume.scheduled) }}<small>场</small></strong>
            </div>
            <div class="ov-dim-box">
              <span class="ov-meta-k">快速会议</span>
              <strong class="ov-dim-v">{{ intVal(volume.quick) }}<small>场</small></strong>
            </div>
            <div class="ov-dim-box">
              <span class="ov-meta-k">语音对讲</span>
              <strong class="ov-dim-v">{{ intVal(volume.voice) }}<small>场</small></strong>
            </div>
            <div class="ov-dim-box">
              <span class="ov-meta-k">开会天数</span>
              <strong class="ov-dim-v is-blue">{{ intVal(volume.activeDays) }}<small>天</small></strong>
            </div>
          </div>
        </section>

        <!-- C. 录制（能量环 + 不重复的三项录制指标） -->
        <section class="ov-card ov-card-recording">
          <div class="ov-sec-head">
            <span class="ov-sec-bar is-emerald" />
            <h3 class="ov-sec-title">录制</h3>
          </div>

          <div class="ov-gauge-stage">
            <svg class="ov-gauge-svg" viewBox="0 0 180 144" aria-hidden="true">
              <defs>
                <linearGradient id="ovRecGrad" x1="0%" y1="100%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="#165dff" />
                  <stop offset="55%" stop-color="#38bdf8" />
                  <stop offset="100%" stop-color="#10b981" />
                </linearGradient>
              </defs>
              <circle
                cx="90"
                cy="90"
                r="64"
                fill="none"
                class="ov-gauge-track"
                stroke-width="10"
                stroke-linecap="round"
                :stroke-dasharray="`${ARC_LEN} ${CIRCUMFERENCE}`"
                transform="rotate(150 90 90)"
              />
              <circle
                cx="90"
                cy="90"
                r="64"
                fill="none"
                stroke="url(#ovRecGrad)"
                stroke-width="10"
                stroke-linecap="round"
                :stroke-dasharray="`${coverageArcLen} ${CIRCUMFERENCE}`"
                transform="rotate(150 90 90)"
                class="ov-gauge-arc"
              />
            </svg>
            <div class="ov-gauge-center">
              <strong class="ov-num ov-gauge-val">{{ coverageRateText }}</strong>
              <span class="ov-gauge-label">录制覆盖率</span>
            </div>
          </div>

          <div class="ov-rec-grid">
            <div class="ov-rec-cell">
              <span class="ov-meta-k">录制次数</span>
              <strong class="ov-rec-num is-emerald">{{ intVal(recording.count) }}<small>次</small></strong>
            </div>
            <div class="ov-rec-cell">
              <span class="ov-meta-k">未录制场次</span>
              <strong class="ov-rec-num">{{ unrecordedCount }}<small>场</small></strong>
            </div>
            <div class="ov-rec-cell">
              <span class="ov-meta-k">平均录制时长</span>
              <strong class="ov-rec-num is-compact">{{ avgRecordingDurationText }}</strong>
            </div>
          </div>
        </section>
      </div>

      <!-- B. 时间账本（支持 全部 / 会议 / 语音 切换） -->
      <section class="ov-section">
        <div class="ov-sec-row">
          <div class="ov-sec-head">
            <span class="ov-sec-bar is-blue" />
            <h3 class="ov-sec-title">时间账本</h3>
          </div>
          <div class="ov-kind-seg" role="tablist" aria-label="会议类型切换">
            <button
              v-for="kt in DURATION_KIND_TABS"
              :key="kt.value"
              type="button"
              role="tab"
              class="ov-kind-btn"
              :class="{ active: durationKind === kt.value }"
              :aria-selected="durationKind === kt.value"
              @click="durationKind = kt.value"
            >
              <i :class="kt.icon" />
              <span>{{ kt.label }}</span>
            </button>
          </div>
        </div>

        <div class="ov-grid-duration">
          <article class="ov-tile is-blue">
            <span class="ov-label">总时长</span>
            <strong class="ov-num ov-num-dur">{{ formatHM(activeDuration.totalSeconds) }}</strong>
          </article>
          <article class="ov-tile is-sky">
            <span class="ov-label">主持总时长</span>
            <strong class="ov-num ov-num-dur">{{ formatHM(activeDuration.hostedSeconds) }}</strong>
          </article>
          <article class="ov-tile is-indigo">
            <span class="ov-label">参会总时长</span>
            <strong class="ov-num ov-num-dur">{{ formatHM(activeDuration.participatedSeconds) }}</strong>
          </article>
          <article class="ov-tile is-cyan">
            <span class="ov-label">平均单场会议时长</span>
            <strong class="ov-num ov-num-dur">{{ averageDurationText }}</strong>
          </article>
          <article class="ov-tile is-emerald">
            <span class="ov-label">录制总时长</span>
            <strong class="ov-num ov-num-dur">{{ formatHM(activeDuration.recordingSeconds) }}</strong>
          </article>
        </div>
      </section>

      <!-- D. 关键会议（醒目展示会议名称 + 主持人 + 起止时间） -->
      <section class="ov-section">
        <div class="ov-sec-head">
          <span class="ov-sec-bar is-indigo" />
          <h3 class="ov-sec-title">关键会议</h3>
        </div>
        <div class="ov-grid-extremes">
          <article class="ov-milestone">
            <div class="ov-ms-bar is-blue" aria-hidden="true" />
            <div class="ov-ms-body">
              <div class="ov-ms-top">
                <span class="ov-ms-tag is-blue">最早一次会议</span>
                <span v-if="extremes.earliest" class="ov-ms-dur">{{ formatHM(extremes.earliest.durationSeconds) }}</span>
              </div>
              <template v-if="extremes.earliest">
                <div class="ov-ms-title" :title="extremes.earliest.title">
                  {{ extremes.earliest.title || '未命名会议' }}
                </div>
                <div v-if="extremes.earliest.hostName" class="ov-ms-host">
                  <i class="ri-user-3-line" />
                  <span>主持人：{{ extremes.earliest.hostName }}</span>
                </div>
                <div class="ov-ms-time">
                  <i class="ri-time-line" />
                  <span>{{ formatTimeRange(extremes.earliest) }}</span>
                </div>
              </template>
              <div v-else class="ov-ms-empty">—</div>
            </div>
          </article>

          <article class="ov-milestone is-highlight">
            <div class="ov-ms-bar is-emerald" aria-hidden="true" />
            <div class="ov-ms-body">
              <div class="ov-ms-top">
                <span class="ov-ms-tag is-emerald">最长一次会议</span>
                <span v-if="extremes.longest" class="ov-ms-badge">{{ formatHM(extremes.longest.durationSeconds) }}</span>
              </div>
              <template v-if="extremes.longest">
                <div class="ov-ms-title" :title="extremes.longest.title">
                  {{ extremes.longest.title || '未命名会议' }}
                </div>
                <div v-if="extremes.longest.hostName" class="ov-ms-host">
                  <i class="ri-user-3-line" />
                  <span>主持人：{{ extremes.longest.hostName }}</span>
                </div>
                <div class="ov-ms-time">
                  <i class="ri-time-line" />
                  <span>{{ formatTimeRange(extremes.longest) }}</span>
                </div>
              </template>
              <div v-else class="ov-ms-empty">—</div>
            </div>
          </article>

          <article class="ov-milestone">
            <div class="ov-ms-bar is-indigo" aria-hidden="true" />
            <div class="ov-ms-body">
              <div class="ov-ms-top">
                <span class="ov-ms-tag is-indigo">最近一次会议</span>
                <span v-if="extremes.latest" class="ov-ms-dur">{{ formatHM(extremes.latest.durationSeconds) }}</span>
              </div>
              <template v-if="extremes.latest">
                <div class="ov-ms-title" :title="extremes.latest.title">
                  {{ extremes.latest.title || '未命名会议' }}
                </div>
                <div v-if="extremes.latest.hostName" class="ov-ms-host">
                  <i class="ri-user-3-line" />
                  <span>主持人：{{ extremes.latest.hostName }}</span>
                </div>
                <div class="ov-ms-time">
                  <i class="ri-time-line" />
                  <span>{{ formatTimeRange(extremes.latest) }}</span>
                </div>
              </template>
              <div v-else class="ov-ms-empty">—</div>
            </div>
          </article>
        </div>
      </section>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  getMeetingOverview,
  type MeetingOverviewDuration,
  type MeetingOverviewExtremeItem,
  type MeetingOverviewStats,
  type StatsDimension,
} from '@/api/meeting'
import { fetchOverviewFallbackFromList } from '@/utils/meetingOverviewFallback'

const router = useRouter()

const DIMENSION_TABS: Array<{ value: Exclude<StatsDimension, 'custom'>; label: string; title: string }> = [
  { value: 'total', label: '总体', title: '总体统计' },
  { value: 'month', label: '本月', title: '本月统计' },
  { value: 'week', label: '本周', title: '本周统计' },
]

type DurationKind = 'all' | 'meeting' | 'voice'

const DURATION_KIND_TABS: Array<{ value: DurationKind; label: string; icon: string }> = [
  { value: 'all', label: '全部', icon: 'ri-apps-line' },
  { value: 'meeting', label: '会议', icon: 'ri-vidicon-line' },
  { value: 'voice', label: '语音', icon: 'ri-mic-line' },
]

const EMPTY_DURATION: MeetingOverviewDuration = {
  totalSeconds: 0,
  hostedSeconds: 0,
  participatedSeconds: 0,
  averageSeconds: 0,
  recordingSeconds: 0,
}

const CIRCUMFERENCE = 2 * Math.PI * 64
const ARC_LEN = (CIRCUMFERENCE * 240) / 360

const dimension = ref<StatsDimension>('total')
const durationKind = ref<DurationKind>('all')
const loading = ref(false)
const stats = ref<MeetingOverviewStats | null>(null)

const dimensionTitle = computed(() => {
  const matched = DIMENSION_TABS.find((t) => t.value === dimension.value)
  return matched ? matched.title : '总体统计'
})

const volume = computed(() => {
  const v = stats.value?.volume
  if (!v) return { total: 0, hosted: 0, participated: 0, online: 0, offline: 0, hybrid: 0 }
  return v
})

const isEmpty = computed(() => !loading.value && stats.value !== null && intVal(volume.value.total) === 0)

const emptyTitle = computed(() => {
  if (dimension.value === 'month') return '本月暂无会议记录'
  if (dimension.value === 'week') return '本周暂无会议记录'
  return '暂未开启过会议'
})

const emptyDesc = computed(() => {
  if (dimension.value === 'total') return '完成首次会议后，这里将自动汇总你的会议量、时间账本与关键会议'
  return '切换其他统计周期，或前往首页发起新会议'
})

function goHome() {
  void router.push('/')
}

const overallDuration = computed<MeetingOverviewDuration>(() => stats.value?.duration ?? EMPTY_DURATION)

const activeDuration = computed<MeetingOverviewDuration>(() => {
  if (!stats.value) return EMPTY_DURATION
  if (durationKind.value === 'meeting') {
    return stats.value.durationByKind?.meeting ?? EMPTY_DURATION
  }
  if (durationKind.value === 'voice') {
    return stats.value.durationByKind?.voice ?? EMPTY_DURATION
  }
  return stats.value.duration ?? EMPTY_DURATION
})

const recording = computed(() => stats.value?.recording ?? { count: 0, coverageRate: 0 })
const extremes = computed(() => stats.value?.extremes ?? { earliest: null, longest: null, latest: null })

const unrecordedCount = computed(() => Math.max(0, intVal(volume.value.total) - intVal(recording.value.count)))

const hostedPercent = computed(() => {
  const t = intVal(volume.value.total)
  if (t <= 0) return 0
  return Math.round((intVal(volume.value.hosted) / t) * 100)
})

const participatedPercent = computed(() => {
  const t = intVal(volume.value.total)
  if (t <= 0) return 0
  return Math.max(0, 100 - hostedPercent.value)
})

const hostedPercentText = computed(() => (intVal(volume.value.total) > 0 ? `${hostedPercent.value}%` : '—'))
const participatedPercentText = computed(() => (intVal(volume.value.total) > 0 ? `${participatedPercent.value}%` : '—'))

function intVal(n: number | undefined | null): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0
  return Math.round(n)
}

function formatHM(seconds: number | undefined | null): string {
  const totalSec = intVal(seconds)
  const totalMin = Math.round(totalSec / 60)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return `${h}小时${m}分钟`
}

const avgRecordingDurationText = computed(() => {
  const cnt = intVal(recording.value.count)
  if (cnt <= 0) return '—'
  const avgMin = Math.round(intVal(overallDuration.value.recordingSeconds) / cnt / 60)
  return `${avgMin}分钟`
})

const averageDurationText = computed(() => {
  const sec = intVal(activeDuration.value.averageSeconds)
  if (durationKind.value === 'all' && intVal(volume.value.total) <= 0) return '—'
  if (durationKind.value !== 'all' && intVal(activeDuration.value.totalSeconds) <= 0 && sec <= 0) return '—'
  return `${Math.round(sec / 60)}分钟`
})

const coverageRateNum = computed<number | null>(() => {
  const total = intVal(volume.value.total)
  if (total <= 0) return null
  const rate = recording.value.coverageRate
  if (typeof rate === 'number' && Number.isFinite(rate)) {
    return Math.min(100, Math.max(0, Math.round(rate)))
  }
  return Math.min(100, Math.max(0, Math.round((intVal(recording.value.count) / total) * 100)))
})

const coverageRateText = computed(() => (coverageRateNum.value === null ? '—' : `${coverageRateNum.value}%`))
const coverageArcLen = computed(() => {
  const pct = coverageRateNum.value ?? 0
  return (ARC_LEN * pct) / 100
})

function formatTimeRange(item: MeetingOverviewExtremeItem): string {
  if (!item.startTime) return '—'
  return item.endTime ? `${item.startTime} - ${item.endTime}` : item.startTime
}

let reqSeq = 0

async function loadOverview() {
  const seq = ++reqSeq
  loading.value = true
  try {
    try {
      const res = await getMeetingOverview({ dimension: dimension.value })
      if (seq !== reqSeq) return
      if (res.data && res.data.volume) {
        stats.value = res.data
        return
      }
    } catch {
      /* 远端云服务尚未部署 /meetings/overview 时自动回退到已有列表接口 */
    }
    const fallback = await fetchOverviewFallbackFromList(dimension.value)
    if (seq !== reqSeq) return
    stats.value = fallback
  } catch {
    if (seq !== reqSeq) return
  } finally {
    if (seq === reqSeq) loading.value = false
  }
}

function selectDimension(dim: StatsDimension) {
  if (dimension.value === dim) return
  dimension.value = dim
  void loadOverview()
}

onMounted(() => {
  void loadOverview()
})
</script>

<style scoped>
/* 与系统原生日间 / 夜间主题 (--bg-dark / --bg-card / --bg-soft / --border-color) 100% 融为一体 */
.ov-board {
  --ov-blue: #165dff;
  --ov-indigo: #4f46e5;
  --ov-emerald: #059669;
  --ov-cyan: #0284c7;
  --ov-track: rgba(148, 163, 184, 0.2);
  --ov-sub-bg: var(--bg-soft, #f7fafc);
  --ov-card-shadow: 0 2px 10px rgba(15, 23, 42, 0.04);

  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 20px 28px 28px;
  color: var(--text-primary);
}

:global(.dark-theme) .ov-board {
  --ov-blue: #60a5fa;
  --ov-indigo: #a5b4fc;
  --ov-emerald: #34d399;
  --ov-cyan: #38bdf8;
  --ov-track: rgba(148, 163, 184, 0.16);
  --ov-sub-bg: rgba(15, 23, 42, 0.42);
  --ov-card-shadow: 0 4px 18px rgba(0, 0, 0, 0.24);
}

.ov-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.ov-title-group {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.ov-accent-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--primary, #165dff);
  box-shadow: 0 0 0 4px var(--primary-soft, rgba(22, 93, 255, 0.14));
}

.ov-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: 0.02em;
}

.ov-seg {
  display: inline-flex;
  align-items: center;
  padding: 3px;
  border-radius: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
}

.ov-seg-btn {
  min-width: 66px;
  height: 30px;
  padding: 0 14px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease;
}

.ov-seg-btn:hover {
  color: var(--text-primary);
}

.ov-seg-btn.active {
  background: var(--primary, #165dff);
  color: #ffffff;
}

.ov-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 80px 0;
  color: var(--text-muted);
  font-size: 14px;
}

.ov-spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--ov-track);
  border-top-color: var(--primary, #165dff);
  animation: ov-spin 0.8s linear infinite;
}

@keyframes ov-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 新用户 / 无记录静默页 */
.ov-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 72px 24px;
  border-radius: 16px;
  background: var(--bg-card);
  border: 1px dashed var(--border-color);
  gap: 12px;
}

.ov-empty-orb {
  width: 60px;
  height: 60px;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--primary-soft);
  color: var(--primary-text);
  font-size: 28px;
  margin-bottom: 4px;
}

.ov-empty-title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  color: var(--text-primary);
}

.ov-empty-desc {
  margin: 0;
  max-width: 420px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-muted);
}

.ov-empty-btn {
  margin-top: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 20px;
  border: 0;
  border-radius: 10px;
  background: var(--primary, #165dff);
  color: #ffffff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.ov-empty-btn:hover {
  opacity: 0.92;
}

.ov-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
  transition: opacity 0.18s ease;
}

.ov-body.is-refreshing {
  opacity: 0.65;
}

/* 分组头 */
.ov-sec-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.ov-sec-head {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.ov-sec-bar {
  width: 4px;
  height: 14px;
  border-radius: 2px;
}

.ov-sec-bar.is-blue {
  background: var(--ov-blue);
}

.ov-sec-bar.is-emerald {
  background: var(--ov-emerald);
}

.ov-sec-bar.is-indigo {
  background: var(--ov-indigo);
}

.ov-sec-bar.is-cyan {
  background: var(--ov-cyan);
}

.ov-sec-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
}

/* 通用卡片 */
.ov-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 14px;
  padding: 20px 22px;
  box-shadow: var(--ov-card-shadow);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 16px;
}

.ov-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
}

.ov-num-line {
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
}

.ov-num {
  font-family: 'DIN Alternate', 'Bahnschrift', 'SFMono-Regular', ui-monospace, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.08;
  letter-spacing: -0.02em;
}

.ov-num-hero {
  font-size: 52px;
  color: var(--ov-blue);
}

.ov-num-lg {
  font-size: 32px;
}

.ov-num-md {
  font-size: 24px;
}

.ov-num-dur {
  font-size: 22px;
  white-space: nowrap;
}

.is-blue {
  color: var(--ov-blue);
}

.is-indigo {
  color: var(--ov-indigo);
}

.is-emerald {
  color: var(--ov-emerald);
}

.ov-unit {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
}

/* 主视窗 */
.ov-hero-row {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(290px, 1fr);
  gap: 16px;
}

.ov-vol-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
}

.ov-kpi-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ov-kpi-split {
  display: inline-flex;
  align-items: center;
  gap: 22px;
  padding: 14px 22px;
  border-radius: 12px;
  background: var(--ov-sub-bg);
  border: 1px solid var(--border-color);
}

.ov-sub-cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ov-sub-divider {
  width: 1px;
  height: 38px;
  background: var(--border-color);
}

.ov-ratio-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ov-ratio-labels {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-secondary);
}

.ov-ratio-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ov-ratio-item strong {
  font-family: 'DIN Alternate', ui-monospace, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}

.ov-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.ov-dot.is-blue {
  background: var(--ov-blue);
}

.ov-dot.is-indigo {
  background: var(--ov-indigo);
}

.ov-stack-track {
  display: flex;
  width: 100%;
  height: 7px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--ov-track);
}

.ov-stack-seg {
  height: 100%;
  transition: width 0.3s ease;
}

.ov-stack-seg.is-blue {
  background: var(--ov-blue);
}

.ov-stack-seg.is-indigo {
  background: var(--ov-indigo);
}

.ov-vol-meta {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.ov-meta-box {
  padding: 11px 13px;
  border-radius: 10px;
  background: var(--ov-sub-bg);
  border: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.ov-vol-dims {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.ov-dim-box {
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--ov-sub-bg);
  border: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ov-dim-v {
  font-family: 'DIN Alternate', ui-monospace, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  white-space: nowrap;
}

.ov-dim-v small {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
  margin-left: 3px;
}

.ov-meta-k {
  font-size: 12px;
  color: var(--text-muted);
}

.ov-meta-v {
  font-family: 'DIN Alternate', ui-monospace, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
  white-space: nowrap;
}

/* 录制卡 */
.ov-gauge-stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: -8px 0 -6px;
}

.ov-gauge-svg {
  width: 176px;
  height: 142px;
}

.ov-gauge-track {
  stroke: var(--ov-track);
}

.ov-gauge-arc {
  transition: stroke-dasharray 0.45s cubic-bezier(0.22, 1, 0.36, 1);
}

.ov-gauge-center {
  position: absolute;
  top: 54%;
  left: 50%;
  transform: translate(-50%, -44%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.ov-gauge-val {
  font-size: 32px;
  color: var(--text-primary);
}

.ov-gauge-label {
  font-size: 12px;
  color: var(--text-muted);
}

.ov-rec-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.ov-rec-cell {
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--ov-sub-bg);
  border: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ov-rec-num {
  font-family: 'DIN Alternate', ui-monospace, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.ov-rec-num small {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
  margin-left: 3px;
}

.ov-rec-num.is-compact {
  font-size: 15px;
}

/* 时间账本 */
.ov-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ov-kind-seg {
  display: inline-flex;
  align-items: center;
  padding: 3px;
  border-radius: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
}

.ov-kind-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.16s ease, color 0.16s ease;
}

.ov-kind-btn:hover {
  color: var(--text-primary);
}

.ov-kind-btn.active {
  background: var(--primary, #165dff);
  color: #ffffff;
}

.ov-grid-duration {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 14px;
}

.ov-tile {
  position: relative;
  overflow: hidden;
  border-radius: 12px;
  padding: 18px 18px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  box-shadow: var(--ov-card-shadow);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 10px;
}

.ov-tile::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
}

.ov-tile.is-blue::before {
  background: var(--ov-blue);
}

.ov-tile.is-sky::before {
  background: #38bdf8;
}

.ov-tile.is-indigo::before {
  background: var(--ov-indigo);
}

.ov-tile.is-cyan::before {
  background: var(--ov-cyan);
}

.ov-tile.is-emerald::before {
  background: var(--ov-emerald);
}

/* 关键会议 */
.ov-grid-extremes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}

.ov-milestone {
  display: flex;
  align-items: stretch;
  border-radius: 12px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  box-shadow: var(--ov-card-shadow);
  overflow: hidden;
}

.ov-ms-bar {
  width: 4px;
  flex-shrink: 0;
}

.ov-ms-bar.is-blue {
  background: var(--ov-blue);
}

.ov-ms-bar.is-emerald {
  background: var(--ov-emerald);
}

.ov-ms-bar.is-indigo {
  background: var(--ov-indigo);
}

.ov-ms-body {
  flex: 1;
  min-width: 0;
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ov-ms-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ov-ms-tag {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--ov-sub-bg);
}

.ov-ms-tag.is-blue {
  color: var(--ov-blue);
}

.ov-ms-tag.is-emerald {
  color: var(--ov-emerald);
}

.ov-ms-tag.is-indigo {
  color: var(--ov-indigo);
}

.ov-ms-dur {
  font-family: 'DIN Alternate', ui-monospace, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}

.ov-ms-badge {
  font-family: 'DIN Alternate', ui-monospace, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: 700;
  color: var(--ov-emerald);
  background: rgba(16, 185, 129, 0.14);
  border-radius: 6px;
  padding: 2px 8px;
  white-space: nowrap;
}

.ov-ms-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
  height: 22px;
  line-height: 22px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ov-ms-host {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 20px;
  line-height: 20px;
  font-size: 13px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ov-ms-time {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: 'DIN Alternate', ui-monospace, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: var(--text-secondary);
}

.ov-ms-empty {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 22px;
  font-weight: 600;
  color: var(--text-muted);
  padding: 4px 0;
}

/* 业务专项 */
.ov-collapse-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 13px 18px;
  border-radius: 12px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  cursor: pointer;
}

.ov-collapse-arrow {
  font-size: 18px;
  color: var(--text-secondary);
}

.ov-grid-special {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
  gap: 14px;
}

.ov-card-sub {
  gap: 16px;
}

.ov-access-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ov-access-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ov-access-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.ov-access-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
}

.ov-bar-track {
  width: 100%;
  height: 7px;
  border-radius: 999px;
  background: var(--ov-track);
  overflow: hidden;
}

.ov-bar-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.3s ease;
}

.ov-bar-fill.is-edge {
  background: var(--ov-emerald);
}

.ov-bar-fill.is-cloud {
  background: var(--ov-blue);
}

.ov-bar-fill.is-cat {
  background: linear-gradient(90deg, var(--ov-blue), var(--ov-indigo));
}

.ov-cat-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.ov-cat-row {
  display: grid;
  grid-template-columns: 78px minmax(0, 1fr) 44px;
  align-items: center;
  gap: 12px;
}

.ov-cat-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ov-cat-count {
  font-family: 'DIN Alternate', ui-monospace, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
  text-align: right;
}

/* 响应式 */
@media (max-width: 1280px) {
  .ov-grid-duration {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 960px) {
  .ov-hero-row {
    grid-template-columns: 1fr;
  }
  .ov-grid-duration {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .ov-grid-extremes {
    grid-template-columns: 1fr;
  }
  .ov-grid-special {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .ov-board {
    padding: 16px 14px 20px;
  }
  .ov-vol-dims {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .ov-kpi-split {
    width: 100%;
    justify-content: space-around;
  }
}
</style>
