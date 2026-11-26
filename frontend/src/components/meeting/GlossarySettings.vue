<template>
  <p>
    标准词和别名用于校正发言，再生成译文。{{
      meetingId ? '此处的设置适用于本场会议。' : '此词库用于你主持的会议。'
    }}
  </p>
  <label v-if="editable"
    >导入 CSV 或 JSON 词库 <input type="file" accept=".csv,.json" @change="importFile"
  /></label>
  <p v-if="error" role="alert">{{ error }}</p>
  <dl>
    <template v-for="(aliases, term) in terms" :key="term"
      ><dt>{{ term }}</dt>
      <dd>{{ aliases.join('、') || '—' }}</dd></template
    >
  </dl>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { assistantRequest, jsonBody } from '@/api/assistant'
const props = withDefaults(defineProps<{ meetingId?: number; number?: string; editable?: boolean }>(), {
  editable: true,
})
const terms = ref<Record<string, string[]>>({}),
  error = ref('')
async function load() {
  const id = props.meetingId
  try {
    const response = await assistantRequest(
      id ? 'meetings/' + id + '/state' : 'settings/glossary',
      {},
      props.number,
    )
    const result = await response.json()
    if (id === props.meetingId) {
      terms.value = result.terms
      error.value = ''
    }
  } catch (e) {
    error.value = (e as Error).message
  }
}
watch(() => [props.meetingId, props.number], load, { immediate: true })
async function importFile(e: Event) {
  const input = e.target as HTMLInputElement,
    file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const text = await file.text()
    await assistantRequest(
      props.meetingId ? 'meetings/' + props.meetingId + '/terms' : 'settings/glossary',
      jsonBody('PUT', { terms: file.name.toLowerCase().endsWith('.json') ? JSON.parse(text) : text }),
      props.number,
    )
    await load()
    ElMessage.success('术语库已更新')
  } catch (e) {
    error.value = (e as Error).message
  }
}
</script>
<style scoped>
p,
label,
dl {
  font-size: 14px;
  line-height: 1.5;
}
dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 14px;
}
dt {
  font-weight: 600;
}
dd {
  margin: 0;
  color: var(--el-text-color-secondary);
}
</style>
