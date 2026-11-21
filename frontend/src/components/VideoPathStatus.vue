<template>
  <section v-if="reading" class="video-path" aria-label="视频线路状态">
    <label class="line-selector"><strong>视频线路</strong>
      <select :value="modelValue" aria-label="查看视频线路" @change="selectLine">
        <option value="">跟随主画面</option>
        <option v-for="s in streams" :key="s.id" :value="s.id">{{ s.ownerName }} · {{ s.kind === 'screen' ? '屏幕共享' : '摄像头' }}</option>
      </select>
    </label>
    <div class="line-heading"><b>{{ reading.name }}</b><span>{{ reading.own ? '本机预览' : '远端画面' }}</span></div>
    <VideoLineRates :reading="reading" />
    <p v-if="reading.compression.applicable" class="basis">{{ reading.compression.basisText }}</p>
    <dl class="detail">
      <dt>传输策略</dt><dd>{{ strategy }}</dd>
      <template v-if="reading.mode === 'cloud'"><dt>云端目标码率</dt><dd>{{ measuredRateText(reading.target) }}</dd></template>
      <dt>采集帧率</dt><dd>{{ fpsText(reading.stats.captureFps) }}</dd>
      <dt>浏览器发送帧率</dt><dd>{{ fpsText(reading.stats.publishFps) }}</dd>
      <dt>阿里云接收帧率</dt><dd>{{ fpsText(reading.stats.cloudInputFps) }}</dd>
      <dt>阿里云输出帧率</dt><dd>{{ fpsText(reading.stats.cloudOutputFps) }}</dd>
      <dt>观看连接</dt><dd data-rate="viewers">{{ reading.stats.viewerCount ?? '—' }}</dd>
      <dt title="该线路向所有观看端实际发送的合计速率">公网媒体下行</dt><dd data-rate="egress">{{ measuredRateText(reading.stats.publicEgressKbps) }}</dd>
    </dl>
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import type { StreamVo } from '@/api/meeting'
import { fpsText, measuredRateText } from '@/utils/compression'
import { strategies, type VideoLineReading } from '@/utils/videoDelivery'
import VideoLineRates from './VideoLineRates.vue'
const props = defineProps<{ streams: StreamVo[]; modelValue: string; reading?: VideoLineReading }>()
const emit = defineEmits<{ (e: 'update:modelValue', id: string): void }>()
function selectLine(event: Event) { emit('update:modelValue', (event.target as HTMLSelectElement).value) }
const strategy = computed(() => props.reading?.mode === 'original' ? '原始转发' : strategies.find(s => s.value === props.reading?.strategy)?.label ?? '云端压缩')
</script>
<style scoped>
.video-path { display: grid; gap: 10px; padding: 14px 0; border-top: 1px solid var(--border-color); font-size: 13px; color: var(--text-primary); }
.line-selector,.line-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.line-selector select { max-width: 65%; min-width: 0; border: 1px solid var(--border-color); border-radius: 8px; color: inherit; background: var(--bg-input); padding: 5px 8px; font: inherit; }
.line-heading { flex-wrap: wrap; }
.line-heading span,.basis { color: var(--text-muted); font-size: 12px; }
.basis { margin: 0; line-height: 1.5; }
.detail { display: grid; grid-template-columns: 1fr auto; gap: 6px 8px; margin: 0; padding-top: 10px; border-top: 1px solid var(--border-color); }
.detail dt { color: var(--text-secondary); }
.detail dd { margin: 0; font-variant-numeric: tabular-nums; text-align: right; }
</style>
