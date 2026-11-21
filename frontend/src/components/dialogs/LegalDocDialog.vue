<template>
  <div v-if="modelValue" class="legal-mask" @click.self="close">
    <div
      class="legal-panel"
      role="dialog"
      aria-modal="true"
      :style="panelVars"
    >
      <header class="legal-head">
        <h3>{{ doc.title }}</h3>
        <div class="legal-toolbar">
          <button
            type="button"
            class="legal-tool"
            :disabled="fontStep <= 0"
            :title="locale === 'zh' ? '缩小字体' : 'Decrease font size'"
            @click="shrinkFont"
          >
            <i class="ri-font-size-2" />
            <span>A−</span>
          </button>
          <button
            type="button"
            class="legal-tool"
            :disabled="fontStep >= maxFontStep"
            :title="locale === 'zh' ? '放大字体' : 'Increase font size'"
            @click="growFont"
          >
            <i class="ri-font-size" />
            <span>A+</span>
          </button>
          <button
            type="button"
            class="legal-tool legal-lang"
            :title="locale === 'zh' ? 'Switch to English' : '切换为中文'"
            @click="toggleLocale"
          >
            {{ locale === 'zh' ? 'EN' : '中文' }}
          </button>
          <button type="button" class="legal-close" :title="ui.close" @click="close">
            <i class="ri-close-line" />
          </button>
        </div>
      </header>
      <p class="legal-updated">{{ ui.updated }}{{ doc.updatedAt }}</p>
      <div class="legal-body">
        <section v-for="(s, i) in doc.sections" :key="i" class="legal-section">
          <h4>{{ s.heading }}</h4>
          <p v-for="(p, j) in s.paragraphs" :key="j">{{ p }}</p>
        </section>
      </div>
      <footer class="legal-foot">
        <button type="button" class="legal-ok" @click="close">{{ ui.ok }}</button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getLegalDoc, type LegalDocId, type LegalLocale } from '@/data/legal'

const props = defineProps<{ modelValue: boolean; docId: LegalDocId }>()
const emit = defineEmits<{ 'update:modelValue': [boolean] }>()

/** 基准已比原先大 1 号；再点放大最多 +3 号 */
const maxFontStep = 3
const fontStep = ref(0)
const locale = ref<LegalLocale>('zh')

const doc = computed(() => getLegalDoc(props.docId, locale.value))

const ui = computed(() =>
  locale.value === 'zh'
    ? { updated: '更新日期：', ok: '我知道了', close: '关闭' }
    : { updated: 'Updated: ', ok: 'Got it', close: 'Close' },
)

const panelVars = computed(() => ({
  '--legal-title': `${19 + fontStep.value}px`,
  '--legal-h': `${15 + fontStep.value}px`,
  '--legal-p': `${14 + fontStep.value}px`,
  '--legal-meta': `${13 + fontStep.value}px`,
}))

function growFont() {
  if (fontStep.value < maxFontStep) fontStep.value += 1
}

function shrinkFont() {
  if (fontStep.value > 0) fontStep.value -= 1
}

function toggleLocale() {
  locale.value = locale.value === 'zh' ? 'en' : 'zh'
}

function close() {
  emit('update:modelValue', false)
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      fontStep.value = 0
      locale.value = 'zh'
    }
  },
)
</script>

<style scoped>
.legal-mask {
  position: fixed;
  inset: 0;
  z-index: 1200;
  background: rgba(15, 23, 42, 0.55);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  animation: legalMaskIn 0.22s ease both;
}
.legal-panel {
  width: min(720px, 100%);
  max-height: min(80vh, 720px);
  background: var(--bg-card);
  color: var(--text-primary);
  border-radius: 16px;
  border: 1px solid var(--border-color);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.28);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: legalPanelIn 0.28s ease both;
}
.legal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 16px 8px 20px;
}
.legal-head h3 {
  font-size: var(--legal-title, 19px);
  font-weight: 650;
  min-width: 0;
  flex: 1;
  line-height: 1.35;
}
.legal-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.legal-tool {
  height: 32px;
  min-width: 36px;
  padding: 0 10px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-soft);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.legal-tool i {
  font-size: 14px;
}
.legal-tool:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.legal-tool:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}
.legal-lang {
  min-width: 44px;
  color: var(--primary-text);
  border-color: color-mix(in srgb, var(--primary) 35%, var(--border-color));
}
.legal-close {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 18px;
}
.legal-close:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.legal-updated {
  padding: 0 20px 12px;
  font-size: var(--legal-meta, 13px);
  color: var(--text-muted);
}
.legal-body {
  padding: 0 20px 16px;
  overflow: auto;
  flex: 1;
}
.legal-section {
  margin-bottom: 16px;
}
.legal-section h4 {
  font-size: var(--legal-h, 15px);
  font-weight: 650;
  margin-bottom: 8px;
}
.legal-section p {
  font-size: var(--legal-p, 14px);
  line-height: 1.75;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.legal-foot {
  padding: 12px 20px 18px;
  border-top: 1px solid var(--border-soft);
  display: flex;
  justify-content: flex-end;
}
.legal-ok {
  border: none;
  border-radius: 10px;
  padding: 8px 18px;
  background: var(--primary);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
@keyframes legalMaskIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes legalPanelIn {
  from { opacity: 0; transform: translateY(10px) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
</style>
