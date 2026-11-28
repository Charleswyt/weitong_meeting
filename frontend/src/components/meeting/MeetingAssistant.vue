<template>
  <el-drawer
    :model-value="modelValue"
    direction="rtl"
    size="min(288px, 100vw)"
    class="ma-drawer"
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
  >
    <template #header>
      <div class="ma-header">
        <div class="ma-header-left">
          <span class="ma-brand-icon" aria-hidden="true">
            <i class="ri-sparkling-2-line" />
          </span>
          <div class="ma-title-group">
            <div class="ma-title-row">
              <h3 class="ma-title">会议助手</h3>
              <span v-if="number" class="ma-meeting-no">#{{ number }}</span>
            </div>
            <p class="ma-subtitle">材料分发 · 加密云录 · 实时字幕与纪要</p>
          </div>
        </div>
        <div class="ma-header-right">
          <span v-if="state?.capture" class="ma-live-pill ma-live-pill--rec">
            <i class="ma-pulse-dot" /> 录制中
          </span>
          <span v-else-if="state?.transcription.enabled" class="ma-live-pill ma-live-pill--sub">
            <i class="ri-translate-2" /> 转录中
          </span>
          <button
            type="button"
            class="ma-icon-btn"
            title="刷新状态"
            :disabled="refreshing"
            @click="manualRefresh"
          >
            <i class="ri-refresh-line" :class="{ 'ma-spin': refreshing }" />
          </button>
        </div>
      </div>
    </template>

    <div class="ma-shell">
      <div v-if="error" class="ma-alert" role="alert">
        <i class="ri-error-warning-line ma-alert-ic" />
        <span class="ma-alert-msg">{{ error }}</span>
        <button type="button" class="ma-alert-btn" @click="manualRefresh">重试</button>
      </div>

      <div v-if="!state && !error" class="ma-loading">
        <i class="ri-loader-4-line ma-spin" />
        <span>正在同步会议助手状态…</span>
      </div>

      <template v-else-if="state">
        <nav class="ma-tabs" role="tablist" aria-label="会议助手功能切换">
          <button
            v-if="!inMeeting && state.history"
            type="button"
            role="tab"
            class="ma-tab"
            :class="{ active: tab === 'captions' }"
            :aria-selected="tab === 'captions'"
            @click="tab = 'captions'"
          >
            <i class="ri-chat-quote-line" />
            <span>发言记录</span>
            <em v-if="captions.length" class="ma-badge">{{ captions.length }}</em>
          </button>

          <button
            type="button"
            role="tab"
            class="ma-tab"
            :class="{ active: tab === 'materials' }"
            :aria-selected="tab === 'materials'"
            @click="tab = 'materials'"
          >
            <i class="ri-folder-open-line" />
            <span>材料包</span>
            <em v-if="state.materials.length" class="ma-badge">{{ state.materials.length }}</em>
          </button>

          <button
            type="button"
            role="tab"
            class="ma-tab"
            :class="{ active: tab === 'record' }"
            :aria-selected="tab === 'record'"
            @click="tab = 'record'"
          >
            <i class="ri-shield-keyhole-line" />
            <span>加密录制</span>
            <em v-if="state.files.length" class="ma-badge">{{ state.files.length }}</em>
          </button>

          <button
            type="button"
            role="tab"
            class="ma-tab"
            :class="{ active: tab === 'minutes' }"
            :aria-selected="tab === 'minutes'"
            @click="tab = 'minutes'"
          >
            <i class="ri-file-text-line" />
            <span>会议纪要</span>
            <span v-if="state.minutes" class="ma-dot-ready" title="已生成" />
          </button>
        </nav>

        <div class="ma-panel">
          <!-- 发言记录 -->
          <section v-if="tab === 'captions' && !inMeeting && state.history" class="ma-section">
            <div v-if="captions.length" class="ma-toolbar">
              <span class="ma-toolbar-meta">共 {{ captions.length }} 条发言记录</span>
              <button type="button" class="ma-ghost-btn" @click="copyAllCaptions">
                <i class="ri-file-copy-line" /> 复制全部
              </button>
            </div>

            <div v-if="captions.length" class="ma-caption-list">
              <article v-for="s in ordered" :key="s.id" class="ma-caption-card">
                <div class="ma-caption-avatar">{{ (s.speaker || '?').slice(0, 1) }}</div>
                <div class="ma-caption-body">
                  <header class="ma-caption-head">
                    <strong class="ma-caption-speaker">{{ s.speaker }}</strong>
                    <time class="ma-caption-time">{{ clock(s.at) }}</time>
                  </header>
                  <p class="ma-caption-text">{{ s.text }}</p>
                </div>
              </article>
            </div>

            <div v-else class="ma-empty">
              <div class="ma-empty-ic"><i class="ri-chat-off-line" /></div>
              <h4>暂无发言记录</h4>
              <p>本场会议开启实时转录后的发言内容会汇总在这里。</p>
            </div>
          </section>

          <!-- 材料包 -->
          <section v-else-if="tab === 'materials'" class="ma-section">
            <div class="ma-hero-bar">
              <div class="ma-hero-actions">
                <label v-if="state.host" class="ma-primary-btn ma-upload-btn">
                  <i class="ri-upload-cloud-2-line" />
                  <span>发布会前材料</span>
                  <input type="file" multiple class="ma-hidden-input" @change="uploadMaterials" />
                </label>
                <button
                  type="button"
                  class="ma-outline-btn"
                  :disabled="!state.materials.length"
                  @click="download('package', '会议材料包.zip')"
                >
                  <i class="ri-download-2-line" />
                  <span>打包下载全部</span>
                </button>
              </div>
              <p class="ma-hero-tip">
                <i class="ri-information-line" />
                受邀成员可在入会前从会议详情页提前领取全部材料。
              </p>
            </div>

            <div v-if="state.materials.length" class="ma-card-list">
              <article v-for="m in state.materials" :key="m.id" class="ma-item-card">
                <div class="ma-file-ic" :class="'ma-file-ic--' + fileKind(m.name)">
                  <i :class="fileIcon(m.name)" />
                </div>
                <div class="ma-item-main">
                  <strong class="ma-item-title" :title="m.name">{{ m.name }}</strong>
                  <div class="ma-item-meta">
                    <span>{{ formatBytes(m.size) }}</span>
                    <span class="ma-sep">·</span>
                    <span><i class="ri-user-received-line" /> {{ m.downloads }} 人领取</span>
                  </div>
                </div>
                <button
                  type="button"
                  class="ma-action-chip"
                  title="下载材料"
                  @click="download('materials/' + m.id, m.name)"
                >
                  <i class="ri-download-line" />
                  <span>下载</span>
                </button>
              </article>
            </div>

            <div v-else class="ma-empty">
              <div class="ma-empty-ic"><i class="ri-folder-add-line" /></div>
              <h4>尚未发布会议材料</h4>
              <p>{{ state.host ? '点击上方「发布会前材料」上传议程、PPT 或附件。' : '主持人发布材料后，可在这里一键查看与下载。' }}</p>
            </div>
          </section>

          <!-- 加密录制 -->
          <section v-else-if="tab === 'record'" class="ma-section">
            <div v-if="state.capture" class="ma-rec-banner">
              <div class="ma-rec-banner-ic">
                <span class="ma-pulse-dot ma-pulse-dot--lg" />
              </div>
              <div class="ma-rec-banner-body">
                <strong>加密云录制进行中</strong>
                <p>仅录制已同意成员正在发布的摄像头、麦克风与共享屏幕。</p>
              </div>
            </div>

            <!-- 回放分发权限 -->
            <div v-if="managedCapturesFinished.length" class="ma-block">
              <div class="ma-block-head">
                <span class="ma-block-title"><i class="ri-share-forward-line" /> 回放分发权限</span>
              </div>
              <div class="ma-card-list">
                <div v-for="r in managedCapturesFinished" :key="r.id" class="ma-item-card">
                  <div class="ma-file-ic ma-file-ic--share">
                    <i class="ri-user-shared-line" />
                  </div>
                  <div class="ma-item-main">
                    <strong class="ma-item-title">{{ clock(r.at) }}{{ r.endedAt ? ' 至 ' + clock(r.endedAt) : '' }} 录制段</strong>
                    <div class="ma-item-meta">
                      <span v-if="r.finalizing">正在保存</span>
                      <span v-else-if="r.readyFiles === 0">本段没有可回放的轨道</span>
                      <span v-if="r.finishReason">{{ finishLabels[r.finishReason] || r.finishReason }}</span>
                      <span v-if="r.users.length" class="ma-perm-pill ma-perm-pill--shared">
                        已授权 {{ r.users.length }} 人：{{ r.users.join('、') }}
                      </span>
                      <span v-else class="ma-perm-pill">仅主持人可查看</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    class="ma-action-chip"
                    @click="shareRecording(r.id, r.users)"
                  >
                    <i class="ri-settings-3-line" />
                    <span>权限</span>
                  </button>
                </div>
              </div>
            </div>

            <!-- 录制文件列表 -->
            <div v-if="state.files.length" class="ma-block">
              <div class="ma-block-head">
                <span class="ma-block-title"><i class="ri-film-line" /> 云端录制文件</span>
                <span class="ma-block-sub">{{ state.files.length }} 份</span>
              </div>

              <div class="ma-card-list">
                <article
                  v-for="f in state.files"
                  :key="f.id"
                  class="ma-rec-card"
                  :class="{ 'is-playing': playingId === f.id }"
                >
                  <div class="ma-rec-top">
                    <div class="ma-file-ic" :class="'ma-file-ic--' + trackKindClass(f.kind)">
                      <i :class="trackIcon(f.kind)" />
                    </div>
                    <div class="ma-item-main">
                      <div class="ma-rec-title-row">
                        <strong class="ma-item-title">{{ tracks[f.kind] || f.kind }}</strong>
                        <span class="ma-owner-tag">账号 {{ f.owner }}</span>
                        <span
                          class="ma-status-tag"
                          :class="
                            f.status !== 'ready'
                              ? 'ma-status-tag--warn'
                              : f.archived
                                ? 'ma-status-tag--ok'
                                : 'ma-status-tag--info'
                          "
                        >
                          {{
                            f.status !== 'ready'
                              ? '正在写入'
                              : f.archived
                                ? '已归档 OSS'
                                : '待归档'
                          }}
                        </span>
                      </div>
                      <div class="ma-item-meta">
                        <span v-if="f.captureStartedAt">{{ clock(f.captureStartedAt) }} 开始的录制段</span>
                        <span>轨道 {{ clock(f.at) }}</span>
                        <template v-if="f.status === 'ready'">
                          <span class="ma-sep">·</span>
                          <span>{{ formatBytes(f.bytes) }}</span>
                        </template>
                      </div>
                    </div>
                  </div>

                  <div v-if="f.status === 'ready'" class="ma-rec-actions">
                    <button
                      type="button"
                      class="ma-mini-btn ma-mini-btn--primary"
                      :disabled="loadingReplay === f.id"
                      @click="playRecording(f.id)"
                    >
                      <i :class="loadingReplay === f.id ? 'ri-loader-4-line ma-spin' : 'ri-play-circle-line'" />
                      <span>{{ loadingReplay === f.id ? '加载中…' : '播放回放' }}</span>
                    </button>
                    <button
                      type="button"
                      class="ma-mini-btn"
                      @click="download('files/' + f.id, '会议录制-' + f.id + '.mp4')"
                    >
                      <i class="ri-video-download-line" />
                      <span>导出水印 MP4</span>
                    </button>
                    <button
                      type="button"
                      class="ma-mini-btn"
                      @click="sealedDownload(f.id)"
                    >
                      <i class="ri-lock-2-line" />
                      <span>加密水印副本</span>
                    </button>
                  </div>
                </article>
              </div>
            </div>

            <div v-else-if="!state.capture" class="ma-empty">
              <div class="ma-empty-ic"><i class="ri-vidicon-2-line" /></div>
              <h4>暂无可查看的录制</h4>
              <p>开启加密云录制并完成写入后，录制轨道将展示在这里。</p>
            </div>

            <!-- 云端回放播放器 -->
            <div v-if="replayUrl" class="ma-player-box">
              <div class="ma-player-bar">
                <span><i class="ri-play-fill" /> 云端回放预览</span>
                <button type="button" class="ma-player-close" title="关闭预览" @click="clearPreview">
                  <i class="ri-close-line" />
                </button>
              </div>
              <video :src="replayUrl" controls autoplay playsinline class="ma-video-el" />
            </div>

            <!-- 本地加密文件工具 -->
            <div class="ma-portable-card">
              <button
                type="button"
                class="ma-portable-toggle"
                :aria-expanded="portableOpen"
                @click="portableOpen = !portableOpen"
              >
                <div class="ma-portable-title">
                  <i class="ri-key-2-line" />
                  <span>本地加密文件工具（.wtrec）</span>
                </div>
                <i class="ri-arrow-down-s-line ma-portable-arrow" :class="{ open: portableOpen }" />
              </button>

              <div v-show="portableOpen" class="ma-portable-body">
                <div class="ma-portable-grid">
                  <label class="ma-tool-tile">
                    <span class="ma-tool-ic"><i class="ri-lock-password-line" /></span>
                    <span class="ma-tool-text">
                      <strong>加密本地录制</strong>
                      <small>支持 MP4 / WebM / WAV</small>
                    </span>
                    <input
                      type="file"
                      accept="video/mp4,video/webm,audio/mp4,audio/webm,audio/wav"
                      class="ma-hidden-input"
                      @change="localFile($event, false)"
                    />
                  </label>

                  <label class="ma-tool-tile">
                    <span class="ma-tool-ic ma-tool-ic--alt"><i class="ri-lock-unlock-line" /></span>
                    <span class="ma-tool-text">
                      <strong>打开加密录制</strong>
                      <small>解密并播放 .wtrec 文件</small>
                    </span>
                    <input
                      type="file"
                      accept=".wtrec"
                      class="ma-hidden-input"
                      @change="localFile($event, true)"
                    />
                  </label>
                </div>

                <p class="ma-portable-tip">
                  <i class="ri-shield-check-line" />
                  口令仅用于本机端到端加解密，平台不保存口令且无法代为找回，请妥善保管。
                </p>

                <div v-if="previewUrl" class="ma-player-box">
                  <div class="ma-player-bar">
                    <span><i class="ri-lock-unlock-line" /> 本地解密预览</span>
                    <button type="button" class="ma-player-close" title="关闭预览" @click="clearPreview">
                      <i class="ri-close-line" />
                    </button>
                  </div>
                  <video :src="previewUrl" controls playsinline class="ma-video-el" />
                </div>
              </div>
            </div>
          </section>

          <!-- 会议纪要 -->
          <section v-else-if="tab === 'minutes'" class="ma-section">
            <div
              v-if="inMeeting || state.minutesStatus === 'processing'"
              class="ma-processing-card"
              role="status"
            >
              <div class="ma-processing-ic">
                <i class="ri-quill-pen-line" />
              </div>
              <h4>{{ inMeeting ? '会议进行中' : '正在智能整理会议纪要' }}</h4>
              <p>
                {{
                  inMeeting
                    ? '会议结束后将结合发言转录自动生成结构化纪要，届时可在会议列表中查看。'
                    : '处理中，请稍候片刻，整理完成后将自动刷新展示。'
                }}
              </p>
            </div>

            <template v-else-if="state.minutes">
              <div class="ma-toolbar">
                <span class="ma-toolbar-meta">
                  <i class="ri-sparkling-line" /> 已整理完成
                </span>
                <div class="ma-toolbar-btns">
                  <button type="button" class="ma-ghost-btn" @click="copyMinutes">
                    <i class="ri-file-copy-line" /> 复制全文
                  </button>
                  <button type="button" class="ma-ghost-btn" @click="exportMinutes">
                    <i class="ri-download-line" /> 导出 Markdown
                  </button>
                </div>
              </div>
              <article class="ma-minutes-doc">{{ state.minutes.body }}</article>
            </template>

            <div v-else class="ma-empty">
              <div class="ma-empty-ic"><i class="ri-file-list-3-line" /></div>
              <h4>暂无已整理的会议纪要</h4>
              <p>开启发言转录并结束会议后，会议纪要会自动沉淀在这里。</p>
            </div>
          </section>
        </div>
      </template>
    </div>
  </el-drawer>

  <!-- 会中实时字幕浮层 -->
  <aside v-if="inMeeting && state?.transcription.enabled" class="live-captions" aria-live="polite">
    <template v-if="captions.length">
      <div v-for="s in ordered.slice(0, 2).reverse()" :key="s.id" class="lc-line">
        <span class="lc-speaker">{{ s.speaker }}</span>
        <div class="lc-content">
          <p class="lc-origin">{{ s.text }}</p>
          <p v-if="target && target !== s.lang && translations[s.id]" class="lc-trans">
            {{ translations[s.id] }}
          </p>
        </div>
      </div>
    </template>
    <div v-else class="lc-waiting">
      <i class="ri-mic-2-line" />
      <span>转录与翻译已开启，正在等待发言…</span>
    </div>
    <div v-if="error" class="lc-error" role="alert">
      <i class="ri-error-warning-line" /> {{ error }}
    </div>
  </aside>

  <!-- 云录制知情同意弹窗 -->
  <el-dialog
    :model-value="!!permissionJob || !!admissionError"
    append-to-body
    :title="admissionError ? '确认录制状态' : '本场会议正在云录制'"
    width="min(460px, 94vw)"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="false"
  >
    <div class="ma-consent-box">
      <div class="ma-consent-ic" :class="{ 'is-error': !!admissionError }">
        <i :class="admissionError ? 'ri-error-warning-line' : 'ri-shield-keyhole-line'" />
      </div>
      <div class="ma-consent-body">
        <p class="ma-consent-text">
          {{
            admissionError ||
            '同意后，你发布的摄像头、麦克风和共享屏幕将加入本次加密云录制。回放默认仅主持人可见，主持人可在录制结束后授权分发。'
          }}
        </p>
        <p v-if="consentError" class="ma-consent-err" role="alert">{{ consentError }}</p>
      </div>
    </div>
    <template #footer>
      <el-button @click="declineRecording">离开会议</el-button>
      <el-button v-if="admissionError" type="primary" @click="retryAdmission">重试</el-button>
      <el-button v-else type="primary" :loading="working" @click="acceptRecording">同意录制并继续</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { clientPrefs, updateClientPrefs } from '@/utils/clientPrefs'
import { ElMessage, ElMessageBox } from 'element-plus'
import { assistantRequest, jsonBody as payload, type AssistantState as State } from '@/api/assistant'
import { listen, wav } from '@/utils/meetingSpeech'
import { sealRecording, openRecording } from '@/utils/sealedRecording'
import { copyText } from '@/utils/clipboard'

type Line = State['captions'][number]

const props = defineProps<{
  modelValue: boolean
  meetingId: number
  number?: string
  stream?: MediaStream | null
  mic?: boolean
  inMeeting?: boolean
  initialTab?: string
}>()
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void; (e: 'leave'): void }>()

const state = ref<State | null>(null)
const tab = ref('materials')
const error = ref('')
const captions = ref<Line[]>([])
const target = computed({
  get: () => clientPrefs.captionLanguage || 'zh',
  set: (v: string) => {
    void updateClientPrefs({ captionLanguage: v })
  },
})
const previewUrl = ref('')
const replayUrl = ref('')
const loadingReplay = ref('')
const playingId = ref('')
const refreshing = ref(false)
const portableOpen = ref(false)

function clearPreview() {
  loadingReplay.value = ''
  playingId.value = ''
  if (replayUrl.value) URL.revokeObjectURL(replayUrl.value)
  replayUrl.value = ''
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
}

const translations = ref<Record<number, string>>({})
const tracks: Record<string, string> = { camera: '摄像头', microphone: '麦克风', screen: '共享屏幕' }
const finishLabels: Record<string, string> = { host_stop: '主持人停止', meeting_ended: '会议结束', empty_timeout: '空房超时', service_restart: '服务中断' }
type CaptureControl = { id: string; stop: boolean; previous: string | null }
let pendingControl: CaptureControl | null = null
const enrolling = ref(false)
const working = ref(false)
const admissionError = ref('')
const consentError = ref('')

const ordered = computed(() => [...captions.value].sort((a, b) => b.at - a.at || b.id - a.id))
const managedCapturesFinished = computed(() =>
  (state.value?.managedCaptures || []).filter((r) => r.status !== 'running'),
)
const permissionJob = computed(() =>
  props.inMeeting &&
  state.value?.live &&
  state.value.capture &&
  !Object.keys(tracks).every((k) => state.value?.consent.includes(k))
    ? state.value.capture.id
    : '',
)

const clock = (n: number) => new Date(n * 1000).toLocaleTimeString()

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${(bytes / 1073741824).toFixed(2)} GB`
}

function fileKind(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  if (ext === 'pdf') return 'pdf'
  if (['doc', 'docx'].includes(ext)) return 'doc'
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'sheet'
  if (['ppt', 'pptx'].includes(ext)) return 'slide'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'img'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'zip'
  return 'other'
}

function fileIcon(name: string): string {
  const kind = fileKind(name)
  if (kind === 'pdf') return 'ri-file-pdf-2-line'
  if (kind === 'doc') return 'ri-file-word-2-line'
  if (kind === 'sheet') return 'ri-file-excel-2-line'
  if (kind === 'slide') return 'ri-file-ppt-2-line'
  if (kind === 'img') return 'ri-image-2-line'
  if (kind === 'zip') return 'ri-file-zip-line'
  return 'ri-file-text-line'
}

function trackIcon(kind: string): string {
  if (kind === 'camera') return 'ri-vidicon-line'
  if (kind === 'microphone') return 'ri-mic-line'
  if (kind === 'screen') return 'ri-airplay-line'
  return 'ri-film-line'
}

function trackKindClass(kind: string): string {
  if (kind === 'camera') return 'doc'
  if (kind === 'microphone') return 'sheet'
  if (kind === 'screen') return 'slide'
  return 'other'
}

async function copyAllCaptions() {
  const text = [...ordered.value]
    .reverse()
    .map((s) => `[${clock(s.at)}] ${s.speaker}：${s.text}`)
    .join('\n')
  if (await copyText(text)) ElMessage.success('发言记录已复制')
  else ElMessage.warning('复制失败，请手动选中复制')
}

async function copyMinutes() {
  const body = state.value?.minutes?.body || ''
  if (!body) return
  if (await copyText(body)) ElMessage.success('会议纪要已复制')
  else ElMessage.warning('复制失败，请手动选中复制')
}

function exportMinutes() {
  const body = state.value?.minutes?.body || ''
  if (!body) return
  const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' })
  saveBlob(blob, `会议纪要-${props.number || props.meetingId}.md`)
}

let seen = 0
let version = 0
let requestSeq = 0
let applied = 0
let translating = false
let alive = true
let leaving = false
let stopEnroll: (() => void) | undefined
let waiting: ((accepted: boolean) => void) | undefined

const api = (path: string, opts: RequestInit = {}) =>
  assistantRequest('meetings/' + props.meetingId + '/' + path, opts, props.number)

function report(e: unknown) {
  if (alive) error.value = e instanceof Error ? e.message : '会议请求失败'
}

async function action(fn: () => Promise<unknown>) {
  try {
    error.value = ''
    await fn()
    await refresh()
  } catch (e) {
    report(e)
    ElMessage.error(error.value)
  }
}

async function manualRefresh() {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await refresh()
  } finally {
    refreshing.value = false
  }
}

async function refresh() {
  if (!alive || !props.meetingId || (!props.modelValue && !props.inMeeting)) return false
  const v = version
  const seq = ++requestSeq
  try {
    const next: State = await (await api('state?after=' + seen, { signal: AbortSignal.timeout(12000) })).json()
    if (!alive || v !== version || seq < applied) return false
    applied = seq
    state.value = next
    if (pendingControl && (pendingControl.stop ? next.capture?.id !== pendingControl.id
      : next.capture?.id === pendingControl.id || next.managedCaptures.some((r) => r.id === pendingControl?.id))) {
      pendingControl = null
    }
    const fresh = next.captions.filter((s) => s.id > seen)
    if (fresh.length) {
      captions.value.push(...fresh)
      seen = fresh[fresh.length - 1]!.id
    }
    error.value = ''
    if (next.live && waiting) admissionError.value = ''
    if (next.live && !permissionJob.value && waiting) {
      waiting(true)
      waiting = undefined
      admissionError.value = ''
    }
    void translate()
    if (fresh.length === 100) void refresh()
    return true
  } catch (e) {
    if (v === version && seq >= applied) report(e)
    return false
  }
}

async function retryAdmission() {
  const ok = await refresh()
  if (!waiting) return
  if (!ok || !state.value?.live) {
    admissionError.value = error.value || '暂时无法确认入会状态，请重试。'
    return
  }
  admissionError.value = ''
  if (!permissionJob.value) {
    waiting(true)
    waiting = undefined
  }
}

function admit(): Promise<boolean> {
  return new Promise((resolve) => {
    waiting = resolve
    void retryAdmission()
  })
}

function declineRecording() {
  leaving = true
  waiting?.(false)
  waiting = undefined
  emit('leave')
}

async function acceptRecording() {
  const id = permissionJob.value
  if (!id || working.value) return
  working.value = true
  consentError.value = ''
  try {
    await api('consent', payload('PUT', { captureId: id, kinds: Object.keys(tracks) }))
    await refresh()
  } catch (e) {
    consentError.value = (e as Error).message
    await refresh()
  } finally {
    working.value = false
  }
}

async function toggleSpeech() {
  if (working.value) return
  working.value = true
  try {
    if (!state.value) await refresh()
    if (!state.value?.live) throw new Error('请先入会')
    await api('transcription', payload('PUT', { enabled: !state.value.transcription.enabled }))
    await refresh()
  } catch (e) {
    report(e)
    ElMessage.error(error.value)
  } finally {
    working.value = false
  }
}

async function translate() {
  if (translating || !target.value || !state.value?.transcription.enabled || !props.inMeeting) return
  translating = true
  const lang = target.value
  const v = version
  try {
    for (const s of ordered.value.slice(0, 3)) {
      if (!alive || lang !== target.value || v !== version || !state.value?.transcription.enabled) break
      if (translations.value[s.id] || !s.lang) continue
      const t =
        s.lang === lang ? s.text : (await (await api('translations/' + s.id + '?lang=' + lang)).json()).text
      if (lang === target.value && v === version) translations.value[s.id] = t
    }
  } catch (e) {
    report(e)
  } finally {
    translating = false
  }
}

watch(target, () => {
  translations.value = {}
  void translate()
})
watch(tab, () => void translate())
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      tab.value = props.initialTab || 'materials'
      void refresh()
    } else clearPreview()
  },
  { immediate: true },
)

function halt() {
  stopEnroll?.()
  stopEnroll = undefined
  enrolling.value = false
}

function micTrack() {
  const track = props.stream?.getAudioTracks().find((t) => t.enabled && t.readyState === 'live')
  if (!props.mic || !track) throw new Error('请先开启会议麦克风')
  return track
}

watch(
  () => [props.mic, props.stream],
  () => {
    if (!props.mic || !props.stream) halt()
  },
)
watch(
  () => props.meetingId,
  () => {
    halt()
    version++
    pendingControl = null
    seen = 0
    state.value = null
    captions.value = []
    translations.value = {}
    void refresh()
  },
)
watch(
  () => props.initialTab,
  (tabName) => {
    if (tabName) tab.value = tabName
  },
)
watch(permissionJob, () => {
  consentError.value = ''
})

async function enroll() {
  try {
    await ElMessageBox.confirm('将从你的会议麦克风提取声纹，仅供本场发言匹配。可随时删除。', '绑定我的声纹', {
      confirmButtonText: '同意并录制',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const track = micTrack()
    const frames: Float32Array[] = []
    enrolling.value = true
    const v = version
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('录音未完成，请检查麦克风')), 8000)
      void listen(track, (f) => {
        frames.push(f)
        if (frames.length >= 40) resolve()
      }).then((stop) => {
        if (!enrolling.value) {
          stop()
          reject(new Error('声纹录制已取消'))
          return
        }
        stopEnroll = stop
      }, reject)
    })
    if (v === version && enrolling.value)
      await action(() =>
        api('voice', { method: 'PUT', headers: { 'Content-Type': 'audio/wav' }, body: wav(frames) }),
      )
  } catch (e) {
    report(e)
  } finally {
    clearTimeout(timer)
    stopEnroll?.()
    stopEnroll = undefined
    enrolling.value = false
  }
}

const removeVoice = () => action(() => api('voice', { method: 'DELETE' }))

function filesOf(e: Event) {
  const el = e.target as HTMLInputElement
  const f = Array.from(el.files || [])
  el.value = ''
  return f
}

function uploadMaterials(e: Event) {
  const fs = filesOf(e)
  if (!fs.length) return
  void action(async () => {
    for (const f of fs)
      await api('materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name) },
        body: f,
      })
    ElMessage.success(`已发布 ${fs.length} 份材料`)
  })
}

async function toggleRecording() {
  if (working.value) return
  working.value = true
  try {
    if (!state.value && !await refresh()) throw new Error('无法确认录制状态，请重试')
    if (!state.value?.host) throw new Error('仅主持人可控制云录制')
    const id = state.value.capture?.id
    const previous = state.value.lastCaptureId ?? null
    const meetingVersion = version
    if (!pendingControl && !id) {
      try {
        await ElMessageBox.confirm(
          '开始后将录制你发布的摄像头、麦克风和共享屏幕，并向其他参会人征求同意。',
          '开启加密云录制',
          { confirmButtonText: '同意并开启', cancelButtonText: '取消' },
        )
      } catch {
        return
      }
    }
    if (meetingVersion !== version || !alive) return
    const command = pendingControl || { id: id || crypto.randomUUID().replace(/-/g, ''), stop: !!id, previous }
    pendingControl = command
    try {
      const path = command.stop ? 'capture?captureId=' + encodeURIComponent(command.id) : 'capture'
      const opts = command.stop ? { method: 'DELETE' } : payload('POST', { captureId: command.id, previousCaptureId: command.previous })
      await api(path, { ...opts, signal: AbortSignal.timeout(12000) })
      if (meetingVersion !== version) return
      applied = ++requestSeq
      if (await refresh()) pendingControl = null
    } catch (e) {
      if (meetingVersion !== version) return
      applied = ++requestSeq
      await refresh()
      if (!pendingControl) return
      const status = (e as { status?: number })?.status
      if (status && status >= 400 && status < 500) {
        pendingControl = null
        throw e
      }
      throw new Error('录制请求尚未确认，再次点击可重试同一段录制')
    }
  } catch (e) {
    report(e)
    ElMessage.error(error.value)
  } finally {
    working.value = false
  }
}

async function shareRecording(id: string, users: number[]) {
  let value: string
  try {
    ;({ value } = await ElMessageBox.prompt(
      '填写可领取回放的参会账号 ID，用逗号分隔。清空后仅主持人可见。',
      '分发回放',
      {
        inputValue: users.join(','),
        inputPattern: /^\s*(?:[1-9]\d*(?:[\s,，]+[1-9]\d*)*)?\s*$/,
        inputErrorMessage: '请输入账号 ID',
      },
    ))
  } catch {
    return
  }
  await action(() =>
    api(
      'sharing/' + id,
      payload('PUT', {
        users: value
          .trim()
          .split(/[\s,，]+/)
          .filter(Boolean)
          .map(Number),
      }),
    ),
  )
}

defineExpose({ state, target, working, enrolling, enroll, removeVoice, toggleSpeech, toggleRecording, admit })

function saveBlob(blob: Blob, name: string) {
  const u = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = u
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(u), 30000)
}

async function playRecording(id: string) {
  clearPreview()
  loadingReplay.value = id
  try {
    const blob = await (await api('files/' + id)).blob()
    if (alive && props.modelValue && loadingReplay.value === id) {
      replayUrl.value = URL.createObjectURL(blob)
      playingId.value = id
    }
  } catch (e) {
    report(e)
  } finally {
    if (loadingReplay.value === id) loadingReplay.value = ''
  }
}

async function download(path: string, name: string) {
  await action(async () => saveBlob(await (await api(path)).blob(), name))
}

async function password(title: string) {
  try {
    const r = await ElMessageBox.prompt('请输入至少 10 个字符的口令', title, {
      inputType: 'password',
      inputPattern: /^.{10,}$/u,
      inputErrorMessage: '口令至少需要 10 个字符',
    })
    return r.value as string
  } catch {
    return ''
  }
}

async function sealedDownload(id: string) {
  const pass = await password('加密本次水印副本')
  if (pass)
    await action(async () =>
      saveBlob(
        await sealRecording(await (await api('files/' + id)).blob(), pass),
        '会议录制-' + id + '.wtrec',
      ),
    )
}

async function localFile(e: Event, open: boolean) {
  const f = filesOf(e)[0]
  if (!f) return
  const pass = await password(open ? '打开加密录制' : '加密本地录制')
  if (!pass) return
  await action(async () => {
    if (open) {
      const blob = await openRecording(f, pass)
      clearPreview()
      previewUrl.value = URL.createObjectURL(blob)
      portableOpen.value = true
    } else saveBlob(await sealRecording(f, pass), f.name + '.wtrec')
  })
}

const timer = setInterval(() => {
  if (!leaving) void refresh()
}, 1800)

onBeforeUnmount(() => {
  waiting?.(false)
  waiting = undefined
  alive = false
  version++
  halt()
  clearPreview()
  clearInterval(timer)
})
</script>

<style>
.ma-drawer .el-drawer__header {
  margin-bottom: 0;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color, var(--el-border-color-lighter));
  background: var(--bg-card, var(--el-bg-color));
}
.ma-drawer .el-drawer__body {
  padding: 0;
  background: var(--bg-dark, var(--el-bg-color-page));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
</style>

<style scoped>
/* ── Header ── */
.ma-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding-right: 4px;
}
.ma-header-left {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
}
.ma-brand-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--primary, #165dff) 0%, #4d9aff 100%);
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
  box-shadow: 0 4px 12px rgba(22, 93, 255, 0.25);
}
.ma-title-group {
  min-width: 0;
}
.ma-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ma-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary, var(--el-text-color-primary));
  line-height: 1.25;
}
.ma-meeting-no {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--bg-hover, var(--el-fill-color));
  color: var(--text-muted, var(--el-text-color-secondary));
  font-variant-numeric: tabular-nums;
}
.ma-subtitle {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-muted, var(--el-text-color-secondary));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ma-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.ma-live-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
}
.ma-live-pill--rec {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}
.ma-live-pill--sub {
  background: var(--primary-soft, rgba(22, 93, 255, 0.12));
  color: var(--primary-text, var(--primary, #165dff));
}
.ma-icon-btn {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--border-color, var(--el-border-color));
  background: transparent;
  color: var(--text-secondary, var(--el-text-color-regular));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.ma-icon-btn:hover:not(:disabled) {
  background: var(--bg-hover, var(--el-fill-color));
  color: var(--primary-text, var(--primary, #165dff));
  border-color: var(--primary, #165dff);
}
.ma-icon-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* ── Shell & Tabs ── */
.ma-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.ma-alert {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 16px 0;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.25);
  color: #ef4444;
  font-size: 13px;
}
.ma-alert-ic {
  font-size: 16px;
  flex-shrink: 0;
}
.ma-alert-msg {
  flex: 1;
  min-width: 0;
}
.ma-alert-btn {
  border: 0;
  background: rgba(239, 68, 68, 0.14);
  color: #ef4444;
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.ma-alert-btn:hover {
  background: rgba(239, 68, 68, 0.22);
}

.ma-loading {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-muted, var(--el-text-color-secondary));
  font-size: 13px;
}
.ma-loading i {
  font-size: 24px;
  color: var(--primary, #165dff);
}

.ma-tabs {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: 4px;
  padding: 8px 10px;
  background: var(--bg-soft, var(--el-fill-color-light));
  border-bottom: 1px solid var(--border-color, var(--el-border-color-lighter));
  flex-shrink: 0;
}
.ma-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 7px 6px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary, var(--el-text-color-regular));
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  min-width: 0;
  overflow: hidden;
  transition: background 0.16s, color 0.16s, box-shadow 0.16s;
}
.ma-tab i {
  font-size: 13.5px;
  flex-shrink: 0;
}
.ma-tab:hover {
  background: var(--bg-hover, var(--el-fill-color));
  color: var(--text-primary, var(--el-text-color-primary));
}
.ma-tab.active {
  background: var(--bg-card, var(--el-bg-color));
  color: var(--primary-text, var(--primary, #165dff));
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(15, 23, 42, 0.08);
}
.ma-badge {
  font-style: normal;
  font-size: 11px;
  font-weight: 600;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-hover, var(--el-fill-color));
  color: var(--text-muted, var(--el-text-color-secondary));
}
.ma-tab.active .ma-badge {
  background: var(--primary, #165dff);
  color: #fff;
}
.ma-dot-ready {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success, #22c55e);
}

/* ── Panel Content ── */
.ma-panel {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}
.ma-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ma-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.ma-toolbar-meta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-muted, var(--el-text-color-secondary));
}
.ma-toolbar-btns {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ma-ghost-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 7px;
  border: 1px solid var(--border-color, var(--el-border-color));
  background: var(--bg-card, var(--el-bg-color));
  color: var(--text-secondary, var(--el-text-color-regular));
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}
.ma-ghost-btn:hover {
  border-color: var(--primary, #165dff);
  color: var(--primary-text, var(--primary, #165dff));
}

/* ── Hero Actions Card (Materials) ── */
.ma-hero-bar {
  padding: 14px;
  border-radius: 12px;
  background: var(--bg-card, var(--el-bg-color));
  border: 1px solid var(--border-color, var(--el-border-color-lighter));
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ma-hero-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.ma-primary-btn,
.ma-outline-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 36px;
  padding: 0 14px;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.16s;
}
.ma-primary-btn {
  border: 0;
  background: var(--primary, #165dff);
  color: #fff;
  box-shadow: 0 2px 8px rgba(22, 93, 255, 0.25);
}
.ma-primary-btn:hover {
  background: var(--primary-dark, #1350e0);
}
.ma-outline-btn {
  border: 1px solid var(--border-color, var(--el-border-color));
  background: var(--bg-input, var(--el-fill-color-light));
  color: var(--text-primary, var(--el-text-color-primary));
}
.ma-outline-btn:hover:not(:disabled) {
  border-color: var(--primary, #165dff);
  color: var(--primary-text, var(--primary, #165dff));
}
.ma-outline-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ma-hidden-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
.ma-upload-btn {
  position: relative;
  overflow: hidden;
}
.ma-hero-tip {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-muted, var(--el-text-color-secondary));
  line-height: 1.5;
}

/* ── Card List & Items ── */
.ma-card-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ma-item-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--bg-card, var(--el-bg-color));
  border: 1px solid var(--border-color, var(--el-border-color-lighter));
  transition: border-color 0.16s, box-shadow 0.16s;
}
.ma-item-card:hover {
  border-color: rgba(22, 93, 255, 0.4);
  box-shadow: 0 4px 14px rgba(15, 23, 42, 0.06);
}
.ma-file-ic {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  flex-shrink: 0;
  background: var(--bg-hover, var(--el-fill-color));
  color: var(--text-secondary, var(--el-text-color-regular));
}
.ma-file-ic--pdf { background: rgba(239, 68, 68, 0.12); color: #ef4444; }
.ma-file-ic--doc { background: rgba(22, 93, 255, 0.12); color: #165dff; }
.ma-file-ic--sheet { background: rgba(34, 197, 94, 0.12); color: #16a34a; }
.ma-file-ic--slide { background: rgba(245, 158, 11, 0.14); color: #d97706; }
.ma-file-ic--img { background: rgba(168, 85, 247, 0.12); color: #9333ea; }
.ma-file-ic--zip { background: rgba(100, 116, 139, 0.14); color: #64748b; }
.ma-file-ic--share { background: rgba(22, 93, 255, 0.12); color: #165dff; }

.ma-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.ma-item-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, var(--el-text-color-primary));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ma-item-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  font-size: 12px;
  color: var(--text-muted, var(--el-text-color-secondary));
}
.ma-sep {
  opacity: 0.5;
}
.ma-action-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 11px;
  border-radius: 8px;
  border: 1px solid var(--border-color, var(--el-border-color));
  background: var(--bg-input, var(--el-fill-color-light));
  color: var(--text-primary, var(--el-text-color-primary));
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s;
}
.ma-action-chip:hover {
  border-color: var(--primary, #165dff);
  background: var(--primary-soft, rgba(22, 93, 255, 0.1));
  color: var(--primary-text, var(--primary, #165dff));
}

/* ── Captions History ── */
.ma-caption-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ma-caption-card {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--bg-card, var(--el-bg-color));
  border: 1px solid var(--border-color, var(--el-border-color-lighter));
}
.ma-caption-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--primary-soft, rgba(22, 93, 255, 0.14));
  color: var(--primary-text, var(--primary, #165dff));
  font-size: 13px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.ma-caption-body {
  flex: 1;
  min-width: 0;
}
.ma-caption-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}
.ma-caption-speaker {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, var(--el-text-color-primary));
}
.ma-caption-time {
  font-size: 11px;
  color: var(--text-muted, var(--el-text-color-secondary));
  font-variant-numeric: tabular-nums;
}
.ma-caption-text {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text-secondary, var(--el-text-color-regular));
  word-break: break-word;
}

/* ── Recording Tab ── */
.ma-rec-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 15px;
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.1) 0%, rgba(239, 68, 68, 0.04) 100%);
  border: 1px solid rgba(239, 68, 68, 0.25);
}
.ma-rec-banner-ic {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: rgba(239, 68, 68, 0.14);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.ma-rec-banner-body strong {
  display: block;
  font-size: 14px;
  color: #ef4444;
  margin-bottom: 2px;
}
.ma-rec-banner-body p {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary, var(--el-text-color-regular));
  line-height: 1.45;
}

.ma-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ma-block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
}
.ma-block-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, var(--el-text-color-primary));
}
.ma-block-sub {
  font-size: 12px;
  color: var(--text-muted, var(--el-text-color-secondary));
}

.ma-perm-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11.5px;
  background: var(--bg-hover, var(--el-fill-color));
  color: var(--text-secondary, var(--el-text-color-regular));
}
.ma-perm-pill--shared {
  background: var(--primary-soft, rgba(22, 93, 255, 0.1));
  color: var(--primary-text, var(--primary, #165dff));
}

.ma-rec-card {
  padding: 13px 14px;
  border-radius: 12px;
  background: var(--bg-card, var(--el-bg-color));
  border: 1px solid var(--border-color, var(--el-border-color-lighter));
  display: flex;
  flex-direction: column;
  gap: 11px;
  transition: border-color 0.16s, box-shadow 0.16s;
}
.ma-rec-card:hover {
  border-color: rgba(22, 93, 255, 0.4);
}
.ma-rec-card.is-playing {
  border-color: var(--primary, #165dff);
  box-shadow: 0 0 0 2px rgba(22, 93, 255, 0.12);
}
.ma-rec-top {
  display: flex;
  align-items: center;
  gap: 12px;
}
.ma-rec-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.ma-owner-tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 5px;
  background: var(--bg-hover, var(--el-fill-color));
  color: var(--text-secondary, var(--el-text-color-regular));
}
.ma-status-tag {
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
}
.ma-status-tag--ok { background: rgba(34, 197, 94, 0.12); color: #16a34a; }
.ma-status-tag--info { background: rgba(22, 93, 255, 0.12); color: #165dff; }
.ma-status-tag--warn { background: rgba(245, 158, 11, 0.14); color: #d97706; }

.ma-rec-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 10px;
  border-top: 1px dashed var(--border-color, var(--el-border-color-lighter));
}
.ma-mini-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 7px;
  border: 1px solid var(--border-color, var(--el-border-color));
  background: var(--bg-input, var(--el-fill-color-light));
  color: var(--text-primary, var(--el-text-color-primary));
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}
.ma-mini-btn:hover:not(:disabled) {
  border-color: var(--primary, #165dff);
  color: var(--primary-text, var(--primary, #165dff));
}
.ma-mini-btn--primary {
  background: var(--primary-soft, rgba(22, 93, 255, 0.12));
  border-color: transparent;
  color: var(--primary-text, var(--primary, #165dff));
  font-weight: 600;
}
.ma-mini-btn--primary:hover:not(:disabled) {
  background: var(--primary, #165dff);
  color: #fff;
}
.ma-mini-btn:disabled {
  opacity: 0.6;
  cursor: wait;
}

/* ── Player Box ── */
.ma-player-box {
  border-radius: 12px;
  overflow: hidden;
  background: #0f172a;
  border: 1px solid var(--border-color, var(--el-border-color));
}
.ma-player-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 500;
  color: #cbd5e1;
  background: rgba(255, 255, 255, 0.04);
}
.ma-player-bar span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ma-player-close {
  border: 0;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ma-player-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}
.ma-video-el {
  display: block;
  width: 100%;
  max-height: 300px;
  background: #000;
}

/* ── Portable Local Encryption Card ── */
.ma-portable-card {
  border-radius: 12px;
  background: var(--bg-card, var(--el-bg-color));
  border: 1px solid var(--border-color, var(--el-border-color-lighter));
  overflow: hidden;
}
.ma-portable-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border: 0;
  background: transparent;
  color: var(--text-primary, var(--el-text-color-primary));
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.ma-portable-toggle:hover {
  background: var(--bg-hover, var(--el-fill-color-light));
}
.ma-portable-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.ma-portable-title i {
  color: var(--primary, #165dff);
  font-size: 16px;
}
.ma-portable-arrow {
  font-size: 18px;
  color: var(--text-muted, var(--el-text-color-secondary));
  transition: transform 0.2s;
}
.ma-portable-arrow.open {
  transform: rotate(180deg);
}
.ma-portable-body {
  padding: 0 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ma-portable-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.ma-tool-tile {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 12px;
  border-radius: 10px;
  border: 1px dashed var(--border-color, var(--el-border-color));
  background: var(--bg-input, var(--el-fill-color-light));
  cursor: pointer;
  transition: all 0.16s;
}
.ma-tool-tile:hover {
  border-style: solid;
  border-color: var(--primary, #165dff);
  background: var(--primary-soft, rgba(22, 93, 255, 0.08));
}
.ma-tool-ic {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: rgba(22, 93, 255, 0.12);
  color: var(--primary, #165dff);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 17px;
  flex-shrink: 0;
}
.ma-tool-ic--alt {
  background: rgba(34, 197, 94, 0.12);
  color: #16a34a;
}
.ma-tool-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ma-tool-text strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, var(--el-text-color-primary));
}
.ma-tool-text small {
  font-size: 11px;
  color: var(--text-muted, var(--el-text-color-secondary));
}
.ma-portable-tip {
  margin: 0;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted, var(--el-text-color-secondary));
}

/* ── Minutes Tab ── */
.ma-processing-card {
  padding: 36px 24px;
  border-radius: 14px;
  background: var(--bg-card, var(--el-bg-color));
  border: 1px solid var(--border-color, var(--el-border-color-lighter));
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.ma-processing-ic {
  width: 52px;
  height: 52px;
  border-radius: 16px;
  background: var(--primary-soft, rgba(22, 93, 255, 0.12));
  color: var(--primary, #165dff);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
}
.ma-processing-card h4 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary, var(--el-text-color-primary));
}
.ma-processing-card p {
  margin: 0;
  max-width: 340px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-muted, var(--el-text-color-secondary));
}
.ma-minutes-doc {
  margin: 0;
  padding: 16px 18px;
  border-radius: 12px;
  background: var(--bg-card, var(--el-bg-color));
  border: 1px solid var(--border-color, var(--el-border-color-lighter));
  color: var(--text-primary, var(--el-text-color-primary));
  font-size: 14px;
  line-height: 1.75;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── Empty State ── */
.ma-empty {
  padding: 38px 20px;
  border-radius: 14px;
  background: var(--bg-card, var(--el-bg-color));
  border: 1px dashed var(--border-color, var(--el-border-color));
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.ma-empty-ic {
  width: 48px;
  height: 48px;
  border-radius: 14px;
  background: var(--bg-hover, var(--el-fill-color));
  color: var(--text-muted, var(--el-text-color-secondary));
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  margin-bottom: 2px;
}
.ma-empty h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary, var(--el-text-color-primary));
}
.ma-empty p {
  margin: 0;
  max-width: 300px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-muted, var(--el-text-color-secondary));
}

/* ── Live Captions Overlay ── */
.live-captions {
  position: fixed;
  z-index: 15;
  left: 50%;
  bottom: calc(84px + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  max-width: min(44rem, 92vw);
  min-width: 240px;
  width: max-content;
  padding: 10px 16px;
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.86);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  color: #f8fafc;
  display: flex;
  flex-direction: column;
  gap: 6px;
  pointer-events: none;
}
.lc-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  line-height: 1.5;
}
.lc-speaker {
  flex-shrink: 0;
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(59, 130, 246, 0.28);
  color: #bfdbfe;
  font-size: 12px;
  font-weight: 600;
  margin-top: 2px;
}
.lc-content {
  min-width: 0;
}
.lc-origin {
  margin: 0;
  font-size: 14px;
  color: #f8fafc;
}
.lc-trans {
  margin: 2px 0 0;
  font-size: 13px;
  color: #93c5fd;
}
.lc-waiting {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  color: #cbd5e1;
}
.lc-error {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #fca5a5;
}

/* ── Consent Dialog ── */
.ma-consent-box {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}
.ma-consent-ic {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  background: var(--primary-soft, rgba(22, 93, 255, 0.12));
  color: var(--primary, #165dff);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  flex-shrink: 0;
}
.ma-consent-ic.is-error {
  background: rgba(239, 68, 68, 0.12);
  color: #ef4444;
}
.ma-consent-body {
  flex: 1;
  min-width: 0;
}
.ma-consent-text {
  margin: 0;
  font-size: 14px;
  line-height: 1.65;
  color: var(--text-primary, var(--el-text-color-primary));
}
.ma-consent-err {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: #ef4444;
}

/* ── Animations ── */
.ma-pulse-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #ef4444;
  display: inline-block;
  animation: ma-pulse 1.5s ease-in-out infinite;
}
.ma-pulse-dot--lg {
  width: 10px;
  height: 10px;
}
@keyframes ma-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.85); }
}
.ma-spin {
  display: inline-block;
  animation: ma-spin 0.9s linear infinite;
}
@keyframes ma-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 520px) {
  .ma-portable-grid {
    grid-template-columns: 1fr;
  }
}
</style>
