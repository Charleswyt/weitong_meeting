<template>
  <!-- 共享中独立控制条（带预览、暂停/恢复、一步切换共享、收起为胶囊、停止共享） -->
  <div
    v-if="sharing"
    class="ssp-live"
    :class="{ 'is-collapsed': collapsed, 'is-paused': paused }"
    role="status"
  >
    <template v-if="collapsed">
      <span class="ssp-live-dot" />
      <span class="ssp-live-mini-text">{{ paused ? '共享已暂停' : '正在共享屏幕' }}</span>
      <button type="button" class="ssp-live-btn" @click="collapsed = false" title="展开控制面板">
        <i class="ri-arrow-down-s-line" />
      </button>
      <button type="button" class="ssp-live-stop" @click="emit('stop')">停止</button>
    </template>

    <template v-else>
      <div class="ssp-live-preview">
        <video
          v-if="stream"
          class="ssp-live-video"
          autoplay
          playsinline
          muted
          :srcObject="stream"
        />
        <i v-else class="ri-computer-line" />
        <span v-if="paused" class="ssp-live-paused-tag">已暂停</span>
      </div>

      <div class="ssp-live-info">
        <div class="ssp-live-title">
          <span class="ssp-live-dot" />
          <b>{{ paused ? '屏幕共享已暂停' : '正在共享屏幕' }}</b>
          <span v-if="specLabel" class="ssp-live-spec">{{ specLabel }}</span>
        </div>
        <div class="ssp-live-sub">{{ trackLabel }}</div>
      </div>

      <div class="ssp-live-actions">
        <button
          type="button"
          class="ssp-live-btn"
          :class="{ active: paused }"
          @click="togglePause"
        >
          <i :class="paused ? 'ri-play-circle-line' : 'ri-pause-circle-line'" />
          <span>{{ paused ? '恢复共享' : '暂停共享' }}</span>
        </button>
        <button
          type="button"
          class="ssp-live-btn"
          @click="emit('switch')"
        >
          <i class="ri-exchange-line" />
          <span>切换</span>
        </button>
        <button type="button" class="ssp-live-stop" @click="emit('stop')">
          <i class="ri-stop-circle-line" />
          <span>停止共享</span>
        </button>
        <button
          type="button"
          class="ssp-live-collapse"
          title="收起面板"
          @click="collapsed = true"
        >
          <i class="ri-subtract-line" />
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  sharing: boolean
  stream: MediaStream | null
}>()

const emit = defineEmits<{
  (e: 'switch'): void
  (e: 'stop'): void
}>()

const paused = ref(false)
const collapsed = ref(false)

watch(
  () => props.sharing,
  (on) => {
    if (!on) {
      paused.value = false
      collapsed.value = false
    }
  },
)

const trackLabel = computed(() => {
  const label = props.stream?.getVideoTracks()[0]?.label || ''
  return label ? label.slice(0, 48) : '你的屏幕画面已推送给参会者'
})

const specLabel = computed(() => {
  const s = props.stream?.getVideoTracks()[0]?.getSettings?.()
  if (!s?.width || !s?.height) return ''
  const fps = s.frameRate ? ` · ${Math.round(s.frameRate)}fps` : ''
  const audio = props.stream?.getAudioTracks().length ? ' · 含声音' : ''
  return `${s.width}×${s.height}${fps}${audio}`
})

function togglePause() {
  const tracks = props.stream?.getVideoTracks() || []
  if (!tracks.length) return
  paused.value = !paused.value
  tracks.forEach((t) => {
    t.enabled = !paused.value
  })
}
</script>

<style scoped>
.ssp-live {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 12px 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.32);
  color: #f8fafc;
  backdrop-filter: blur(10px);
}
.ssp-live.is-collapsed {
  align-self: center;
  padding: 6px 12px;
  border-radius: 999px;
}
.ssp-live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.25);
  flex-shrink: 0;
}
.ssp-live.is-paused .ssp-live-dot {
  background: #f59e0b;
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.25);
}
.ssp-live-mini-text {
  font-size: 12.5px;
  font-weight: 600;
}
.ssp-live-preview {
  position: relative;
  width: 76px;
  height: 44px;
  border-radius: 8px;
  overflow: hidden;
  background: #020617;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.ssp-live-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.ssp-live-paused-tag {
  position: absolute;
  inset: 0;
  background: rgba(15, 23, 42, 0.72);
  color: #fbbf24;
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ssp-live-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ssp-live-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
}
.ssp-live-spec {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.1);
  color: #cbd5e1;
  font-variant-numeric: tabular-nums;
}
.ssp-live-sub {
  font-size: 12px;
  color: #94a3b8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ssp-live-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.ssp-live-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 11px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: rgba(255, 255, 255, 0.08);
  color: #f1f5f9;
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.16s ease, border-color 0.16s ease;
}
.ssp-live-btn:hover {
  background: rgba(255, 255, 255, 0.16);
}
.ssp-live-btn.active {
  border-color: rgba(251, 191, 36, 0.55);
  background: rgba(245, 158, 11, 0.22);
  color: #fde68a;
}
.ssp-live-stop {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 13px;
  border-radius: 8px;
  border: none;
  background: #ef4444;
  color: #fff;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
.ssp-live-stop:hover {
  background: #dc2626;
}
.ssp-live-collapse {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: #94a3b8;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.ssp-live-collapse:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

@media (max-width: 767px) {
  .ssp-live {
    flex-wrap: wrap;
    gap: 8px;
  }
  .ssp-live-preview {
    display: none;
  }
}
</style>
