<template>
  <aside class="mp">
    <header class="mp-head">
      <i class="ri-group-line mp-head-icon" />
      <span class="mp-title">成员</span>
      <span class="mp-count">{{ joinedCount }}</span>
      <button class="mp-icon" title="收起成员面板" @click="$emit('close')">
        <i class="ri-arrow-right-s-line" />
      </button>
    </header>

    <div class="mp-search">
      <i class="ri-search-line mp-search-icon" />
      <input v-model="keyword" type="search" placeholder="搜索成员" />
    </div>

    <div class="mp-body">
      <div
        v-for="r in filteredRows"
        :key="r.key"
        class="mp-item"
        :class="{ 'is-focusable': r.joined, 'is-active': r.key === activeKey }"
        @click="r.joined && $emit('focus', r.key)"
      >
        <div class="mp-thumb" :class="{ speaking: r.speaking }">
          <canvas
            v-if="r.thumb === 'canvas' && r.streamId"
            :ref="(el) => registerCanvas(r.streamId, el as HTMLCanvasElement | null)"
            class="mp-video"
          />
          <video
            v-else-if="r.thumb === 'self'"
            :ref="(el) => setSelfThumb(el as HTMLVideoElement | null)"
            class="mp-video"
            autoplay
            playsinline
            muted
          />
          <video
            v-else-if="r.thumb === 'stream' && r.thumbStream"
            class="mp-video"
            autoplay
            playsinline
            muted
            :srcObject="r.thumbStream"
          />
          <div v-else class="mp-avatar-box">
            <span class="mp-avatar">
              <img v-if="avatarSrcFor(r.key || r.name, r.avatar)" :src="avatarSrcFor(r.key || r.name, r.avatar)" :alt="r.name" @error="markAvatarBroken(r.key || r.name)" />
              <em v-else>{{ r.name.charAt(0) || '?' }}</em>
            </span>
            <p v-if="r.hint" class="mp-thumb-hint">{{ r.hint }}</p>
          </div>
        </div>

        <div class="mp-info">
          <div class="mp-name-row">
            <span class="mp-name" :title="r.name">{{ r.name }}</span>
            <span
              v-if="r.nodeType"
              class="mp-tag"
              :class="r.nodeType === 'edge' ? 'mp-tag-edge' : 'mp-tag-cloud'"
            >{{ r.nodeType === 'edge' ? '边' : '云' }}</span>
            <span v-if="r.isHost" class="mp-tag mp-tag-host">主持人</span>
            <span v-if="r.isSelf" class="mp-tag mp-tag-self">我</span>
            <span v-if="!r.joined" class="mp-tag mp-tag-wait">待入会</span>
            <!-- 设备状态只有已入会者才有真值；等候入场的人不给画图标。 -->
            <span v-if="r.joined" class="mp-media">
              <i
                :class="r.micOn ? 'ri-mic-line' : 'ri-mic-off-line'"
                :title="r.micOn ? '麦克风已开' : '麦克风已关'"
              />
              <i
                :class="r.cameraOn ? 'ri-vidicon-line' : 'ri-video-off-line'"
                :title="r.cameraOn ? '摄像头已开' : '摄像头已关'"
              />
            </span>
          </div>
          <div class="mp-rate-row">
            <span :title="r.upKbps === null ? '测不到对方上行' : '本端实测上行'">↑{{ rateTextCompact(r.upKbps) }}</span>
            <span>↓{{ rateTextCompact(r.downKbps) }}</span>
          </div>
          <p v-if="r.error" class="mp-error">{{ r.error }}</p>
        </div>
      </div>
      <div v-if="!filteredRows.length" class="mp-empty">没有匹配的成员</div>
    </div>

    <footer class="mp-foot">
      <div class="mp-net" :class="'mp-net-' + (netLevel || 'idle')" :title="netTitle">
        <span class="mp-net-k">网络质量</span>
        <b>{{ netText }}</b>
      </div>
      <button class="mp-primary" @click="$emit('invite')">邀请成员</button>
    </footer>
  </aside>
</template>

<script lang="ts">
import { rateTextCompact } from '@/utils/compression'

// 成员行由 InMeetingView 统一构造：缩略图放哪儿（主画面/面板/头像）只有父级按排列才说得清。
export interface MemberRow {
  key: string
  name: string
  avatar: string
  isSelf: boolean
  isHost: boolean
  nodeType: string
  joined: boolean
  micOn: boolean
  cameraOn: boolean
  speaking: boolean
  /** 该成员当前可上 canvas 的视频流号，'' 表示没有 */
  streamId: string
  /** canvas=面板里挂解码画布；self=面板里放本地预览；stream=画面在一条接收流上、直接绑 <video>；avatar=头像占位 */
  thumb: 'canvas' | 'self' | 'stream' | 'avatar'
  /** thumb='stream' 时这一格要绑的那条流 */
  thumbStream?: MediaStream | null
  /** 顶部排列的缩略条副本：只画头像，不挂第二块解码画布 */
  strip?: boolean
  /** 缩略条里这一位此刻正占着下面的主画面（原型：那一格带蓝描边） */
  inMain?: boolean
  hint: string
  error: string
  upKbps: number | null
  downKbps: number | null
}

// 速率文本不在这里实现：全仓唯一的 kbps→Mbps 换算在 @/utils/compression 的 rateText，
// 紧凑写法 rateTextCompact 只去空格、不重算。此前这里是一份 /1024 的副本 mbpsText，
// 与生产端的 /1000 刻度差 2.4%，已删。
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { avatarSrcFor, markAvatarBroken } from '@/utils/avatarImage'

const props = defineProps<{
  rows: MemberRow[]
  /** 当前占主画面那一格的 key，原型里它在成员栏带蓝色描边 */
  activeKey: string
  registerCanvas: (id: string, el: HTMLCanvasElement | null) => void
  selfStream: MediaStream | null
  netText: string
  netTitle: string
  netLevel: string
}>()

defineEmits<{ (e: 'close'): void; (e: 'invite'): void; (e: 'focus', key: string): void }>()

const keyword = ref('')

const kw = computed(() => keyword.value.trim().toLowerCase())
const filteredRows = computed(() =>
  kw.value ? props.rows.filter((r) => r.name.toLowerCase().includes(kw.value)) : props.rows,
)
const joinedCount = computed(() => props.rows.filter((r) => r.joined).length)

// 本地预览轨可能被主画面与面板缩略图同时消费，srcObject 要跟着挂载点走。
// 这里原先写的是 v-for 内的字符串 ref —— Vue 会把同名 ref 收进**数组**，
// `selfThumbRef.value.srcObject = ...` 只是给数组挂了个不相干的属性，那一格永远是黑的。
const selfThumbs = new Set<HTMLVideoElement>()
function attachSelf(v: HTMLVideoElement) {
  if (v.srcObject !== props.selfStream) v.srcObject = props.selfStream
  if (v.paused) void v.play().catch(() => { /* 自动播放被拦时画面稍后自起，不弹技术细节 */ })
}
function setSelfThumb(el: HTMLVideoElement | null) {
  if (!el) return
  selfThumbs.add(el)
  attachSelf(el)
}
watch(
  () => props.selfStream,
  () => {
    for (const el of selfThumbs) {
      if (!el.isConnected) selfThumbs.delete(el)
      else attachSelf(el)
    }
  },
)
</script>

<style scoped>
.mp {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border-left: 1px solid var(--border-soft);
}

/* 平板/窄屏：右侧成员栏与画面抢同一行宽度，280px 会吃掉一块瓦片。 */
@media (max-width: 1024px) {
  .mp { width: 216px; }
}

@media (max-width: 767px) {
  .mp {
    width: 100%;
  }
  .mp-info { width: auto; flex: 1; }
}

/* 原型：头部 56（group 图标 + 成员 + 计数 + 收起） */
.mp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 56px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border-soft);
}
.mp-head-icon { font-size: 18px; color: var(--primary-text); }
.mp-title { font-size: 15px; font-weight: 600; color: var(--text-primary); }
.mp-count {
  min-width: 20px; padding: 0 6px; height: 18px; line-height: 18px;
  border-radius: var(--radius-pill); background: var(--bg-hover);
  font-size: 12px; color: var(--text-tertiary); text-align: center;
}
.mp-icon {
  margin-left: auto; width: 26px; height: 26px; border: 0; background: transparent;
  color: var(--text-muted); cursor: pointer; font-size: 16px; border-radius: 6px;
}
.mp-icon:hover { background: var(--bg-hover); color: var(--text-primary); }

/* 原型：搜索框 36 */
.mp-search {
  position: relative;
  padding: 10px 14px;
}
.mp-search-icon {
  position: absolute; left: 24px; top: 50%; transform: translateY(-50%);
  font-size: 14px; color: var(--text-muted); pointer-events: none;
}
.mp-search input {
  width: 100%; height: 36px; padding: 0 12px 0 32px; font-size: 13px;
  background: var(--bg-input); border: 1px solid var(--border-color);
  border-radius: var(--radius); color: var(--text-primary); outline: none;
}
.mp-search input:focus { border-color: var(--primary); }

.mp-body { flex: 1; overflow-y: auto; padding: 0 10px 12px; }

/* 原型：成员项 h=104，左缩略图 97×82 + 右信息列 */
.mp-item {
  display: flex; align-items: center; gap: 10px;
  height: 104px; padding: 0 4px; border-radius: var(--radius);
}
.mp-item:hover { background: var(--bg-hover); }
.mp-item.is-focusable { cursor: pointer; }
/* 原型：当前占主画面那一行是淡蓝底 + 蓝描边（用 inset 阴影，避免边框撑动行高） */
.mp-item.is-active { background: var(--primary-soft); box-shadow: inset 0 0 0 1px var(--primary); }

.mp-thumb {
  width: 97px; height: 82px; flex-shrink: 0; overflow: hidden;
  border-radius: 8px; background: #1e293b;
  border: 2px solid transparent;
}
.mp-thumb.speaking { border-color: var(--success); }
.mp-video { width: 100%; height: 100%; object-fit: cover; display: block; }
.mp-avatar-box {
  width: 100%; height: 100%;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4px; background: var(--bg-hover);
}
.mp-avatar {
  width: 40px; height: 40px; border-radius: 50%; overflow: hidden;
  background: var(--primary-soft); display: flex; align-items: center; justify-content: center;
}
.mp-avatar img { width: 100%; height: 100%; object-fit: cover; }
.mp-avatar em { font-style: normal; font-size: 15px; font-weight: 600; color: var(--primary-text); }
.mp-thumb-hint { margin: 0; font-size: 10px; line-height: 1.2; color: var(--text-tertiary); text-align: center; }

/* 信息列：姓名行 + 速率行 fs12 */
.mp-info { width: 140px; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.mp-name-row { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; min-width: 0; }
.mp-name {
  max-width: 100%; font-size: 13px; font-weight: 500; color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mp-tag {
  flex-shrink: 0; min-width: 18px; height: 18px; padding: 0 4px; box-sizing: border-box;
  border-radius: var(--radius-sm); font-size: 11px; line-height: 18px; text-align: center;
}
.mp-tag-host { background: var(--warning-bg); color: var(--warning-text); }
.mp-tag-self { background: var(--primary-soft); color: var(--primary-text); }
.mp-tag-wait { background: var(--bg-hover); color: var(--text-muted); }
.mp-tag-edge { background: rgba(34, 197, 94, 0.12); color: var(--success-text); }
.mp-tag-cloud { background: var(--bg-hover); color: var(--text-tertiary); }
.mp-media { display: inline-flex; gap: 3px; font-size: 15px; color: var(--text-secondary); }
.mp-media .ri-mic-off-line, .mp-media .ri-video-off-line { color: var(--text-muted); }
.mp-rate-row { display: flex; gap: 10px; font-size: 12px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.mp-error { margin: 0; font-size: 11px; color: var(--danger-text); line-height: 1.3; }
.mp-empty { padding: 12px; font-size: 12px; color: var(--text-muted); text-align: center; }

/* 原型底部：网络质量卡 + 「邀请成员」蓝底按钮 */
.mp-foot { padding: 12px 14px; border-top: 1px solid var(--border-soft); display: flex; flex-direction: column; gap: 10px; }
.mp-net {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px; border-radius: var(--radius); background: var(--bg-input);
  border: 1px solid var(--border-soft); font-size: 12px;
}
.mp-net-k { color: var(--text-muted); }
.mp-net b { color: var(--text-primary); font-weight: 600; }
.mp-net-good b { color: var(--success-text); }
.mp-net-fair b { color: var(--warning-text); }
.mp-net-poor b { color: var(--danger-text); }
.mp-primary {
  height: 36px; border-radius: var(--radius); font-size: 13px; cursor: pointer;
  border: 0; background: var(--primary); color: #fff;
}
.mp-primary:hover { background: var(--primary-dark); }
</style>
