<template>
  <div class="delivery" :data-delivery="kind" aria-label="视频传输设置">
    <div class="delivery-top">
      <div class="source-switch" role="group" aria-label="配置的视频源">
        <button
          v-for="source in rows"
          :key="source.kind"
          type="button"
          :data-source="source.kind"
          :aria-pressed="source.kind === kind"
          @click="kind = source.kind"
        >
          {{ source.label }}
        </button>
      </div>
      <div class="actions">
        <span role="status">{{ row.status }}</span>
        <el-button
          type="primary"
          size="default"
          :loading="row.busy"
          :disabled="!account"
          @click="apply(row)"
          >应用设置</el-button
        >
      </div>
    </div>
    <div class="delivery-fields">
      <label class="field"
        ><span
          >传输方式<small>{{
            row.value.transportMode === "original"
              ? "直接转发原始画面，延迟最低；若带宽受限可切至压缩转发。"
              : "由云端按目标码率与策略二次压缩，节省下行带宽。"
          }}</small></span
        >
        <select
          v-model="row.value.transportMode"
          data-field="mode"
          :disabled="row.busy"
          @change="row.status = ''"
        >
          <option value="original">原始转发</option>
          <option value="cloud">压缩转发</option>
        </select>
      </label>
      <template v-if="row.value.transportMode === 'cloud'">
        <label class="field"
          ><span
            >压缩策略<small>{{ hints[row.value.encodingStrategy] }}</small></span
          >
          <select
            v-model="row.value.encodingStrategy"
            data-field="strategy"
            :disabled="row.busy"
            @change="row.status = ''"
          >
            <option v-for="s in strategies" :key="s.value" :value="s.value">
              {{ s.label }}
            </option>
          </select>
        </label>
        <label class="field"
          ><span>云端目标码率<small>20 至 6000 kbps</small></span>
          <span class="bitrate"
            ><input
              v-model.number="row.value.targetBitrateKbps"
              data-field="target"
              type="number"
              min="20"
              max="6000"
              step="1"
              :disabled="row.busy"
              @input="row.status = ''"
            /><span>kbps</span></span
          >
        </label>
      </template>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useUserStore } from "@/store/user";
import {
  readDelivery,
  saveDelivery,
  strategies,
  type VideoDelivery,
  type VideoKind,
} from "@/utils/videoDelivery";

const props = defineProps<{
  applyLive?: (kind: VideoKind, value: VideoDelivery) => Promise<boolean>;
}>();
const user = useUserStore();
const account = computed(() => user.userInfo?.username || "");
const hints = {
  source_frames: "保留输入帧率。",
  bandwidth_first: "随带宽预算和画面复杂度调整帧率。",
  optimized: "自动调整分辨率、帧率和画面质量。",
};
const kind = ref<VideoKind>("camera");
const rows = reactive(
  (["camera", "screen"] as const).map((kind) => ({
    kind,
    label: kind === "camera" ? "摄像头" : "共享屏幕",
    value: readDelivery(account.value, kind),
    busy: false,
    status: "",
  })),
);
watch(account, (name) => {
  for (const source of rows) {
    source.value = readDelivery(name, source.kind);
    source.status = "";
  }
});
const row = computed(() => rows.find((r) => r.kind === kind.value)!);
async function apply(row: (typeof rows)[number]) {
  const name = account.value;
  if (!name || row.busy) return;
  const value = { ...row.value };
  if (
    !Number.isInteger(value.targetBitrateKbps) ||
    value.targetBitrateKbps < 20 ||
    value.targetBitrateKbps > 6000
  ) {
    if (value.transportMode === "cloud") {
      row.status = "请输入 20 至 6000 的整数";
      return;
    }
    value.targetBitrateKbps = readDelivery(name, row.kind).targetBitrateKbps;
  }
  row.busy = true;
  try {
    const live = await props.applyLive?.(row.kind, value);
    saveDelivery(name, row.kind, value);
    row.value.targetBitrateKbps = value.targetBitrateKbps;
    row.status = live ? "已应用到当前发布" : "已保存，下次发布时生效";
  } catch {
    row.status = "应用失败，请重试";
  } finally {
    row.busy = false;
  }
}
</script>
<style scoped>
.delivery {
  color: var(--text-primary);
  font-size: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.delivery-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
}
.delivery-fields {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border-soft);
}
.source-switch {
  display: inline-flex;
  padding: 3px;
  gap: 2px;
  border-radius: 10px;
  background: var(--bg-input);
}
.source-switch button {
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font: inherit;
  padding: 6px 16px;
}
.source-switch button[aria-pressed="true"] {
  color: var(--primary);
  background: var(--bg-card);
  font-weight: 600;
}
.field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
}
.field > span:first-child {
  font-weight: 600;
}
.field small {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
  line-height: 1.5;
}
.field select,
.bitrate {
  box-sizing: border-box;
  width: min(43%, 260px);
  height: 42px;
  padding: 0 12px;
  border: 1px solid var(--border-color);
  border-radius: 11px;
  color: var(--text-primary);
  background: var(--bg-input);
  font: inherit;
}
.bitrate {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
}
.bitrate input {
  min-width: 0;
  flex: 1;
  background: transparent;
  border: 0;
  color: var(--text-primary);
  font: inherit;
}
.bitrate:focus-within,
select:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
.actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 12px;
  padding: 8px 0;
}
.actions [role="status"] {
  font-size: 12px;
  color: var(--text-secondary);
}
</style>
