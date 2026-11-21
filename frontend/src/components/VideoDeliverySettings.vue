<template>
  <section class="delivery" aria-label="视频传输设置">
    <h3>视频传输</h3>
    <div v-for="row in rows" :key="row.kind" class="delivery-row" :data-delivery="row.kind">
      <h4>{{ row.label }}</h4>
      <label>传输方式
        <select v-model="row.value.transportMode" :disabled="row.busy">
          <option value="original">原始转发</option><option value="cloud">阿里云软件压缩</option>
        </select>
      </label>
      <template v-if="row.value.transportMode === 'cloud'">
        <label>压缩策略
          <select v-model="row.value.encodingStrategy" :disabled="row.busy">
            <option v-for="s in strategies" :key="s.value" :value="s.value">{{ s.label }}</option>
          </select>
        </label>
        <span class="hint">{{ hints[row.value.encodingStrategy] }}</span>
        <label>云端压缩目标码率（kbps）
          <input v-model.number="row.value.targetBitrateKbps" type="number" min="20" max="6000" step="1" :disabled="row.busy" />
        </label>
      </template>
      <div class="actions">
        <el-button size="small" :loading="row.busy" @click="apply(row)">应用到{{ row.label }}</el-button>
        <span role="status">{{ row.status }}</span>
      </div>
    </div>
  </section>
</template>
<script setup lang="ts">
import { reactive } from 'vue'
import { useUserStore } from '@/store/user'
import { readDelivery, saveDelivery, strategies, type VideoDelivery, type VideoKind } from '@/utils/videoDelivery'

const props = defineProps<{ applyLive?: (kind: VideoKind, value: VideoDelivery) => Promise<boolean> }>()
const user = useUserStore()
const account = () => user.userInfo?.username || ''
const hints = {
  source_frames: '按输入帧率编码，使用设定的目标码率。',
  bandwidth_first: '按码率预算和画面复杂度调节输出帧率。',
  optimized: '自动选择 360p 或 540p，使用动态帧率、全帧 AQ 和渐进刷新。',
}
const rows = reactive((['camera', 'screen'] as const).map(kind => ({
  kind, label: kind === 'camera' ? '摄像头' : '共享屏幕', value: readDelivery(account(), kind), busy: false, status: '',
})))
async function apply(row: typeof rows[number]) {
  if (row.busy) return
  const value = { ...row.value }
  if (!Number.isInteger(value.targetBitrateKbps) || value.targetBitrateKbps < 20 || value.targetBitrateKbps > 6000) {
    row.status = '目标码率请输入 20 至 6000 的整数'; return
  }
  row.busy = true
  try {
    const live = await props.applyLive?.(row.kind, value)
    saveDelivery(account(), row.kind, value)
    row.status = live ? '已应用到当前发布' : '已保存，下次发布时生效'
  } catch { row.status = '应用失败，请重试' }
  finally { row.busy = false }
}
</script>
<style scoped>
.delivery { display: grid; gap: 12px; margin: 12px 0 18px; }
.delivery h3,.delivery h4 { margin: 0; font-size: 15px; }
.delivery-row { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--el-border-color-light); border-radius: 8px; }
.delivery-row label,.actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.delivery-row select,.delivery-row input { max-width: 100%; padding: 5px 9px; border-radius: 4px; border: 1px solid var(--el-border-color); color: inherit; background: var(--el-bg-color); }
.hint,.actions span { font-size: 12px; color: var(--el-text-color-secondary); }
</style>
