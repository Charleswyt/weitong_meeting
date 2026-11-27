<template>
  <Teleport to="body">
    <div
      class="modal-overlay"
      :class="{ show: modelValue }"
      @click.self="close"
    >
      <div
        class="modal-box sched-cal-modal"
        role="dialog"
        aria-modal="true"
        aria-label="我的日程"
      >
        <div class="modal-header">
          <div class="wt-dlg-head-left">
            <i class="wt-dlg-icon ri-calendar-event-line" />
            <h3>我的日程</h3>
            <span class="sc-head-pill">
              未来 30 天 · {{ totalMeetings }} 场 / {{ activeDayKeys.length }} 天
            </span>
          </div>
          <button
            class="modal-close"
            type="button"
            aria-label="关闭"
            @click="close"
          >
            <i class="ri-close-line" />
          </button>
        </div>

        <div class="modal-body sc-body">
          <!-- 左侧：未来 30 天日历矩阵 -->
          <div class="sc-cal-pane">
            <div class="sc-cal-bar">
              <span class="sc-cal-range">{{ rangeLabel }}</span>
              <button
                type="button"
                class="sc-today-btn"
                @click="selectDay(todayKey)"
              >
                回到今天
              </button>
            </div>

            <div class="sc-weekdays">
              <span v-for="w in WEEKDAYS" :key="w">{{ w }}</span>
            </div>

            <div class="sc-grid">
              <button
                v-for="cell in calendarCells"
                :key="cell.key"
                type="button"
                class="sc-cell"
                :class="{
                  'is-outside': !cell.inRange,
                  'is-today': cell.isToday,
                  'is-selected': cell.key === selectedKey,
                  'has-meetings': cell.count > 0,
                }"
                :disabled="!cell.inRange"
                @click="selectDay(cell.key)"
              >
                <span v-if="cell.monthBadge" class="sc-month-tag">{{
                  cell.monthBadge
                }}</span>
                <span class="sc-day-num">{{ cell.day }}</span>
                <span v-if="cell.count > 0" class="sc-count-tag">
                  {{ cell.count }}场
                </span>
              </button>
            </div>

            <div v-if="activeDayKeys.length" class="sc-quick-days">
              <span class="sc-quick-label">有会日期：</span>
              <div class="sc-quick-chips">
                <button
                  v-for="dKey in activeDayKeys"
                  :key="dKey"
                  type="button"
                  class="sc-day-chip"
                  :class="{ active: dKey === selectedKey }"
                  @click="selectDay(dKey)"
                >
                  {{ shortDayLabel(dKey) }}
                  <em>{{ (meetingsByDay.get(dKey) || []).length }}</em>
                </button>
              </div>
            </div>
          </div>

          <!-- 右侧：所选日期会议列表 -->
          <div class="sc-list-pane">
            <div class="sc-list-head">
              <div>
                <div class="sc-list-date">{{ selectedDateTitle }}</div>
                <div class="sc-list-sub">
                  {{
                    selectedMeetings.length
                      ? `共 ${selectedMeetings.length} 场会议`
                      : "当天暂无安排"
                  }}
                </div>
              </div>
            </div>

            <div v-if="selectedMeetings.length" class="sc-meeting-list">
              <div
                v-for="m in selectedMeetings"
                :key="m.id"
                class="sc-meeting-card"
              >
                <div class="sc-mc-top">
                  <span class="sc-mc-time">{{ formatTimeRange(m) }}</span>
                  <span
                    class="sc-mc-status"
                    :class="m.status === 'running' ? 'is-live' : 'is-sched'"
                  >
                    {{ m.status === "running" ? "进行中" : "已预约" }}
                  </span>
                </div>
                <div class="sc-mc-title">{{ m.title || "未命名会议" }}</div>
                <div class="sc-mc-foot">
                  <span v-if="m.meetingNo" class="sc-mc-no">
                    会议号 {{ m.meetingNo }}
                  </span>
                  <span v-else class="sc-mc-no">待同步会议号</span>
                  <button
                    type="button"
                    class="sc-mc-join"
                    @click="onJoin(m)"
                  >
                    {{ m.status === "running" ? "进入" : "入会" }}
                  </button>
                </div>
              </div>
            </div>

            <div v-else class="sc-empty">
              <i class="ri-calendar-2-line" />
              <p>这一天暂无会议日程</p>
              <button type="button" class="sc-empty-btn" @click="onNewSchedule">
                <i class="ri-add-line" /> 预约一场会议
              </button>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-cancel" type="button" @click="close">关闭</button>
          <button class="btn-confirm" type="button" @click="onNewSchedule">
            <i class="ri-calendar-check-line" />预约会议
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { MeetingVo } from "@/api/meeting";
import { businessDayKey } from "@/utils/time";

const props = defineProps<{
  modelValue: boolean;
  meetings: MeetingVo[];
}>();

const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "join", m: MeetingVo): void;
  (e: "schedule"): void;
}>();

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const todayStart = computed(() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
});

const todayKey = computed(() => dateKeyOf(todayStart.value));

const rangeEnd = computed(() => {
  const d = new Date(todayStart.value);
  d.setDate(d.getDate() + 30);
  return d;
});

const rangeLabel = computed(() => {
  const s = todayStart.value;
  const e = rangeEnd.value;
  return `${s.getMonth() + 1}月${s.getDate()}日 — ${e.getMonth() + 1}月${e.getDate()}日`;
});

const upcomingMeetings = computed(() => {
  const startMs = todayStart.value.getTime();
  const endMs = rangeEnd.value.getTime() + 86_400_000;
  return [...props.meetings]
    .filter((m) => {
      if (m.status === "ended" || m.status === "cancelled") return false;
      const t = new Date(m.startTime).getTime();
      if (!Number.isFinite(t)) return false;
      return t >= startMs && t < endMs;
    })
    .sort(
      (a, b) =>
        new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
    );
});

const totalMeetings = computed(() => upcomingMeetings.value.length);

const meetingsByDay = computed(() => {
  const map = new Map<string, MeetingVo[]>();
  for (const m of upcomingMeetings.value) {
    const k = businessDayKey(m.startTime);
    if (!k) continue;
    const list = map.get(k) || [];
    list.push(m);
    map.set(k, list);
  }
  return map;
});

const activeDayKeys = computed(() => Array.from(meetingsByDay.value.keys()).sort());

interface CalendarCell {
  key: string;
  day: number;
  monthBadge: string;
  inRange: boolean;
  isToday: boolean;
  count: number;
}

// 从今天所在周的周一开始，覆盖完整 30 天（通常 5~6 周）
const calendarCells = computed<CalendarCell[]>(() => {
  const start = new Date(todayStart.value);
  const dow = (start.getDay() + 6) % 7; // 周一=0 .. 周日=6
  const gridStart = new Date(start);
  gridStart.setDate(gridStart.getDate() - dow);

  const end = rangeEnd.value;
  const endDow = (end.getDay() + 6) % 7;
  const gridEnd = new Date(end);
  gridEnd.setDate(gridEnd.getDate() + (6 - endDow));

  const cells: CalendarCell[] = [];
  const cursor = new Date(gridStart);
  const startMs = todayStart.value.getTime();
  const endMs = end.getTime();

  while (cursor.getTime() <= gridEnd.getTime()) {
    const key = dateKeyOf(cursor);
    const ms = cursor.getTime();
    const inRange = ms >= startMs && ms <= endMs;
    const isFirstOfMonth = cursor.getDate() === 1;
    cells.push({
      key,
      day: cursor.getDate(),
      monthBadge: isFirstOfMonth ? `${cursor.getMonth() + 1}月` : "",
      inRange,
      isToday: key === todayKey.value,
      count: inRange ? (meetingsByDay.value.get(key) || []).length : 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return cells;
});

const selectedKey = ref("");

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    // 默认选中今天（若今天无会但未来有会，仍停在今天方便总览，用户可点快捷日期或日历）
    selectedKey.value =
      (meetingsByDay.value.get(todayKey.value)?.length
        ? todayKey.value
        : activeDayKeys.value[0]) || todayKey.value;
  },
  { immediate: true },
);

const selectedMeetings = computed(
  () => meetingsByDay.value.get(selectedKey.value) || [],
);

const selectedDateTitle = computed(() => {
  if (!selectedKey.value) return "今日日程";
  const [y, m, d] = selectedKey.value.split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  const wk = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][dt.getDay()];
  const tag = selectedKey.value === todayKey.value ? " · 今天" : "";
  return `${m}月${d}日 ${wk}${tag}`;
});

function shortDayLabel(key: string): string {
  const [, m, d] = key.split("-").map(Number);
  if (key === todayKey.value) return "今天";
  return `${m}/${d}`;
}

function formatTimeRange(m: MeetingVo): string {
  const s = new Date(m.startTime);
  if (isNaN(s.getTime())) return "--:--";
  const sh = `${pad(s.getHours())}:${pad(s.getMinutes())}`;
  const mins = Number(m.durationMinutes) || 0;
  if (mins <= 0) return sh;
  const e = new Date(s.getTime() + mins * 60_000);
  return `${sh} - ${pad(e.getHours())}:${pad(e.getMinutes())}`;
}

function selectDay(key: string) {
  selectedKey.value = key;
}

function close() {
  emit("update:modelValue", false);
}

function onJoin(m: MeetingVo) {
  close();
  emit("join", m);
}

function onNewSchedule() {
  close();
  emit("schedule");
}
</script>

<style scoped>
.sched-cal-modal {
  width: min(820px, 94vw);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
}
.sc-head-pill {
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary-text);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.sc-body {
  display: grid;
  grid-template-columns: 1.18fr 0.82fr;
  gap: 20px;
  overflow-y: auto;
  min-height: 360px;
  max-height: 68vh;
}
.sc-cal-pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.sc-cal-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.sc-cal-range {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text-primary);
}
.sc-today-btn {
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-soft);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.16s ease;
}
.sc-today-btn:hover {
  border-color: var(--primary);
  color: var(--primary-text);
}
.sc-weekdays {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  padding: 4px 0;
}
.sc-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 6px;
}
.sc-cell {
  position: relative;
  height: 54px;
  border-radius: 10px;
  border: 1px solid var(--border-soft);
  background: var(--bg-soft);
  color: var(--text-primary);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  cursor: pointer;
  transition: all 0.16s ease;
}
.sc-cell:hover:not(:disabled) {
  border-color: var(--primary);
  background: var(--bg-hover);
}
.sc-cell.is-outside {
  opacity: 0.28;
  cursor: default;
  background: transparent;
  border-color: transparent;
}
.sc-cell.is-today {
  border-color: color-mix(in srgb, var(--primary) 50%, transparent);
}
.sc-cell.is-today .sc-day-num {
  color: var(--primary-text);
  font-weight: 700;
}
.sc-cell.has-meetings {
  background: color-mix(in srgb, var(--primary) 8%, var(--bg-card));
  border-color: color-mix(in srgb, var(--primary) 26%, var(--border-soft));
}
.sc-cell.is-selected {
  background: var(--primary) !important;
  border-color: var(--primary) !important;
  color: #fff !important;
  box-shadow: 0 6px 16px rgba(22, 93, 255, 0.28);
}
.sc-cell.is-selected .sc-day-num,
.sc-cell.is-selected .sc-month-tag,
.sc-cell.is-selected .sc-count-tag {
  color: #fff !important;
  background: rgba(255, 255, 255, 0.2);
}
.sc-cell.is-selected .sc-day-num,
.sc-cell.is-selected .sc-month-tag {
  background: transparent;
}
.sc-month-tag {
  position: absolute;
  top: 3px;
  left: 5px;
  font-size: 9.5px;
  font-weight: 600;
  color: var(--primary-text);
  line-height: 1;
}
.sc-day-num {
  font-size: 13.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.sc-count-tag {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary-text);
  line-height: 1.3;
}
.sc-quick-days {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--border-soft);
}
.sc-quick-label {
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  padding-top: 4px;
}
.sc-quick-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.sc-day-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 9px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.16s ease;
}
.sc-day-chip em {
  font-style: normal;
  font-size: 11px;
  font-weight: 600;
  color: var(--primary-text);
}
.sc-day-chip:hover,
.sc-day-chip.active {
  border-color: var(--primary);
  background: var(--primary-soft);
  color: var(--primary-text);
}

.sc-list-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-left: 18px;
  border-left: 1px solid var(--border-soft);
  min-width: 0;
}
.sc-list-date {
  font-size: 15px;
  font-weight: 650;
  color: var(--text-primary);
}
.sc-list-sub {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}
.sc-meeting-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
}
.sc-meeting-card {
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--bg-soft);
  border: 1px solid var(--border-soft);
  display: flex;
  flex-direction: column;
  gap: 6px;
  transition: border-color 0.16s ease;
}
.sc-meeting-card:hover {
  border-color: color-mix(in srgb, var(--primary) 45%, var(--border-soft));
}
.sc-mc-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.sc-mc-time {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--primary-text);
  font-variant-numeric: tabular-nums;
}
.sc-mc-status {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
}
.sc-mc-status.is-live {
  background: rgba(34, 197, 94, 0.14);
  color: var(--success-text, #16a34a);
}
.sc-mc-status.is-sched {
  background: var(--primary-soft);
  color: var(--primary-text);
}
.sc-mc-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-mc-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
}
.sc-mc-no {
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.sc-mc-join {
  height: 26px;
  padding: 0 12px;
  border-radius: 8px;
  border: none;
  background: var(--primary);
  color: #fff;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.16s ease;
}
.sc-mc-join:hover {
  background: var(--primary-dark);
}
.sc-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 36px 12px;
  color: var(--text-muted);
  text-align: center;
}
.sc-empty i {
  font-size: 32px;
  opacity: 0.45;
}
.sc-empty p {
  margin: 0;
  font-size: 13px;
}
.sc-empty-btn {
  margin-top: 6px;
  height: 32px;
  padding: 0 14px;
  border-radius: 9px;
  border: 1px solid var(--border-color);
  background: var(--bg-card);
  color: var(--primary-text);
  font-size: 12.5px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.sc-empty-btn:hover {
  border-color: var(--primary);
  background: var(--primary-soft);
}

@media (max-width: 767px) {
  .sc-body {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  .sc-list-pane {
    padding-left: 0;
    padding-top: 14px;
    border-left: none;
    border-top: 1px solid var(--border-soft);
  }
  .sc-cell {
    height: 46px;
  }
}
</style>
