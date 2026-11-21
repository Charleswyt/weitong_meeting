<template>
  <div class="rec-page">
    <div class="rec-page-header">
      <div>
        <h2 class="rec-page-title">录制会议<span v-if="recordingCount" class="rec-count">共 {{ recordingCount }} 个录制</span></h2>
        <p class="rec-page-sub">查看和管理所有会议录制内容</p>
      </div>
      <input v-model="keyword" class="rec-search" type="text" placeholder="搜索录制名称" @input="debounceLoad">
    </div>

    <div class="rec-tabs" role="tablist" aria-label="录制来源">
      <div
        v-for="t in tabs"
        :key="t.value"
        class="rec-tab"
        role="tab"
        tabindex="0"
        :aria-selected="activeTab === t.value"
        :class="{ active: activeTab === t.value }"
        @click="switchTab(t.value)"
        @keydown.enter.prevent="switchTab(t.value)"
        @keydown.space.prevent="switchTab(t.value)"
      >{{ t.label }}</div>
    </div>

    <!-- 原型在"本地录制"这一栏顶部写清了谁能看到这些文件；这句话也解释了为什么它跟云端那一栏完全不同源 -->
    <p v-if="activeTab === 'local'" class="rec-notice">
      <i class="ri-information-line" /> 只在你这台电脑上可见
    </p>

    <div class="rec-toolbar">
      <select v-model="timeFilter" class="rec-filter" @change="load()">
        <option value="">全部时间</option>
        <option value="7">最近7天</option>
        <option value="30">最近30天</option>
      </select>
    </div>

    <div v-if="loading" class="rec-loading">加载中...</div>
    <div v-else-if="groups.length" class="rec-grid">
      <div v-for="(g, i) in groups" :key="g.key" class="rec-card" :class="{ 'rec-card-missing': primaryLane(g).dataMissing }">
        <div class="rec-thumb" @click="primaryLane(g).dataMissing ? undefined : openPlayer(primaryLane(g))">
          <div class="rec-thumb-bg" :class="'rec-thumb-' + ((i % 4) + 1)"></div>
          <div v-if="primaryLane(g).dataMissing" class="rec-missing-badge">录制已失效</div>
          <div v-else class="rec-play-icon">▶</div>
        </div>
        <div class="rec-info">
          <div class="rec-title-row">
            <div class="rec-title">{{ g.lanes[0].title }}</div>
            <div class="rec-duration" :title="g.lanes.length > 1 ? '从第一路开始到最后一路结束的时间轴跨度，与点进回放页看到的时长同一个数' : ''">⊙ {{ humanizeDuration(g.durationSec) }}</div>
          </div>
          <!-- 会议号 = 三方号（本域没有本地号）。挂不到会的那类孤立录像只能空着，如实说，不拿别的键顶上 -->
          <div class="rec-no" :title="g.meetingNo ? '' : MEETING_NO_ABSENT_HINT">
            <span class="rec-no-icon">#</span> 会议号 {{ g.meetingNo ? formatMeetingNo(g.meetingNo) : MEETING_NO_ABSENT }}
          </div>
          <div class="rec-meta">{{ formatDate(g.startedAt) }} · {{ groupSummary(g) }} · {{ humanizeSize(g.fileSizeBytes) }}</div>
          <div class="rec-actions">
            <!-- 进回放页看的是**这一场的所有路**（页面里按画面/声音分窗格与声音面板） -->
            <button class="rec-action-btn" :disabled="!usableLanes(g).length" @click="openPlayer(primaryLane(g))">▶ 播放</button>
            <!-- 主按钮 = **一个整场文件**：用户点"下载"期望的就是这场会的一个文件，
                 不是十几个文件（旧写法按一路一个下，16 路就是 16 次保存询问）。
                 只有一路画面且没有单独的声音路时不重编码 —— 直接给原片，转码只会掉质量还白等。 -->
            <button
              class="rec-action-btn"
              :disabled="!usableLanes(g).length || groupBusy(g)"
              @click="downloadWholeGroup(g)"
            >
              <i class="ri-download-line" /> {{ groupActionLabel(g) }}
            </button>
            <button
              class="rec-action-btn rec-action-danger"
              :disabled="!g.deletable"
              :title="g.deletable ? '' : '这条录制不由当前账号删除'"
              @click="confirmDelete(primaryLane(g))"
            ><i class="ri-delete-bin-line" /> 删除</button>
            <!-- 要原片的出口留着（现场核对、单独取证都要它），但不占主按钮位 -->
            <el-dropdown v-if="canDownloadPerLane(g)" trigger="click" @command="(c: string) => onGroupCommand(c, g)">
              <button class="rec-action-btn" title="更多动作"><i class="ri-more-line" /> 更多</button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="perLane">逐路原片（每路单独保存）</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </div>
      </div>
      <div v-if="hasMore" class="rec-more">
        <button class="rec-more-btn" :disabled="loading" @click="load(true)">
          {{ loading ? '加载中…' : `加载更多（已显示 ${groups.length} / ${recordingCount} 个录制）` }}
        </button>
      </div>
    </div>
    <div v-else class="rec-empty">
      <div class="rec-empty-icon"><i class="ri-vidicon-line" /></div>
      <div class="rec-empty-title">暂无录制内容</div>
      <div class="rec-empty-sub">{{ emptyHint }}</div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { getRecordingList, deleteRecording, getDownloadUrl, getPlayback, type RecordingRow, type RecordingVo, type PlaybackStream } from '@/api/recording'
import { humanizeDuration, formatDate } from '@/utils/time'
import { forgetPlaybackPath } from '@/utils/playbackResume'
import { mergeUniqueRecordings, groupRecordingsBySession, type RecordingGroup } from '@/utils/recordingRows'
import { formatMeetingNo, MEETING_NO_ABSENT, MEETING_NO_ABSENT_HINT } from '@/utils/meetingNo'
import {
  listLocalRecordings, getLocalRecording, getLocalRecordingBlob, getSegmentBlob,
  recordingIsMine,
  getTrackBlobFromDisk,
  removeLocalRecording, downloadBlob, type LocalRecording,
} from '@/utils/localRecorder'
import { ensureRecordingsRecovered } from '@/utils/recordingRecovery'
import { describeTrackDownload, downloadLocalRecordingTracks, trackIsDamaged } from '@/utils/trackRecorder'
import { useComposeStore, composeTaskIdOf } from '@/store/compose'
import { buildLanesFromRecording } from '@/utils/offlineCompose/intake'
import { buildLanesFromCloud } from '@/utils/offlineCompose/cloudIntake'
import { cloudStreamsToTracks } from '@/utils/cloudReplay'
import { autoCols } from '@/utils/composeLayout'
import { lanesTimelineEndSec, type ComposeLane, type ComposeSpec } from '@/utils/offlineCompose/engine'

const router = useRouter()
interface Tab {
  label: string
  value: string
}

const tabs: Tab[] = [
  { label: '全部录制', value: '' },
  { label: '云端录制', value: 'cloud' },
  { label: '本地录制', value: 'local' },
]

const activeTab = ref('')
// 空态要按 tab 说清事实：本地那一支列的是会议设备落在本机的录像，
// 而在本页面发起的录制是直接进浏览器下载目录的，不在这个列表里 ——
// 一句"没有文件"会把两种不同的东西混成"功能坏了"。
const emptyHint = computed(() => {
  if (activeTab.value === 'local') return '还没有本机录制：在会中点「本地录制」即可'
  if (keyword.value || timeFilter.value) {
    return '没有符合当前筛选条件的录制'
  }
  return '当前账号下没有可见的录制'
})
const list = ref<RecordingVo[]>([])
// 「全部录制」必须真的全部：后端只交代得出云端录制，本机那几场是这台浏览器自己的账，
// 两边不合并就会顶着一个"全部"的名只给一半。
const localRows = ref<RecordingRow[]>([])
const keyword = ref('')
const timeFilter = ref('')
const loading = ref(false)
const pageNum = ref(1)
const total = ref(0)

let debounceTimer: number | null = null
let loadSeq = 0

function switchTab(value: string) {
  activeTab.value = value
  load()
}

function debounceLoad() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => load(), 300)
}

function humanizeSize(bytes: number) {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

// 墓碑行（media_deleted）由服务端摘掉，所以前端一次请求就够一屏：
// 之前为了躲墓碑把整个目录循环拉平，条目一多就会顶到 axios 的 10 秒上限（第 35 项）。
// 一页 = 20 **场**（不是 20 路）：后端分页单位已跟着卡片改，见契约 ADR-0081。
const REC_PAGE_SIZE = 20

// 本地录制这一栏的真源是**这台浏览器自己**：文件是这台机器录的，后端从来不知道它们存在，
// 所以这里不问接口，读本机清单（第 33 项"一条记录都没有"的根因就是之前去问了后端）。
//
// 分轨道录制（schema 2）的一条 = 一场录制会话，里面有若干路。卡片上那几个字段必须从清单里数出来：
// "几路画面/几路声音"是实测条数，"谁"是各路真实归属的参会者，不写"本机 · 画面+声音"这种一概而论的假标签。
function describeLocalRow(x: LocalRecording): { participant: string; mediaLabel: string } {
  const tracks = x.schema === 2 ? x.tracks || [] : []
  if (!tracks.length) return { participant: '本机', mediaLabel: x.schema === 2 ? '没有已完成的片段' : '画面+声音' }
  // 明细按**回放路数**数（参会者 × 通路去重），与进回放页看到的对上：同一人中途退会再入，
  // 清单里是两条路（一条原片只有一个容器头），回放并成一条路。卡片数原始条数就会报出一个数不出来的数。
  const lanes = new Map<string, { video: boolean; audio: boolean }>()
  for (const t of tracks) {
    const k = t.ownerId + '|' + t.kind
    const cur = lanes.get(k) || { video: false, audio: false }
    cur.video = cur.video || t.hasVideo
    cur.audio = cur.audio || t.hasAudio
    lanes.set(k, cur)
  }
  const vals = [...lanes.values()]
  const video = vals.filter((l) => l.video).length
  const audio = vals.filter((l) => l.audio).length
  const owners = [...new Set(tracks.map((t) => t.ownerName).filter(Boolean))]
  const who = owners.slice(0, 3).join('、') + (owners.length > 3 ? ` 等 ${owners.length} 人` : '')
  const parts: string[] = []
  if (video) parts.push(`${video} 路画面`)
  if (audio) parts.push(`${audio} 路声音`)
  // D4 接通：清单里那个"不完整"以前只写不读，缺口存在与否界面完全看不出来。
  // 它说的是事实 —— 这一场有路内断流或有路提前收场（含没点停止就关掉、后来被自愈重建出来的那场）。
  if (x.partial) parts.push('不完整')
  // 某一路的字节出自多于一次录制（历史上并写过的那几场）：这一路的文件是坏的，点下载之前就该看见
  if (tracks.some((t) => trackIsDamaged(t))) parts.push('有损坏')
  return { participant: who || '本机', mediaLabel: parts.join(' · ') }
}

// 元数据在但分片字节被浏览器回收的条目，标记 dataMissing 让界面告知用户文件已不可用。
// 磁盘为真源的录制（dirHandle=true）：检查磁盘文件是否存在。
async function hasLocalData(x: LocalRecording): Promise<boolean> {
  // 磁盘录制：检查各路 .webm 文件是否在授权目录里
  if (x.dirHandle && x.dirPath) {
    for (const tr of x.tracks || []) {
      const blob = await getTrackBlobFromDisk(x, tr)
      if (blob) return true
    }
    return false
  }
  // IndexedDB 路径（旧 schema 或降级）
  if (x.schema === 2) {
    for (const tr of x.tracks || []) {
      for (const seg of tr.segments) {
        if (await getSegmentBlob(seg.blobKey)) return true
      }
    }
    return false
  }
  return !!(await getLocalRecordingBlob(x.id))
}

async function loadLocalRows(): Promise<RecordingRow[]> {
  // 先让启动自愈跑完再读清单：上一次没点停止的那场就在这一步变成一条看得见的条目
  // （同一条在途 Promise，重复调用只等不重跑，所以放在每次筛选/翻页都会走的位置是安全的）
  await ensureRecordingsRecovered()
  // 只交出属于当前账号的条目：别人的与判不出归属的都不进界面（要追查看控制台）
  const mine = await listLocalRecordings()
  const kw = keyword.value.trim().toLowerCase()
  const cutoff = timeFilter.value ? Date.now() - Number(timeFilter.value) * 86400000 : 0
  const filtered = mine
    .filter((x) => !kw || x.title.toLowerCase().includes(kw) || x.fileName.toLowerCase().includes(kw))
    .filter((x) => !cutoff || x.startedAt >= cutoff)
  // 逐条探 blobs store，标记分片已被浏览器回收的条目
  const dataFlags = await Promise.all(filtered.map((x) => hasLocalData(x)))
  return filtered.map((x, i) => {
    const desc = describeLocalRow(x)
    return {
      recordingId: x.id,
      meetingId: 'local',
      // 会话头里那个号就是当时入会用的三方号（录制只可能发生在已入会之后），从前这里把它丢了
      meetingNo: x.meetingNo,
      title: x.title,
      participant: desc.participant,
      status: x.schema === 2 && !(x.tracks || []).length ? 'not_started' : 'ready',
      mediaKind: 'camera',
      mediaLabel: desc.mediaLabel,
      recordingType: 'local' as const,
      deletable: recordingIsMine(x),
      startedAt: new Date(x.startedAt).toISOString(),
      durationSec: x.durationSec,
      // 契约里 meetingStartedAt/meetingSpanSec 是 HTTP 线格式恒出现的键（同场聚合）。本机条目
      // 一条就是一场（`recordingRows.ts` 那句"它一条就是一场"），聚合值就是它自己 —— 如实填，
      // 不是编造；分组卡片的兜底路径（缺字段时按已加载行推）因此对本地行不再触发。
      meetingStartedAt: new Date(x.startedAt).toISOString(),
      meetingSpanSec: x.durationSec,
      fileSizeBytes: x.sizeBytes,
      playbackUrl: '',
      downloadUrl: '',
      dataMissing: !dataFlags[i],
    }
  })
}

async function load(append = false) {
  // 切页签、改筛选、翻页都会起跑 load()，而每一栏要等的东西不一样快（云端是 HTTP、本机是 IndexedDB）。
  // 没有代次判定，上一栏那个还没回来的响应会晚一步覆写这一栏的结果 —— 表现为"本地录制里混进云端条目"，
  // 反向也一样（云端栏冒出本机录制），连"共 x 个录制"都会跟着错。只有最后起跑那次有权写屏。
  const seq = ++loadSeq
  loading.value = true
  try {
    if (activeTab.value === 'local') {
      const rows = await loadLocalRows()
      if (seq !== loadSeq) return
      localRows.value = rows
      list.value = rows
      total.value = rows.length
      pageNum.value = 1
      return
    }
    // 全部那一栏顺带读本机清单：读不到只少本机那几行，不该把云端那一半也一起拖没。
    // 但"少了几行"必须留下成因 —— 这里从前是 `catch(() => [])` 全吞，本机整栏空了而界面与
    // 控制台都说不出为什么（用户报"看不到我的本地录制"时就只能猜）。
    const local = activeTab.value === '' ? await loadLocalRows().catch((e) => {
      console.warn('[recordings] 本机清单没读到', e instanceof Error ? `${e.name}: ${e.message}` : String(e))
      return []
    }) : []
    if (seq !== loadSeq) return
    localRows.value = local
    const params: Record<string, any> = {
      pageNum: append ? pageNum.value + 1 : 1,
      pageSize: REC_PAGE_SIZE,
      keyword: keyword.value,
    }
    if (activeTab.value) params.type = activeTab.value
    if (timeFilter.value) params.days = timeFilter.value
    const res = await getRecordingList(params)
    if (seq !== loadSeq) return
    const rows = res.rows || []
    // `total` 现在是**场次**（一页 = 若干场），不是路数：页头那个数要与屏幕上的卡片数同单位。
    // 后端没给 total 时只能拿这一页自己的卡片数兜底（是下限，不是全集）。
    total.value = res.total ?? groupRecordingsBySession(rows).length
    if (append) {
      pageNum.value += 1
      // 按 recordingId 去重：上游目录在两次请求之间会变，同一条可能既在第 1 页又在第 2 页
      // （后端已去一次重，这里按"列表里不许出现两行同一条"再兜一层）。
      list.value = mergeUniqueRecordings(list.value, rows)
    } else {
      pageNum.value = 1
      list.value = rows
    }
  } catch (e) {
    console.warn('[recordings] 录制列表加载失败', e instanceof Error ? `${e.name}: ${e.message}` : String(e))
    if (seq !== loadSeq) return
    if (!append) {
      list.value = []
      total.value = 0
      pageNum.value = 1
    }
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

const hasMore = computed(() => groups.value.length > 0 && groups.value.length < recordingCount.value)

// 全部 = 本机清单 + 后端那页，按开始时间倒序；云端那页还在往后翻，所以翻页判断只看后端两份。
const shownRows = computed(() =>
  activeTab.value === ''
    ? [...localRows.value, ...list.value].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    : list.value,
)
/** 这一栏一共有多少个**录制**（后端那一页的 total + 本机清单；翻页判断用 shownRows 对比它） */
const recordingCount = computed(() => (activeTab.value === '' ? total.value + localRows.value.length : total.value))

// —— 一张卡 = 一场会 ——
//
// 三方归档的单位是**一路发布**：一个人的摄像头、麦克风、屏幕共享各是一条独立 recording
// （各有 id、时长、下载地址），一场会平铺出来就是十几行、标题还都是会议名，看起来像"重复"（2026-10-01 现场）。
// 所以按**场次**聚成一张卡：卡上写清有几路、有谁；**进回放页看这一场的所有路**（页面里本来就按
// 画面/声音分窗格与声音面板）；下载按一路一个文件全下（与本机那栏同一口径，不冒充"一个文件"）。
// 分组放在 computed 上（不是取数时）：翻页把这一场剩下的路加载进来之后，它们会自动合回同一张卡。
type RecGroup = RecordingGroup<RecordingRow>
const groups = computed(() => groupRecordingsBySession(shownRows.value))
/** 这一场的每一路（用于"有没有可下的"和统一判定），可下 = 不在归档中且本机字节还在 */
const usableLanes = (g: RecGroup) => g.lanes.filter((l) => playable(l) && !l.dataMissing)
/** 点缩略图/播放进的是整场：先挑一路有画面的进去（回放页会把这一场所有路都摆出来） */
function primaryLane(g: RecGroup): RecordingRow {
  return g.lanes.find((l) => l.mediaKind && l.mediaKind !== 'audio') || g.lanes[0]
}
/** 正在下载的那一场（按组键记，不是按某一路） */
const downloadingKey = ref('')

/** 卡上那行说明：**分路明细** + 参会者（写法与本机卡片一致，如 `1 路画面 · 1 路声音 · 陈芳`）。
 *
 * 明细按**回放路数**（参会者 × 通路去重）数，所以与进回放页看到的对得上；同一人退了再入会的
 * 两份画面在这里并成一条路（用户 2026-10-01 定"报回放路数"）。
 * 本机条目只有一条，它自己的 mediaLabel 本来就是这份明细（"1 路画面 · 1 路声音"）。 */
function groupSummary(g: RecGroup): string {
  const parts: string[] = []
  if (g.lanes[0].recordingType === 'local') {
    parts.push(g.lanes[0].mediaLabel || '录制')
  } else {
    const b = g.laneBreakdown
    if (b.video) parts.push(`${b.video} 路画面`)
    if (b.audio) parts.push(`${b.audio} 路声音`)
    if (b.screen) parts.push(`${b.screen} 路共享屏幕`)
    if (!parts.length) parts.push('录制')
  }
  const people = [...new Set(g.lanes.map((l) => l.participant).filter(Boolean))]
  const who = people.slice(0, 3).join('、') + (people.length > 3 ? ` 等 ${people.length} 人` : '')
  if (who) parts.push(who)
  return parts.join(' · ')
}

/** 这一场下载 = 每一路各下一个文件（一条录制是若干路原片，这是本系统一贯的下载口径）。 */
async function downloadGroup(g: RecGroup) {
  const lanes = usableLanes(g)
  if (!lanes.length) {
    ElMessage.error('这一场没有可下载的录制')
    return
  }
  downloadingKey.value = g.key
  try {
    if (lanes.length > 1) ElMessage.info(`这一场有 ${lanes.length} 路，逐路保存，浏览器会挨个询问`)
    // 一路失败不带走其余的：逐路各自兜住，失败的那一路记控制台（提示由 download() 自己给）
    for (const lane of lanes) {
      try {
        await download(lane)
      } catch (e) {
        console.warn('[recordings] 这一路下载失败', lane.recordingId, e)
      }
    }
  } finally {
    downloadingKey.value = ''
  }
}

const composeStore = useComposeStore()

/** 这一场对应的合成任务：任务键以 `compose:<本机清单 id>:` 开头，谁发起的卡片都看得见 */
function composeTaskOf(g: RecGroup) {
  if (g.lanes[0].recordingType !== 'local') return null
  return composeStore.tasks.find((t) => t.id.startsWith(`compose:${g.lanes[0].recordingId}:`)) ?? null
}

function groupBusy(g: RecGroup): boolean {
  if (downloadingKey.value === g.key) return true
  const t = composeTaskOf(g)
  return !!t && (t.state === 'queued' || t.state === 'running')
}

/** "一个文件"两侧都做得到：本机吃 IndexedDB 分片，云端吃每条发布的 faststart MP4 */
function canCompose(g: RecGroup): boolean {
  return !!g.lanes.length
}

/**
 * 本机卡片一律给"逐路原片"这个出口。
 * 判据不能看 `usableLanes(g).length` —— 一次本机录制在分组里就是**一行**（`recordingRows` 那句
 * "本机条目不聚"），组数恒等于 1，那样这个入口永远出不来。真正"多路"的是这一场里的轨道数，
 * 而 `downloadGroup` 对本机条目本来就是"把这一场的所有轨道各下一个文件"。
 */
function canDownloadPerLane(g: RecGroup): boolean {
  return canCompose(g)
}

function groupActionLabel(g: RecGroup): string {
  if (downloadingKey.value === g.key) return '下载中…'
  const t = composeTaskOf(g)
  if (t && (t.state === 'queued' || t.state === 'running')) {
    return t.state === 'queued' ? '排队合成中…' : `合成中 ${Math.round((t.ratio || 0) * 100)}%`
  }
  return '下载（整场合成）'
}

function onGroupCommand(command: string, g: RecGroup) {
  if (command === 'perLane') void downloadGroup(g)
}

/**
 * 云端一场的"一个文件"。先取回放清单（每路的偏移与时长都在里面），再走与本机**同一条**装配与队列。
 *
 * 入料是每条发布自己的 faststart MP4（`/download`），由合成器按 `UrlSource` 顺序流读 ——
 * 后端不支持 Range，所以不像本机那样按字节区间取；同人再入会 = 另一条发布 = 这一格里的第二个容器。
 */
async function composeCloudGroup(g: RecGroup, lanes: RecordingRow[]) {
  const meetingId = lanes[0].meetingId
  let streams: PlaybackStream[]
  try {
    const res = await getPlayback(meetingId)
    streams = res.data?.streams || []
  } catch {
    await downloadGroup(g)
    return
  }
  if (!streams.length) {
    ElMessage.warning('这场还没给出可合成的回放清单：进这一场看一眼再点，或改用「逐路原片」')
    return
  }
  const { tracks } = cloudStreamsToTracks(streams)
  const intake = buildLanesFromCloud(tracks, streams)
  const videoLanes = intake.lanes.filter((l) => l.hasVideo)
  if (!videoLanes.length) {
    await downloadGroup(g)
    return
  }
  // 一路且只有一个容器 ⇒ 原片就是那"一个文件"，重编码只会掉质量还白等
  if (intake.lanes.length === 1 && intake.lanes[0].containers.length === 1 && !intake.lanes[0].hasAudio) {
    ElMessage.info('这一场只有一路，给的是原片，没有重新编码')
    await download(lanes[0])
    return
  }
  const followUp: string[] = []
  if (intake.emptyLanes.length) {
    followUp.push(`有 ${intake.emptyLanes.length} 路还没有可下载的录制，成品里不含它们：${intake.emptyLanes.join('、')}`)
  }
  await dispatchCompose(g, intake.lanes, meetingId, followUp)
}
/**
 * 整场下载。三种走法，判据都在数据上而不是在按钮上：
 * ① 一路画面且没有单独的声音路 ⇒ 原片就是那"一个文件"，**不重编码**（转码只会掉质量还白等）；
 * ② 多路（或画面+声音分家）⇒ 交给合成队列，产物自动落下载目录（进度在右下角浮标）；
 * ③ 云端条目走 `composeCloudGroup`：入料是每条发布自己的 faststart MP4，与本机共用同一套合成器。
 */
async function downloadWholeGroup(g: RecGroup) {
  const lanes = usableLanes(g)
  if (!lanes.length) {
    ElMessage.error('这一场没有可下载的录制')
    return
  }
  if (!canCompose(g)) {
    await downloadGroup(g)
    return
  }
  if (lanes[0].recordingType === 'cloud') {
    await composeCloudGroup(g, lanes)
    return
  }
  const localId = lanes[0].recordingId
  const rec = await getLocalRecording(localId)
  if (!rec?.tracks?.length) {
    ElMessage.warning('这一场的录制清单读不出来：进这一场再点一次下载')
    return
  }
  const intake = await buildLanesFromRecording(rec)
  const videoLanes = intake.lanes.filter((l) => l.hasVideo)
  if (!videoLanes.length) {
    await downloadGroup(g)
    return
  }
  if (videoLanes.length === 1 && intake.lanes.length === 1) {
    ElMessage.info('这一场只有一路，给的是原片，没有重新编码')
    await download(lanes[0])
    return
  }
  const followUp: string[] = []
  if (intake.damagedLanes.length) {
    followUp.push(`有 ${intake.damagedLanes.length} 路的原片是坏的，成品里那几段是缺的：${intake.damagedLanes.join('、')}`)
  }
  await dispatchCompose(g, intake.lanes, localId, followUp)
}

/**
 * 把一组 lane 交给合成队列。本机与云端**共用这一段** —— 两处的差别只在字节从哪来（装配层已消化），
 * 到这里形状一致；分叉成两份的话，将来"产物命名/进度/落点"的修正只会落到其中一侧。
 */
async function dispatchCompose(
  g: RecGroup,
  lanes: ComposeLane[],
  scopeKey: string,
  followUp: string[] = [],
): Promise<void> {
  const videoLanes = lanes.filter((l) => l.hasVideo)
  const cols = autoCols(videoLanes.length)
  const durationSec = lanesTimelineEndSec(lanes)
  const spec: ComposeSpec = {
    lanes, mode: 'grid', cols, cellWidth: 480, fpsOut: 15, durationSec,
  }
  await composeStore.dispatch({
    id: composeTaskIdOf(scopeKey, lanes, { mode: 'grid', cols, focusId: null }),
    label: g.lanes[0].title || '这一场',
    spec,
    followUpNotices: followUp,
  })
}

function openPlayer(r: RecordingVo) {  if (!playable(r)) return
  if (r.recordingType === 'local') {
    // 本机条目没有会议号可查，播放器按 local=<清单 id> 从 IndexedDB 取文件
    router.push({ name: 'RecordingPlayback', params: { meetingId: 'local' }, query: { local: r.recordingId } })
    return
  }
  // 回放是整页（原型「录制会议-播放详情」），不是弹窗：820px 弹窗装不下原型那条 600 高的播放器
  router.push({ name: 'RecordingPlayback', params: { meetingId: r.meetingId }, query: { rec: r.recordingId } })
}

// media_deleted = 云端已回收文件，fileSizeBytes=0 = 还没落出文件，这两种都没有可放/可下的东西。
// 服务端只交代得出文件的条目；仍在录制/转码的还没文件，播放与下载要等它归档完。
function playable(r: RecordingVo) {
  return !['recording', 'finalizing', 'pending'].includes(r.status)
}

// 下载必须带 Authorization，window.open 不带令牌会被后端 401 挡掉。
async function download(r: RecordingVo) {
  if (!playable(r)) return
  if (r.recordingType === 'local') {
    const meta = await getLocalRecording(r.recordingId)
    // D3：这一支以前读的是 `blobs[条目id]`，而 schema 2 从不写那个键（分片的键是 `路id#片号`），
    // 所以本机录制的下载**恒**弹"已不可读取"。现在按清单逐路把分片拼回原文件。
    // 一条录制是**若干路原片**，所以就是若干次下载 —— 这里不冒充"整场一个文件"，
    // 合成件是回放页那件事（否则用户拿到的东西和他看到的宫格不是一回事）。
    const trackCount = (meta?.tracks || []).filter((t) => t.segments.length > 0).length
    if (trackCount) {
      const { ok, failed, damaged } = await downloadLocalRecordingTracks(meta!)
      const note = describeTrackDownload({ ok, failed, damaged })
      if (note.tone === 'error') ElMessage.error(note.text)
      else if (note.tone === 'warning') ElMessage.warning(note.text)
      else if (note.text) ElMessage.info(note.text)
      return
    }
    // schema 1 的老条目：产物当年是整份一个 blob，键就是条目 id —— 那条路照旧走这里。
    const blob = await getLocalRecordingBlob(r.recordingId)
    if (!blob) {
      ElMessage.error('本机录制已不可读取')
      return
    }
    downloadBlob(meta?.fileName || `${r.recordingId}.webm`, blob)
    return
  }
  try {
    const res = await fetch(getDownloadUrl(r.recordingId), {
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
    a.download = `${r.title || 'recording'}.mp4`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  } catch {
    ElMessage.error('下载失败')
  }
}

async function confirmDelete(r: RecordingVo) {
  if (r.recordingType === 'local') {
    try {
      await ElMessageBox.confirm(
        `确定删除「${r.title}」的本机录制？只影响这台设备上保存的这份录制。`,
        '删除确认',
        { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
      )
    } catch {
      return
    }
    try {
      await removeLocalRecording(r.recordingId)
      ElMessage.success('本机录制已删除')
      await load()
    } catch (e) {
      // 走到这里说明列表与数据层的归属判据不一致（比如另一台标签页刚换过账号）——
      // 报"删除失败"会把人引去重试，而重试一百次也不会成，所以单独一句
      if ((e as Error)?.message === 'not_owner') ElMessage.error('这条录制不属于当前账号，删不了')
      else ElMessage.error('删除失败')
    }
    return
  }
  try {
    await ElMessageBox.confirm(
      `确定删除「${r.title}」的录制？这会一并移除该会议的所有录制，且不可恢复。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  try {
    await deleteRecording(r.recordingId)
    ElMessage.success('该会议的录制已删除')
    // 三方只能按整场删，所以同会议的条目一并摘掉。
    // 不重新拉列表：删完立刻重拉会把这一屏的等待又压回请求路径上（第 35 项的口径）。
    list.value = list.value.filter((x) => x.meetingId !== r.meetingId)
  } catch {
    // 提示由 request 拦截器统一给出
  }
}

onMounted(() => {
  forgetPlaybackPath()
  load()
})
</script>

<style scoped>
.rec-page {
  padding: 16px 20px;
  box-sizing: border-box;
}
.rec-page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.rec-page-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
}

.rec-page-sub {
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 4px;
}

.rec-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border-color);
  margin-bottom: 20px;
}

.rec-tab {
  padding: 10px 20px;
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: all 0.2s;
  user-select: none;
}

.rec-tab:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.rec-tab:hover {
  color: var(--primary-text);
}

.rec-tab.active {
  color: var(--primary-text);
  border-bottom-color: var(--primary);
  font-weight: 600;
}

.rec-toolbar {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
}

.rec-search {
  flex: 1;
  max-width: 300px;
  padding: 8px 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
}

.rec-search:focus {
  border-color: var(--primary);
}

.rec-filter {
  padding: 8px 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  cursor: pointer;
}

.rec-loading {
  text-align: center;
  padding: 60px;
  color: var(--text-muted);
  font-size: 14px;
}

.rec-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 20px;
}

.rec-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  overflow: hidden;
  transition: all 0.2s;
}

.rec-card:hover {
  border-color: var(--primary);
  box-shadow: 0 4px 16px rgba(22,93,255, 0.1);
}

.rec-thumb {
  position: relative;
  height: 160px;
  cursor: pointer;
  overflow: hidden;
}

.rec-thumb-bg {
  width: 100%;
  height: 100%;
}

/* 四档全部取自 prototype.css 既有色板（品牌蓝 / 蓝紫主视觉 / home-hero / bg-thumb.c1），
   只为让卡片之间可辨；不要换成外部通用渐变——那正是"看着像三方系统"的来源。 */
.rec-thumb-1 { background: linear-gradient(135deg, #165DFF, #4D8BFF); }
.rec-thumb-2 { background: linear-gradient(135deg, #165DFF, #6C63FF); }
.rec-thumb-3 { background: linear-gradient(135deg, #1E3A5F, #165DFF); }
.rec-thumb-4 { background: linear-gradient(135deg, #1a3a6a, #2a5a9a); }

.rec-play-icon {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  transition: background 0.2s;
}

.rec-thumb:hover .rec-play-icon {
  background: rgba(22,93,255, 0.8);
}

.rec-card-missing {
  opacity: 0.6;
}
.rec-card-missing .rec-thumb-bg {
  filter: grayscale(100%);
}
.rec-missing-badge {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 6px 14px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  border-radius: 6px;
  font-size: 13px;
  white-space: nowrap;
}

.rec-count {
  margin-left: 10px;
  font-size: 13px;
  font-weight: 400;
  color: var(--text-tertiary);
}

.rec-notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 16px;
  padding: 10px 14px;
  background: rgba(22, 93, 255, 0.08);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 13px;
}

.rec-title-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.rec-duration {
  flex: none;
  font-size: 12px;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.rec-info {
  padding: 14px;
}

.rec-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rec-no {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-tertiary);
  margin-bottom: 6px;
}
.rec-no-icon { font-weight: 700; }
.rec-meta {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 12px;
}

.rec-actions {
  display: flex;
  gap: 8px;
}

.rec-action-btn {
  padding: 6px 12px;
  border: 1px solid var(--border-color);
  background: var(--bg-card);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s;
}

.rec-action-btn:hover {
  border-color: var(--primary);
  color: var(--primary-text);
}

.rec-action-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  border-color: var(--border-color);
  color: var(--text-muted);
}

.rec-dead {
  color: var(--danger-text);
}

.rec-action-danger:hover {
  border-color: var(--danger);
  color: var(--danger-text);
}

.rec-more {
  grid-column: 1 / -1;
  display: flex;
  justify-content: center;
  padding: 8px 0 4px;
}
.rec-more-btn {
  padding: 8px 20px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary, #94a3b8);
  font-size: 13px;
  cursor: pointer;
}
.rec-more-btn:disabled { opacity: 0.6; cursor: default; }
.rec-empty {
  padding: 60px 20px;
  text-align: center;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
}

.rec-empty-icon {
  font-size: 48px;
  margin-bottom: 12px;
  opacity: 0.5;
}

.rec-empty-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
}

.rec-empty-sub {
  font-size: 13px;
  color: var(--text-muted);
}
</style>
