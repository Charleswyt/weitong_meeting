<template>
  <button
    type="button"
    class="home-node-card"
    :class="[`is-${mode}`, { 'is-checking': checking }]"
    :title="tooltip"
    @click="detect(true)"
  >
    <span class="home-node-art" aria-hidden="true">
      <svg
        v-if="mode === 'edge'"
        viewBox="0 0 44 32"
        width="44"
        height="32"
        fill="none"
      >
        <rect x="2.5" y="9" width="11" height="14" rx="2.5" stroke="currentColor" stroke-width="1.6" />
        <line x1="5.5" y1="13" x2="10.5" y2="13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        <circle cx="8" cy="19.5" r="1.2" fill="currentColor" />
        <path
          d="M15 16H26"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-dasharray="2.5 2.5"
          stroke-linecap="round"
          class="node-link-flow"
        />
        <rect
          x="27.5"
          y="6"
          width="14"
          height="20"
          rx="3.5"
          fill="currentColor"
          fill-opacity="0.14"
          stroke="currentColor"
          stroke-width="1.6"
        />
        <circle cx="34.5" cy="12" r="2.2" fill="currentColor" />
        <line x1="31" y1="18.5" x2="38" y2="18.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <line x1="31" y1="21.5" x2="36" y2="21.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
      <svg
        v-else
        viewBox="0 0 44 32"
        width="44"
        height="32"
        fill="none"
      >
        <rect x="2.5" y="10" width="11" height="12" rx="2.2" stroke="currentColor" stroke-width="1.6" />
        <line x1="5" y1="24.5" x2="11" y2="24.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <path
          d="M15 16H23"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-dasharray="2.5 2.5"
          stroke-linecap="round"
          class="node-link-flow"
        />
        <path
          d="M27.5 22.5H37.8C40.1 22.5 42 20.7 42 18.4C42 16.3 40.4 14.6 38.4 14.4C37.7 11.4 35.1 9.2 32 9.2C28.7 9.2 26 11.7 25.6 14.9C24 15.5 23 17 23 18.7C23 20.8 25 22.5 27.5 22.5Z"
          fill="currentColor"
          fill-opacity="0.14"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
      </svg>
    </span>
    <span class="home-node-info">
      <span class="home-node-top">
        <span class="home-node-dot" />
        <span class="home-node-label">{{ label }}</span>
        <i class="ri-refresh-line home-node-refresh" :class="{ spinning: checking }" />
      </span>
      <span class="home-node-sub">{{ subText }}</span>
    </span>
  </button>
</template>

<script setup lang="ts">
import { useAccessNode } from '@/composables/useAccessNode'

const { mode, checking, label, subText, tooltip, detect } = useAccessNode()
</script>

<style scoped>
.home-node-card {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-left: 6px;
  padding: 6px 12px 6px 10px;
  border-radius: 12px;
  border: 1px solid var(--border-soft);
  background: var(--bg-card);
  color: var(--primary-text);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.16s ease, background-color 0.2s ease;
  flex-shrink: 0;
}
.home-node-card:hover {
  border-color: color-mix(in srgb, currentColor 42%, var(--border-color));
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.08);
  transform: translateY(-1px);
}
.home-node-card.is-cloud {
  color: #165dff;
  background: linear-gradient(135deg, rgba(22, 93, 255, 0.08), rgba(56, 189, 248, 0.06));
  border-color: rgba(22, 93, 255, 0.22);
}
.home-node-card.is-edge {
  color: #059669;
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.09), rgba(20, 184, 166, 0.06));
  border-color: rgba(16, 185, 129, 0.26);
}
.home-node-card.is-offline {
  color: #d97706;
  background: rgba(245, 158, 11, 0.08);
  border-color: rgba(245, 158, 11, 0.28);
}
.home-node-card.is-checking {
  color: var(--text-secondary);
}
.home-node-art {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.node-link-flow {
  animation: nodeLinkFlow 1.6s linear infinite;
}
@keyframes nodeLinkFlow {
  to {
    stroke-dashoffset: -10;
  }
}
.home-node-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.home-node-top {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.home-node-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 20%, transparent);
  flex-shrink: 0;
}
.home-node-label {
  font-size: 13px;
  font-weight: 650;
  color: var(--text-primary);
  white-space: nowrap;
}
.home-node-refresh {
  font-size: 12px;
  color: var(--text-muted);
  opacity: 0.7;
  transition: opacity 0.16s ease;
}
.home-node-card:hover .home-node-refresh {
  opacity: 1;
  color: currentColor;
}
.home-node-refresh.spinning {
  animation: nodeSpin 0.8s linear infinite;
  opacity: 1;
}
@keyframes nodeSpin {
  to {
    transform: rotate(360deg);
  }
}
.home-node-sub {
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
</style>
