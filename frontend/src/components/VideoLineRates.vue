<template>
  <dl class="line-rates" :class="{ compact }">
    <dt title="发布端逐帧统计解码后可见画面的字节数">解码后原始速率</dt><dd data-rate="decoded">{{ reading.compression.rawText }}</dd>
    <dt>发布端视频上行</dt><dd data-rate="publish">{{ measuredRateText(reading.stats.publishKbps) }}</dd>
    <dt>云端视频接收</dt><dd>{{ measuredRateText(reading.stats.cloudInputKbps) }}</dd>
    <dt>云端视频输出</dt><dd data-rate="output">{{ measuredRateText(reading.stats.cloudOutputKbps) }}</dd>
    <template v-if="!reading.own"><dt>本端视频实收</dt><dd data-rate="received">{{ measuredRateText(reading.received) }}</dd></template>
    <dt :title="reading.compression.basisText">压缩比</dt><dd data-rate="ratio" class="ratio" :title="reading.compression.basisText">{{ reading.compression.ratioText }}</dd>
    <template v-if="reading.compression.applicable"><dt>节省带宽</dt><dd>{{ reading.compression.savedText.replace(/^节省\s*/, '') }}</dd></template>
  </dl>
</template>
<script setup lang="ts">
import type { VideoLineReading } from '@/utils/videoDelivery'
import { measuredRateText } from '@/utils/compression'
defineProps<{ reading: VideoLineReading; compact?: boolean }>()
</script>
<style scoped>
.line-rates { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: baseline; gap: 7px 8px; margin: 0; font-size: 13px; line-height: 1.45; }
dt { color: var(--text-secondary); }
dd { margin: 0; text-align: right; color: var(--text-primary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ratio { font-weight: 650; color: var(--primary); }
.compact { font-size: 12px; gap: 5px 4px; }
</style>
