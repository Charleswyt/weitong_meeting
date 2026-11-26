<template>
  <div class="gs-wrap" :class="{ 'is-compact': !!meetingId }">
    <!-- 顶部说明与操作栏 -->
    <div class="gs-top">
      <div class="gs-top-info">
        <p class="gs-desc">
          标准词和别名用于校正语音识别发言，再生成译文。{{
            meetingId ? '此处的设置仅适用于本场会议。' : '此词库默认用于你主持的会议。'
          }}
        </p>
        <div class="gs-stats">
          <span class="gs-stat-pill">
            <i class="ri-book-mark-line" />
            {{ termList.length }} 条标准词
          </span>
          <span v-if="totalAliases" class="gs-stat-pill">
            <i class="ri-price-tag-3-line" />
            {{ totalAliases }} 个别名
          </span>
        </div>
      </div>

      <div class="gs-top-actions">
        <button
          v-if="termList.length"
          type="button"
          class="gs-btn gs-btn--ghost"
          title="导出当前术语库为 JSON"
          @click="exportJson"
        >
          <i class="ri-download-2-line" />
          <span>导出 JSON</span>
        </button>
        <label v-if="editable" class="gs-btn gs-btn--primary" title="支持导入 CSV 或 JSON 格式词库">
          <i class="ri-upload-cloud-2-line" />
          <span>导入 CSV / JSON</span>
          <input type="file" accept=".csv,.json" class="gs-hidden-input" @change="importFile" />
        </label>
      </div>
    </div>

    <!-- 错误提示 -->
    <div v-if="error" class="gs-error" role="alert">
      <i class="ri-error-warning-line" />
      <span>{{ error }}</span>
    </div>

    <!-- 搜索过滤（词条较多时显示） -->
    <div v-if="termList.length >= 4" class="gs-search">
      <i class="ri-search-line gs-search-ic" />
      <input
        v-model.trim="keyword"
        type="text"
        class="gs-search-input"
        placeholder="搜索标准词或别名…"
        aria-label="搜索术语"
      />
      <button
        v-if="keyword"
        type="button"
        class="gs-search-clear"
        title="清空搜索"
        @click="keyword = ''"
      >
        <i class="ri-close-circle-fill" />
      </button>
    </div>

    <!-- 术语列表 -->
    <div v-if="termList.length" class="gs-table">
      <div class="gs-table-head">
        <span class="gs-col-term">标准词</span>
        <span class="gs-col-alias">识别别名 / 常见误识</span>
      </div>

      <div v-if="filteredList.length" class="gs-table-body">
        <div v-for="[term, aliases] in filteredList" :key="term" class="gs-row">
          <div class="gs-col-term">
            <span class="gs-term-badge">{{ term }}</span>
          </div>
          <div class="gs-col-alias">
            <template v-if="aliases.length">
              <span v-for="a in aliases" :key="a" class="gs-alias-chip">{{ a }}</span>
            </template>
            <span v-else class="gs-empty-alias">无别名</span>
          </div>
        </div>
      </div>

      <div v-else class="gs-no-match">
        <i class="ri-search-eye-line" />
        <span>未找到包含「{{ keyword }}」的术语</span>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="gs-empty">
      <div class="gs-empty-ic"><i class="ri-book-2-line" /></div>
      <div class="gs-empty-text">
        <strong>暂未配置专业术语</strong>
        <p>{{ editable ? '点击「导入 CSV / JSON」上传行业词汇与常见误识映射，提升识别与翻译准确度。' : '主持人暂未为本场会议配置术语库。' }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { assistantRequest, jsonBody } from '@/api/assistant'

const props = withDefaults(defineProps<{ meetingId?: number; number?: string; editable?: boolean }>(), {
  editable: true,
})

const terms = ref<Record<string, string[]>>({})
const error = ref('')
const keyword = ref('')

const termList = computed(() => Object.entries(terms.value || {}))
const totalAliases = computed(() => termList.value.reduce((sum, [, aliases]) => sum + aliases.length, 0))
const filteredList = computed(() => {
  const q = keyword.value.toLowerCase()
  if (!q) return termList.value
  return termList.value.filter(
    ([term, aliases]) =>
      term.toLowerCase().includes(q) || aliases.some((a) => a.toLowerCase().includes(q)),
  )
})

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
      terms.value = result.terms || {}
      error.value = ''
    }
  } catch (e) {
    error.value = (e as Error).message
  }
}

watch(() => [props.meetingId, props.number], load, { immediate: true })

async function importFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
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

function exportJson() {
  const blob = new Blob([JSON.stringify(terms.value, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = props.meetingId ? `术语库-${props.number || props.meetingId}.json` : '转录翻译术语库.json'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
</script>

<style scoped>
.gs-wrap {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ── Top bar ── */
.gs-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}
.gs-top-info {
  flex: 1;
  min-width: 220px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.gs-desc {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-muted, var(--el-text-color-secondary));
}
.gs-stats {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.gs-stat-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  background: var(--bg-hover, var(--el-fill-color));
  color: var(--text-secondary, var(--el-text-color-regular));
}
.gs-stat-pill i {
  font-size: 13px;
  color: var(--primary-text, var(--primary, #165dff));
}

.gs-top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.gs-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  padding: 0 13px;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.16s;
}
.gs-btn--primary {
  border: 0;
  background: var(--primary, #165dff);
  color: #fff;
  box-shadow: 0 2px 8px rgba(22, 93, 255, 0.22);
}
.gs-btn--primary:hover {
  background: var(--primary-dark, #1350e0);
}
.gs-btn--ghost {
  border: 1px solid var(--border-color, var(--el-border-color));
  background: var(--bg-input, var(--el-fill-color-light));
  color: var(--text-primary, var(--el-text-color-primary));
  font-weight: 500;
}
.gs-btn--ghost:hover {
  border-color: var(--primary, #165dff);
  color: var(--primary-text, var(--primary, #165dff));
}
.gs-hidden-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

/* ── Error ── */
.gs-error {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 12px;
  border-radius: 9px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.24);
  color: #ef4444;
  font-size: 12.5px;
}

/* ── Search ── */
.gs-search {
  position: relative;
  display: flex;
  align-items: center;
}
.gs-search-ic {
  position: absolute;
  left: 11px;
  font-size: 15px;
  color: var(--text-muted, var(--el-text-color-placeholder));
  pointer-events: none;
}
.gs-search-input {
  width: 100%;
  height: 36px;
  padding: 0 32px 0 34px;
  border-radius: 9px;
  border: 1px solid var(--border-color, var(--el-border-color));
  background: var(--bg-input, var(--el-fill-color-light));
  color: var(--text-primary, var(--el-text-color-primary));
  font-size: 13px;
  outline: none;
  transition: border-color 0.16s, box-shadow 0.16s;
}
.gs-search-input:focus {
  border-color: var(--primary, #165dff);
  box-shadow: 0 0 0 2px rgba(22, 93, 255, 0.12);
}
.gs-search-input::placeholder {
  color: var(--text-muted, var(--el-text-color-placeholder));
}
.gs-search-clear {
  position: absolute;
  right: 8px;
  border: 0;
  background: transparent;
  color: var(--text-muted, var(--el-text-color-placeholder));
  cursor: pointer;
  font-size: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
}
.gs-search-clear:hover {
  color: var(--text-primary, var(--el-text-color-primary));
}

/* ── Table ── */
.gs-table {
  border-radius: 11px;
  border: 1px solid var(--border-color, var(--el-border-color-lighter));
  background: var(--bg-card, var(--el-bg-color));
  overflow: hidden;
}
.gs-table-head {
  display: grid;
  grid-template-columns: minmax(110px, 160px) 1fr;
  gap: 12px;
  padding: 9px 14px;
  background: var(--bg-input, var(--el-fill-color-light));
  border-bottom: 1px solid var(--border-color, var(--el-border-color-lighter));
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted, var(--el-text-color-secondary));
}
.gs-table-body {
  max-height: 360px;
  overflow-y: auto;
}
.gs-wrap.is-compact .gs-table-head {
  grid-template-columns: minmax(90px, 125px) 1fr;
  padding: 7px 11px;
}
.gs-wrap.is-compact .gs-table-body {
  max-height: 220px;
}
.gs-wrap.is-compact .gs-row {
  grid-template-columns: minmax(90px, 125px) 1fr;
  padding: 9px 11px;
}

.gs-row {
  display: grid;
  grid-template-columns: minmax(110px, 160px) 1fr;
  gap: 12px;
  align-items: center;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-soft, var(--el-border-color-lighter));
  transition: background 0.14s;
}
.gs-row:last-child {
  border-bottom: 0;
}
.gs-row:hover {
  background: var(--bg-hover, var(--el-fill-color-lighter));
}

.gs-col-term {
  min-width: 0;
}
.gs-term-badge {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 3px 9px;
  border-radius: 7px;
  background: var(--primary-soft, rgba(22, 93, 255, 0.1));
  color: var(--primary-text, var(--primary, #165dff));
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  word-break: break-word;
}

.gs-col-alias {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.gs-alias-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 1.45;
  background: var(--bg-input, var(--el-fill-color-light));
  border: 1px solid var(--border-color, var(--el-border-color-lighter));
  color: var(--text-secondary, var(--el-text-color-regular));
}
.gs-empty-alias {
  font-size: 12px;
  color: var(--text-muted, var(--el-text-color-placeholder));
}

.gs-no-match {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 24px 14px;
  font-size: 13px;
  color: var(--text-muted, var(--el-text-color-secondary));
}

/* ── Empty State ── */
.gs-empty {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 20px 18px;
  border-radius: 11px;
  border: 1px dashed var(--border-color, var(--el-border-color));
  background: var(--bg-input, var(--el-fill-color-light));
}
.gs-empty-ic {
  width: 42px;
  height: 42px;
  border-radius: 11px;
  background: var(--bg-card, var(--el-bg-color));
  border: 1px solid var(--border-color, var(--el-border-color-lighter));
  color: var(--primary, #165dff);
  font-size: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.gs-empty-text strong {
  display: block;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-primary, var(--el-text-color-primary));
  margin-bottom: 3px;
}
.gs-empty-text p {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-muted, var(--el-text-color-secondary));
}

@media (max-width: 560px) {
  .gs-table-head,
  .gs-row {
    grid-template-columns: 1fr;
    gap: 6px;
  }
  .gs-table-head .gs-col-alias {
    display: none;
  }
}
</style>
