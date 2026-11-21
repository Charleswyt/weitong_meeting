<template>
  <div class="rp-page">
    <header class="rp-topbar">
      <div class="rp-top-left">
        <button class="rp-back" title="返回" @click="back">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M12 4l-1.4 1.4L5.8 10.6H20v2H5.8l4.8 4.8L12 18.8 4 11.4z" fill="currentColor" />
          </svg>
        </button>
        <div class="rp-title-group">
          <h2 class="rp-title">{{ meetingTitle }}</h2>
          <div class="rp-meta-row">
            <span class="rp-meta" :title="meetingNoTitle"><i class="rp-meta-icon">#</i>会议号 {{ metaMeetingNo }}</span>
            <span class="rp-meta"><i class="rp-meta-icon ri-calendar-line" />{{ metaDate }}</span>
            <span class="rp-meta"><i class="rp-meta-icon">⏱</i>{{ metaDuration }}</span>
            <span class="rp-tag">{{ recordingTypeLabel }}</span>
          </div>
        </div>
      </div>

      <div class="rp-top-right">
        <button
          v-if="sessionMode"
          class="rp-action"
          :disabled="composing || !videoRows.length"
          title="按这一页当前勾选的路与排列方式，合成一整场"
          @click="startCompose"
        >
          <i class="rp-action-icon ri-download-line" />{{ composeBtnText }}
        </button>
        <button v-if="composing" class="rp-action" @click="cancelCompose()">取消合成</button>
        <!-- 会话态不再给"下载当前这一路"：哪一路是"当前"取决于勾选与主画面，页面上看不出来，
             指哪下哪的下载已经挂到上面每一颗勾选上了（2026-10-09 用户定）。 -->
        <button v-if="!sessionMode" class="rp-action" :disabled="!canPlay || busyDownload" @click="download">
          <i class="rp-action-icon ri-download-line" />{{ busyDownload ? '下载中…' : '下载' }}
        </button>
        <button v-if="!sessionMode" class="rp-action" @click="onShare">
          <span class="rp-action-icon">↗</span>分享
        </button>
        <div class="rp-more-wrap">
          <button class="rp-back" title="更多" @click="moreOpen = !moreOpen">⋯</button>
          <div v-if="moreOpen" class="rp-more-menu">
            <button class="rp-more-item rp-more-danger" @click="confirmDelete">{{ localId ? '删除本机录制' : '删除该会议的录制' }}</button>
          </div>
        </div>
      </div>
    </header>

    <div class="rp-content">
      <!-- 本机分轨道录制（第 15 项）：一个全局时钟 + 多窗格，各路自己按清单找当前片，
           找不到的那一格如实显示缺口，不拿别的时间点的画面冒充连续。 -->
      <div v-if="sessionMode" class="rp-session">
        <!-- 轨道选择面板：常驻在舞台上方，用户勾选画面/声音路，默认全选 -->
        <div v-if="videoRows.length || audioRows.length" class="rp-track-panel">
          <div v-if="videoRows.length" class="rp-track-section">
            <span class="rp-track-label">画面</span>
            <div class="rp-track-options">
              <span v-for="row in videoRows" :key="'tv-' + row.recordingId" class="rp-track-check">
                <label class="rp-track-pick">
                  <input type="checkbox" :checked="selectedVideoIds.has(row.recordingId)" @change="toggleVideoTrack(row.recordingId)" />
                  <span>{{ row.ownerName }} · {{ row.streamLabel }}</span>
                </label>
                <button class="rp-track-dl" title="下载这一路画面" @click="downloadRow(row)">
                  <i class="ri-download-line" />
                </button>
              </span>
            </div>
          </div>
          <div v-if="audioRows.length" class="rp-track-section">
            <span class="rp-track-label">声音</span>
            <div class="rp-track-options">
              <span v-for="row in audioRows" :key="'ta-' + row.recordingId" class="rp-track-check">
                <label class="rp-track-pick">
                  <input type="checkbox" :checked="selectedAudioIds.has(row.recordingId)" @change="toggleAudioTrack(row.recordingId)" />
                  <span>{{ row.ownerName }} · {{ row.streamLabel }}</span>
                </label>
                <!-- 勾选就是这一路声音的唯一开关：不勾 = 不出声，也 = 不进合成成品
                     （回放所见 = 导出所得，ADR-0055）。从前这里还有第二个"静音这一路"，
                     两处控制同一个状态、会互相说假话，已撤。 -->
                <span v-if="!selectedAudioIds.has(row.recordingId)" class="rp-track-note">已静音</span>
                <span v-else-if="row.state !== 'playing'" class="rp-track-note">{{ row.statusText }}</span>
                <button
                  v-if="row.state === 'error' || row.state === 'blocked'"
                  class="rp-track-note"
                  @click="retryRow(row)"
                >重试这一路</button>
                <button class="rp-track-dl" title="下载这一路声音" @click="downloadRow(row)">
                  <i class="ri-download-line" />
                </button>
              </span>
            </div>
          </div>
        </div>

        <div class="rp-stage" :style="stageStyle">
          <article
            v-for="row in videoRows"
            :key="row.recordingId"
            v-show="row.visible"
            :ref="(el) => attachTileEl(row, el)"
            class="rp-tile"
            :style="tileStyle(row)"
            :data-state="row.state"
            :data-main="isMainTile(row) ? '1' : undefined"
            :data-thumb="isThumbTile(row) ? '1' : undefined"
            :aria-label="row.ownerName + ' · ' + row.streamLabel"
            :title="row.ownerName + ' · ' + row.streamLabel + ' · ' + row.statusText"
          >
            <video class="rp-tile-media" playsinline preload="metadata" :ref="(el) => attachRowMedia(row, el)" />
            <div v-if="row.state !== 'playing' && row.state !== 'paused'" class="rp-tile-gap">
              <span class="rp-tile-gap-char">{{ (row.ownerName || '?').charAt(0) }}</span>
              <span class="rp-tile-gap-text">{{ row.statusText }}</span>
              <button v-if="row.state === 'error' || row.state === 'blocked'" class="rp-tile-btn" @click="retryRow(row)">重试这一路</button>
            </div>
            <div class="rp-tile-cap">
              <strong class="rp-tile-name">{{ row.ownerName }} · {{ row.streamLabel }}</strong>
              <span class="rp-tile-rate" :title="row.closeReason ? closeReasonText(row.closeReason) : ''">{{ row.statusText }}</span>
              <!-- 这一路的字节出自多于一次录制：能播多少没有保证，先照实标出来（不修字节） -->
              <span v-if="row.damaged" class="rp-tile-dmg">原片有损坏</span>
              <span class="rp-tile-acts">
                <button class="rp-tile-btn" :title="isMainTile(row) ? '收回宫格' : '设为主画面'" @click="focusRow(row)">{{ isMainTile(row) ? '收回' : '放大' }}</button>
              </span>
            </div>
          </article>
          <p v-if="!videoRows.length" class="rp-stage-empty">
            {{ audioRows.length ? '本场只有录音，勾上上面的「声音」即可回听。' : '这场本地录制没有已完成的片段。' }}
          </p>
        </div>

        <div class="rp-control-row rp-stage-tools">
          <div class="rp-control-left rp-tool-groups">
            <span class="rp-tool-group">
              <span class="rp-tool-label">画面</span>
              <button v-for="m in STAGE_MODES" :key="m.value" class="rp-tile-btn"
                      :class="{ 'rp-tile-btn-on': sMode === m.value }" :aria-pressed="sMode === m.value"
                      :title="m.title" @click="setStageMode(m.value)">{{ m.label }}</button>
            </span>
            <!-- 列数只在宫格档有意义：主画面那两档的形状由"一路大 + 一圈缩略"决定，
                 留着按钮就是给一个吞点击的假控制（口径 §9.1） -->
            <span v-if="!isMainStage" class="rp-tool-group">
              <span class="rp-tool-label">列数</span>
              <button v-for="n in [1, 2, 3, 4, 5, 6]" :key="n" class="rp-tile-btn"
                      :class="{ 'rp-tile-btn-on': sLayout === n }" :aria-pressed="sLayout === n"
                      @click="setLayout(n)">{{ n }}</button>
            </span>
          </div>
          <div class="rp-control-right">
            <span class="rp-wall" title="录制开始的时刻和当前进度">{{ sWallClock }}</span>
          </div>
        </div>

        <div class="rp-session-controls">
          <div class="rp-progress" @pointerdown="onTrackPointerDown" @click="onTrackClick">
            <div class="rp-progress-played" :style="{ width: progressPercent + '%' }" />
          </div>
          <div class="rp-control-row">
            <div class="rp-control-left">
              <button class="rp-ctl rp-ctl-dark" :title="sPlaying ? '暂停' : '播放'" @click="togglePlay">
                <i :class="sPlaying ? 'ri-pause-line' : 'ri-play-line'" />
              </button>
              <button class="rp-ctl rp-ctl-dark" title="后退 10 秒" :disabled="!sDuration" @click="engine?.rewind()">-10</button>
              <button class="rp-ctl rp-ctl-dark" title="前进 10 秒" :disabled="!sDuration" @click="engine?.forward()">+10</button>
              <span class="rp-time rp-time-dark">{{ fmtClock(sTime) }} / {{ fmtClock(sDuration) }}</span>
              <button class="rp-ctl rp-ctl-dark" :title="sMuted ? '恢复声音' : '全部静音'" :aria-pressed="sMuted" @click="toggleGlobalMute">
                <i :class="sMuted ? 'ri-volume-mute-line' : 'ri-volume-up-line'" />
              </button>
            </div>
            <div class="rp-control-right">
              <div class="rp-speed-wrap">
                <button class="rp-ctl rp-ctl-dark" title="播放速度" @click="speedOpen = !speedOpen">{{ sRate }}×</button>
                <div v-if="speedOpen" class="rp-more-menu rp-speed-menu">
                  <button
                    v-for="r in sessionRates"
                    :key="r"
                    class="rp-more-item"
                    :class="{ 'rp-more-on': r === sRate }"
                    @click="setRate(r)"
                  >
                    {{ r }}×
                  </button>
                </div>
              </div>
              <button class="rp-ctl rp-ctl-dark" title="全屏" @click="toggleFullscreen"><i class="ri-fullscreen-line" /></button>
            </div>
          </div>
          <p class="rp-sync-hint">{{ sSyncHint }}</p>
        </div>

        <!-- 纯音轨行的 `<audio>` 必须留着挂载点：引擎播的就是 `row.media`，把整块面板一删，
             声音会跟着元素一起没了。面板上那三行重复控制（静音 / 下载 / 状态）已按
             2026-10-09 定的口径撤到上面的「声音」勾选里，这里只剩不可见的元素本身。 -->
        <div v-if="audioRows.length" class="rp-audio-mount" aria-hidden="true">
          <audio
            v-for="row in audioRows.filter((r) => !r.hasVideo)"
            :key="'am-' + row.recordingId"
            preload="metadata"
            :ref="(el) => attachRowMedia(row, el)"
          />
        </div>
      </div>

      <div v-else class="rp-player" :class="{ 'rp-player-live': started }">
        <video
          ref="videoRef"
          class="rp-video"
          playsinline
          preload="metadata"
          @click="togglePlay"
          @timeupdate="onTimeUpdate"
          @loadedmetadata="onLoadedMetadata"
          @ended="started = false"
        />

        <!-- 只开麦没开摄像头的录制本来就没有像素：留一块纯黑会被当成"回放坏了"（第 7 项报的就是这个）。
             如实说明这路只有声音，并把正在播的是谁标出来。 -->
        <div v-if="audioOnly && started" class="rp-audio-only">
          <i class="rp-audio-icon ri-mic-line" />
          <span class="rp-audio-who">{{ current?.displayName || '参会者' }} · {{ current?.mediaLabel }}</span>
          <span class="rp-audio-hint">该路录制只有声音，没有画面</span>
        </div>

        <div v-if="!started" class="rp-idle">
          <button class="rp-play-ring" :disabled="!canPlay" :title="canPlay ? '播放' : noSourceHint" @click="start">
            <span class="rp-play-inner">▶</span>
          </button>
          <p v-if="loadError || (!loading && !canPlay)" class="rp-idle-hint">{{ loadError || noSourceHint }}</p>
        </div>

        <div v-if="started" class="rp-controls">
          <div class="rp-progress" @pointerdown="onTrackPointerDown" @click="onTrackClick">
            <div class="rp-progress-played" :style="{ width: progressPercent + '%' }" />
          </div>
          <div class="rp-control-row">
            <div class="rp-control-left">
              <button class="rp-ctl" :title="playing ? '暂停' : '播放'" @click="togglePlay">
                <i :class="playing ? 'ri-pause-line' : 'ri-play-line'" />
              </button>
              <span class="rp-time">{{ fmtClock(currentSec) }} / {{ fmtClock(totalSec) }}</span>
              <button class="rp-ctl" :title="muted ? '取消静音' : '静音'" @click="toggleMute">
                <i :class="muted ? 'ri-volume-mute-line' : 'ri-volume-up-line'" />
              </button>
              <input v-model.number="volume" class="rp-volume" type="range" min="0" max="1" step="0.05" @input="applyVolume" />
            </div>
            <div class="rp-control-right">
              <div class="rp-speed-wrap">
                <button class="rp-ctl" title="播放设置" @click="speedOpen = !speedOpen">{{ rate }}×</button>
                <div v-if="speedOpen" class="rp-more-menu rp-speed-menu">
                  <button
                    v-for="r in rates"
                    :key="r"
                    class="rp-more-item"
                    :class="{ 'rp-more-on': r === rate }"
                    @click="setRate(r)"
                  >
                    {{ r }}×
                  </button>
                </div>
              </div>
              <button class="rp-ctl" title="全屏" @click="toggleFullscreen"><i class="ri-fullscreen-line" /></button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="!sessionMode && streams.length > 1" class="rp-streams">
        <span class="rp-streams-label">本场共 {{ streams.length }} 路录制</span>
        <button
          v-for="(s, i) in streams"
          :key="s.recordingId"
          class="rp-stream-chip"
          :class="{ 'rp-stream-on': i === currentIdx }"
          @click="selectStream(i)"
        >
          {{ [s.displayName, s.mediaLabel].filter(Boolean).join(' · ') || ('第 ' + (i + 1) + ' 路') }}
        </button>
      </div>

      <section class="rp-file-card">
        <header class="rp-file-head"><span class="rp-file-head-icon">ⓘ</span>录制信息</header>
        <div class="rp-file-items">
          <div v-for="f in fileItems" :key="f.label" class="rp-file-item" :title="f.title || ''">
            <span class="rp-file-label">{{ f.label }}</span>
            <span class="rp-file-value">{{ f.value }}</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import Hls from 'hls.js'
import { deleteRecording, getDownloadUrl, getPlayback, getRecordingList, type PlaybackData, type PlaybackStream } from '@/api/recording'
import { cloudStreamsToTracks, type CloudLane } from '@/utils/cloudReplay'
import { formatDateTime, humanizeDuration } from '@/utils/time'
import { formatMeetingNo, MEETING_NO_ABSENT, MEETING_NO_ABSENT_HINT } from '@/utils/meetingNo'
import {
  inspectLocalRecording,
  getLocalRecordingBlob,
  getSegmentBlob,
  getTrackBlobFromDisk,
  getTrackBlob,
  removeLocalRecording,
  downloadBlob,
  type LocalRecording,
} from '@/utils/localRecorder'
import { ReplayEngine, formatClock, groupTracksByLane, type EngineRow, type EngineTrack } from '@/utils/replayEngine'
import { webmInitHeaderBytes } from '@/utils/webmDuration'
import {
  assembleTrackBlob,
  downloadLocalRecordingTracks,
  describeTrackDownload,
  trackIsDamaged,
  type ComposePane,
} from '@/utils/trackRecorder'
import { ensureAudioBus } from '@/utils/audioBus'
import { useComposeStore, composeTaskIdOf } from '@/store/compose'
import { autoCols, buildLayout, type LayoutLane, type LayoutMode } from '@/utils/composeLayout'
import { buildLanesFromRecording } from '@/utils/offlineCompose/intake'
import { lanesTimelineEndSec } from '@/utils/offlineCompose/engine'
import { buildLanesFromCloud } from '@/utils/offlineCompose/cloudIntake'
import { composeRealtime } from '@/utils/offlineCompose/composeRealtime'
import type { ComposeCtl, ComposeLane, ComposeOutcome, ComposeSpec } from '@/utils/offlineCompose/engine'
import { createHoldController } from '@/utils/visibilityHold'
import { forgetPlaybackPath, rememberPlaybackPath } from '@/utils/playbackResume'
import { copyText } from '@/utils/clipboard'

const route = useRoute()
const router = useRouter()

const meetingId = String(route.params.meetingId || '')
const wantRecordingId = String(route.query.rec || '')
// 本机录制走 ?local=<清单 id>：文件在 IndexedDB 里，后端从来不知道它存在。
const localId = String(route.query.local || '')
let localObjectUrl = ''

const loading = ref(false)
const loadError = ref('')
const data = ref<PlaybackData | null>(null)
const currentIdx = ref(0)
const streams = computed<PlaybackStream[]>(() => data.value?.streams || [])
const current = computed(() => streams.value[currentIdx.value] || null)
// 录制行的元信息（大小/类型/标题）只有列表里有真值，回放接口不返回这些。
const listed = ref<{ title: string; startedAt: string; durationSec: number; fileSizeBytes: number; recordingType: string } | null>(null)

const videoRef = ref<HTMLVideoElement | null>(null)
let hlsInstance: Hls | null = null

const started = ref(false)
const playing = ref(false)
const muted = ref(false)
const volume = ref(1)
const rate = ref(1)
const rates = [0.5, 1, 1.25, 1.5, 2]
// 分轨道回放的速度档位与三方回看页一致（0.5/1/1.5/2）：多路同时 seek 时 1.25× 这种
// 非整档会让各路反复对不齐，实测在 4 路以上尤其明显。
const sessionRates = [0.5, 1, 1.5, 2]
const speedOpen = ref(false)
const moreOpen = ref(false)
const currentSec = ref(0)
const totalSec = ref(0)
const busyDownload = ref(false)

// —— 本机分轨道录制（schema 2）的回放与合成导出 ——————————————————————————
// 清单是唯一依据：每一路有哪些片、从哪一刻开始、什么时候停的，都读录制时逐片落下的记录，
// 不在这里推断任何"应该有"的片段。
const sessionMeta = ref<LocalRecording | null>(null)
const engine = shallowRef<ReplayEngine | null>(null)
// 引擎改一次状态就 +1：窗格状态、倍速、静音这些都是引擎里的普通对象，靠这个计数触发重渲染。
const tick = ref(0)
const sTime = ref(0)
/**
 * 合成任务活在 `store/compose` 的队列里，不活在本组件的 ref 上 ——
 * "点完可以离开这一页"是选后台合成的理由，任务挂在组件上时这句话就是假的（换路由 = 组件卸载 = 任务没）。
 * 本页只留三件事：这一场的任务键、按钮文案、以及实时那条路需要的媒体元素句柄。
 */
const composeStore = useComposeStore()
const composeTaskId = ref('')
const myComposeTask = computed(() =>
  composeTaskId.value ? composeStore.tasks.find((t) => t.id === composeTaskId.value) ?? null : null,
)
const composing = computed(() => {
  const t = myComposeTask.value
  return !!t && (t.state === 'queued' || t.state === 'running')
})
/** 页面被切到后台——实时合成按住、回前台接着录（按住的这段时间既不进文件也不占时长） */
const composeHeld = ref(false)
const composeBtnText = computed(() => {
  const t = myComposeTask.value
  if (!t || !composing.value) return '合成整场（按当前勾选与布局）'
  if (t.state === 'queued') return '排队中 · 前面还有合成在跑'
  if (composeHeld.value) return '已暂停 · 切回这一页就接着合成'
  if (t.phase === 'wrap') return '正在生成成品…'
  const pct = Math.round((t.ratio || 0) * 100)
  // 只有前台陪放能报"约剩几秒"：剩余就是剩余内容。后台那条的预估要靠没标定的吞吐算，写出来就是承诺
  if (t.engine === 'realtime') {
    return `合成中 ${pct}% · 约剩 ${Math.max(0, Math.round((t.expectedSec || 0) - t.coveredSec))} 秒`
  }
  return `后台合成中 ${pct}% · 已到第 ${Math.round(t.coveredSec || 0)} 秒`
})
function cancelCompose() {
  if (composeTaskId.value) composeStore.cancel(composeTaskId.value)
}
// —— 轨道选择：用户勾选的画面路和声音路（默认全选）——
const selectedVideoIds = ref(new Set<string>())
const selectedAudioIds = ref(new Set<string>())
const urlCache = new Map<string, string>()
// 云端会话里"某一片 → 它是哪条录制、该下载谁"的对照：回放清单每片都是一条独立录制。
let cloudLanes = new Map<string, CloudLane>()

// 只要建起了多路引擎就是会话态（本机分轨道、云端多路发布都走这一套窗格与控件）。
const sessionMode = computed(() => !!engine.value)
const engineRows = computed<EngineRow[]>(() => {
  void tick.value
  return engine.value?.rows || []
})
const videoRows = computed(() => engineRows.value.filter((r) => r.hasVideo))
const audioRows = computed(() => {
  void tick.value
  const eng = engine.value
  return eng ? eng.rows.filter((r) => r.hasAudio) : []
})
const sDuration = computed(() => {
  void tick.value
  return engine.value?.duration || 0
})
const sPlaying = computed(() => {
  void tick.value
  return !!engine.value?.playing
})
const sRate = computed(() => {
  void tick.value
  return engine.value?.rate || 1
})
const sMuted = computed(() => {
  void tick.value
  return !!engine.value?.muted
})
const sLayout = computed(() => {
  void tick.value
  const eng = engine.value
  if (!eng) return 1
  // 默认列数按路数算（`clamp(⌈√N⌉,1,6)`，口径正本 §4）：列数不改编码量只改形状，
  // 而 16:9 屏上画布越扁每格越小 —— 写死 2 等于替所有人决定"路多了就挤成一条横带"。
  // 引擎没记过列数时才用它；用户手动选过就一直跟着用户。
  return eng.cols || autoCols(eng.rows.filter((r) => r.hasVideo).length)
})
const sMode = computed<LayoutMode>(() => {
  void tick.value
  return engine.value?.mode || 'grid'
})
/**
 * 三档按钮（口径 §9.1）。档位名与会议中页那三个对齐（`InMeetingView` 的 `layouts`）：
 * 同一个应用里"一路大画面 + 一圈缩略"在两页叫两个名字，用户不会认为这是两件事。
 * 三档的真实差别不是方位，而是"能不能牺牲其余路来喂那一路"。
 * 列数仍另起一组 —— 从前 `宫格｜主画面·上｜主画面·右｜1列…6列` 八个同质按钮并排，
 * 两个不同维度（视图 / 列数）挤在一条带上，看着就是一排没有归属的按钮（2026-10-09 用户"太丑"）。
 */
const STAGE_MODES: Array<{ value: LayoutMode; label: string; title: string }> = [
  { value: 'grid', label: '宫格排列', title: '每一路一样大，看全场概览' },
  { value: 'top', label: '顶部排列', title: '一路大画面，其余缩小排在上方；换看哪一路点画面上的「放大」' },
  { value: 'right', label: '右侧排列', title: '一路大画面，其余缩小排在右侧；换看哪一路点画面上的「放大」' },
]
const isMainStage = computed(() => sMode.value !== 'grid')

/** 本机一格 = `ownerId+通路`（`intake.ts` 的键），云端一格 = 归组后的 `recordingId`（`cloudIntake.ts`）。 */
const stageIsCloud = computed(() => sessionMeta.value?.storage === 'cloud')
function laneKeyOf(row: EngineRow): string {
  return stageIsCloud.value ? row.recordingId : `${row.ownerId}\u0000${row.kind}`
}

/**
 * 回放页的几何**就是导出件的几何**：两边都只调这一个 `buildLayout`，喂同一批勾选进来的画面路、
 * 同一档、同一个主画面。从前 DOM 走 CSS `grid-template-columns`、导出走 `composeLayout`，
 * 两套算法各算一套 —— 分叉的症状不是报错，而是"我看到的宫格和他拿到的成品不一样"（§9.1 立这处的原因）。
 */
const stageLayout = computed(() => {
  void tick.value
  const eng = engine.value
  const rows = (eng?.videoRows || []).filter((r) => r.visible)
  const lanes: LayoutLane[] = rows.map((r) => ({
    id: laneKeyOf(r),
    hasVideo: true,
    kind: r.kind as LayoutLane['kind'],
    durationSec: Math.max(0, (r.endOffsetSec ?? eng?.duration ?? 0) - r.startOffsetSec),
  }))
  const focused = eng?.focusRowId ? rows.find((r) => r.recordingId === eng.focusRowId) : null
  return buildLayout({
    lanes,
    mode: eng?.mode || 'grid',
    cols: eng?.cols || autoCols(lanes.length),
    focusId: focused ? laneKeyOf(focused) : null,
  })
})

/**
 * 舞台宽高比 = 画布宽高比，每格按 rect 百分比绝对定位。
 * `maxWidth` 是"按比值反推的宽度上限"而不是直接夹高度：直接给 `max-height` 会让浏览器
 * 保留 100% 宽度、只压高度 ⇒ 比值被拉扁，百分比格子跟着变形，"回放所见 = 导出所得"当场作废。
 * 夹宽度则让高度自己按比值落，几何仍然精确。不夹的话主画面档（1280×810）在 1661 宽的屏上
 * 会把进度条与档位按钮整个顶到折叠线以下（2026-10-09 用户 Edge 实测）。
 */
const stageStyle = computed(() => {
  const l = stageLayout.value
  const ratio = l.canvasHeight > 0 ? l.canvasWidth / l.canvasHeight : 1.78
  return { aspectRatio: `${l.canvasWidth} / ${l.canvasHeight}`, maxWidth: `calc(${ratio.toFixed(4)} * 52vh)`, marginInline: 'auto' }
})
function tileStyle(row: EngineRow) {  const l = stageLayout.value
  const cell = l.cells.find((c) => c.id === laneKeyOf(row))
  if (!cell) return { display: 'none' }
  return {
    left: `${(cell.x / l.canvasWidth) * 100}%`,
    top: `${(cell.y / l.canvasHeight) * 100}%`,
    width: `${(cell.w / l.canvasWidth) * 100}%`,
    height: `${(cell.h / l.canvasHeight) * 100}%`,
  }
}
/** 这一格是不是主画面（`top`/`right` 档才有；宫格档恒 false） */
function isMainTile(row: EngineRow): boolean {
  const l = stageLayout.value
  return !!l.mainId && laneKeyOf(row) === l.mainId
}
/** 主画面档里除主画面之外的那些小格：宽度只有画布的 10–12%，装不下一行说明文字 */
function isThumbTile(row: EngineRow): boolean {
  const l = stageLayout.value
  return !!l.mainId && laneKeyOf(row) !== l.mainId
}

const sWallClock = computed(() => {
  void tick.value
  return engine.value ? engine.value.wallClockText() : ''
})
const sSyncHint = computed(() => {
  void tick.value
  const eng = engine.value
  if (!eng) return ''
  if (composeStore.hasPageBoundWork) return '正在前台陪放合成中，请不要离开这一页'
  if (eng.playing) return '各路按会议时间轴同步，缺口显示为中断'
  return sDuration.value ? (sTime.value >= sDuration.value ? '播放结束' : '已暂停') : '暂无可播放片段'
})
const CLOSE_REASON_TEXT: Record<string, string> = {
  session_end: '随本场录制一起结束',
  publisher_left: '这一路的参会者离开或停止发布',
  track_disabled: '这一路被关掉（关摄像头/停止共享/关麦）',
  recorder_error: '这一路编码中断',
  leave_page: '离开会议页面时结束',
}
function closeReasonText(reason: string) {
  return CLOSE_REASON_TEXT[reason] || '这一路提前结束'
}

function attachRowMedia(row: EngineRow, el: unknown) {
  const media = el as HTMLMediaElement | null
  if (!media) return
  // 首挂载时这一格所在子树还没被插进文档，`isConnected` 当场是 false ——
  // 就地判会让这一格**永远**拿不到元素：症状是整格停在「正在准备…」、时钟不动、宫格合成也不起跑
  // （引擎里连 `可播区取不出地址` 都不会打，因为 loadSegment 根本没被调到）。等一帧再交。
  void nextTick(() => {
    if (media.isConnected) engine.value?.attachMedia(row, media)
  })
}

// —— 视口观察：滚出视口的**纯画面路**不占解码器 ——
// 原型要求所有画面路默认都显示，但"全部同时解码"正是本机回放卡的直接原因（多路 VP9 软解）。
// 折中：格子照旧全部渲染，只用视口位置决定装不装载 —— 看不见的格不必解码，滚回来立刻补上。
// 带声音的画面路不在优化范围内（引擎的 shouldLoad 会把它们留着，卸载就等于把声音一起卸了）。
let tileObserver: IntersectionObserver | null = null
const tileRowOf = new WeakMap<Element, EngineRow>()

function attachTileEl(row: EngineRow, el: unknown) {
  const node = el as Element | null
  if (!node) return
  if (!tileObserver && typeof IntersectionObserver !== 'undefined') {
    tileObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const target = tileRowOf.get(entry.target)
        if (target) engine.value?.setRowOnScreen(target, entry.isIntersecting)
      }
    }, { rootMargin: '200px 0px' }) // 提前 200px 装载：滚到眼前时已经在播，不给"正在加载"的闪烁
  }
  if (!tileObserver) return
  tileRowOf.set(node, row)
  tileObserver.observe(node)
}

function retryRow(row: EngineRow) {
  engine.value?.retry(row)
}
function focusRow(row: EngineRow) {
  engine.value?.focusRow(row)
}
function setLayout(n: number) {
  engine.value?.setLayout({ cols: n })
}
/** 切档。宫格档没有主画面这一说，切回去就把选中的那一路让出来（否则"主画面"会跟着进导出） */
function setStageMode(mode: LayoutMode) {
  const eng = engine.value
  if (!eng) return
  if (mode === 'grid') eng.focusRowId = null
  eng.setLayout({ mode })
}
function toggleGlobalMute() {
  const eng = engine.value
  if (eng) eng.setMuted(!eng.muted)
}

// 每次录制会话的容器头（取该会话 seq=0 那片）：录制中途断掉后重新起播的可播区是从**无头续片**开始的，
// 不补容器头就是 `MEDIA_ERR_SRC_NOT_SUPPORTED`（实测：挖掉中间 5 片后，洞后那段直接 error）。
// 键是**会话 id**而不是窗格 id：一个人再入会后同一格里有两次会话，两次的头各归各的，
// 拿前一次的头去补后一次的续片就是喂进去一份坏文件。
const headerCache = new Map<string, Promise<Uint8Array<ArrayBuffer> | null>>()

async function initHeaderOf(row: EngineRow, session: string): Promise<Uint8Array<ArrayBuffer> | null> {
  let p = headerCache.get(session)
  if (!p) {
    p = (async () => {
      const zero = row.segments.find((s) => s.session === session && s.seq === 0)
      if (!zero) return null
      const b = await getSegmentBlob(zero.blobKey)
      if (!b) return null
      return webmInitHeaderBytes(new Uint8Array(await b.arrayBuffer()))
    })()
    headerCache.set(session, p)
  }
  return p
}

// 分片在库里是 keyed blob，播放器只认地址。**一个可播区 = 一段连续分片拼成的 Blob**：
// MediaRecorder 的时片只有第一片带容器头，把中间某一片单独喂给 <video> 会直接
// `MEDIA_ERR_SRC_NOT_SUPPORTED`（实测 code=4，第 1 片能播、第 2 片起全挂）。
// 存储侧仍然是一片一片的，这里只是把连续的片合成能播的一段。地址缓存到本页关闭。
//
// 磁盘为真源的录制（dirHandle=true）：整路是一个 .webm 文件，直接从磁盘读，
// 不走分片拼接。缓存按 track fileName 键控，同一路只读一次盘。
const diskTrackUrlCache = new Map<string, string>()

async function resolveSegmentUrl(row: EngineRow, span: EngineRow['spans'][number]) {
  const meta = sessionMeta.value
  // 磁盘录制：整路文件在授权目录里，直接读
  if (meta?.dirHandle && meta?.dirPath) {
    // 一个窗格背后可能有**多次录制**（中途退会再入 = 两次会话、两个容器）：必须按"这一段属于哪次会话"
    // 取文件。原先固定拿 sources[0]，第二段会被喂上第一段的文件（时长对不上的那种"内容串了"）。
    const track = row.sources.find((s) => s.recordingId === span.session) || row.sources[0]
    if (track) {
      const cacheKey = `${meta.id}#${track.fileName}`
      const cached = diskTrackUrlCache.get(cacheKey)
      if (cached) return cached
      const blob = await getTrackBlobFromDisk(meta, track)
      if (blob) {
        const url = URL.createObjectURL(blob)
        diskTrackUrlCache.set(cacheKey, url)
        return url
      }
    }
  }

  // IndexedDB 分片路径（旧 schema 或授权目录写入失败的降级）
  const first = span.segments[0]
  const key = first.blobKey + '#' + span.segments.length
  const cached = urlCache.get(key)
  if (cached) return cached
  const parts: Blob[] = []
  const mime = first.mime || 'video/webm'
  if (first.seq !== 0) {
    const header = await initHeaderOf(row, span.session)
    if (header) parts.push(new Blob([header], { type: mime }))
  }
  for (const seg of span.segments) {
    const blob = await getSegmentBlob(seg.blobKey)
    if (!blob) throw new Error('该片段已不可读取')
    parts.push(blob)
  }
  const url = URL.createObjectURL(new Blob(parts, { type: mime }))
  urlCache.set(key, url)
  return url
}

function buildEngine(meta: LocalRecording) {
  // 第 17 项：清单一条 = 一次连续录制会话，同一人中途退会再入是另一条。
  // 按「人 × 通路」归组后交给引擎 —— 一个窗格一个人，中断留在同一格的两个可播区之间。
  const tracks = groupTracksByLane(meta.tracks || [])
  if (!tracks.length) return
  const durationSec = Math.max(1, meta.durationSec)
  engine.value = new ReplayEngine({
    tracks,
    durationSec,
    startAtMs: meta.startedAt,
    resolveUrl: resolveSegmentUrl,
    // 本机分片必须连成区才能播（见 resolveSegmentUrl），云端那路是完整流，不开这个
    assembleRuns: true,
    onChange: () => {
      tick.value++
    },
    onClock: (t) => {
      sTime.value = t
    },
  })
  tick.value++
  initTrackSelection()
}

// 云端一路是 HLS 清单，Chromium 不能靠 media.src 直接播 —— 交给 hls.js 接管，并把令牌带上
// （清单与分片都走我方后端代理，代理端点在 JWT 组内）。返回的句柄由引擎在换片/出画时调用。
function attachCloudRow(row: EngineRow, url: string, media: HTMLMediaElement): (() => void) | null {
  if (!url.includes('.m3u8')) {
    media.src = url
    media.load()
    return null
  }
  if (Hls.isSupported()) {
    const hls = new Hls({
      xhrSetup: (xhr) => xhr.setRequestHeader('Authorization', 'Bearer ' + (localStorage.getItem('token') || '')),
    })
    hls.loadSource(url)
    hls.attachMedia(media)
    hls.on(Hls.Events.ERROR, (_e: unknown, d: any) => {
      if (!d?.fatal) return
      console.warn('[replay] 这一路 HLS 致命错误', d.type, d.details, d.response?.code)
      engine.value?.markSourceError(
        row,
        d.response?.code === 401 ? '登录态已失效，请重新登录后再回放' : '这一路播放中断，可点重试',
      )
    })
    return () => hls.destroy()
  }
  if (media.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari 原生能放 HLS，但带不出 Authorization 头，所以把令牌挂在查询串上
    const token = localStorage.getItem('token') || ''
    media.src = url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
    media.load()
    return null
  }
  engine.value?.markSourceError(row, '当前浏览器无法在线播放录制，请改用最新版 Edge 或 Chrome')
  return null
}

// 第 15/19 项：云端回看也走本机同一套多路宫格引擎。只有一路时不必宫格，仍用单路播放器
// （那套有音量条/全屏/分享，宫格态没有这些）。
function buildCloudEngine(list: PlaybackStream[]): boolean {
  const timeline = data.value?.timeline
  if (!timeline || list.length < 2) return false
  const { tracks, laneBySegmentKey } = cloudStreamsToTracks(list)
  if (!tracks.length) return false
  cloudLanes = laneBySegmentKey
  // 三方 timeline.durationSeconds 可能是预约时长而非实际经过时长（提前结束会议时不准）；
  // 从各路实际录制跨度算 max(offset + duration)，三方 timeline 仅作兜底
  const streamEnd = list.reduce((max, s) => Math.max(max, s.offsetSeconds + s.durationSeconds), 0)
  const durationSec = Math.max(1, streamEnd || timeline.durationSeconds || 0)
  const startedMs = (timeline.startAt || 0) * 1000
  sessionMeta.value = {
    id: 'cloud:' + meetingId,
    title: meetingTitle.value,
    meetingNo: data.value?.meeting?.meetingNo || '',
    fileName: '',
    startedAt: startedMs,
    durationSec,
    sizeBytes: 0,
    schema: 2,
    tracks,
    dirPath: null,
    dirHandle: false,
    partial: !!data.value?.partial,
    // 产物在三方云端，本机没有对应文件：这一路只是把回放清单合成本机清单的形状喂引擎
    storage: 'cloud',
  }
  engine.value = new ReplayEngine({
    tracks,
    durationSec,
    startAtMs: startedMs,
    resolveUrl: async (_row, span) => span.segments[0].blobKey,
    attachSource: attachCloudRow,
    onChange: () => {
      tick.value++
    },
    onClock: (t) => {
      sTime.value = t
    },
  })
  totalSec.value = durationSec
  tick.value++
  initTrackSelection()
  return true
}

/**
 * 这一格背后有几次录制（同一人中途退会再入）。原始文件是**一次会话一份** ——
 * 两次会话是两个独立的 MediaRecorder 容器，拼成一份就是个坏文件，所以不做"整格合成一个原文件"。
 */
function laneCovering(row: EngineRow, t: number) {
  const hit = row.sources.find((s) => t >= s.startOffsetSec && (s.endOffsetSec === null || t < s.endOffsetSec))
  if (hit) return hit
  return row.sources.find((s) => s.startOffsetSec > t) || row.sources[row.sources.length - 1]
}

async function downloadRow(row: EngineRow) {
  if (sessionMeta.value?.storage === 'cloud') {
    await downloadCloudRow(row)
    return
  }
  if (!row.sources.length) {
    ElMessage.error('这一路的记录已不可读取')
    return
  }
  const track = laneCovering(row, engine.value?.time ?? 0)
  // 这一路的字节出自多于一次录制（片号回绕 / 同一片两次）：交出去就是一份播不出内容的坏件，
  // 不能只说"下载好了"。这里不修字节，只说实话。
  if (trackIsDamaged(track)) {
    ElMessage.error('这一路的原片是坏的，下下来也播不出内容')
    return
  }
  if (row.sources.length > 1) {
    // 说清下的是哪一次：不说这句，用户会以为一份文件就是这整格
    ElMessage.info(
      `这一格有 ${row.sources.length} 次录制（中途退会再入），本次下的是 ${formatClock(track.startOffsetSec)} 起那一次`,
    )
  }
  const blob = await getTrackBlob(sessionMeta.value!, track, assembleTrackBlob)
  if (!blob) {
    ElMessage.error('这一路没有已完成的片段，没有可下载的内容')
    return
  }
  downloadBlob(track.fileName, blob)
}

// 云端那一侧没有"本机分片可拼"这件事：这一路此刻在播的那条发布就是可下载单位，
// 下它当前所在的这一段（一个人多次入会 = 多条录制，不谎称能一次下一整条路）。
async function downloadCloudRow(row: EngineRow) {
  const span = row.spans[row.index >= 0 ? row.index : 0] || row.spans[0]
  const lane = span ? cloudLanes.get(span.segments[0].blobKey) : undefined
  if (!lane) {
    ElMessage.error('这一路当前没有可下载的云端录制条目')
    return
  }
  busyDownload.value = true
  try {
    const res = await fetch(getDownloadUrl(lane.recordingId), {
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('token') || '') },
    })
    const ctype = res.headers.get('Content-Type') || ''
    if (!res.ok || ctype.includes('application/json')) {
      const env = await res.json().catch(() => null)
      ElMessage.error(env?.msg || '下载失败')
      return
    }
    const blob = await res.blob()
    downloadBlob(lane.fileName, blob)
  } catch {
    ElMessage.error('下载失败')
  } finally {
    busyDownload.value = false
  }
}

// —— 轨道选择：控制回放页的显示/静音 ——
function toggleVideoTrack(id: string) {
  const s = new Set(selectedVideoIds.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  selectedVideoIds.value = s
  updatePlaybackVisibility()
}
function toggleAudioTrack(id: string) {
  const s = new Set(selectedAudioIds.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  selectedAudioIds.value = s
  updatePlaybackMute()
}
function updatePlaybackVisibility() {
  const eng = engine.value
  if (!eng) return
  // 走引擎的意图接口：勾选是**意图**，装载/卸载（以及要不要补一次对齐）由引擎在一处决定。
  // 旧写法是就地改 `row.visible` 再 `renderLayout()`，而 renderLayout 会顺手卸载纯音轨行、之后又不补 sync
  // —— 暂停态下取消一次画面勾选，声音就永久不回来了。
  for (const row of eng.rows) {
    if (row.hasVideo) eng.setRowVisible(row, selectedVideoIds.value.has(row.recordingId))
  }
}
function updatePlaybackMute() {
  const eng = engine.value
  if (!eng) return
  for (const row of eng.rows) {
    if (row.hasAudio) {
      row.muted = !selectedAudioIds.value.has(row.recordingId)
    }
  }
}
function initTrackSelection() {
  const eng = engine.value
  if (!eng) return
  selectedVideoIds.value = new Set(eng.rows.filter((r) => r.hasVideo).map((r) => r.recordingId))
  selectedAudioIds.value = new Set(eng.rows.filter((r) => r.hasAudio).map((r) => r.recordingId))
}

// —— 实时合成：陪时间轴在屏幕上完整放一遍（`composeGrid` 出帧 + Web Audio 混音）——
//
// 这是「离线合成之前」那套实时合成的口径，三条都经现场验证过，别再单方面改：
//   ① **时钟按住**：页面切走就 `pause()`、回来原位 `play()` 续上 —— 那几段既不进文件也不占时长，
//      产物仍是整场。判据同时看事件与 `document.hidden`（只认事件会在"一进来就在后台"时漏判）。
//   ② 陪放期间**钉死 1× 且不静音**：这是陪着时间轴放一遍，倍速只会把内容压成快放视频。
//   ③ **半截也照给，但绝不冒充完整**：文件名与提示里都写清"只到第几秒"。
// 在它之上只加两件 2026-09-30 实测得来的事：
//   · 声音：`ensureAudioBus()` 必须在**点击的同步段**唤醒（弹窗 `await` 之后手势就没了，
//     那样混出来的是一条静音轨 —— 旧合成件实测是数字静音）。`composeGrid` 用的就是这条共用总线。
//   · 容器：收尾把 MediaRecorder 的**分片 MP4** remux 成**渐进 MP4**（`utils/mp4/remuxFmp4.ts`）——
//     分片 MP4 的 `moov` 样本表是空的，不少播放器读不到时长/索引；这一步不改码流、只重排容器。
async function startCompose() {
  if (composing.value) return
  const eng = engine.value
  if (!eng) return
  if (!selectedVideoIds.value.size) {
    ElMessage.warning('至少选一条画面轨道')
    return
  }
  const rec = sessionMeta.value
  if (!rec?.tracks?.length) {
    ElMessage.warning('这一场的录制清单还没读出来：回列表页再进来一次')
    return
  }
  // 入料装配在 DOM 之外做（列表页要用同一份判据）。勾选是**意图**、落在行上：
  // 本机一格 = ownerId+kind，云端一格 = cloudReplay 归组后的那条 recordingId ⇒ 两种键都建。
  // 只建一种的话另一侧的勾选会静默对不回格子，表现是"勾了但成品里没有这一路"
  const isCloud = rec.storage === 'cloud'
  const intake = isCloud
    ? buildLanesFromCloud(rec.tracks as unknown as EngineTrack[], data.value?.streams || [])
    : await buildLanesFromRecording(rec)
  const rowsByKey = new Map<string, EngineRow>()
  for (const r of eng.rows) {
    rowsByKey.set(`${r.ownerId}\u0000${r.kind}`, r)
    if (!rowsByKey.has(r.recordingId)) rowsByKey.set(r.recordingId, r)
  }
  const lanes: ComposeLane[] = []
  for (const l of intake.lanes) {
    const row = rowsByKey.get(l.id)
    if (!row) continue
    const hasVideo = l.hasVideo && row.visible && selectedVideoIds.value.has(row.recordingId)
    const hasAudio = l.hasAudio && selectedAudioIds.value.has(row.recordingId)
    if (!hasVideo && !hasAudio) continue
    lanes.push({ ...l, hasVideo, hasAudio, audioMuted: !hasAudio })
  }
  if (!lanes.some((l) => l.hasVideo)) {
    ElMessage.warning('这一组没有可合成的画面：先点播放让画面加载出来，或换布局后再试')
    return
  }
  // 顺序按**页面上看到的行序**排：DOM 与导出件喂给 `buildLayout` 的是同一份有序列表，
  // 不同序会让"我放大的这一格"和"成品里最大的那一格"不是同一路（两侧仍同源，只是输入不一致）
  const laneOrder = new Map(eng.rows.map((r, i) => [laneKeyOf(r), i]))
  lanes.sort((a, b) => (laneOrder.get(a.id) ?? 0) - (laneOrder.get(b.id) ?? 0))
  const focusedRow = eng.focusRowId ? eng.videoRows.find((r) => r.recordingId === eng.focusRowId) : null
  const spec: ComposeSpec = {
    lanes, mode: eng.mode, cols: sLayout.value, cellWidth: 480, fpsOut: 15,
    focusId: focusedRow ? laneKeyOf(focusedRow) : null,
    // 分母必须是被勾选路的时间轴末端。填 eng.duration（整场跨度、含没勾的路）会让
    // 只勾部分路被命名判据当成半截件 —— 完整的成品被标成「只有前 N 秒」
    durationSec: lanesTimelineEndSec(lanes),
  }

  // 只有前台陪放需要先点头：它要占满一整场、还离不开这一页。后台合成不问 ——
  // 问了就等于劝人守着这一页，而那正是这轮要拿掉的东西
  const { engine: chosen } = await composeStore.previewEngine(spec)
  if (chosen === 'realtime') {
    if (document.hidden) {
      ElMessage.warning('这一页在后台，切回来再点一次即可开始合成')
      return
    }
    // 音频总线必须在**点击的同步段**创建并唤醒（三条硬约束见 `utils/audioBus.ts`）
    const bus = ensureAudioBus()
    if (!bus) ElMessage.warning('本浏览器不支持音频混流，这次合成只会有画面')
    try {
      await ElMessageBox.confirm(
        `这场要用前台陪放：完整放一遍约 ${fmtClock(Math.max(1, Math.round(eng.duration)))}，中途切走会自动暂停，回来接着放。`
        + '跑完即下载到浏览器下载目录；只要单路用旁边的「下载当前这一路」。',
        '开始合成？',
        { confirmButtonText: '开始', cancelButtonText: '先不等', type: 'warning' },
      )
    } catch {
      return
    }
  } else {
    ElMessage.info('已开始后台合成：可以离开这一页，进度在右下角')
  }
  // 选中的路里有**文件本身是坏的**那几路（分片混进了第二次录制）：陪放到那儿解不出内容，
  // 成品就是缺那几段。这句要跟在结局后面说 —— 用户是拿着产物判断缺没缺的人，不是看进度条的人。
  const followUp: string[] = []
  const damagedLabels = eng.rows
    .filter((r) => r.damaged && (r.hasVideo ? selectedVideoIds.value.has(r.recordingId) : selectedAudioIds.value.has(r.recordingId)))
    .map((r) => `${r.ownerName} · ${r.streamLabel}`)
  if (damagedLabels.length) {
    followUp.push(`有 ${damagedLabels.length} 路的原片是坏的，成品里那几段是缺的：${damagedLabels.join('、')}`)
  }

  const runRealtime = async (ctl: ComposeCtl): Promise<ComposeOutcome> => {
    // 选中的路才进合成：画面看勾选，声音也看勾选（静音的那路 gain=0，仍然占位不出声）
  const panes: ComposePane[] = []
  for (const row of eng.rows) {
    if (!row.media) continue
    panes.push({
      id: row.recordingId,
      label: `${row.ownerName} · ${row.streamLabel}`,
      hasVideo: row.hasVideo && row.visible,
      hasAudio: row.hasAudio && selectedAudioIds.value.has(row.recordingId),
      muted: row.muted || eng.muted,
      media: row.media,
    })
  }
  let stopped = false
  /**
   * 按住/继续由 `utils/visibilityHold.ts` 的状态机管：它**只认 `document.hidden` 这一个输入**，
   * 判据与状态分开。2026-09-30 现场就是因为把两者混成一个谓词、还拿它当入参，
   * 切走之后 `holding` 永远解不开 —— 回来时钟与编码器都不恢复（"回来没有自动播放"）。
   */
  const hold = createHoldController({
    isHidden: () => document.hidden,
    onHold: () => {
      composeHeld.value = true
      eng.pause()
    },
    onResume: () => {
      composeHeld.value = false
      // 到点了就别再 play()：引擎的 play() 会把播到头的时钟重新从 0 起。
      // 引擎的 play() 自己会清掉每一路的 `blocked`，所以"切走时被浏览器拒过"的那几路
      // 会在这条路上自动重试一次 —— 回来必须能自己接着放，而不是等人去点「重试这一路」。
      if (eng.time < eng.duration - 0.05) eng.play()
    },
  })
  const onVisibility = () => {
    if (!stopped) hold.sync()
  }
  document.addEventListener('visibilitychange', onVisibility)
  hold.sync() // 开局对齐一次（一进来就不可见的情况已被上面的提示挡掉）
  try {
    // 陪放期间钉死 1× 与不静音
    eng.setRate(1)
    eng.setMuted(false)
    // 合成期所有选中的路都要装载（离屏也要）——引擎的 shouldLoad 认这个开关
    eng.composeMode = true
    eng.seek(0)
    eng.play()
    // `composeGrid` 的 `onVis()` 只负责把**出帧循环**重新踢起来，编码器的起停由它自己的 `check` 定时器管；
    // **时钟与各路媒体元素的恢复在这一侧**（`setHeld(false)` → `eng.play()`）。两条都要在，缺一条就是"切回来不动"。
    return await composeRealtime(spec, ctl, {
      panes,
      getTime: () => eng.time,
      isHolding: () => hold.isHeld(),
    })
  } catch (e) {
    console.warn('[compose] 实时合成出错', e)
    return {
      engine: 'realtime', kind: 'failed' as const, mime: '', ext: 'mp4', coveredSec: 0,
      durationSec: spec.durationSec ?? 0,
      droppedAudioLanes: [], placeholderLanes: [], skippedAnomalousLanes: [], unusableVideoLanes: [],
      reasons: [`realtime_error:${(e as Error)?.name ?? 'unknown'}`],
    }
  } finally {
    stopped = true
    document.removeEventListener('visibilitychange', onVisibility)
    composeHeld.value = false
    eng.composeMode = false
    eng.pause()
    // 按住过就要说清楚：那几段既没进文件也没占时长，产物仍是整场
    const hs = hold.stats()
    if (hs.count) followUp.push(`期间切走 ${hs.count} 次共约 ${Math.round(hs.ms / 1000)} 秒；那几段没进成品，长度仍是整场。`)
  }
  }

  const dispatched = await composeStore.dispatch({
    id: composeTaskIdOf(localId, lanes, { mode: eng.mode, cols: sLayout.value, focusId: spec.focusId }),
    label: rec.title || rec.meetingNo || '这一场',
    spec,
    runRealtime,
    followUpNotices: followUp,
  })
  composeTaskId.value = dispatched.id
}


const canPlay = computed(() => (sessionMode.value ? sDuration.value > 0 : !!current.value?.playbackUrl))
// "只有音频"有两个证据源：三方的 mediaKind，以及元数据加载后画面轨道到底有没有像素。
// 只看 mediaKind 会漏掉标注不准的文件，只看像素又要等加载完 —— 两者取或。
const noPicture = ref(false)
const audioOnly = computed(() => current.value?.mediaKind === 'audio' || (started.value && noPicture.value))
const noSourceHint = computed(() => {
  if (loading.value) return '加载中…'
  if (!streams.value.length) return '本场会议没有可回放的录制'
  return '该录制当前不可播放（云端可能已被回收）'
})

const meetingTitle = computed(() => {
  const t = data.value?.meeting?.title || listed.value?.title
  return t || '录制回放'
})
const metaDate = computed(() => {
  const started = data.value?.meeting?.startedAt
  if (started) return formatDateTime(new Date(started * 1000).toISOString())
  return listed.value?.startedAt ? formatDateTime(listed.value.startedAt) : '—'
})
const metaDuration = computed(() => {
  // 页头那个时长必须和"此刻播放器在播什么"同口径，否则同一屏会出现两个互相矛盾的数：
  // 实测这场 43 条流的会，进度条走的是整场时间轴 32:56，而页头按"这一路"报成 08:38。
  // 宫格引擎（本机分轨道会话、云端多路回看都算）播的是整场时间轴 → 报整场；
  // 只有非引擎的单路模式，报的才是那一路自己的时长
  // （整场会比单路长得多，拿整场值冒充单路是假数据 —— 两个方向都不能串）。
  const sec = sessionMode.value
    ? (sessionMeta.value?.durationSec || data.value?.timeline?.durationSeconds || 0)
    : (current.value?.durationSeconds || data.value?.timeline?.durationSeconds || listed.value?.durationSec || 0)
  return sec ? humanizeDuration(sec) : '—'
})
const recordingTypeLabel = computed(() => (listed.value?.recordingType === 'local' ? '本地录制' : '云端录制'))
const metaMeetingNo = computed(() => {
  // 三方会议号（本域没有"本地号"这种东西）。**两个来源都要读**：
  // 云端多路与本机分轨道（schema 2）走的是 `sessionMeta`（本机那条分支压根不合成 `data`，
  // 只认 `data.meeting` 就会把明明有号的录制说成"查不到" —— 与卡片对不上，实测踩过），
  // 本机单路（schema 1）才只有 `data.meeting`。两侧同值时取哪个都一样。
  const no = sessionMeta.value?.meetingNo || data.value?.meeting?.meetingNo || ''
  return no ? formatMeetingNo(no) : MEETING_NO_ABSENT
})
// 悬浮说明跟着同一个判据走：把"有没有号"再在模板里读一遍来源，就是上面那个 bug 的重演方式
const meetingNoTitle = computed(() =>
  sessionMeta.value?.meetingNo || data.value?.meeting?.meetingNo ? '' : MEETING_NO_ABSENT_HINT,
)

const fileItems = computed(() => {
  if (sessionMode.value) {
    const meta = sessionMeta.value!
    const tracks = meta.tracks || []
    const videoN = tracks.filter((t) => t.hasVideo).length
    const audioN = tracks.filter((t) => t.hasAudio).length
    const early = tracks.filter((t) => t.closeReason && t.closeReason !== 'session_end')
    // 云端清单的 tracks 实际是 EngineTrack[]（带 audioDropped），但 sessionMeta 的类型是本机清单形状，
    // 所以在这里就地读出这个可选标记 —— 不为了它去改 LocalRecording 的类型（本机录制的路永远没有它）。
    const droppedAudio = (tracks as Array<{ ownerName: string; audioDropped?: boolean }>)
      .filter((t) => t.audioDropped)
      .map((t) => t.ownerName)
    return [
      { label: '录制时间', value: formatDateTime(new Date(meta.startedAt).toISOString()), title: '' },
      {
        label: '整体时长',
        value: humanizeDuration(meta.durationSec),
        title: '录制开始到最后一个片段结束的整体时长',
      },
      {
        label: '原始轨道',
        value: `${tracks.length} 段（画面 ${videoN} · 声音 ${audioN}）· 回放 ${engine.value?.videoRows.length ?? videoN} 格画面`,
        title: '一段 = 一次连续录制；中途退会再入会另起一段',
      },
      ...(droppedAudio.length
        ? [{
            label: '音轨去重',
            value: `${droppedAudio.join('、')} 的画面音轨已丢弃`,
            title: '这些人的画面录制里也带音轨，与本人的独立音频路重复；只保留独立音频路，避免同一人同时出声两遍',
          }]
        : []),
      {
        label: '占用大小',
        value: meta.sizeBytes ? humanizeSize(meta.sizeBytes) : '—',
        title: '每一路实际存下来的大小加起来',
      },
      {
        label: '保存位置',
        value: meta.storage === 'cloud'
          ? '云端（边缘设备 / 阿里云）'
          : meta.dirPath || '仅保存在这台浏览器里',
        title: meta.storage === 'cloud'
          ? '云端录制由会议平台保存和清理，这里只负责播放'
          : meta.dirHandle
            ? '已按目录层级写入选定的保存目录'
            : '当时没写进所选目录（未选过或授权失效），录制仍在本地，可下载',
      },
      {
        label: '中断情况',
        value: early.length ? `${early.length} 路提前结束` : '无',
        title: early.map((t) => `${t.ownerName}：${closeReasonText(t.closeReason)}`).join('\n'),
      },
    ]
  }
  return [
    { label: '录制时间', value: metaDate.value, title: '' },
    { label: '视频时长', value: metaDuration.value, title: '' },
    {
      label: '占用大小',
      value: listed.value?.fileSizeBytes ? humanizeSize(listed.value.fileSizeBytes) : '—',
      title: '以录制列表的实测大小为准',
    },
    {
      label: '录制者',
      value: current.value?.displayName || '—',
      title: '这一路是谁录的',
    },
    {
      label: '观看权限',
      value: '—',
      title: '这项信息暂未提供',
    },
  ]
})

function humanizeSize(bytes: number) {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

const progressPercent = computed(() => {
  if (sessionMode.value) return sDuration.value ? (sTime.value / sDuration.value) * 100 : 0
  return totalSec.value ? (currentSec.value / totalSec.value) * 100 : 0
})

function fmtClock(sec: number) {
  const s = Math.max(0, Math.floor(sec || 0))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

function back() {
  forgetPlaybackPath()
  router.push('/recordings')
}

// —— 合成进行中"离开这一页"必须先问一句 ——
// 合成是陪着这一页的画面在放（各路的媒体元素就在这一页上），离开路由 = 陪放没了来源，只能取消；
// 但直接取消会让人以为"点了返回没事，回头文件呢"。所以：确认才取消并离开，不确认就留在原页继续跑。
// （切标签页/把浏览器放后台**不算**离开，那是"按住-回来继续"，见 startCompose 里的 setHeld。）
onBeforeRouteLeave(async () => {
  // 只有**前台陪放**才拦得住离开：它的画面来源就是这一页的媒体元素，离开就没得陪了。
  // 后台合成不依赖这一页（字节从库里按范围读），拦用户反而是把上一轮那条老毛病又焊回去。
  if (!composeStore.hasPageBoundWork) return true
  try {
    await ElMessageBox.confirm('离开会取消这次合成，已跑的部分不会留下成品。', '合成进行中', {
      type: 'warning',
      confirmButtonText: '离开并取消',
      cancelButtonText: '留在这里',
    })
  } catch {
    return false
  }
  cancelCompose()
  return true
})

/** 刷新/关标签页：交给浏览器弹它自己的提示（我们只负责在合成中把它唤起来）。 */
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!composing.value) return
  e.preventDefault()
  e.returnValue = ''
}

async function load() {
  if (localId) {
    await loadLocal()
    return
  }
  // 本机录制的地址是 `/recordings/play/local?local=<清单 id>`：**目标在那个查询串里**。
  // 少了它却按会议号去查云端，只会得到一句与真因无关的「没有找到这场会议的录制归档」——
  // 所以这里当场说清楚该从哪儿进。
  if (meetingId === 'local') {
    data.value = null
    loadError.value = '这条本机录制的地址缺少录制编号，请从「录制会议 → 本地录制」列表进入'
    return
  }
  if (!meetingId) {
    loadError.value = '缺少会议号，无法回放'
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    const res = await getPlayback(meetingId)
    data.value = res.data || null
    // 多路发布（实测单场最多 43 条）交给和本机分轨道同一套宫格引擎；
    // 只有一路时没必要宫格，仍用单路播放器（它有音量条/全屏/分享）。
    if (buildCloudEngine(streams.value)) {
      await loadListItem()
      return
    }
    // 一条录制只是某位参会者的**一路发布**：声音通路天生没有画面。
    // 默认落在有画面的那一路，否则进来就是"只有声音"，看着像播放器坏了。
    const wanted = wantRecordingId
      ? streams.value.findIndex((s) => s.recordingId === wantRecordingId)
      : streams.value.findIndex((s) => s.mediaKind && s.mediaKind !== 'audio')
    currentIdx.value = wanted >= 0 ? wanted : 0
    await loadListItem()
  } catch {
    // 提示只透出后端 msg（request 拦截器已弹），这里只把播放器留在不可播状态并说明原因
    loadError.value = '回放清单获取失败，请稍后重试'
  } finally {
    loading.value = false
  }
}

// 本机录制：清单与产物都在本机浏览器里，不走任何接口；播的是分片地址（非 HLS），
// 所以下载/删除也各自走本机分支。取不到就如实报错，不回退去问后端"这场会"。
async function loadLocal() {
  loading.value = true
  loadError.value = ''
  try {
    const looked = await inspectLocalRecording(localId)
    if (looked.state !== 'mine') {
      data.value = null
      // 三种"打不开"要分开说：报错了成因，用户才知道下一步做什么（或什么都不做）
      loadError.value =
        looked.state === 'missing'
          ? '本机录制已不可读取'
          : looked.state === 'others'
            ? '这条录制不属于当前账号'
            : '无法判定这条录制属于谁，未打开'
      return
    }
    const meta = looked.rec
    sessionMeta.value = meta
    // 分轨道录制（第 15/17 项）：走多窗格 + 全局时钟那条路，云端 HLS 通路完全不动。
    if (meta.schema === 2 && meta.tracks?.length) {
      buildEngine(meta)
      totalSec.value = meta.durationSec
      listed.value = {
        title: meta.title,
        startedAt: new Date(meta.startedAt).toISOString(),
        durationSec: meta.durationSec,
        fileSizeBytes: meta.sizeBytes,
        recordingType: 'local',
      }
      return
    }
    const blob = await getLocalRecordingBlob(localId)
    if (!blob) {
      data.value = null
      loadError.value = '本机录制已不可读取'
      return
    }
    localObjectUrl = URL.createObjectURL(blob)
    const startedSec = Math.floor(meta.startedAt / 1000)
    data.value = {
      partial: false,
      meeting: { meetingId: 'local', meetingNo: meta.meetingNo, title: meta.title, startedAt: startedSec },
      timeline: { startAt: startedSec, durationSeconds: meta.durationSec },
      streams: [{
        recordingId: meta.id,
        displayName: '本机',
        mediaKind: 'camera',
        mediaLabel: '画面+声音',
        // 契约（线格式）里这两键恒出现；schema-1 老单体产物就是"画面+声音"一路，照 mediaLabel 给真值。
        hasVideo: true,
        hasAudio: true,
        playbackUrl: localObjectUrl,
        downloadUrl: '',
        offsetSeconds: 0,
        durationSeconds: meta.durationSec,
      }],
    }
    currentIdx.value = 0
    listed.value = {
      title: meta.title,
      startedAt: new Date(meta.startedAt).toISOString(),
      durationSec: meta.durationSec,
      fileSizeBytes: meta.sizeBytes,
      recordingType: 'local',
    }
  } finally {
    loading.value = false
  }
}

// 大小与"本地/云端"只有列表接口有真源；取不到就留 '—'，不猜。
async function loadListItem() {
  try {
    const res = await getRecordingList({ pageNum: 1, pageSize: 200, keyword: '' })
    const rows = res.rows || []
    const mine = rows.find((r) => r.recordingId === (current.value?.recordingId || ''))
      || rows.find((r) => r.meetingId === meetingId)
    if (mine) {
      listed.value = {
        title: mine.title,
        startedAt: mine.startedAt,
        durationSec: mine.durationSec,
        fileSizeBytes: mine.fileSizeBytes,
        recordingType: mine.recordingType,
      }
    }
  } catch {
    /* 列表拿不到只影响文件大小这一格，不阻塞回放 */
  }
}

function destroyHls() {
  if (hlsInstance) {
    hlsInstance.destroy()
    hlsInstance = null
  }
  const el = videoRef.value
  if (el) {
    el.removeAttribute('src')
    el.load()
  }
}

async function attachSource() {
  destroyHls()
  await nextTick()
  const el = videoRef.value
  const src = current.value?.playbackUrl || ''
  if (!el || !src) return
  if (src.includes('.m3u8')) {
    if (Hls.isSupported()) {
      hlsInstance = new Hls({
        // 清单与分片都走我方后端代理，代理端点在 JWT 组内 —— 不带令牌会被 401 挡掉。
        xhrSetup: (xhr) => xhr.setRequestHeader('Authorization', 'Bearer ' + (localStorage.getItem('token') || '')),
      })
      hlsInstance.loadSource(src)
      hlsInstance.attachMedia(el)
      hlsInstance.on(Hls.Events.ERROR, (_e: unknown, d: any) => {
        if (!d?.fatal) return
        console.warn('[playback] HLS 致命错误', d.type, d.details, d.response?.code)
        loadError.value = d.response?.code === 401 ? '登录态已失效，请重新登录后再回放' : '播放中断，请关闭后重新打开回放'
      })
    } else if (el.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari 原生播不了带不出 Authorization 头的清单，代理端点对录制只读资产放行票参。
      const token = localStorage.getItem('token') || ''
      el.src = src + (src.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
    } else {
      loadError.value = '本浏览器无法在线播放，请换 Edge 或下载后观看'
      return
    }
  } else {
    el.src = src
  }
  totalSec.value = current.value?.durationSeconds || 0
}

async function start() {
  if (!canPlay.value) return
  started.value = true
  noPicture.value = false
  await attachSource()
  await nextTick()
  const el = videoRef.value
  if (!el) return
  el.volume = volume.value
  el.muted = muted.value
  try {
    await el.play()
    playing.value = true
  } catch {
    // 浏览器可能拒绝自动起播，控制条还在，用户点一下就行
    playing.value = false
  }
}

async function selectStream(i: number) {
  currentIdx.value = i
  moreOpen.value = false
  speedOpen.value = false
  if (!started.value) return
  await start()
}

async function togglePlay() {
  if (sessionMode.value) {
    const eng = engine.value
    if (!eng || !eng.duration) return
    if (eng.playing) eng.pause()
    else eng.play()
    return
  }
  if (!started.value) {
    await start()
    return
  }
  const el = videoRef.value
  if (!el) return
  if (el.paused) {
    await el.play().catch(() => undefined)
    playing.value = true
  } else {
    el.pause()
    playing.value = false
  }
}

function onTimeUpdate() {
  const el = videoRef.value
  if (!el) return
  currentSec.value = el.currentTime
  if (el.duration && Number.isFinite(el.duration)) totalSec.value = el.duration
}

function onLoadedMetadata() {
  const el = videoRef.value
  if (el && Number.isFinite(el.duration)) totalSec.value = el.duration
  // 画面轨道宽度为 0 就是"这路录制没有画面"的实测证据，别留一块黑让人以为坏了。
  noPicture.value = !!el && !el.videoWidth
}

// seek 一律以**整条时间轴**为比例基准：绑在已播段上会用那段自己的宽度算，
// 进度一变基准就变，点右侧未播区也完全没有响应。
function ratioAt(clientX: number, track: HTMLElement): number | null {
  const rect = track.getBoundingClientRect()
  if (!rect.width) return null
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
}

/** 精确落点（点击 / 松手）：一次强制对齐全部路。 */
function seekAt(clientX: number, track: HTMLElement) {
  const ratio = ratioAt(clientX, track)
  if (ratio === null) return
  if (sessionMode.value) {
    const eng = engine.value
    if (!eng || !eng.duration) return
    eng.seek(ratio * eng.duration)
    sTime.value = eng.time
    return
  }
  const el = videoRef.value
  if (!el || !totalSec.value) return
  el.currentTime = ratio * totalSec.value
  currentSec.value = el.currentTime
}

/**
 * 拖动中：只搬时钟，**不逐路强制 seek**（`engine.scrub` 里按 ~10Hz 做常规对齐）。
 * 本机录制的 webm 没有 Cues，"每次 pointermove 都强制写 currentTime"会让每路反复重扫 Cluster，
 * 画面一顿一顿 —— 松手时再由 `seekAt` 落到精确位置。
 * 单路播放器（原生 `<video>`）没这个问题，照旧直接写 currentTime。
 */
function scrubAt(clientX: number, track: HTMLElement) {
  const ratio = ratioAt(clientX, track)
  if (ratio === null) return
  if (sessionMode.value) {
    const eng = engine.value
    if (!eng || !eng.duration) return
    eng.scrub(ratio * eng.duration)
    sTime.value = eng.time
    return
  }
  const el = videoRef.value
  if (!el || !totalSec.value) return
  el.currentTime = ratio * totalSec.value
  currentSec.value = el.currentTime
}

function onTrackClick(e: MouseEvent) {
  seekAt(e.clientX, e.currentTarget as HTMLElement)
}

// 按住拖动：pointer capture 让指针移出轨道仍收得到事件；
// 拖动中走 scrub（轻），松手才 seek（重，精确）。
function onTrackPointerDown(e: PointerEvent) {
  const track = e.currentTarget as HTMLElement
  // 必须捕获指针：从进度条按下、拖到条**外面**松手时，pointermove/pointerup 不会再回到这个元素，
  // 那对监听器就永久留在原地 —— 之后鼠标只是划过进度条也会跟着 seek（看起来像"进度条黏住了"）。
  track.setPointerCapture?.(e.pointerId)
  seekAt(e.clientX, track)
  let lastX = e.clientX
  const move = (ev: PointerEvent) => {
    lastX = ev.clientX
    scrubAt(ev.clientX, track)
  }
  const up = () => {
    if (track.hasPointerCapture?.(e.pointerId)) track.releasePointerCapture(e.pointerId)
    track.removeEventListener('pointermove', move)
    track.removeEventListener('pointerup', up)
    track.removeEventListener('pointercancel', up)
    // 松手落到精确位置：拖动中只搬时钟，这里才把每一路真正对齐到同一时刻
    seekAt(lastX, track)
  }
  track.addEventListener('pointermove', move)
  track.addEventListener('pointerup', up)
  track.addEventListener('pointercancel', up)
}

// 音量 slider 只改 ref 不会作用到元素上 —— 必须在这里回写，用户才听得到变化。
function applyVolume() {
  const el = videoRef.value
  if (!el) return
  el.volume = volume.value
  el.muted = volume.value === 0
  muted.value = el.muted
}

function toggleMute() {
  const el = videoRef.value
  muted.value = !muted.value
  if (el) el.muted = muted.value
}

function setRate(r: number) {
  rate.value = r
  speedOpen.value = false
  if (sessionMode.value) {
    engine.value?.setRate(r)
    return
  }
  if (videoRef.value) videoRef.value.playbackRate = r
}

async function toggleFullscreen() {
  const el = document.querySelector(sessionMode.value ? '.rp-session' : '.rp-player')
  if (!el) return
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await el.requestFullscreen()
  } catch {
    ElMessage.info('浏览器拒绝了全屏请求')
  }
}

async function onShare() {
  const src = current.value?.playbackUrl
  if (!src) {
    ElMessage.warning('当前没有可分享的录制地址')
    return
  }
  // 分享只能是这条回放地址本身：本系统没有"分享给某人"的授权接口，不做假动作。
  const ok = await copyText(location.origin + route.fullPath)
  if (ok) ElMessage.success('链接已复制；对方需用自己的账号登录')
  else ElMessage.info('复制失败，请手动复制地址栏链接')
}

async function download() {
  // 分轨道的本机录制没有"一个整场文件"可下：这里下的是当前看到的那一路原片，
  // 要整场的一份请用「合成整场（按当前勾选与布局）」。
  if (sessionMode.value) {
    const row = videoRows.value.find((r) => r.visible) || videoRows.value[0] || audioRows.value[0]
    if (!row) {
      ElMessage.error('这一路没有可下载的录制')
      return
    }
    await downloadRow(row)
    return
  }
  const rec = current.value?.recordingId
  if (!rec) return
  if (localId) {
    const looked = await inspectLocalRecording(localId)
    if (looked.state !== 'mine') {
      ElMessage.error(
        looked.state === 'missing'
          ? '本机录制已不可读取'
          : looked.state === 'others'
            ? '这条录制不属于当前账号'
            : '无法判定这条录制属于谁，未下载',
      )
      return
    }
    const meta = looked.rec
    // 与列表页同一个修复（D3）：schema 2 没有 `blobs[条目id]` 这个键，整场下载要按清单逐路拼回原片。
    const trackCount = (meta?.tracks || []).filter((t) => t.segments.length > 0).length
    if (trackCount) {
      const { ok, failed, damaged } = await downloadLocalRecordingTracks(meta!)
      const note = describeTrackDownload({ ok, failed, damaged })
      if (note.tone === 'error') ElMessage.error(note.text)
      else if (note.tone === 'warning') ElMessage.warning(note.text)
      else if (note.text) ElMessage.info(note.text)
      return
    }
    const blob = await getLocalRecordingBlob(localId)
    if (!blob) {
      ElMessage.error('本机录制已不可读取')
      return
    }
    downloadBlob(meta?.fileName || `${localId}.webm`, blob)
    return
  }
  busyDownload.value = true
  try {
    const res = await fetch(getDownloadUrl(rec), {
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('token') || '') },
    })
    const ctype = res.headers.get('Content-Type') || ''
    if (!res.ok || ctype.includes('application/json')) {
      const env = await res.json().catch(() => null)
      ElMessage.error(env?.msg || '下载失败')
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${meetingTitle.value || 'recording'}.mp4`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch {
    ElMessage.error('下载失败')
  } finally {
    busyDownload.value = false
  }
}

async function confirmDelete() {
  const rec = current.value?.recordingId
  moreOpen.value = false
  if (!rec && !localId) return
  if (localId) {
    try {
      await ElMessageBox.confirm('只影响这台设备上保存的这份录制，且不可恢复。', '删除确认', {
        type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消',
      })
    } catch {
      return
    }
    try {
      await removeLocalRecording(localId)
      ElMessage.success('本机录制已删除')
      router.push('/recordings')
    } catch {
      ElMessage.error('删除失败')
    }
    return
  }
  try {
    await ElMessageBox.confirm(
      '这会一并移除该会议的所有录制，且不可恢复。',
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await deleteRecording(rec)
    ElMessage.success('该会议的录制已删除')
    router.push('/recordings')
  } catch {
    /* 提示由 request 拦截器统一给出 */
  }
}

onMounted(() => {
  // 记**整条地址**（含 `?local=` 这类查询串）：只记 meetingId 的话，本机录制的续看入口会退化成
  // "查会议 local 的云端归档"（见 utils/playbackResume.ts 的注释）。
  rememberPlaybackPath(route.fullPath)
  window.addEventListener('beforeunload', onBeforeUnload)
  load()
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  // 这一页要拆了：前台陪放那条**必须**停 —— 它的画面来源就是本页那些媒体元素，
  // 拆了页就没得陪了；停法仍交给 composeGrid 自己的收尾（不要在这里硬停编码器，
  // 编码器 `paused` 时直接 stop 会把最后一段留在缓冲里）。
  // 后台那条不依赖本页，留着它跑完 —— 这正是"可以离开这一页"的落点。
  if (myComposeTask.value?.pageBound) cancelCompose()
  destroyHls()
  tileObserver?.disconnect()
  tileObserver = null
  if (localObjectUrl) URL.revokeObjectURL(localObjectUrl)
  engine.value?.destroy()
  engine.value = null
  for (const url of urlCache.values()) URL.revokeObjectURL(url)
  urlCache.clear()
  // 磁盘那一路的 objectURL 原先从不释放：离开回放页后整份文件仍被这些 URL 钉着，
  // 连着看几场录制内存只增不减（多路大文件时尤其明显）。
  for (const url of diskTrackUrlCache.values()) URL.revokeObjectURL(url)
  diskTrackUrlCache.clear()
  headerCache.clear()
})
</script>

<style scoped>
.rp-page {
  padding: 0 0 36px;
  /* 底色走全局 --bg-dark（与会中页容器同一块底色）。原来写的是 var(--bg-page, #f4f6fa)，
     而 --bg-page 全仓从未定义过 → 永远吃浅色兜底，深色主题下这页底色不跟着翻。 */
  background: var(--bg-dark);
  min-height: 100%;
  /* 只有"压在视频画面上"的那一层不参与主题（两种主题下画面区都是暗的），
     集中成这一组 on-media 值；其余一律走全局 token，别再散写 slate 字面量。
     --rp-media-bg 与会中页 .im-video 同值，两页的画面底色保持一致。 */
  --rp-media-bg: #1e293b;
  --rp-on-media: #e2e8f0;
  --rp-on-media-dim: #94a3b8;
  --rp-on-media-border: rgba(226, 232, 240, 0.28);
  --rp-on-media-fill: rgba(148, 163, 184, 0.18);
  /* 压在画面上的"这一路文件坏了"标记：不参与主题（画面区两种主题都是暗的），
     所以照上面的规矩集中声明一个 on-media 值，而不是散写十六进制字面量。 */
  --rp-on-media-warn: #fbbf24;
  /* 格底名牌压在画面上那一层：与会议中页 `InMeetingView` 的 `.im-tile-foot` / `.im-statbar` 同一个值，
     两边要改一起改（那两处的字色也是钉死的 slate，不跟主题翻，理由同本页）。 */
  --rp-on-media-scrim: rgba(15, 23, 42, 0.55);
  --rp-scrim-grad: linear-gradient(to top, rgba(11, 18, 32, 0.9), rgba(11, 18, 32, 0));
  --rp-track: rgba(226, 232, 240, 0.22);
}

.rp-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px 0;
}
.rp-top-left { display: flex; align-items: center; gap: 14px; min-width: 0; }
.rp-top-right { display: flex; align-items: center; gap: 12px; }

.rp-back {
  width: 40px; height: 40px; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--border-color); border-radius: 11px;
  background: var(--bg-card); color: var(--text-secondary); cursor: pointer;
}
.rp-back:hover { color: var(--text-primary); }

.rp-title-group { min-width: 0; }
.rp-title {
  margin: 0; font-size: 20px; font-weight: 600; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rp-meta-row { display: flex; align-items: center; gap: 12px; margin-top: 4px; }
.rp-meta { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; color: var(--text-tertiary); }
.rp-meta-icon { font-style: normal; font-size: 13px; }
.rp-tag {
  padding: 1px 8px; border-radius: 6px; background: var(--primary-soft); color: var(--primary-text); font-size: 12px;
}

.rp-action {
  display: inline-flex; align-items: center; gap: 6px;
  height: 40px; padding: 0 16px;
  border: 1px solid var(--border-color); border-radius: 11px;
  background: var(--bg-card); color: var(--text-secondary); font-size: 14px; cursor: pointer;
}
.rp-action:hover:not(:disabled) { color: var(--primary-text); border-color: var(--primary); }
.rp-action:disabled { opacity: 0.5; cursor: not-allowed; }
.rp-action-icon { font-style: normal; }

.rp-more-wrap { position: relative; }
.rp-more-menu {
  position: absolute; right: 0; top: 44px; z-index: 20;
  min-width: 160px; padding: 6px;
  border: 1px solid var(--border-color); border-radius: 10px;
  background: var(--bg-card); box-shadow: var(--shadow);
}
.rp-more-item {
  display: block; width: 100%; padding: 8px 10px;
  border: 0; border-radius: 8px; background: transparent;
  color: var(--text-secondary); font-size: 13px; text-align: left; cursor: pointer;
}
.rp-more-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.rp-more-on { color: var(--primary-text); font-weight: 600; }
.rp-more-danger:hover { color: var(--danger-text); background: var(--danger-bg); }

.rp-content { display: flex; flex-direction: column; gap: 20px; padding: 20px 40px 0; }

.rp-player {
  position: relative;
  height: 600px; max-height: 62vh;
  border-radius: 18px; overflow: hidden;
  background: var(--rp-media-bg);
}
.rp-video { width: 100%; height: 100%; object-fit: contain; display: block; }

.rp-audio-only {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px;
  pointer-events: none; color: var(--rp-on-media-dim);
}
.rp-audio-icon { font-size: 56px; line-height: 1; }
.rp-audio-who { font-size: 15px; color: var(--rp-on-media); }
.rp-audio-hint { font-size: 13px; }

.rp-idle {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
}
/* 播放键用主色实心圆，跟全站按钮语言一致（原先是白底黑字的播放器通用外观）。 */
.rp-play-ring {
  width: 96px; height: 96px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border: 1px solid var(--rp-on-media-border); border-radius: 9999px;
  background: transparent; cursor: pointer;
}
.rp-play-ring:disabled { cursor: not-allowed; opacity: 0.6; }
.rp-play-inner {
  width: 76px; height: 76px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 9999px; background: var(--primary); color: #fff; font-size: 26px;
}
.rp-idle-hint { margin: 0; font-size: 13px; color: var(--rp-on-media-dim); }

.rp-controls {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: flex; flex-direction: column; gap: 12px;
  padding: 20px 24px;
  background: var(--rp-scrim-grad);
}
/* 命中区 14px、可视条 4px：4px 高的轨道人根本按不住，拖动就失效了。 */
.rp-progress {
  position: relative;
  height: 14px;
  padding: 5px 0;
  box-sizing: border-box;
  background: var(--rp-track);
  background-clip: content-box;
  border-radius: 9999px;
  cursor: pointer;
}
.rp-progress-played { height: 4px; border-radius: 9999px; background: var(--primary); }
.rp-control-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.rp-control-left, .rp-control-right { display: flex; align-items: center; gap: 16px; }
/* 布局档位分成两组各带一个名字（画面 / 缩略位置｜列数）：
   从前八个同质按钮并排，看不出哪几个是一件事，两组之间也没有边界。 */
.rp-tool-groups { gap: 14px; flex-wrap: wrap; }
.rp-tool-group { display: inline-flex; align-items: center; gap: 6px; }
.rp-tool-group + .rp-tool-group { padding-left: 14px; border-left: 1px solid var(--border-color); }
.rp-tool-label { font-size: 12px; color: var(--text-secondary); }
/* .rp-ctl 默认是"压在画面上"的取值；页面流里的那批由 .rp-ctl-dark 覆盖成主题 token。 */
.rp-ctl {
  border: 0; background: transparent; color: var(--rp-on-media); font-size: 16px; cursor: pointer; padding: 0;
}
.rp-time { font-size: 13px; color: var(--rp-on-media); }
.rp-volume { width: 72px; accent-color: var(--primary); }
.rp-speed-wrap { position: relative; }
/* 倍速按钮在播放器底栏，菜单向下开会伸出底栏被裁掉（点不到）—— 改为向上展开。 */
.rp-speed-menu { top: auto; bottom: 36px; }

.rp-streams { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rp-streams-label { font-size: 13px; color: var(--text-tertiary); }
.rp-stream-chip {
  height: 30px; padding: 0 12px;
  border: 1px solid var(--border-color); border-radius: 8px;
  background: var(--bg-card); color: var(--text-secondary); font-size: 13px; cursor: pointer;
}
.rp-stream-on { border-color: var(--primary); color: var(--primary-text); background: var(--primary-soft); }

.rp-file-card {
  display: flex; flex-direction: column; gap: 16px;
  padding: 24px; border: 1px solid var(--border-color); border-radius: 18px;
  background: var(--bg-card);
}
.rp-file-head { display: flex; align-items: center; gap: 8px; font-size: 16px; color: var(--text-primary); }
.rp-file-head-icon { color: var(--primary-text); font-style: normal; }
.rp-file-items { display: flex; gap: 16px; flex-wrap: wrap; }
.rp-file-item {
  flex: 1 1 180px; min-height: 74px;
  display: flex; flex-direction: column; gap: 6px; justify-content: center;
  padding: 16px; border: 1px solid var(--border-color); border-radius: 12px;
  background: var(--bg-soft);
}
.rp-file-label { font-size: 12px; color: var(--text-tertiary); }
.rp-file-value { font-size: 14px; color: var(--text-primary); }

/* —— 本机分轨道录制：多窗格回看 —— */
/* 这块是**页面流**，不是压在画面上的层，所以全部走主题 token：
   原先整块钉死 #0f172a/#14203a/#94a3b8 一套三方回看页的深色，浅色主题下变成页面里嵌一块黑岛、
   深色主题下又和 --bg-card 对不上，两种主题都不一致。 */
.rp-session {
  display: flex; flex-direction: column; gap: 14px;
  padding: 16px; border: 1px solid var(--border-color); border-radius: 18px;
  background: var(--bg-card);
}
/* 舞台 = 导出件画布的等比镜像：宽高比与每格的 left/top/width/height 全部来自 `composeLayout`。
   这里**不再自己排 grid** —— CSS 排一套、导出算一套正是"回放所见 ≠ 导出所见"的分叉点（口径 §9.1）。
   缝隙用边框画而不是 margin：`box-sizing: border-box` 下边框不吃位置，百分比几何保持精确。 */
.rp-stage { position: relative; width: 100%; background: var(--rp-media-bg); overflow: hidden; }
.rp-tile {
  position: absolute; display: flex; flex-direction: column; box-sizing: border-box;
  border: 2px solid var(--rp-media-bg); background: var(--bg-soft); overflow: hidden;
  /* 名牌改成压在画面上的浮层后，"格子有多窄"只能按**渲染后的真实宽度**判（画布是按比例缩放显示的），
     所以把每一格自己变成查询容器；inline-size 包含不吃 paint，绝对定位的后代照常以本格为包含块。 */
  container-type: inline-size;
}
.rp-tile[data-state='gap'], .rp-tile[data-state='error'], .rp-tile[data-state='blocked'] { border-color: var(--text-muted); }
.rp-tile-media { flex: 1 1 auto; width: 100%; min-height: 0; object-fit: contain; background: var(--rp-media-bg); }
/* 缺口态覆盖在画面上 → 用 on-media 那组值，不跟主题翻。 */
.rp-tile-gap {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  color: var(--rp-on-media-dim); font-size: 12px; text-align: center; padding: 0 10px;
}
.rp-tile-gap-char {
  width: 40px; height: 40px; display: flex; align-items: center; justify-content: center;
  border-radius: 9999px; background: var(--rp-on-media-fill); color: var(--rp-on-media); font-size: 16px;
}
.rp-tile-gap .rp-tile-btn { border-color: var(--rp-on-media-border); color: var(--rp-on-media); }
/* 格底名牌：与会议中页一样**压在画面上**的半透明浮层，常显（2026-10-11 用户定）。
   从前它在文档流里、实色 `--bg-card`，代价是每一格都要让出这一行的高度。
   改成浮层后新增一条硬约束：**结构上只可能是一行** —— 两行就等于把画面糊掉一半。
   所以 nowrap + 名字省略号 + 状态与按钮不参与收缩（挤的时候先挤名字），
   并给整条一个 `max-height` 兜住字体缩放之类的意外；名字被截断时整格的 `title` 里是全的。 */
.rp-tile-cap {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: flex; align-items: center; gap: 8px; flex-wrap: nowrap;
  max-height: 24px; overflow: hidden;
  padding: 2px 8px; background: var(--rp-on-media-scrim); color: var(--rp-on-media); font-size: 12px;
}
.rp-tile-name {
  flex: 0 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  color: var(--rp-on-media); font-weight: 600;
}
.rp-tile-rate { flex: 0 0 auto; color: var(--rp-on-media-dim); }
.rp-tile-dmg { flex: 0 0 auto; color: var(--rp-on-media-warn); font-size: 12px; }
.rp-tile-acts { flex: 0 0 auto; margin-left: auto; display: flex; gap: 6px; }
/* 名牌里的按钮走 on-media 那组值（同 `.rp-tile-gap` 里的按钮），并比页面流里的矮一档，
   否则 24px 的按钮会把整条顶到 30px，缩略格那点高度就全被吃了 */
.rp-tile-cap .rp-tile-btn {
  height: 20px; padding: 0 6px; font-size: 11px;
  border-color: var(--rp-on-media-border); color: var(--rp-on-media);
}
/* 极小格（渲染后不足 140 宽）再收一档：字、内边距、按钮高度一起降，
   把宽度还给名字、把高度还给画面。判据用容器宽度而不是"哪一档"，
   因为宫格多列与右侧档回落两列时都会走到这里。 */
@container (max-width: 140px) {
  .rp-tile-cap { gap: 4px; padding: 1px 4px; font-size: 10px; max-height: 18px; }
  .rp-tile-cap .rp-tile-btn { height: 16px; padding: 0 4px; font-size: 10px; border-radius: 4px; }
}
/* 缩略格只有画布 10–12% 宽：说明文字与缺口浮层在这里必然压到按钮上（2026-10-09 用户 Edge 实测）。
   留名字 + 一个"放大"（点它才能把这一路升成主画面），其余收掉 —— 静音在下方声音面板里有，
   全局静音也在，缩略格上再放一个是挤不下的重复入口。 */
.rp-tile[data-thumb] { font-size: 11px; }
.rp-tile[data-thumb] .rp-tile-gap,
.rp-tile[data-thumb] .rp-tile-rate,
.rp-tile[data-thumb] .rp-tile-dmg,
.rp-tile[data-thumb] .rp-tile-acts .rp-tile-btn + .rp-tile-btn { display: none; }
/* 但"原片有损坏"不许因为格子小而静默：缩略格装不下那行字，就把它换成整格的描边色 ——
   警告可以被压缩，不可以被吞掉 */
.rp-tile[data-thumb]:has(.rp-tile-dmg) { border-color: var(--rp-on-media-warn); }
.rp-tile[data-thumb] .rp-tile-cap { padding: 2px 6px; gap: 4px; white-space: nowrap; overflow: hidden; }
.rp-tile-btn {
  height: 24px; padding: 0 8px;
  border: 1px solid var(--border-color); border-radius: 6px;
  background: transparent; color: var(--text-secondary); font-size: 12px; cursor: pointer;
}
.rp-tile-btn:hover { color: var(--primary-text); border-color: var(--primary); }
.rp-tile-btn-on { border-color: var(--primary); color: var(--primary-text); background: var(--primary-soft); }
.rp-stage-empty { margin: 0; padding: 40px 0; text-align: center; color: var(--text-tertiary); font-size: 13px; }
.rp-stage-tools { padding: 0 2px; }
.rp-wall { font-size: 12px; color: var(--text-tertiary); }
/* 类名沿用 -dark（模板里 6 处），取值已经改回主题 token；它标的是"页面流里的按钮"。 */
.rp-ctl-dark { color: var(--text-secondary); }
.rp-ctl-dark:hover:not(:disabled) { color: var(--primary-text); }
.rp-ctl-dark:disabled { opacity: 0.4; cursor: not-allowed; }
.rp-time-dark { color: var(--text-primary); }
.rp-session-controls {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px; border-radius: 12px; background: var(--bg-soft);
}
.rp-sync-hint { margin: 0; font-size: 12px; color: var(--text-tertiary); }
/* 纯音轨行的 `<audio>` 只要元素在就行：控件与状态已经并入上面的「声音」勾选。
   元素本身从前也是 `display:none`（没有 controls，声音由引擎直接放），所以藏起来不改变行为。 */
.rp-audio-mount { display: none; }

/* —— 合成轨道选择对话框 —— */
.rp-track-panel {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 16px; border-radius: 12px;
  background: var(--bg-soft);
}
.rp-track-section { display: flex; align-items: flex-start; gap: 10px; }
.rp-track-label {
  flex-shrink: 0; width: 36px; font-size: 13px; font-weight: 600;
  color: var(--text-primary); line-height: 28px;
}
.rp-track-options { display: flex; flex-wrap: wrap; gap: 8px; }
.rp-track-check {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 8px; font-size: 13px;
  color: var(--text-secondary);
  border: 1px solid var(--border-color); background: var(--bg-card);
}
/* 一颗勾选里只有"勾选+名字"是可点的选择区：下载和状态挂在同一颗上，
   但别让整颗 chip 都变成点击区（点下载却把这一路取消勾选是另一种吞操作）。 */
.rp-track-pick { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.rp-track-pick:hover { color: var(--primary-text); }
.rp-track-check input[type="checkbox"] { accent-color: var(--el-color-primary, #409eff); }
.rp-track-note { font-size: 12px; color: var(--text-tertiary); }
button.rp-track-note { border: 0; padding: 0; background: transparent; color: var(--primary-text); cursor: pointer; }
.rp-track-dl {
  display: inline-flex; align-items: center; padding: 0; border: 0; cursor: pointer;
  font-size: 14px; color: var(--text-tertiary); background: transparent;
}
.rp-track-dl:hover { color: var(--primary-text); }
</style>
