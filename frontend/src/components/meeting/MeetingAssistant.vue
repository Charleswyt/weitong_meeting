<template>
  <el-drawer
    :model-value="modelValue"
    title="会议助手"
    direction="rtl"
    size="min(610px, 100vw)"
    append-to-body
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p v-if="error" class="assistant-error" role="alert">
      {{ error }} <el-button link @click="refresh">重新加载</el-button>
    </p>
    <template v-if="state">
      <el-tabs v-model="tab">
        <el-tab-pane v-if="!inMeeting && state.history" label="发言记录" name="captions">
          <article v-for="s in ordered" :key="s.id" class="entry">
            <header>{{ s.speaker }} · {{ clock(s.at) }}</header>
            <p>{{ s.text }}</p>
          </article>
          <p v-if="!captions.length" class="hint">本场暂无发言记录。</p>
        </el-tab-pane>
        <el-tab-pane label="材料包" name="materials">
          <div class="actions">
            <label v-if="state.host" class="file-pick"
              >发布会前材料<input type="file" multiple @change="uploadMaterials"
            /></label>
            <el-button :disabled="!state.materials.length" @click="download('package', '会议材料包.zip')"
              >下载全部材料</el-button
            >
          </div>
          <p class="hint">受邀用户可在入会前从会议详情领取材料。</p>
          <article v-for="m in state.materials" :key="m.id" class="entry">
            <strong>{{ m.name }}</strong
            ><span>{{ (m.size / 1024).toFixed(1) }} KiB · {{ m.downloads }} 人领取</span
            ><el-button link @click="download('materials/' + m.id, m.name)">下载</el-button>
          </article>
          <p v-if="!state.materials.length" class="hint">主持人尚未发布材料。</p>
        </el-tab-pane>
        <el-tab-pane label="加密录制" name="record">
          <p v-if="state.capture" class="hint">
            加密云录制进行中。仅录制已同意成员正在发布的摄像头、麦克风与共享屏幕。
          </p>
          <p v-else-if="!state.files.length" class="hint">暂无可查看的录制。</p>
          <div
            v-for="r in state.managedCaptures.filter((r) => r.status !== 'running')"
            :key="r.id"
            class="entry"
          >
            <strong>{{ clock(r.at) }} · 回放分发</strong>
            <span>{{ r.users.length ? '已授权账号：' + r.users.join('、') : '仅主持人可查看' }}</span>
            <el-button link @click="shareRecording(r.id, r.users)">设置回放权限</el-button>
          </div>
          <article v-for="f in state.files" :key="f.id" class="entry">
            <strong>{{ tracks[f.kind] || f.kind }} · 账号 {{ f.owner }}</strong
            ><span
              >{{ clock(f.at) }} ·
              {{
                f.status === 'ready'
                  ? (f.bytes / 1048576).toFixed(1) +
                    ' MiB · ' +
                    (f.archived ? '已归档至 OSS' : '等待 OSS 归档')
                  : '正在写入'
              }}</span
            ><el-button
              v-if="f.status === 'ready'"
              link
              :loading="loadingReplay === f.id"
              @click="playRecording(f.id)"
              >播放回放</el-button
            ><el-button
              v-if="f.status === 'ready'"
              link
              @click="download('files/' + f.id, '会议录制-' + f.id + '.mp4')"
              >导出水印 MP4</el-button
            ><el-button v-if="f.status === 'ready'" link @click="sealedDownload(f.id)"
              >下载加密水印副本</el-button
            >
          </article>
          <video v-if="replayUrl" :src="replayUrl" controls autoplay playsinline style="width: 100%" />
          <details class="portable">
            <summary>本地加密文件</summary>
            <div class="actions">
              <label class="file-pick"
                >加密一份本地录制<input
                  type="file"
                  accept="video/mp4,video/webm,audio/mp4,audio/webm,audio/wav"
                  @change="localFile($event, false)"
              /></label>
              <label class="file-pick"
                >打开加密录制<input type="file" accept=".wtrec" @change="localFile($event, true)"
              /></label>
            </div>
            <p class="hint">口令用于本机加解密。请单独保管口令，平台无法代为找回。</p>
            <video v-if="previewUrl" :src="previewUrl" controls playsinline style="width: 100%" />
          </details>
        </el-tab-pane>
        <el-tab-pane label="会议纪要" name="minutes">
          <p v-if="inMeeting || state.minutesStatus === 'processing'" role="status">
            处理中，会议结束后整理。
          </p>
          <pre v-else-if="state.minutes">{{ state.minutes.body }}</pre>
          <p v-else class="hint">暂无已整理的会议纪要。</p>
        </el-tab-pane>
      </el-tabs>
    </template>
  </el-drawer>
  <aside v-if="inMeeting && state?.transcription.enabled" class="live-captions" aria-live="polite">
    <div v-for="s in ordered.slice(0, 2).reverse()" :key="s.id">
      <strong>{{ s.speaker }}</strong> {{ s.text }}
      <span v-if="target && target !== s.lang && translations[s.id]">{{ translations[s.id] }}</span>
    </div>
    <span v-if="!captions.length">转录与翻译已开启，正在等待发言。</span>
    <span v-if="error" role="alert">{{ error }}</span>
  </aside>
  <el-dialog
    :model-value="!!permissionJob || !!admissionError"
    append-to-body
    :title="admissionError ? '确认录制状态' : '本场会议正在云录制'"
    width="min(455px, 94vw)"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="false"
  >
    <p>
      {{
        admissionError ||
        '同意后，你发布的摄像头、麦克风和共享屏幕将加入本次加密云录制。回放默认仅主持人可见，主持人可在录制结束后授权分发。'
      }}
    </p>
    <p v-if="consentError" role="alert">{{ consentError }}</p>
    <template #footer>
      <el-button @click="declineRecording">离开会议</el-button>
      <el-button v-if="admissionError" type="primary" @click="retryAdmission">重试</el-button>
      <el-button v-else type="primary" :loading="working" @click="acceptRecording">同意录制并继续</el-button>
    </template>
  </el-dialog>
</template>
<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { assistantRequest, jsonBody as payload, type AssistantState as State } from '@/api/assistant'
import { listen, wav } from '@/utils/meetingSpeech'
import { sealRecording, openRecording } from '@/utils/sealedRecording'
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
const state = ref<State | null>(null),
  tab = ref('materials'),
  error = ref(''),
  captions = ref<Line[]>([]),
  target = ref(localStorage.getItem('weitong.caption-language') || 'zh')
const previewUrl = ref(''),
  replayUrl = ref(''),
  loadingReplay = ref('')
function clearPreview() {
  loadingReplay.value = ''
  if (replayUrl.value) URL.revokeObjectURL(replayUrl.value)
  replayUrl.value = ''
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
}
const translations = ref<Record<number, string>>({})
const tracks: Record<string, string> = { camera: '摄像头', microphone: '麦克风', screen: '共享屏幕' }
const enrolling = ref(false),
  working = ref(false),
  admissionError = ref(''),
  consentError = ref('')
const ordered = computed(() => [...captions.value].sort((a, b) => b.at - a.at || b.id - a.id))
const permissionJob = computed(() =>
  props.inMeeting &&
  state.value?.live &&
  state.value.capture &&
  !Object.keys(tracks).every((k) => state.value?.consent.includes(k))
    ? state.value.capture.id
    : '',
)
const clock = (n: number) => new Date(n * 1000).toLocaleTimeString()
let seen = 0,
  version = 0,
  requestSeq = 0,
  applied = 0,
  translating = false,
  alive = true,
  leaving = false
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
async function refresh() {
  if (!alive || !props.meetingId || (!props.modelValue && !props.inMeeting)) return false
  const v = version,
    seq = ++requestSeq
  try {
    const next: State = await (await api('state?after=' + seen)).json()
    if (!alive || v !== version || seq < applied) return false
    applied = seq
    state.value = next
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
  const lang = target.value,
    v = version
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
  localStorage.setItem('weitong.caption-language', target.value)
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
    const track = micTrack(),
      frames: Float32Array[] = []
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
  void action(async () => {
    for (const f of fs)
      await api('materials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name) },
        body: f,
      })
  })
}
async function toggleRecording() {
  if (working.value) return
  working.value = true
  try {
    if (!state.value) await refresh()
    if (!state.value?.host) throw new Error('仅主持人可控制云录制')
    const id = state.value.capture?.id
    if (!id) {
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
    await api('capture', id ? { method: 'DELETE' } : payload('POST', {}))
    await refresh()
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
  const u = URL.createObjectURL(blob),
    a = document.createElement('a')
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
    if (alive && props.modelValue && loadingReplay.value === id) replayUrl.value = URL.createObjectURL(blob)
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
<style scoped>
.live-captions {
  position: fixed;
  z-index: 15;
  left: 50%;
  bottom: calc(84px + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  max-width: min(42rem, 90vw);
  width: max-content;
  padding: 8px 16px;
  border-radius: 8px;
  background: rgba(18, 25, 35, 0.9);
  color: white;
  line-height: 1.5;
  pointer-events: none;
}
.live-captions strong {
  margin-right: 6px;
}
.live-captions div span {
  display: block;
  color: #b6e4ff;
}

.portable {
  margin-top: 20px;
}
.actions,
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin: 12px 0;
}
.actions label,
.row {
  font-size: 14px;
}
.entry {
  padding: 12px 0;
  border-bottom: 1px solid var(--el-border-color-lighter);
  display: grid;
  gap: 5px;
}
.entry header,
.entry > span,
.hint,
details {
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.entry p {
  margin: 0;
  line-height: 1.6;
}
.entry .translated {
  color: var(--el-color-primary);
}
.entry .el-button {
  justify-self: start;
}
.file-pick {
  color: var(--el-color-primary);
  cursor: pointer;
}
.file-pick input {
  display: block;
  max-width: 240px;
  margin-top: 4px;
}
.hint {
  line-height: 1.55;
}
.assistant-error {
  color: var(--el-color-danger);
}
textarea,
pre {
  width: 100%;
  box-sizing: border-box;
  white-space: pre-wrap;
  font: inherit;
  line-height: 1.65;
  padding: 10px;
  color: var(--el-text-color-primary);
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
}
select {
  padding: 4px 8px;
}
strong {
  font-weight: 600;
}
</style>
