<template>
  <el-dialog
    :model-value="modelValue"
    title="版本更新日志"
    width="560px"
    class="vd-dialog"
    align-center
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <!-- 头部只放"现在是什么版本"，历史版本在下面按倒序排；
         不在这里重复列条目 —— 最新那一版在列表里已经默认展开了。 -->
    <div class="vd-head">
      <div class="vd-head-main">
        <span class="vd-current">当前版本 {{ current.version }}</span>
        <!-- 发布日期与构建时间必须是**同一种短横线格式**（`2026-10-14` / `2026-11-13 08:31`）。
             一处斜杠一处短横，读起来像两个来源的数据。 -->
        <span class="vd-date">{{ businessDayKey(current.date) }}</span>
      </div>
      <span v-if="buildDate" class="vd-build">构建于 {{ buildDate }}</span>
      <span v-else class="vd-build vd-dev">开发态（未注入构建信息）</span>
    </div>

    <div class="vd-body">
      <div v-for="(rel, i) in releases" :key="rel.version" class="vd-release">
        <button
          class="vd-release-head"
          :class="{ open: isOpen(rel) }"
          type="button"
          @click="toggle(rel)"
        >
          <i class="vd-caret" :class="isOpen(rel) ? 'ri-arrow-down-s-line' : 'ri-arrow-right-s-line'" />
          <span class="vd-version">{{ rel.version }}</span>
          <span class="vd-release-date">{{ businessDayKey(rel.date) }}</span>
          <span v-if="i === 0" class="vd-badge">当前</span>
        </button>

        <div v-if="isOpen(rel)" class="vd-items">
          <!-- 无记录版本必须显式说出来：跳过它会让版本号看起来像跳号，
               用户会以为自己漏装了某一版。 -->
          <p v-if="!rel.items.length" class="vd-empty">该版本无更新日志记录</p>
          <ul v-else class="vd-list">
            <li v-for="(item, k) in rel.items" :key="k" class="vd-item">{{ item }}</li>
          </ul>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { CHANGELOG, currentRelease, type Release } from '@/data/changelog'
import { businessDayKey, dashDateTime } from '@/utils/time'

defineProps<{ modelValue: boolean }>()
defineEmits<{ 'update:modelValue': [boolean] }>()

const releases = CHANGELOG
const current = currentRelease()

/**
 * 构建时间只能在构建期注入（源码里没有"什么时候打的包"这个事实）。
 * 拿不到就说"开发态"，不显示空值、也不编一个日期 —— 一个假日期比没有更糟。
 * 注入点在 vite.config.ts 的 define，值来自镜像构建的 --build-arg。
 *
 * ⚠ 注入的是 **ISO UTC 串**（`2026-11-13T00:13:34Z`），必须过 `formatDateTime` 转业务时区
 * 再上桌：直接摆 UTC 串，08:13 打的包会显示成 00:13 —— 差 8 小时，用户会以为是别的时间。
 */
const buildDate = dashDateTime(import.meta.env.VITE_BUILD_DATE)

// 只展开最新一版；其余默认收起，11 个版本平铺会把弹窗撑成一整页。
const openSet = ref<Set<string>>(new Set([current.version]))
function isOpen(rel: Release) {
  return openSet.value.has(rel.version)
}
function toggle(rel: Release) {
  const next = new Set(openSet.value)
  if (next.has(rel.version)) next.delete(rel.version)
  else next.add(rel.version)
  openSet.value = next
}
</script>

<style scoped>
.vd-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 4px 2px 16px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border-soft);
}

.vd-head-main {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.vd-current {
  font-size: 15px;
  font-weight: 650;
  color: var(--text-primary);
}

.vd-date {
  font-size: 12px;
  color: var(--text-secondary);
}

.vd-build {
  font-size: 12px;
  color: var(--text-secondary);
}

.vd-dev {
  color: var(--warning-text);
}

.vd-body {
  max-height: 52vh;
  overflow-y: auto;
  padding-right: 4px;
}

.vd-release {
  border-bottom: 1px solid var(--border-soft);
}

.vd-release:last-child {
  border-bottom: none;
}

.vd-release-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 12px 6px;
  background: none;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  color: var(--text-primary);
}

.vd-release-head:hover {
  background: var(--bg-hover);
}

.vd-release-head.open .vd-version {
  color: var(--primary-text);
}

.vd-caret {
  font-size: 16px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.vd-version {
  font-size: 14px;
  font-weight: 650;
}

.vd-release-date {
  font-size: 12px;
  color: var(--text-secondary);
}

.vd-badge {
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  background: var(--primary-soft);
  color: var(--primary-text);
  font-size: 11px;
  font-weight: 600;
}

.vd-items {
  padding: 0 0 14px 28px;
}

.vd-list {
  margin: 0;
  padding-left: 16px;
}

.vd-item {
  padding: 4px 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text-secondary);
}

/* 无记录那句话用灰字而不是红色：它不是错误，是如实记账 */
.vd-empty {
  margin: 0;
  padding: 3px 0;
  font-size: 13px;
  color: var(--text-secondary);
}
</style>

<!-- el-dialog 会 teleport 到 body，scoped 罩不住壳子；夜间下 EP 默认白底 + 本页浅色变量未同步，
     内容区却走 --text-primary（夜间为白）→ 白字白底。这里把壳对齐本站 token。 -->
<style>
.vd-dialog.el-dialog {
  background: var(--bg-card) !important;
  border: 1px solid var(--border-color);
  border-radius: 16px !important;
  box-shadow: 0 20px 56px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}
.vd-dialog .el-dialog__header {
  padding: 18px 20px 10px;
  margin-right: 0;
  border-bottom: 1px solid var(--border-soft);
}
.vd-dialog .el-dialog__title {
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 650;
}
.vd-dialog .el-dialog__headerbtn .el-dialog__close {
  color: var(--text-secondary);
}
.vd-dialog .el-dialog__headerbtn:hover .el-dialog__close {
  color: var(--text-primary);
}
.vd-dialog .el-dialog__body {
  padding: 14px 20px 20px;
  color: var(--text-primary);
  background: var(--bg-card);
}
.dark-theme .vd-dialog.el-dialog {
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
}
.dark-theme .vd-badge {
  background: rgba(122, 162, 255, 0.18);
}
</style>
