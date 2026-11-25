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
        <el-tab-pane label="转录与翻译" name="captions">
          <div v-if="state.live && inMeeting" class="actions">
            <el-button :type="capturing ? 'default' : 'primary'" @click="toggleSpeech">{{
              capturing ? '停止转录我的发言' : '转录我的发言'
            }}</el-button>
            <el-button v-if="!state.voiceBound" :disabled="enrolling" @click="enroll">{{
              enrolling ? '请连续讲话 4 秒…' : '绑定我的声纹'
            }}</el-button>
            <el-button v-else @click="removeVoice">删除我的声纹</el-button>
          </div>
          <p v-if="state.live" class="hint">
            开启后，本人的麦克风发言会显示给参会人。声纹仅供本场区分发言人，可随时删除。
          </p>
          <label class="row"
            >字幕翻译
            <select v-model="target">
              <option value="">显示原文</option>
              <option v-for="(name, k) in state.languages" :key="k" :value="k">{{ name }}</option>
            </select></label
          >
          <p v-if="!captions.length" class="hint">尚无转录。参会人可分别开启自己的麦克风转录。</p>
          <article v-for="s in ordered" :key="s.id" class="entry">
            <header>
              <strong>{{ s.speaker }}</strong> · {{ clock(s.at) }} ·
              {{ s.attribution === 'voice' ? '声纹匹配' : '参会麦克风' }}
            </header>
            <p>{{ s.text }}</p>
            <p v-if="target && translations[s.id]" class="translated">{{ translations[s.id] }}</p>
            <details v-if="s.raw !== s.text">
              <summary>查看术语修正前的原文</summary>
              {{ s.raw }}
            </details>
          </article>
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
          <template v-if="state.live && inMeeting">
            <strong>允许云端录制我的轨道</strong>
            <div class="actions">
              <label v-for="(name, k) in tracks" :key="k"
                ><input
                  type="checkbox"
                  :checked="state.consent.includes(String(k))"
                  @change="consent(String(k), ($event.target as HTMLInputElement).checked)"
                />
                {{ name }}</label
              >
            </div>
          </template>
          <template v-if="state.host && state.live && inMeeting">
            <label class="row"
              >录制回放权限
              <select v-model="audience" :disabled="!!state.capture">
                <option value="attendees">实际参会人</option>
                <option value="host">仅主持人</option>
                <option value="selected">指定账号 ID</option>
              </select></label
            >
            <input
              v-if="audience === 'selected' && !state.capture"
              v-model="selected"
              placeholder="账号 ID，以逗号分隔"
            />
            <el-button :type="state.capture ? 'danger' : 'primary'" @click="toggleRecording">{{
              state.capture ? '结束加密云录制' : '开始加密云录制'
            }}</el-button>
          </template>
          <p class="hint">
            {{
              state.capture ? '云端正在录制已授权且正在发布的轨道。' : '当前没有进行中的云录制。'
            }}
            每份导出视频嵌入会议、领取人、录制及下载流水水印。
          </p>
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
              @click="download('files/' + f.id, '会议录制-' + f.id + '.mp4')"
              >导出水印 MP4</el-button
            ><el-button v-if="f.status === 'ready'" link @click="sealedDownload(f.id)"
              >下载加密水印副本</el-button
            >
          </article>
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
          <div class="actions">
            <el-button v-if="state.host" type="primary" @click="generate">从发言生成纪要</el-button
            ><el-button v-if="state.minutes" @click="download('minutes/export', '会议纪要.md')"
              >下载 Markdown</el-button
            >
          </div>
          <template v-if="state.minutes">
            <textarea v-if="state.host" v-model="edited" rows="16" aria-label="纪要正文"></textarea>
            <pre v-else>{{ state.minutes.body }}</pre>
            <el-button v-if="state.host" :disabled="edited === state.minutes.body" @click="saveMinutes"
              >保存修订</el-button
            ></template
          >
          <p v-else class="hint">生成后可查看讨论摘要、决定、行动项和待确认问题，每条附发言人和原文时间。</p>
        </el-tab-pane>
        <el-tab-pane label="术语库" name="terms">
          <label v-if="state.host" class="file-pick"
            >导入会议词库<input type="file" accept=".csv,.json" @change="importTerms"
          /></label>
          <p class="hint">
            CSV 每行填写标准词和别名，或使用标准词对应别名数组的 JSON。导入的词库用于后续发言。
          </p>
          <article v-for="(aliases, term) in state.terms" :key="term" class="entry">
            <strong>{{ term }}</strong
            ><span>{{ aliases.join('、') }}</span>
          </article>
        </el-tab-pane>
      </el-tabs>
    </template>
  </el-drawer>
</template>
<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { sitePath } from '@/utils/sitePath'
import { listen, wav } from '@/utils/meetingSpeech'
import { sealRecording, openRecording } from '@/utils/sealedRecording'
import type { paths } from '@/types/api.gen'
type State = paths['/assist/v1/meetings/{assistantMeetingId}/state']['get']['responses'][200]['content']['application/json']
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
const emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>()
const state = ref<State | null>(null),
  tab = ref('captions'),
  error = ref(''),
  captions = ref<Line[]>([]),
  target = ref('')
const previewUrl = ref('')
function clearPreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
}
const translations = ref<Record<number, string>>({}),
  edited = ref(''),
  audience = ref('attendees'),
  selected = ref('')
const tracks: Record<string, string> = { camera: '摄像头', microphone: '麦克风', screen: '共享屏幕' }
const capturing = ref(false),
  enrolling = ref(false),
  ordered = computed(() => [...captions.value].reverse())
const clock = (n: number) => new Date(n * 1000).toLocaleTimeString()
let seen = 0,
  version = 0,
  polling = false,
  translating = false,
  alive = true
let stopListen: (() => void) | undefined,
  stopEnroll: (() => void) | undefined,
  epoch = 0
async function api(path: string, opts: RequestInit = {}) {
  const u = new URL(sitePath('/assist/v1/meetings/' + props.meetingId + '/' + path), location.origin)
  if (props.number) u.searchParams.set('number', props.number)
  const headers = new Headers(opts.headers)
  headers.set('Authorization', 'Bearer ' + (localStorage.getItem('weitong.token') || ''))
  const r = await fetch(u, { ...opts, headers, cache: 'no-store' })
  if (!r.ok) {
    const e = await r.json().catch(() => ({}))
    throw new Error(e.message || '会议助手请求失败 ' + r.status)
  }
  return r
}
function payload(method: string, obj: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }
}
function report(e: unknown) {
  if (alive) error.value = e instanceof Error ? e.message : '请求失败'
}
async function action(fn: () => Promise<unknown>) {
  try {
    error.value = ''
    await fn()
    await refresh()
  } catch (e) {
    report(e)
  }
}
async function refresh() {
  if (polling || !props.meetingId || (!props.modelValue && !props.inMeeting)) return
  polling = true
  const id = props.meetingId,
    v = version
  try {
    const next: State = await (await api('state?after=' + seen)).json()
    if (!alive || id !== props.meetingId || v !== version) return
    if (next.minutes?.revision !== state.value?.minutes?.revision) edited.value = next.minutes?.body || ''
    if (next.capture && !state.value?.capture && props.inMeeting)
      ElMessage.info('主持人已开启加密云录制，可在会议助手中选择允许录制的轨道')
    state.value = next
    if (next.captions.length) {
      captions.value.push(...next.captions)
      seen = next.captions[next.captions.length - 1]!.id
    }
    error.value = ''
    void translate()
  } catch (e) {
    report(e)
  } finally {
    polling = false
  }
}
async function translate() {
  if (translating || !target.value || !props.modelValue || tab.value !== 'captions') return
  translating = true
  const lang = target.value,
    v = version
  try {
    for (const s of ordered.value.slice(0, 100).reverse()) {
      if (!alive || lang !== target.value || v !== version || !props.modelValue) break
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
      tab.value = props.initialTab || 'captions'
      void refresh()
    } else clearPreview()
  },
)
function halt() {
  capturing.value = false
  epoch++
  stopListen?.()
  stopListen = undefined
  stopEnroll?.()
  stopEnroll = undefined
  enrolling.value = false
}
function micTrack() {
  const t = props.stream?.getAudioTracks().find((t) => t.readyState === 'live' && t.enabled)
  if (!props.mic || !t) throw new Error('请先开启会议麦克风')
  return t
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
    captions.value = []
    translations.value = {}
    seen = 0
    state.value = null
    void refresh()
  },
)
let serial: Promise<void> = Promise.resolve(),
  queued = 0
async function toggleSpeech() {
  if (capturing.value) {
    halt()
    return
  }
  try {
    const t = micTrack(),
      gen = ++epoch
    let batch: Float32Array[] = [],
      quiet = 0,
      spoken = 0
    const stop = await listen(t, (f) => {
      if (gen !== epoch) return
      let sum = 0
      for (const x of f) sum += x * x
      const active = Math.sqrt(sum / f.length) > 0.006
      if (!batch.length && !active) return
      batch.push(f)
      if (active) {
        quiet = 0
        spoken++
      } else quiet++
      if (batch.length >= 65 || quiet >= 6) {
        const frames = batch
        batch = []
        quiet = 0
        const n = spoken
        spoken = 0
        if (n < 3) return
        if (queued >= 5) {
          report(new Error('转录积压，本段未发送'))
          return
        }
        const body = wav(frames),
          nonce = crypto.randomUUID()
        queued++
        serial = serial
          .then(async () => {
            if (gen !== epoch) return
            for (let i = 0; i < 2; i++) {
              try {
                await api('captions', {
                  method: 'POST',
                  headers: { 'Idempotency-Key': nonce, 'Content-Type': 'audio/wav' },
                  body,
                })
                break
              } catch (e) {
                if (i || gen !== epoch) throw e
              }
            }
            await refresh()
          })
          .catch(report)
          .finally(() => {
            queued--
          })
      }
    })
    if (gen !== epoch) {
      stop()
      return
    }
    stopListen = stop
    capturing.value = true
  } catch (e) {
    halt()
    report(e)
  }
}
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
function importTerms(e: Event) {
  const f = filesOf(e)[0]
  if (f)
    void action(async () => {
      const raw = await f.text()
      await api(
        'terms',
        payload('PUT', { terms: f.name.toLowerCase().endsWith('.json') ? JSON.parse(raw) : raw }),
      )
    })
}
function consent(k: string, on: boolean) {
  const kinds = new Set(state.value?.consent)
  if (on) kinds.add(k)
  else kinds.delete(k)
  void action(() => api('consent', payload('PUT', { kinds: [...kinds] })))
}
function toggleRecording() {
  void action(() =>
    state.value?.capture
      ? api('capture', { method: 'DELETE' })
      : api(
          'capture',
          payload('POST', {
            audience: audience.value,
            users: selected.value
              .split(/[,，\s]+/)
              .filter(Boolean)
              .map(Number),
          }),
        ),
  )
}
async function generate() {
  if (state.value?.minutes) {
    try {
      await ElMessageBox.confirm('重新生成将替换当前纪要正文。', '重新生成纪要')
    } catch {
      return
    }
  }
  await action(() =>
    api('minutes', payload('PUT', { generate: true, revision: state.value?.minutes?.revision || 0 })),
  )
}
function saveMinutes() {
  void action(() =>
    api('minutes', payload('PUT', { body: edited.value, revision: state.value?.minutes?.revision || 0 })),
  )
}
function saveBlob(blob: Blob, name: string) {
  const u = URL.createObjectURL(blob),
    a = document.createElement('a')
  a.href = u
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(u), 30000)
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
const timer = setInterval(() => void refresh(), 4000)
onBeforeUnmount(() => {
  alive = false
  version++
  halt()
  clearPreview()
  clearInterval(timer)
})
</script>
<style scoped>
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
