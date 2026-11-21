<template>
  <section v-if="video.length" class="video-path">
    <label>视频线路
      <select v-model="selection" aria-label="查看视频线路">
        <option value="">跟随主画面</option>
        <option v-for="s in video" :key="s.id" :value="s.id">{{ s.ownerName }} · {{ s.kind === 'screen' ? '屏幕共享' : '摄像头' }}</option>
      </select>
    </label>
    <template v-if="selected">
      <div class="im-stats-row"><span>当前线路</span><b>{{ selected.ownerName }} · {{ selected.kind === 'screen' ? '屏幕共享' : '摄像头' }}</b></div>
      <div class="im-stats-row"><span>传输策略</span><b>{{ strategy }}</b></div>
      <div v-if="selected.transportMode === 'cloud'" class="im-stats-row"><span>云端目标码率</span><b>{{ measuredRateText(selected.targetBitrateKbps) }}</b></div>
      <div class="im-stats-row"><span>原始视频码率（云端输入）</span><b>{{ measuredRateText(stats?.cloudInputKbps) }}</b></div>
      <div class="im-stats-row"><span>阿里云输出码率</span><b>{{ measuredRateText(stats?.cloudOutputKbps) }}</b></div>
      <div class="im-stats-row"><span>{{ selected.kind === 'screen' ? '屏幕' : '摄像头' }}采集帧率</span><b>{{ fpsText(stats?.captureFps) }}</b></div>
      <div class="im-stats-row"><span>浏览器发送帧率</span><b>{{ fpsText(stats?.publishFps) }}</b></div>
      <div class="im-stats-row"><span>阿里云接收帧率</span><b>{{ fpsText(stats?.cloudInputFps) }}</b></div>
      <div class="im-stats-row"><span>阿里云转发输出帧率</span><b>{{ fpsText(stats?.cloudOutputFps) }}</b></div>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { StreamVo } from '@/api/meeting'
import { fpsText, measuredRateText } from '@/utils/compression'
import { strategies } from '@/utils/videoDelivery'
const props = defineProps<{ streams: StreamVo[]; focus?: StreamVo }>()
const video = computed(() => props.streams.filter(s => s.transportMode && (s.kind === 'camera' || s.kind === 'screen')))
const selection = ref('')
watch(video, rows => { if (!rows.some(s => s.id === selection.value)) selection.value = '' })
const selected = computed(() => (selection.value ? video.value.find(s => s.id === selection.value) : props.focus))
const stats = computed(() => selected.value?.videoStats)
const strategy = computed(() => selected.value?.transportMode === 'original' ? '原始转发' :
  strategies.find(s => s.value === selected.value?.encodingStrategy)?.label ?? '云端压缩')
</script>
<style scoped>
.video-path { display: grid; gap: 6px; padding: 12px 0; border-top: 1px solid var(--el-border-color-light); }
.video-path label,.im-stats-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; }
.video-path select { max-width: 70%; padding: 4px; color: inherit; background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: 4px; }
.im-stats-row b { font-variant-numeric: tabular-nums; font-weight: 500; }
</style>
