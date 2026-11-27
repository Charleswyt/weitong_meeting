<template>
  <div class="ann-layer" :class="{ active }">
    <canvas
      ref="canvasRef"
      class="ann-canvas"
      :class="{ interactive: active }"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    />

    <!-- 文本标注浮框 -->
    <div
      v-if="active && textBox.open"
      class="ann-text-pop"
      :style="{ left: textBox.x + 'px', top: textBox.y + 'px' }"
    >
      <input
        ref="textInputRef"
        v-model="textBox.value"
        type="text"
        class="ann-text-input"
        placeholder="输入批注文字，回车确认"
        maxlength="80"
        @keydown.enter.prevent="commitText"
        @keydown.esc.prevent="textBox.open = false"
        @blur="commitText"
      />
    </div>

    <!-- 腾讯会议风格批注悬浮工具栏 -->
    <div v-if="active" class="ann-toolbar" role="toolbar" aria-label="批注工具栏">
      <div class="ann-group">
        <button
          v-for="t in TOOLS"
          :key="t.id"
          type="button"
          class="ann-btn"
          :class="{ on: tool === t.id }"
          :title="t.label"
          @click="tool = t.id"
        >
          <i :class="t.icon" />
        </button>
      </div>

      <span class="ann-sep" />

      <div class="ann-group ann-colors">
        <button
          v-for="c in COLORS"
          :key="c"
          type="button"
          class="ann-color"
          :class="{ on: color === c }"
          :style="{ background: c }"
          :title="c"
          @click="color = c"
        />
      </div>

      <span class="ann-sep" />

      <div class="ann-group">
        <button
          v-for="w in WIDTHS"
          :key="w.value"
          type="button"
          class="ann-btn ann-width-btn"
          :class="{ on: lineWidth === w.value }"
          :title="w.label"
          @click="lineWidth = w.value"
        >
          <span class="ann-width-dot" :style="{ width: w.dot + 'px', height: w.dot + 'px' }" />
        </button>
      </div>

      <span class="ann-sep" />

      <div class="ann-group">
        <button
          type="button"
          class="ann-btn"
          :disabled="!strokes.length"
          title="撤销"
          @click="undo"
        >
          <i class="ri-arrow-go-back-line" />
        </button>
        <button
          type="button"
          class="ann-btn"
          :disabled="!strokes.length"
          title="清空全部批注"
          @click="clearAll"
        >
          <i class="ri-delete-bin-6-line" />
        </button>
        <button
          type="button"
          class="ann-btn"
          title="截图保存当前批注"
          @click="emit('capture')"
        >
          <i class="ri-screenshot-2-line" />
        </button>
        <button
          type="button"
          class="ann-exit"
          title="退出批注"
          @click="emit('close')"
        >
          <i class="ri-close-line" />
          <span>退出</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'

type ToolId = 'pen' | 'highlighter' | 'line' | 'rect' | 'arrow' | 'text' | 'eraser'

interface Point {
  x: number
  y: number
}

interface Stroke {
  tool: ToolId
  color: string
  width: number
  points: Point[]
  text?: string
}

const props = defineProps<{ active: boolean }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'capture'): void
}>()

const TOOLS: Array<{ id: ToolId; label: string; icon: string }> = [
  { id: 'pen', label: '画笔', icon: 'ri-pencil-line' },
  { id: 'highlighter', label: '荧光笔', icon: 'ri-mark-pen-line' },
  { id: 'line', label: '直线', icon: 'ri-subtract-line' },
  { id: 'arrow', label: '箭头', icon: 'ri-arrow-right-up-line' },
  { id: 'rect', label: '矩形框', icon: 'ri-checkbox-blank-line' },
  { id: 'text', label: '文字', icon: 'ri-text' },
  { id: 'eraser', label: '橡皮擦', icon: 'ri-eraser-line' },
]

const COLORS = ['#ef4444', '#f97316', '#facc15', '#22c55e', '#3b82f6', '#ffffff']
const WIDTHS = [
  { label: '细', value: 2.5, dot: 5 },
  { label: '中', value: 5, dot: 8 },
  { label: '粗', value: 9, dot: 11 },
]

const tool = ref<ToolId>('pen')
const color = ref('#ef4444')
const lineWidth = ref(5)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const textInputRef = ref<HTMLInputElement | null>(null)

const strokes = ref<Stroke[]>([])
let currentStroke: Stroke | null = null
let drawing = false
let ro: ResizeObserver | null = null

const textBox = reactive({
  open: false,
  x: 0,
  y: 0,
  value: '',
})

function syncCanvasSize() {
  const canvas = canvasRef.value
  const parent = canvas?.parentElement
  if (!canvas || !parent) return
  const rect = parent.getBoundingClientRect()
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const w = Math.max(1, Math.round(rect.width))
  const h = Math.max(1, Math.round(rect.height))
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
  }
  redraw()
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  if (!s.points.length) return
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  if (s.tool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out'
    ctx.strokeStyle = 'rgba(0,0,0,1)'
    ctx.lineWidth = s.width * 3.2
  } else if (s.tool === 'highlighter') {
    ctx.globalAlpha = 0.38
    ctx.strokeStyle = s.color
    ctx.lineWidth = s.width * 3
  } else {
    ctx.strokeStyle = s.color
    ctx.fillStyle = s.color
    ctx.lineWidth = s.width
  }

  if (s.tool === 'pen' || s.tool === 'highlighter' || s.tool === 'eraser') {
    ctx.beginPath()
    ctx.moveTo(s.points[0].x, s.points[0].y)
    for (let i = 1; i < s.points.length; i++) {
      ctx.lineTo(s.points[i].x, s.points[i].y)
    }
    ctx.stroke()
  } else if (s.tool === 'line') {
    const a = s.points[0]
    const b = s.points[s.points.length - 1]
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  } else if (s.tool === 'rect') {
    const a = s.points[0]
    const b = s.points[s.points.length - 1]
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y)
  } else if (s.tool === 'arrow') {
    const a = s.points[0]
    const b = s.points[s.points.length - 1]
    const angle = Math.atan2(b.y - a.y, b.x - a.x)
    const head = Math.max(12, s.width * 3.2)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(b.x, b.y)
    ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6))
    ctx.moveTo(b.x, b.y)
    ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6))
    ctx.stroke()
  } else if (s.tool === 'text' && s.text) {
    const a = s.points[0]
    const size = Math.max(15, Math.round(s.width * 3.6))
    ctx.font = `600 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
    ctx.textBaseline = 'top'
    ctx.shadowColor = 'rgba(0,0,0,0.45)'
    ctx.shadowBlur = 4
    ctx.fillText(s.text, a.x, a.y)
  }

  ctx.restore()
}

function redraw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.scale(dpr, dpr)
  for (const s of strokes.value) drawStroke(ctx, s)
  if (currentStroke) drawStroke(ctx, currentStroke)
  ctx.restore()
}

function pointOf(e: PointerEvent): Point {
  const rect = canvasRef.value!.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function onPointerDown(e: PointerEvent) {
  if (!props.active || e.button !== 0) return
  const pt = pointOf(e)
  if (tool.value === 'text') {
    textBox.x = pt.x
    textBox.y = pt.y
    textBox.value = ''
    textBox.open = true
    void nextTick(() => textInputRef.value?.focus())
    return
  }
  canvasRef.value?.setPointerCapture(e.pointerId)
  drawing = true
  currentStroke = {
    tool: tool.value,
    color: color.value,
    width: lineWidth.value,
    points: [pt],
  }
  redraw()
}

function onPointerMove(e: PointerEvent) {
  if (!drawing || !currentStroke) return
  const pt = pointOf(e)
  if (currentStroke.tool === 'pen' || currentStroke.tool === 'highlighter' || currentStroke.tool === 'eraser') {
    currentStroke.points.push(pt)
  } else {
    currentStroke.points = [currentStroke.points[0], pt]
  }
  redraw()
}

function onPointerUp() {
  if (!drawing || !currentStroke) return
  drawing = false
  if (currentStroke.points.length >= 1) {
    strokes.value.push(currentStroke)
  }
  currentStroke = null
  redraw()
}

function commitText() {
  if (!textBox.open) return
  const val = textBox.value.trim()
  textBox.open = false
  if (!val) return
  strokes.value.push({
    tool: 'text',
    color: color.value,
    width: lineWidth.value,
    points: [{ x: textBox.x, y: textBox.y }],
    text: val,
  })
  redraw()
}

function undo() {
  strokes.value.pop()
  redraw()
}

function clearAll() {
  strokes.value = []
  currentStroke = null
  redraw()
}

watch(
  () => props.active,
  (on) => {
    if (on) void nextTick(syncCanvasSize)
    else textBox.open = false
  },
)

onMounted(() => {
  syncCanvasSize()
  const parent = canvasRef.value?.parentElement
  if (parent && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => syncCanvasSize())
    ro.observe(parent)
  }
})

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})

defineExpose({
  getCanvas: () => canvasRef.value,
  clearAll,
})
</script>

<style scoped>
.ann-layer {
  position: absolute;
  inset: 0;
  z-index: 25;
  pointer-events: none;
}
.ann-canvas {
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.ann-canvas.interactive {
  pointer-events: auto;
  cursor: crosshair;
  touch-action: none;
}
.ann-text-pop {
  position: absolute;
  z-index: 30;
  pointer-events: auto;
}
.ann-text-input {
  min-width: 180px;
  height: 34px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1.5px solid #165dff;
  background: rgba(15, 23, 42, 0.92);
  color: #fff;
  font-size: 13.5px;
  outline: none;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.35);
}
.ann-toolbar {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 14px;
  background: rgba(15, 23, 42, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(12px);
  max-width: calc(100% - 24px);
  overflow-x: auto;
}
.ann-group {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.ann-sep {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.14);
  flex-shrink: 0;
}
.ann-btn {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: #cbd5e1;
  font-size: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.ann-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}
.ann-btn.on {
  background: #165dff;
  color: #fff;
}
.ann-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.ann-color {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease;
}
.ann-color.on {
  border-color: #fff;
  transform: scale(1.18);
  box-shadow: 0 0 0 2px rgba(22, 93, 255, 0.65);
}
.ann-width-dot {
  border-radius: 50%;
  background: currentColor;
  display: block;
}
.ann-exit {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  border: none;
  background: rgba(239, 68, 68, 0.2);
  color: #fca5a5;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
}
.ann-exit:hover {
  background: #ef4444;
  color: #fff;
}
</style>
