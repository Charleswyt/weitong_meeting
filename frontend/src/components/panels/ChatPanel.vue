<template>
  <aside class="cp">
    <header class="cp-head">
      <span class="cp-title">聊天</span>
      <span class="cp-count">{{ messages.length }}</span>
      <button class="cp-icon" title="搜索" @click="searchOpen = !searchOpen"><i class="ri-search-line" /></button>
      <button class="cp-icon" @click="$emit('close')"><i class="ri-close-line" /></button>
    </header>

    <div v-if="searchOpen" class="cp-search">
      <input ref="searchRef" v-model="keyword" type="search" placeholder="搜索消息内容" />
    </div>

    <nav class="cp-tabs">
      <button
        v-for="t in tabs"
        :key="t.id"
        class="cp-tab"
        :class="{ on: tab === t.id }"
        @click="tab = t.id"
      >
        {{ t.label }}
      </button>
    </nav>

    <ul ref="listRef" class="cp-list">
      <li v-for="row in visible" :key="row.key" class="cp-row" :class="[row.kind, { mine: row.mine }]">
        <span v-if="row.kind === 'system'" class="cp-system">{{ row.text }}</span>

        <template v-else>
          <span class="cp-avatar">
            <img v-if="avatarSrcFor(row.who, row.avatar)" :src="avatarSrcFor(row.who, row.avatar)" :alt="row.who" @error="markAvatarBroken(row.who)" />
            <em v-else>{{ (row.who || '?').charAt(0) }}</em>
          </span>
          <div class="cp-bubble-wrap">
            <div class="cp-who">
              <span>{{ row.who }}</span>
              <span v-if="row.host" class="cp-tag-host">主持人</span>
              <span class="cp-time">{{ row.time }}</span>
            </div>
            <div v-if="isImageMsg(row.text)" class="cp-bubble cp-bubble-img">
              <img
                :src="extractImageSrc(row.text)"
                alt="聊天图片"
                class="cp-img-thumb"
                @click="previewImg = extractImageSrc(row.text)"
              />
            </div>
            <div v-else class="cp-bubble">{{ row.text }}</div>
          </div>
        </template>
      </li>
      <li v-if="!visible.length" class="cp-empty">暂无消息</li>
    </ul>

    <div class="cp-input">
      <textarea
        v-model="draft"
        class="cp-textarea"
        rows="2"
        maxlength="1000"
        :placeholder="placeholder + '（支持粘贴图片）'"
        @keydown.enter.exact.prevent="$emit('send')"
        @paste="onPasteImage"
      />
      <input
        ref="imgInputRef"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        @change="onPickImage"
      />
      <div class="cp-tools">
        <button
          type="button"
          class="cp-tool cp-tool-btn"
          title="发送图片"
          @click="imgInputRef?.click()"
        ><i class="ri-image-add-line" /></button>
        <span
          v-for="t in tools"
          :key="t.icon"
          class="cp-tool"
          :title="t.title"
          @click="$emit('not-wired', t.label)"
        ><i :class="t.icon" /></span>
        <button class="cp-send" :disabled="!draft.trim()" @click="$emit('send')">发送</button>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="previewImg" class="cp-lightbox" @click="previewImg = ''">
        <img :src="previewImg" alt="图片预览" @click.stop />
        <button type="button" class="cp-lightbox-close" @click="previewImg = ''">
          <i class="ri-close-line" />
        </button>
      </div>
    </Teleport>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { ChatLine } from '@/composables/useWebSocket'
import type { ParticipantVo } from '@/api/meeting'
import { avatarSrcFor, markAvatarBroken } from '@/utils/avatarImage'
import { businessClock } from '@/utils/time'

const props = defineProps<{
  messages: ChatLine[]
  participants: ParticipantVo[]
  myName: string
  startedAt: string
  shareOf: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'send'): void
  (e: 'send-image', dataUrl: string): void
  (e: 'not-wired', label: string): void
}>()

const draft = defineModel<string>('draft', { default: '' })
const imgInputRef = ref<HTMLInputElement | null>(null)
const previewImg = ref('')

const IMG_PREFIX = '[WT_IMG]'
function isImageMsg(text: string): boolean {
  return typeof text === 'string' && text.startsWith(IMG_PREFIX) && text.includes('data:image/')
}
function extractImageSrc(text: string): string {
  return text.slice(IMG_PREFIX.length)
}

async function compressImageFile(file: File): Promise<string | null> {
  if (!file.type.startsWith('image/')) return null
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        const maxW = 720
        const scale = img.width > maxW ? maxW / img.width : 1
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(null)
          return
        }
        ctx.drawImage(img, 0, 0, w, h)
        // 控制图片体积以兼容实时聊天通道
        let dataUrl = canvas.toDataURL('image/webp', 0.72)
        if (!dataUrl.startsWith('data:image/webp')) {
          dataUrl = canvas.toDataURL('image/jpeg', 0.72)
        }
        resolve(dataUrl)
      }
      img.onerror = () => resolve(null)
      img.src = String(reader.result || '')
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

async function handleImageFile(file: File) {
  const dataUrl = await compressImageFile(file)
  if (!dataUrl) return
  emit('send-image', `${IMG_PREFIX}${dataUrl}`)
}

async function onPickImage(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file) await handleImageFile(file)
}

async function onPasteImage(e: ClipboardEvent) {
  const items = Array.from(e.clipboardData?.items || [])
  const imgItem = items.find((i) => i.type.startsWith('image/'))
  if (!imgItem) return
  const file = imgItem.getAsFile()
  if (!file) return
  e.preventDefault()
  await handleImageFile(file)
}

type Tab = 'all' | 'host' | 'mine'
const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'host', label: '主持人' },
  { id: 'mine', label: '仅我' },
]
const tab = ref<Tab>('all')
const searchOpen = ref(false)
const keyword = ref('')
const listRef = ref<HTMLElement | null>(null)
const searchRef = ref<HTMLTextAreaElement | null>(null)

const tools = [
  { icon: 'ri-empathize-line', label: '表情', title: '表情暂未接入' },
  { icon: 'ri-at-line', label: '@提及', title: '@提及暂未接入' },
  { icon: 'ri-attachment-line', label: '附件', title: '附件暂未接入' },
  { icon: 'ri-mic-line', label: '语音', title: '语音消息暂未接入' },
]

const hostNames = computed(() => new Set(props.participants.filter((p) => p.isHost).map((p) => p.name)))

function hhmm(iso: string) {
  if (!iso) return ''
  return businessClock(iso)
}

interface Row {
  key: string
  kind: 'msg' | 'system'
  who: string
  text: string
  time: string
  mine: boolean
  host: boolean
  avatar: string
  at: number
}

// 系统行只由真实状态派生：开会时刻、当前共享者。不编造事件。
const systemRows = computed<Row[]>(() => {
  const out: Row[] = []
  if (props.startedAt) {
    out.push({
      key: 'sys-start', kind: 'system', who: '', text: `会议已开始 · ${hhmm(props.startedAt)}`,
      time: '', mine: false, host: false, avatar: '', at: new Date(props.startedAt).getTime(),
    })
  }
  if (props.shareOf) {
    out.push({
      key: 'sys-share', kind: 'system', who: '', text: `${props.shareOf} 正在共享屏幕`,
      time: '', mine: false, host: false, avatar: '', at: Number.MAX_SAFE_INTEGER,
    })
  }
  return out
})

const messageRows = computed<Row[]>(() =>
  props.messages.map((m, i) => ({
    key: 'm-' + (m.id ?? i),
    kind: 'msg' as const,
    who: m.senderName || '参会者',
    text: m.text,
    time: hhmm(m.sentAt),
    mine: !!m.senderName && m.senderName === props.myName,
    host: hostNames.value.has(m.senderName || ''),
    avatar: props.participants.find((p) => p.name === m.senderName)?.avatar || '',
    at: new Date(m.sentAt).getTime() || 0,
  })),
)

const visible = computed<Row[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  let rows: Row[] = [...systemRows.value, ...messageRows.value]
  if (tab.value === 'host') rows = rows.filter((r) => r.kind === 'msg' && r.host)
  if (tab.value === 'mine') rows = rows.filter((r) => r.kind === 'msg' && r.mine)
  if (kw) rows = rows.filter((r) => r.text.toLowerCase().includes(kw))
  return rows.sort((a, b) => a.at - b.at)
})

const placeholder = computed(() =>
  tab.value === 'mine' ? '发送消息给自己' : '发送消息给所有人',
)

watch(
  () => visible.value.length,
  async () => {
    await nextTick()
    if (listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight
  },
)

watch(searchOpen, async (v) => {
  if (v) {
    await nextTick()
    searchRef.value?.focus()
  }
})
</script>

<style scoped>
.cp {
  width: 288px; flex-shrink: 0; display: flex; flex-direction: column;
  background: var(--bg-card); border-left: 1px solid var(--border-soft);
}
.cp-head {
  display: flex; align-items: center; gap: 6px; height: 46px; padding: 0 14px;
  border-bottom: 1px solid var(--border-soft);
}
.cp-title { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.cp-count {
  min-width: 20px; padding: 0 6px; height: 18px; line-height: 18px; border-radius: var(--radius-pill);
  background: var(--bg-hover); font-size: 12px; color: var(--text-tertiary); text-align: center;
}
.cp-icon {
  margin-left: auto; width: 24px; height: 24px; border: 0; background: transparent;
  color: var(--text-muted); cursor: pointer; font-size: 13px; border-radius: 6px;
}
.cp-icon + .cp-icon { margin-left: 0; }
.cp-icon:hover { background: var(--bg-hover); color: var(--text-primary); }

.cp-search { padding: 10px 14px 0; }
.cp-search input {
  width: 100%; height: 32px; padding: 0 12px; font-size: 13px; outline: none;
  background: var(--bg-input); border: 1px solid var(--border-color); border-radius: var(--radius);
  color: var(--text-primary);
}
.cp-search input:focus { border-color: var(--primary); }

.cp-tabs { display: flex; gap: 16px; padding: 10px 14px 0; border-bottom: 1px solid var(--border-soft); }
.cp-tab {
  position: relative; padding: 0 0 9px; border: 0; background: transparent; cursor: pointer;
  font-size: 13px; color: var(--text-tertiary);
}
.cp-tab.on { color: var(--primary-text); font-weight: 500; }
.cp-tab.on::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
  background: var(--primary); border-radius: 2px;
}

.cp-list { flex: 1; margin: 0; padding: 12px; list-style: none; overflow-y: auto; }
.cp-row + .cp-row { margin-top: 12px; }
.cp-row.system { display: flex; justify-content: center; }
.cp-system { font-size: 11px; color: var(--text-muted); }
.cp-row.mine { flex-direction: row-reverse; }
.cp-avatar {
  width: 28px; height: 28px; border-radius: 50%; overflow: hidden; flex-shrink: 0;
  background: var(--primary-soft); display: flex; align-items: center; justify-content: center;
}
.cp-avatar img { width: 100%; height: 100%; object-fit: cover; }
.cp-avatar em { font-style: normal; font-size: 12px; font-weight: 600; color: var(--primary-text); }
.cp-bubble-wrap { margin-left: 8px; max-width: 210px; }
.cp-row.mine .cp-bubble-wrap { margin-left: 0; margin-right: 8px; }
.cp-who { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-muted); }
.cp-row.mine .cp-who { flex-direction: row-reverse; }
.cp-tag-host { padding: 0 4px; border-radius: 4px; background: var(--primary-soft); color: var(--primary-text); }
.cp-bubble {
  margin-top: 4px; padding: 8px 10px; font-size: 13px; line-height: 1.5; word-break: break-word;
  background: var(--bg-hover); color: var(--text-secondary);
  border-radius: 4px 11px 11px 11px;
}
.cp-row.mine .cp-bubble {
  background: var(--primary); color: #fff; border-radius: 11px 4px 11px 11px;
}
.cp-bubble-img {
  padding: 4px !important;
  background: var(--bg-card) !important;
  border: 1px solid var(--border-soft);
}
.cp-img-thumb {
  display: block;
  max-width: 196px;
  max-height: 180px;
  border-radius: 8px;
  object-fit: cover;
  cursor: zoom-in;
}
.cp-tool-btn {
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
}
.cp-lightbox {
  position: fixed;
  inset: 0;
  z-index: 3200;
  background: rgba(2, 6, 23, 0.82);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.cp-lightbox img {
  max-width: 92vw;
  max-height: 88vh;
  border-radius: 12px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
}
.cp-lightbox-close {
  position: fixed;
  top: 20px;
  right: 24px;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(15, 23, 42, 0.72);
  color: #fff;
  font-size: 20px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.cp-empty { font-size: 12px; color: var(--text-muted); text-align: center; padding: 20px 0; }

.cp-input { border-top: 1px solid var(--border-soft); padding: 10px 12px; }
.cp-textarea {
  width: 100%; resize: none; border: 1px solid var(--border-color); border-radius: var(--radius);
  background: var(--bg-input); padding: 8px 10px; font-size: 13px; line-height: 1.5; outline: none;
  color: var(--text-primary); font-family: inherit;
}
.cp-textarea:focus { border-color: var(--primary); }
.cp-tools { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.cp-tool { font-size: 14px; color: var(--text-muted); cursor: not-allowed; opacity: 0.6; }
.cp-tool:hover { color: var(--text-secondary); }
.cp-send {
  margin-left: auto; height: 28px; padding: 0 14px; border: 0; border-radius: var(--radius);
  background: var(--primary); color: #fff; font-size: 13px; cursor: pointer;
}
.cp-send:disabled { background: var(--border-color); color: var(--text-muted); cursor: not-allowed; }

@media (max-width: 767px) {
  .cp { width: 100%; }
  .cp-bubble-wrap { max-width: min(78vw, 280px); }
}
</style>
