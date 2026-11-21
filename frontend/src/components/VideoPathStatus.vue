<template>
  <section class="video-path" aria-label="视频压缩">
    <label class="line-selector"><strong>视频线路</strong>
      <select :value="modelValue" aria-label="查看视频线路" @change="selectLine">
        <option value="">跟随主画面</option>
        <option v-for="s in streams" :key="s.id" :value="s.id">{{ lineName(s) }}</option>
      </select>
    </label>
    <div class="line-heading">{{ lineName(selected) }}</div>
    <div class="line-result">
      <span>云端压缩比</span>
      <strong data-rate="ratio">{{ cloudCompressionText(selected.transportMode, selected.compressionRatio) }}</strong>
    </div>
  </section>
</template>
<script setup lang="ts">
import type { StreamVo } from '@/api/meeting'
import { cloudCompressionText } from '@/utils/compression'
const props = defineProps<{ streams: StreamVo[]; selected: StreamVo; modelValue: string; selfId: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', id: string): void }>()
function lineName(s: StreamVo) {
  return (s.ownerId === props.selfId ? '我' : s.ownerName) + ' · ' + (s.kind === 'screen' ? '屏幕共享' : '摄像头')
}
function selectLine(event: Event) { emit('update:modelValue', (event.target as HTMLSelectElement).value) }
</script>
<style scoped>
.video-path { display: grid; gap: 10px; padding: 14px 0; border-top: 1px solid var(--border-color); font-size: 13px; color: var(--text-primary); }
.line-selector, .line-result { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.line-selector select { max-width: 65%; min-width: 0; border: 1px solid var(--border-color); border-radius: 8px; color: inherit; background: var(--bg-input); padding: 5px 8px; font: inherit; }
.line-heading { color: var(--text-secondary); }
.line-result strong { color: var(--primary); font-variant-numeric: tabular-nums; }
</style>
