<template>
  <aside class="mp">
    <header class="mp-head">
      <div class="mp-head-left">
        <span class="mp-head-badge"><i class="ri-group-line" /></span>
        <span class="mp-title">参会成员</span>
        <span class="mp-count">{{ joinedCount }}</span>
      </div>
      <button class="mp-icon" title="收起成员面板" @click="$emit('close')">
        <i class="ri-arrow-right-s-line" />
      </button>
    </header>

    <div class="mp-search">
      <i class="ri-search-line mp-search-icon" />
      <input v-model="keyword" type="search" placeholder="搜索成员姓名" />
    </div>

    <div class="mp-body">
      <div
        v-for="r in filteredRows"
        :key="r.key"
        class="mp-item"
        :class="{
          'is-focusable': r.joined,
          'is-active': r.key === activeKey,
          'is-waiting': !r.joined,
        }"
        @click="r.joined && $emit('focus', r.key)"
      >
        <div class="mp-avatar-wrap" :class="{ speaking: r.speaking, waiting: !r.joined }">
          <span class="mp-avatar">
            <img
              v-if="avatarSrcFor(r.key || r.name, r.avatar)"
              :src="avatarSrcFor(r.key || r.name, r.avatar)"
              :alt="r.name"
              @error="markAvatarBroken(r.key || r.name)"
            />
            <em v-else>{{ r.name.charAt(0) || '?' }}</em>
          </span>
          <span v-if="r.sharing" class="mp-avatar-badge is-share" title="正在共享屏幕">
            <i class="ri-screen-share-line" />
          </span>
          <span v-else-if="r.speaking" class="mp-avatar-badge is-speak" title="正在发言" />
        </div>

        <div class="mp-info">
          <div class="mp-name-row">
            <div class="mp-name-group">
              <span class="mp-name" :title="r.name">{{ r.name }}</span>
              <span
                v-if="r.nodeType"
                class="mp-tag"
                :class="r.nodeType === 'edge' ? 'mp-tag-edge' : 'mp-tag-cloud'"
              >{{ r.nodeType === 'edge' ? '边' : '云' }}</span>
              <span v-if="r.isHost" class="mp-tag mp-tag-host">主持人</span>
              <span v-if="r.isSelf" class="mp-tag mp-tag-self">我</span>
              <button
                v-if="r.isSelf && r.joined"
                type="button"
                class="mp-edit-name-btn"
                title="修改我的名称"
                @click.stop="$emit('rename-self', r.name)"
              >
                <i class="ri-edit-line" />
              </button>
              <span v-if="!r.joined" class="mp-tag mp-tag-wait">待入会</span>
            </div>
            <!-- 设备状态只有已入会者才有真值；等候入场的人不给画图标。 -->
            <span v-if="r.joined" class="mp-media">
              <span
                class="mp-media-dot"
                :class="r.micOn ? 'is-on' : 'is-off'"
                :title="r.micOn ? '麦克风已开' : '麦克风已关'"
              >
                <i :class="r.micOn ? 'ri-mic-line' : 'ri-mic-off-line'" />
              </span>
              <span
                class="mp-media-dot"
                :class="r.cameraOn ? 'is-on' : 'is-off'"
                :title="r.cameraOn ? '摄像头已开' : '摄像头已关'"
              >
                <i :class="r.cameraOn ? 'ri-vidicon-line' : 'ri-video-off-line'" />
              </span>
              <button
                v-if="isSelfHost && !r.isSelf"
                type="button"
                class="mp-kick-btn"
                title="移出会议"
                @click.stop="$emit('kick', r.key, r.name)"
              >
                <i class="ri-user-unfollow-line" />
              </button>
            </span>
          </div>

          <div v-if="r.joined" class="mp-sub-row">
            <div class="mp-meta-group">
              <span v-if="r.sharing" class="mp-pill mp-pill-share" title="正在共享屏幕">共享中</span>
              <span v-else-if="r.speaking" class="mp-pill mp-pill-speak" title="正在发言">发言中</span>
              <span
                v-if="r.resolution"
                class="mp-spec"
                title="画面分辨率与帧率"
              >{{ r.resolution }}</span>
              <span v-else-if="!r.cameraOn" class="mp-spec mp-spec-muted">
                {{ r.micOn ? '仅语音' : '音视频已关' }}
              </span>
            </div>
            <div class="mp-rate-row" :title="rateTooltip(r)">
              <span v-if="r.isSelf">↑{{ rateTextCompact(r.upKbps) }}</span>
              <span v-else>↓{{ rateTextCompact(r.downKbps) }}</span>
              <span v-if="r.delayMs != null && r.delayMs > 0" class="mp-delay" :class="delayClass(r.delayMs)">
                {{ Math.round(r.delayMs) }}ms
              </span>
            </div>
          </div>
          <div v-else class="mp-wait-hint">等待加入会议</div>

          <p v-if="r.error" class="mp-error">{{ r.error }}</p>
        </div>
      </div>
      <div v-if="!filteredRows.length" class="mp-empty">没有匹配的成员</div>
    </div>

    <footer class="mp-foot">
      <div class="mp-net" :class="'mp-net-' + (netLevel || 'idle')" :title="netTitle">
        <span class="mp-net-k">
          <span class="mp-signal" aria-hidden="true">
            <i v-for="bar in 4" :key="bar" class="mp-signal-bar" :class="{ 'is-on': bar <= netBars }" />
          </span>
          网络质量
        </span>
        <b>{{ netText }}</b>
      </div>
      <div class="mp-foot-actions">
        <button v-if="isSelfHost" class="mp-secondary" @click="$emit('mute-all')">
          <i class="ri-mic-off-line" />
          <span>全员静音</span>
        </button>
        <button class="mp-primary" @click="$emit('invite')">
          <i class="ri-user-add-line" />
          <span>邀请成员</span>
        </button>
      </div>
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
  /** 实测画面规格（如 "720p · 25fps"） */
  resolution?: string
  /** 是否正在共享屏幕 */
  sharing?: boolean
  /** 实测延迟（本端为 RTT，远端为端到端接收延迟，单位 ms） */
  delayMs?: number | null
  /** 视频编码格式（用于悬浮提示） */
  codec?: string
}
</script>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { avatarSrcFor, markAvatarBroken } from '@/utils/avatarImage'

const props = defineProps<{
  rows: MemberRow[]
  /** 当前占主画面那一格的 key，在成员栏带高亮提示 */
  activeKey: string
  /** 当前登录用户是否是主持人（决定是否显示全员静音 / 移出按钮） */
  isSelfHost?: boolean
  registerCanvas?: (id: string, el: HTMLCanvasElement | null) => void
  selfStream?: MediaStream | null
  netText: string
  netTitle: string
  netLevel: string
}>()

defineEmits<{
  (e: 'close'): void
  (e: 'invite'): void
  (e: 'focus', key: string): void
  (e: 'mute-all'): void
  (e: 'kick', participantId: string, name: string): void
  (e: 'rename-self', currentName: string): void
}>()

const keyword = ref('')
const netBars = computed(() => {
  switch (props.netLevel) {
    case 'good': return 4
    case 'fair': return 3
    case 'poor': return 2
    case 'bad': return 1
    default: return 0
  }
})

const kw = computed(() => keyword.value.trim().toLowerCase())
const filteredRows = computed(() =>
  kw.value ? props.rows.filter((r) => r.name.toLowerCase().includes(kw.value)) : props.rows,
)
const joinedCount = computed(() => props.rows.filter((r) => r.joined).length)

function delayClass(ms: number) {
  if (ms >= 300) return 'is-poor'
  if (ms >= 150) return 'is-fair'
  return 'is-good'
}

function rateTooltip(r: MemberRow) {
  const parts: string[] = []
  if (r.isSelf) {
    parts.push(`本端上行：${rateTextCompact(r.upKbps)}`)
    if (r.downKbps && r.downKbps > 0) parts.push(`本端总下行：${rateTextCompact(r.downKbps)}`)
  } else {
    parts.push(`本端接收：${rateTextCompact(r.downKbps)}`)
  }
  if (r.resolution) parts.push(`画面：${r.resolution}`)
  if (r.delayMs != null && r.delayMs > 0) {
    parts.push(`${r.isSelf ? '网络往返' : '链路延迟'}：${Math.round(r.delayMs)}ms`)
  }
  return parts.join(' ｜ ')
}
</script>

<style scoped>
.mp {
  width: 288px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border-left: 1px solid var(--border-soft);
}

@media (max-width: 1024px) {
  .mp { width: 244px; }
}

@media (max-width: 767px) {
  .mp { width: 100%; }
}

.mp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 54px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border-soft);
}
.mp-head-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mp-head-badge {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: var(--primary-soft);
  color: var(--primary-text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}
.mp-title { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.mp-count {
  min-width: 20px; padding: 0 6px; height: 18px; line-height: 18px;
  border-radius: var(--radius-pill); background: var(--bg-hover);
  font-size: 11px; font-weight: 600; color: var(--text-secondary); text-align: center;
}
.mp-icon {
  width: 28px; height: 28px; border: 0; background: transparent;
  color: var(--text-muted); cursor: pointer; font-size: 16px; border-radius: 8px;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.mp-icon:hover { background: var(--bg-hover); color: var(--text-primary); }

.mp-search {
  position: relative;
  padding: 10px 12px 8px;
}
.mp-search-icon {
  position: absolute; left: 22px; top: 50%; transform: translateY(-50%);
  font-size: 14px; color: var(--text-muted); pointer-events: none;
}
.mp-search input {
  width: 100%; height: 34px; padding: 0 12px 0 32px; font-size: 12.5px;
  background: var(--bg-input); border: 1px solid var(--border-soft);
  border-radius: 9px; color: var(--text-primary); outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.mp-search input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px var(--primary-soft);
}

.mp-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mp-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  transition: background-color 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
}
.mp-item:hover {
  background: var(--bg-hover);
}
.mp-item.is-focusable { cursor: pointer; }
.mp-item.is-active {
  background: var(--primary-soft);
  border-color: rgba(59, 130, 246, 0.35);
  box-shadow: 0 1px 4px rgba(37, 99, 235, 0.08);
}
.mp-item.is-waiting { opacity: 0.78; }

.mp-avatar-wrap {
  position: relative;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border-radius: 50%;
  transition: box-shadow 0.2s ease;
}
.mp-avatar-wrap.speaking {
  box-shadow: 0 0 0 2px var(--bg-card), 0 0 0 4px var(--success);
}
.mp-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  overflow: hidden;
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.18), rgba(99, 102, 241, 0.24));
  border: 1px solid rgba(59, 130, 246, 0.16);
  display: flex;
  align-items: center;
  justify-content: center;
}
.mp-avatar-wrap.waiting .mp-avatar {
  background: var(--bg-hover);
  border: 1px dashed var(--border-color);
}
.mp-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mp-avatar em {
  font-style: normal; font-size: 15px; font-weight: 600; color: var(--primary-text);
}
.mp-avatar-wrap.waiting .mp-avatar em { color: var(--text-muted); }

.mp-avatar-badge {
  position: absolute;
  right: -2px;
  bottom: -2px;
  border-radius: 50%;
  border: 2px solid var(--bg-card);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.mp-avatar-badge.is-share {
  width: 17px;
  height: 17px;
  background: var(--primary);
  color: #fff;
  font-size: 10px;
}
.mp-avatar-badge.is-speak {
  width: 11px;
  height: 11px;
  background: var(--success);
}

/* 信息列：占满右侧剩余空间，不再被挤窄 */
.mp-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.mp-name-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}
.mp-name-group {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: 1;
}
.mp-name {
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mp-tag {
  flex-shrink: 0; min-width: 18px; height: 17px; padding: 0 5px; box-sizing: border-box;
  border-radius: 5px; font-size: 10.5px; font-weight: 500; line-height: 17px; text-align: center;
}
.mp-tag-host { background: var(--warning-bg); color: var(--warning-text); }
.mp-tag-self { background: rgba(59, 130, 246, 0.16); color: var(--primary-text); }
.mp-tag-wait { background: var(--bg-hover); color: var(--text-muted); }
.mp-tag-edge { background: rgba(34, 197, 94, 0.14); color: var(--success-text); }
.mp-tag-cloud { background: var(--bg-hover); color: var(--text-tertiary); }

.mp-media {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.mp-media-dot {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
}
.mp-media-dot.is-on {
  background: var(--bg-hover);
  color: var(--text-secondary);
}
.mp-media-dot.is-off {
  background: rgba(239, 68, 68, 0.08);
  color: var(--text-muted);
}
.mp-kick-btn {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.mp-kick-btn:hover {
  background: rgba(239, 68, 68, 0.12);
  color: var(--danger-text);
}
.mp-edit-name-btn {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.mp-edit-name-btn:hover {
  background: var(--primary-soft);
  color: var(--primary-text);
}

.mp-sub-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
}
.mp-meta-group {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
}
.mp-pill {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  padding: 0 5px;
  height: 16px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
}
.mp-pill-share { background: rgba(59, 130, 246, 0.14); color: var(--primary-text); }
.mp-pill-speak { background: rgba(34, 197, 94, 0.14); color: var(--success-text); }

.mp-spec {
  font-size: 11px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mp-spec-muted { color: var(--text-muted); }

.mp-rate-row {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}
.mp-delay { font-weight: 500; }
.mp-delay.is-good { color: var(--success-text); }
.mp-delay.is-fair { color: var(--warning-text); }
.mp-delay.is-poor { color: var(--danger-text); }
.mp-wait-hint { font-size: 11px; color: var(--text-muted); }
.mp-error { margin: 0; font-size: 11px; color: var(--danger-text); line-height: 1.3; }
.mp-empty { padding: 20px 12px; font-size: 12px; color: var(--text-muted); text-align: center; }

.mp-foot {
  padding: 12px;
  border-top: 1px solid var(--border-soft);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mp-net {
  display: flex; align-items: center; justify-content: space-between;
  padding: 9px 11px; border-radius: 9px; background: var(--bg-input);
  border: 1px solid var(--border-soft); font-size: 12px;
}
.mp-net-k {
  display: inline-flex; align-items: center; gap: 6px;
  color: var(--text-muted);
}
.mp-signal {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 13px;
  padding-bottom: 1px;
}
.mp-signal-bar {
  display: block;
  width: 3px;
  border-radius: 1.5px;
  background: var(--border-color);
  transition: background-color 0.25s ease, transform 0.25s cubic-bezier(0.32, 0.72, 0, 1);
}
.mp-signal-bar:nth-child(1) { height: 4px; }
.mp-signal-bar:nth-child(2) { height: 7px; }
.mp-signal-bar:nth-child(3) { height: 10px; }
.mp-signal-bar:nth-child(4) { height: 13px; }
.mp-net-good .mp-signal-bar.is-on { background: var(--success); }
.mp-net-fair .mp-signal-bar.is-on { background: var(--warning); }
.mp-net-poor .mp-signal-bar.is-on,
.mp-net-bad .mp-signal-bar.is-on { background: var(--danger); }
.mp-net b { color: var(--text-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.mp-net-good b { color: var(--success-text); }
.mp-net-fair b { color: var(--warning-text); }
.mp-net-poor b,
.mp-net-bad b { color: var(--danger-text); }
.mp-foot-actions {
  display: flex;
  gap: 8px;
}
.mp-secondary {
  flex: 1;
  height: 36px; border-radius: 9px; font-size: 12.5px; font-weight: 500; cursor: pointer;
  border: 1px solid var(--border-color); background: var(--bg-input); color: var(--text-primary);
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.mp-secondary:hover { background: var(--bg-hover); border-color: var(--primary); color: var(--primary-text); }
.mp-primary {
  flex: 1;
  height: 36px; border-radius: 9px; font-size: 13px; font-weight: 500; cursor: pointer;
  border: 0; background: var(--primary); color: #fff;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  transition: background-color 0.15s ease, transform 0.1s ease;
}
.mp-primary:hover { background: var(--primary-dark); }
.mp-primary:active { transform: translateY(0.5px); }
</style>
