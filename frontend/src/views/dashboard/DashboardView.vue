<template>
  <!-- 手机端独立 App 形态首页（参照腾讯会议 App）：无多余网页装饰，大触控金刚键 + 极简日程列表 -->
  <div v-if="isPhone" class="m-app-home">
    <section class="m-app-actions" aria-label="快捷入口">
      <button type="button" class="m-app-key" @click="showJoinDialog = true">
        <span class="m-app-key-ic is-blue"><i class="ri-add-box-fill" /></span>
        <span class="m-app-key-txt">加入会议</span>
      </button>
      <button
        type="button"
        class="m-app-key"
        :disabled="starting"
        @click="startNow"
      >
        <span class="m-app-key-ic is-indigo"
          ><i class="ri-flashlight-fill"
        /></span>
        <span class="m-app-key-txt">{{
          starting ? "启动中" : "快速会议"
        }}</span>
      </button>
      <button type="button" class="m-app-key" @click="openSchedule">
        <span class="m-app-key-ic is-green"
          ><i class="ri-calendar-event-fill"
        /></span>
        <span class="m-app-key-txt">预定会议</span>
      </button>
      <button
        type="button"
        class="m-app-key"
        :disabled="starting"
        @click="startForShare"
      >
        <span class="m-app-key-ic is-orange"
          ><i class="ri-share-box-fill"
        /></span>
        <span class="m-app-key-txt">共享屏幕</span>
      </button>
    </section>

    <div class="m-app-subbar">
      <button
        type="button"
        class="m-app-pill"
        :disabled="starting"
        @click="startVoice"
      >
        <i class="ri-mic-line" /><span>语音对讲</span>
      </button>
      <button type="button" class="m-app-pill" @click="goRecordings">
        <i class="ri-record-circle-line" /><span>录制回放</span>
      </button>
    </div>

    <section class="m-app-list-wrap" aria-label="会议日程">
      <div class="m-app-list-head">
        <div class="m-app-list-title">
          <span>{{ monthLine }}{{ dayNum }}日</span>
          <small>{{ weekday }}</small>
        </div>
        <button
          type="button"
          class="m-app-all-btn"
          @click="router.push('/all-meetings')"
        >
          全部会议 <i class="ri-arrow-right-s-line" />
        </button>
      </div>

      <div v-if="loading && !groupedMeetings.length" class="m-app-empty">
        加载中…
      </div>
      <div v-else-if="!groupedMeetings.length" class="m-app-empty">
        <i class="ri-calendar-2-line m-app-empty-ic" />
        <p>暂无近期会议</p>
        <button
          type="button"
          class="m-app-empty-cta"
          :disabled="starting"
          @click="startNow"
        >
          发起快速会议
        </button>
      </div>
      <div v-else class="m-app-groups">
        <div
          v-for="group in groupedMeetings"
          :key="group.label"
          class="m-app-group"
        >
          <div class="m-app-group-label">{{ group.label }}</div>
          <div
            v-for="m in group.items"
            :key="m.id"
            class="m-app-card"
            @click="
              m.status === 'running' || m.status === 'scheduled'
                ? handleJoin(m)
                : undefined
            "
          >
            <div class="m-app-card-main">
              <div class="m-app-card-top">
                <span class="m-app-card-title">{{ m.title }}</span>
                <span class="m-app-card-status" :class="'st-' + m.status">
                  {{
                    m.status === "running"
                      ? "进行中"
                      : m.status === "scheduled"
                        ? "待开始"
                        : "已结束"
                  }}
                </span>
              </div>
              <div class="m-app-card-meta">
                <span>{{ timeRangeOf(m) }}</span>
                <span v-if="m.meetingNo">· {{ m.meetingNo }}</span>
              </div>
            </div>
            <div class="m-app-card-ops" @click.stop>
              <button
                v-if="
                  m.meetingNo &&
                  (m.status === 'scheduled' || m.status === 'running')
                "
                type="button"
                class="m-app-op-icon"
                title="分享邀请"
                @click="handleShare(m)"
              >
                <i class="ri-share-line" />
              </button>
              <button
                v-if="m.status === 'running' || m.status === 'scheduled'"
                type="button"
                class="m-app-op-join"
                @click="handleJoin(m)"
              >
                入会
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <ScheduleMeetingDialog
      v-model="showScheduleDialog"
      :meeting="editingMeeting"
      @created="load(true)"
    />
    <JoinMeetingDialog v-model="showJoinDialog" />
    <MyScheduleDialog
      v-model="showMySchedule"
      :meetings="upcomingMonthMeetings"
      @join="handleJoin"
      @schedule="openSchedule"
    />
  </div>

  <div v-else class="home-page">
    <header class="home-hero">
      <div class="home-hero-left">
        <div class="home-hero-date">
          <div class="home-day">{{ dayNum }}</div>
          <div class="home-hero-meta">
            <div class="home-month-line">{{ monthLine }}</div>
            <div class="home-weekday-line">{{ weekday }} · 今天</div>
          </div>
        </div>
        <div
          v-if="placeLine || weatherLine"
          class="home-weather"
          :title="placeLine"
        >
          <span v-if="placeLine" class="home-place"
            ><i class="ri-map-pin-2-line" />{{ placeLine }}</span
          >
          <span v-if="weatherLine" class="home-wx"
            ><i class="ri-sun-cloudy-line" />{{ weatherLine }}</span
          >
        </div>
        <div
          v-if="sunriseLine || sunsetLine || windLine"
          class="home-weather-extra"
        >
          <span v-if="sunriseLine || sunsetLine" class="home-wx-detail">
            <template v-if="sunriseLine">
              <i class="ri-sun-line" />日出 {{ sunriseLine }}
            </template>
            <template v-if="sunriseLine && sunsetLine">
              <span class="home-wx-sep">·</span>
            </template>
            <template v-if="sunsetLine">
              <i class="ri-moon-clear-line" />日落 {{ sunsetLine }}
            </template>
          </span>
          <span v-if="windLine" class="home-wx-detail">
            <i class="ri-windy-line" />{{ windLine }}
          </span>
        </div>

        <!-- 边/云入会模式示意图：自动探测后端部署侧别并周期静默刷新 -->
        <AccessNodeBadge />
      </div>

      <section class="home-launch" aria-label="会议入口">
        <button
          class="launch-item"
          type="button"
          :disabled="starting"
          @click="startNow"
        >
          <span class="launch-orb launch-orb--blue">
            <i class="ri-video-add-fill" />
          </span>
          <span class="launch-label">{{
            starting ? "正在开始…" : "快速会议"
          }}</span>
        </button>

        <button
          class="launch-item"
          type="button"
          @click="showJoinDialog = true"
        >
          <span class="launch-orb launch-orb--cyan">
            <i class="ri-user-add-fill" />
          </span>
          <span class="launch-label">加入会议</span>
        </button>

        <button class="launch-item" type="button" @click="openSchedule">
          <span class="launch-orb launch-orb--green">
            <i class="ri-calendar-check-fill" />
          </span>
          <span class="launch-label">预约会议</span>
        </button>

        <button
          class="launch-item"
          type="button"
          :disabled="starting"
          title="进入会议后即可共享屏幕"
          @click="startForShare"
        >
          <span class="launch-orb launch-orb--orange">
            <i class="ri-share-forward-fill" />
          </span>
          <span class="launch-label">共享屏幕</span>
        </button>

        <button
          class="launch-item"
          type="button"
          title="查看未来一个月的会议日程"
          @click="showMySchedule = true"
        >
          <span class="launch-orb launch-orb--purple">
            <i class="ri-calendar-event-fill" />
            <span v-if="upcomingMonthCount > 0" class="launch-badge">{{
              upcomingMonthCount > 99 ? "99+" : upcomingMonthCount
            }}</span>
          </span>
          <span class="launch-label">我的日程</span>
        </button>
      </section>
    </header>

    <div class="home-secondary">
      <button
        class="sec-link"
        type="button"
        :disabled="starting"
        @click="startVoice"
      >
        <i class="ri-mic-line" />
        <span>语音对讲</span>
      </button>
      <span class="sec-dot" aria-hidden="true" />
      <button class="sec-link" type="button" @click="goRecordings">
        <i class="ri-record-circle-line" />
        <span>录制回放</span>
      </button>
      <form class="sec-join" @submit.prevent="handleInlineJoin">
        <input
          v-model="joinNumber"
          class="sec-join-input"
          placeholder="会议号 / 粘贴邀请信息"
          aria-label="会议号"
          @input="onJoinInput"
          @paste="onJoinPaste"
        />
        <button class="sec-join-btn" type="submit" :disabled="!canInlineJoin">
          加入
        </button>
      </form>
    </div>

    <section class="home-schedule">
      <div class="home-schedule-head">
        <div class="home-schedule-title-wrap">
          <h2 class="home-schedule-title">近期会议</h2>
          <span class="home-count">{{ allMeetings.length }}</span>
        </div>
        <div class="home-schedule-tools">
          <button
            class="home-text-btn"
            type="button"
            @click="router.push('/all-meetings')"
          >
            <span>查看全部</span>
            <i class="ri-arrow-right-s-line" />
          </button>
        </div>
      </div>

      <div v-if="loading" class="home-loading">加载中…</div>

      <div v-else-if="groupedMeetings.length" class="home-meeting-groups">
        <div
          v-for="group in groupedMeetings"
          :key="group.label"
          class="home-meeting-group"
        >
          <div class="group-label">{{ group.label }}</div>
          <ul class="home-meeting-list">
            <li v-for="m in group.items" :key="m.id" class="home-meeting-item">
              <div class="home-meeting-time">
                <div class="time-start">{{ timeRangeOf(m) }}</div>
                <div class="time-end">UTC+8 北京时间</div>
              </div>
              <div
                class="home-meeting-rail"
                :class="{ live: m.status === 'running' }"
              />
              <div class="home-meeting-info">
                <div class="home-meeting-top">
                  <span class="home-meeting-name">{{ displayTitle(m) }}</span>
                  <span class="home-kind">{{ kindLabel(m.kind) }}</span>
                  <span class="home-status" :class="statusClass(m.status)">{{
                    statusLabel(m.status)
                  }}</span>
                  <span
                    v-if="m.status === 'ended' && endReasonLabel(m.endReason)"
                    class="home-end-reason"
                    :class="
                      m.endReason === 'abnormal_exit'
                        ? 'is-abnormal'
                        : 'is-normal'
                    "
                    >{{ endReasonLabel(m.endReason) }}</span
                  >
                </div>
                <div class="home-meeting-meta">
                  <span
                    >会议号
                    {{
                      m.meetingNo ? formatMeetingNo(m.meetingNo) : "尚未同步"
                    }}</span
                  >
                  <span v-if="hostLabel(m)">· 发起人：{{ hostLabel(m) }}</span>
                  <span v-if="m.participantCount > 0"
                    >· {{ m.participantCount }} 人参加</span
                  >
                  <span
                    v-if="recordingLabel(m)"
                    class="home-rec"
                    :class="'rec-' + effectiveRecording(m)"
                  >
                    · {{ recordingLabel(m) }}
                  </span>
                </div>
              </div>
              <div class="home-meeting-actions">
                <button
                  v-if="m.hasMinutes"
                  class="hm-btn hm-btn-minutes"
                  type="button"
                  @click="openMinutes(m)"
                >
                  会议纪要
                </button>
                <button
                  v-else-if="
                    effectiveRecording(m) === 'ready' && m.thirdPartyMeetingId
                  "
                  class="hm-btn"
                  type="button"
                  @click="openPlayback(m)"
                >
                  回放
                </button>
                <button
                  v-if="
                    m.meetingNo &&
                    (m.status === 'scheduled' || m.status === 'running')
                  "
                  class="hm-btn"
                  type="button"
                  title="复制会议邀请链接与信息"
                  @click="handleShare(m)"
                >
                  分享
                </button>
                <button
                  v-if="m.managed && m.isHost && m.status === 'scheduled'"
                  class="hm-btn"
                  type="button"
                  @click="openEdit(m)"
                >
                  修改
                </button>
                <button
                  v-if="m.managed && m.isHost && m.status === 'scheduled'"
                  class="hm-btn hm-btn-ghost"
                  type="button"
                  @click="handleCancel(m)"
                >
                  取消
                </button>
                <template v-if="m.status === 'running'">
                  <button
                    v-if="isJoined(m)"
                    class="hm-btn hm-btn-joined"
                    type="button"
                    disabled
                  >
                    已入会
                  </button>
                  <button
                    v-else
                    class="hm-btn hm-btn-primary"
                    type="button"
                    @click="handleJoin(m)"
                  >
                    入会
                  </button>
                  <button
                    v-if="m.managed && m.isHost"
                    class="hm-btn hm-btn-ghost"
                    type="button"
                    @click="handleStop(m)"
                  >
                    结束
                  </button>
                </template>
                <button
                  v-else-if="m.status === 'scheduled'"
                  class="hm-btn hm-btn-primary"
                  type="button"
                  @click="goPreMeeting(m)"
                >
                  入会
                </button>
              </div>
            </li>
          </ul>
        </div>
      </div>

      <div v-else class="home-empty">
        今天还没有安排。点上方「预约会议」或「快速会议」开始。
      </div>
    </section>

    <ScheduleMeetingDialog
      v-model="showScheduleDialog"
      :meeting="editingMeeting"
      @created="load(true)"
    />
    <JoinMeetingDialog v-model="showJoinDialog" />
    <MyScheduleDialog
      v-model="showMySchedule"
      :meetings="upcomingMonthMeetings"
      @join="handleJoin"
      @schedule="openSchedule"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useRouter } from "vue-router";
import { useViewport } from "@/composables/useViewport";
import { ElMessage, ElMessageBox } from "element-plus";
import ScheduleMeetingDialog from "@/components/dialogs/ScheduleMeetingDialog.vue";
import JoinMeetingDialog from "@/components/dialogs/JoinMeetingDialog.vue";
import MyScheduleDialog from "@/components/dialogs/MyScheduleDialog.vue";
import AccessNodeBadge from "@/components/dashboard/AccessNodeBadge.vue";
import {
  getMeetingList,
  cancelMeeting,
  stopMeeting,
  precheckMeeting,
  endReasonLabel,
  type MeetingVo,
} from "@/api/meeting";
import { getRecordingList } from "@/api/recording";
import { getDict, dictLabelSync, DICT } from "@/api/dict";
import { useMeetingStore } from "@/store/meeting";
import {
  businessClock,
  businessDayKey,
  businessWeekdayLabel,
} from "@/utils/time";
import {
  copyMeetingInvite,
  parseMeetingNoFromText,
  preJoinPath,
  preJoinPathByNumber,
} from "@/utils/joinFlow";
import { startQuickMeeting, guardSingleActiveMeeting } from "@/utils/startMeeting";
import { formatMeetingNo } from "@/utils/meetingNo";
import { fetchGeoWeather } from "@/utils/geoWeather";

const router = useRouter();
const { isPhone } = useViewport();
const meetingStore = useMeetingStore();
const allMeetings = ref<MeetingVo[]>([]);
const upcomingMonthMeetings = ref<MeetingVo[]>([]);
const loading = ref(false);
const showScheduleDialog = ref(false);
const showJoinDialog = ref(false);
const showMySchedule = ref(false);
const editingMeeting = ref<MeetingVo | null>(null);
const upcomingMonthCount = computed(() => upcomingMonthMeetings.value.length);
const joinNumber = ref("");
const starting = ref(false);
/** thirdPartyMeetingId → 有可回放录制 */
const readyRecordingIds = ref<Set<string>>(new Set());
const placeLine = ref("");
const weatherLine = ref("");
const sunriseLine = ref("");
const sunsetLine = ref("");
const windLine = ref("");
let weatherAbort: AbortController | null = null;

const now = new Date();
const dayNum = String(now.getDate());
const monthLine = `${now.getFullYear()}年${now.getMonth() + 1}月`;
const weekday = [
  "星期日",
  "星期一",
  "星期二",
  "星期三",
  "星期四",
  "星期五",
  "星期六",
][now.getDay()];

const canInlineJoin = computed(() =>
  /^\d{6,12}$/.test(joinNumber.value.replace(/\D/g, "")),
);

function applyJoinField(raw: string) {
  const parsed = parseMeetingNoFromText(raw);
  joinNumber.value = (parsed || raw.replace(/\D/g, "")).slice(0, 12);
}

function onJoinInput() {
  applyJoinField(joinNumber.value);
}

function onJoinPaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData("text") || "";
  if (!text || text.length < 6) return;
  if (/会议|http|卫通|#/.test(text) || text.length > 16) {
    e.preventDefault();
    applyJoinField(text);
  }
}

async function runQuickStart(
  launchKind: "quick" | "share" | "voice" = "quick",
  hint?: string,
) {
  if (starting.value) return;
  starting.value = true;
  try {
    const ok = await startQuickMeeting(router, { launchKind });
    if (ok && hint) ElMessage.info(hint);
  } catch {
    /* 建会失败由拦截器提示 */
  } finally {
    starting.value = false;
  }
}

async function startNow() {
  await runQuickStart("quick");
}

async function startForShare() {
  await runQuickStart("share");
}

async function startVoice() {
  await runQuickStart("voice");
}

function goRecordings() {
  router.push("/recordings");
}

async function handleInlineJoin() {
  const number = joinNumber.value.replace(/\D/g, "");
  if (!/^\d{6,12}$/.test(number)) {
    if (number) ElMessage.warning("请输入 6 到 12 位会议号");
    else showJoinDialog.value = true;
    return;
  }
  const res = await precheckMeeting(number);
  if (res.data && !res.data.joinable) {
    ElMessage.error(res.data.message || "会议不可加入");
    return;
  }
  joinNumber.value = "";
  router.push(preJoinPathByNumber(number));
}

interface MeetingGroup {
  label: string;
  items: MeetingVo[];
}

function dayLabel(d: Date): string {
  const key = businessDayKey(d);
  if (!key) return "";
  const [, m, day] = key.split("-");
  const md = Number(m) + "月" + Number(day) + "日";
  if (key === businessDayKey(Date.now())) return `今天 ${md}`;
  if (key === businessDayKey(Date.now() + 86400000)) return `明天 ${md}`;
  return `${businessWeekdayLabel(d)} ${md}`;
}

function isBriefTempMeeting(m: MeetingVo): boolean {
  if (m.status !== "ended") return false;
  if (m.kind === "scheduled") return false;
  const started = m.startedAt ? new Date(m.startedAt).getTime() : NaN;
  const endedRaw =
    (m as MeetingVo & { endedAt?: string; updatedAt?: string }).endedAt ||
    (m as MeetingVo & { updatedAt?: string }).updatedAt;
  const ended = endedRaw ? new Date(endedRaw).getTime() : NaN;
  if (
    !isNaN(started) &&
    !isNaN(ended) &&
    ended >= started &&
    ended - started < 60_000
  ) {
    return true;
  }
  if (
    !m.startedAt &&
    (m.participantCount ?? 0) <= 1 &&
    m.endReason === "empty_timeout"
  ) {
    return true;
  }
  return false;
}

const groupedMeetings = computed<MeetingGroup[]>(() => {
  const map = new Map<string, MeetingVo[]>();
  for (const m of allMeetings.value) {
    if (isBriefTempMeeting(m)) continue;
    const d = new Date(m.startTime);
    if (isNaN(d.getTime())) continue;
    const key = dayLabel(d);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(m);
  }
  const sorted = [...map.entries()].map(([label, items]) => ({
    label,
    items: items.sort(
      (a, b) =>
        new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
    ),
  }));
  return sorted.sort((a, b) => latestOf(b.items) - latestOf(a.items));
});

function latestOf(items: MeetingVo[]) {
  const ts = items
    .map((m) => new Date(m.startTime).getTime())
    .filter((t) => !isNaN(t));
  return ts.length ? Math.max(...ts) : 0;
}

function timeOf(iso: string) {
  return businessClock(iso);
}
function endTimeOf(m: MeetingVo) {
  const d = new Date(m.startTime);
  if (isNaN(d.getTime())) return "";
  d.setMinutes(d.getMinutes() + m.durationMinutes);
  return businessClock(d);
}
function timeRangeOf(m: MeetingVo) {
  const start = timeOf(m.startTime);
  const end = endTimeOf(m);
  if (start && end) return `${start} - ${end}`;
  return start || end || "--:--";
}
function displayTitle(m: MeetingVo) {
  const raw = (m.title || "").trim();
  if (!raw) return "未命名会议";
  // 左侧已明确展示起止时间，去掉「临时会议 12:15」末尾重复的时间后缀
  const stripped = raw.replace(/\s+\d{1,2}:\d{2}$/, "").trim();
  return stripped || raw;
}
function hostLabel(m: MeetingVo) {
  return (m.creatorName || m.hostName || "").trim();
}
function statusLabel(s: string) {
  return (
    dictLabelSync(DICT.meetingStatus, s) ||
    (s === "running"
      ? "进行中"
      : s === "scheduled"
        ? "待开始"
        : s === "ended"
          ? "已结束"
          : s)
  );
}
function statusClass(s: string) {
  if (s === "running") return "is-live";
  if (s === "scheduled") return "is-pending";
  return "is-muted";
}
function kindLabel(kind?: string) {
  switch (kind) {
    case "scheduled":
      return "预约会议";
    case "share":
      return "共享屏幕";
    case "voice":
      return "语音对讲";
    case "quick":
    default:
      return "快速会议";
  }
}
function effectiveRecording(m: MeetingVo): string {
  const id = m.thirdPartyMeetingId;
  if (id && readyRecordingIds.value.has(id)) return "ready";
  return m.recordingState || (m.cloudRecord ? "planned" : "none");
}
function recordingLabel(m: MeetingVo) {
  const state = effectiveRecording(m);
  if (state === "ready") return "已有云录制";
  if (state === "planned") {
    if (m.status === "running") return "云录制中";
    if (m.status === "scheduled" || m.status === "starting")
      return "已开启云录制";
  }
  return "";
}
function openPlayback(m: MeetingVo) {
  if (!m.thirdPartyMeetingId) return;
  router.push(`/recordings/play/${encodeURIComponent(m.thirdPartyMeetingId)}`);
}
function openMinutes(m: MeetingVo) {
  // 产品尚未接纪要服务：有标志时仍落到同场回放，避免空按钮。
  openPlayback(m);
}

function isJoined(m: MeetingVo) {
  return (
    meetingStore.inMeeting && String(meetingStore.meetingId) === String(m.id)
  );
}

function openSchedule() {
  editingMeeting.value = null;
  showScheduleDialog.value = true;
}
async function handleShare(m: MeetingVo) {
  const ok = await copyMeetingInvite({
    hostName: m.creatorName || m.hostName || "",
    title: m.title,
    meetingNo: m.meetingNo,
    startTime: m.startTime || m.startedAt,
    durationMinutes: m.durationMinutes,
  });
  if (ok) ElMessage.success("已复制会议邀请信息，可直接发送给参会人");
  else ElMessage.warning("复制失败，请手动复制会议号");
}

function openEdit(m: MeetingVo) {
  editingMeeting.value = m;
  showScheduleDialog.value = true;
}
async function goPreMeeting(m: MeetingVo) {
  if (m.meetingNo) {
    const res = await precheckMeeting(m.meetingNo);
    if (res.data && !res.data.joinable) {
      ElMessage.error(res.data.message || "会议不可加入");
      return;
    }
  }
  router.push(preJoinPath(m));
}

async function load(silent = false) {
  if (!silent || !allMeetings.value.length) loading.value = true;
  try {
    const [scheduled, running, ended, recordings] = await Promise.all([
      getMeetingList({ pageNum: 1, pageSize: 50, status: "scheduled" }),
      getMeetingList({ pageNum: 1, pageSize: 50, status: "running" }),
      getMeetingList({ pageNum: 1, pageSize: 50, status: "ended" }),
      getRecordingList({ pageNum: 1, pageSize: 100, days: 14 }).catch(
        () => null,
      ),
    ]);
    const ready = new Set<string>();
    for (const r of recordings?.rows || []) {
      if (r.meetingId && r.playbackUrl) ready.add(r.meetingId);
    }
    readyRecordingIds.value = ready;

    const merged = [
      ...(running.rows || []),
      ...(scheduled.rows || []),
      ...(ended.rows || []),
    ];
    const futureCutoff = new Date();
    futureCutoff.setDate(futureCutoff.getDate() + 8);
    const monthStart = new Date();
    monthStart.setHours(0, 0, 0, 0);
    const monthCutoff = new Date(monthStart);
    monthCutoff.setDate(monthCutoff.getDate() + 31);
    const pastCutoff = new Date();
    pastCutoff.setDate(pastCutoff.getDate() - 7);
    const seen = new Set<string>();
    const monthList: MeetingVo[] = [];
    allMeetings.value = merged.filter((m) => {
      const key = String(m.id);
      if (seen.has(key)) return false;
      seen.add(key);
      const d = new Date(m.startTime);
      if (isNaN(d.getTime())) return false;
      if (
        m.status !== "ended" &&
        m.status !== "cancelled" &&
        d >= monthStart &&
        d < monthCutoff
      ) {
        monthList.push(m);
      }
      if (m.status === "ended") return d >= pastCutoff;
      return d < futureCutoff;
    });
    upcomingMonthMeetings.value = monthList.sort(
      (a, b) =>
        new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
    );
  } catch {
    /* 401 由拦截器处理 */
  } finally {
    loading.value = false;
  }
}

async function handleJoin(m: MeetingVo) {
  if (meetingStore.inMeeting && String(meetingStore.meetingId) !== String(m.id)) {
    if (!(await guardSingleActiveMeeting(router))) return;
  }
  if (m.meetingNo) {
    const res = await precheckMeeting(m.meetingNo);
    if (res.data && !res.data.joinable) {
      ElMessage.error(res.data.message || "会议不可加入");
      return;
    }
  }
  router.push(preJoinPath(m));
}

async function handleCancel(m: MeetingVo) {
  try {
    await ElMessageBox.confirm(
      `确定取消会议「${m.title}」？取消后状态变为已取消。`,
      "取消会议",
      {
        type: "warning",
        confirmButtonText: "确定取消",
        cancelButtonText: "返回",
      },
    );
  } catch {
    return;
  }
  try {
    await cancelMeeting(m.id);
    // 就地更新状态并后台静默刷新，避免列表整体闪烁成「加载中…」
    allMeetings.value = allMeetings.value.filter((item) => item.id !== m.id);
    ElMessage.success("会议已取消");
    void load(true);
  } catch {
    /* 后端 msg 由 request 拦截器统一弹一次 */
  }
}

async function handleStop(m: MeetingVo) {
  try {
    await ElMessageBox.confirm(
      `确定结束会议？所有参会者将会被移出。`,
      "结束会议",
      {
        type: "warning",
      },
    );
  } catch {
    return;
  }
  try {
    await stopMeeting(m.id);
    // 先就地切换该行状态，再静默同步后端列表，消除整屏重载闪烁
    allMeetings.value = allMeetings.value.map((item) =>
      item.id === m.id
        ? { ...item, status: "ended", endReason: "normal" }
        : item,
    );
    ElMessage.success("会议已结束");
    void load(true);
  } catch {
    /* 后端 msg 由 request 拦截器统一弹一次 */
  }
}

let statusPollTimer: number | null = null;
const STATUS_POLL_MS = 15000;

function hasLiveOrPendingMeetings() {
  return allMeetings.value.some(
    (m) => m.status === "running" || m.status === "scheduled",
  );
}

function scheduleStatusPoll() {
  if (statusPollTimer !== null) {
    window.clearTimeout(statusPollTimer);
    statusPollTimer = null;
  }
  if (document.visibilityState !== "visible") return;
  if (!hasLiveOrPendingMeetings()) return;
  statusPollTimer = window.setTimeout(async () => {
    statusPollTimer = null;
    if (document.visibilityState === "visible" && hasLiveOrPendingMeetings()) {
      await load(true);
    }
    scheduleStatusPoll();
  }, STATUS_POLL_MS);
}

function onHomeVisibilityChange() {
  if (document.visibilityState === "visible") {
    if (hasLiveOrPendingMeetings()) {
      void load(true).finally(() => scheduleStatusPoll());
    }
  } else if (statusPollTimer !== null) {
    window.clearTimeout(statusPollTimer);
    statusPollTimer = null;
  }
}

onMounted(() => {
  getDict(DICT.meetingStatus);
  void load().finally(() => scheduleStatusPoll());
  document.addEventListener("visibilitychange", onHomeVisibilityChange);
  weatherAbort = new AbortController();
  void fetchGeoWeather(weatherAbort.signal).then((g) => {
    placeLine.value = g.place;
    weatherLine.value = g.weather;
    sunriseLine.value = g.sunrise;
    sunsetLine.value = g.sunset;
    windLine.value = [g.windDirection, g.windScale].filter(Boolean).join(" ");
  });
});

onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onHomeVisibilityChange);
  if (statusPollTimer !== null) {
    window.clearTimeout(statusPollTimer);
    statusPollTimer = null;
  }
  weatherAbort?.abort();
});
</script>

<style scoped>
.home-page {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 8px 14px 10px;
  display: flex;
  flex-direction: column;
}

/* 顶栏通栏：左日期+天气、右四个入口；给图标悬停上浮留出内边距，避免被裁切 */
.home-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px 28px;
  margin-bottom: 10px;
  padding: 10px 4px 6px;
  flex-shrink: 0;
  overflow: visible;
}

.home-hero-left {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-shrink: 1;
  min-width: 0;
}

.home-hero-date {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.home-day {
  font-size: 44px;
  font-weight: 620;
  letter-spacing: -0.04em;
  line-height: 1;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.home-hero-meta {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
}

.home-month-line {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.2;
}

.home-weekday-line {
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.2;
}

.home-weather {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 14px;
  border-left: 1px solid var(--border-soft);
  min-width: 0;
}

.home-place,
.home-wx {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
}

.home-place i,
.home-wx i {
  font-size: 13px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.home-weather-extra {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 14px;
  border-left: 1px solid var(--border-soft);
  min-width: 0;
}

.home-wx-detail {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.home-wx-detail i {
  font-size: 13px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.home-wx-sep {
  margin: 0 2px;
  color: var(--text-muted);
}

.home-launch {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: clamp(12px, 3.5vw, 36px);
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 4px 0;
  overflow: visible;
}

.launch-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 0;
  background: transparent;
  cursor: pointer;
  min-width: 72px;
  overflow: visible;
}

.launch-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.launch-orb {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  color: #fff;
  transition:
    transform 0.18s ease,
    box-shadow 0.18s ease;
}

.launch-item:hover:not(:disabled) .launch-orb {
  transform: translateY(-2px) scale(1.04);
  box-shadow: 0 8px 20px rgba(15, 23, 42, 0.12);
}

.launch-orb--blue {
  background: #165dff;
}
.launch-orb--cyan {
  background: #0bb4b0;
}
.launch-orb--green {
  background: #2fbf6b;
}
.launch-orb--orange {
  background: #f0871a;
}

.launch-orb--purple {
  position: relative;
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
}

.launch-badge {
  position: absolute;
  top: -5px;
  right: -6px;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: 999px;
  background: #ef4444;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  line-height: 20px;
  text-align: center;
  border: 2px solid var(--bg-card);
  box-shadow: 0 2px 6px rgba(239, 68, 68, 0.35);
  font-variant-numeric: tabular-nums;
}

.launch-label {
  font-size: 13px;
  font-weight: 550;
  color: var(--text-secondary);
  line-height: 1.3;
  white-space: nowrap;
}

.launch-item:hover:not(:disabled) .launch-label {
  color: var(--text-primary);
}

.home-secondary {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  margin: 0 0 14px;
  padding: 0;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.sec-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 4px;
  border: 0;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}

.sec-link i {
  font-size: 15px;
  color: var(--text-muted);
}

.sec-link:hover:not(:disabled) {
  color: var(--primary-text);
}

.sec-link:hover:not(:disabled) i {
  color: var(--primary-text);
}

.sec-link:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.sec-dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--border-color);
  flex-shrink: 0;
}

.sec-join {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  width: 360px;
  min-width: 0;
  height: 36px;
  margin-left: auto;
  padding: 0 4px 0 12px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 999px;
}

.sec-join:focus-within {
  border-color: var(--primary);
}

.sec-join-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: 0;
  background: transparent;
  outline: none;
  font-size: 13px;
  color: var(--text-primary);
}

.sec-join-input::placeholder {
  color: var(--text-muted);
}

.sec-join-btn {
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--primary-text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.sec-join-btn:disabled {
  color: var(--text-muted);
  cursor: not-allowed;
}

.sec-join-btn:not(:disabled):hover {
  background: var(--primary-soft);
}

.home-schedule {
  width: 100%;
  flex: 1 1 auto;
  min-height: 0;
  background: var(--bg-card);
  border: 1px solid var(--border-soft);
  border-radius: 16px;
  padding: 4px 4px 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.home-schedule-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  padding: 0 16px;
  flex-shrink: 0;
}

.home-schedule-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.home-schedule-title {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
  color: var(--text-primary);
}

.home-count {
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bg-hover);
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.home-schedule-tools {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
}

.home-text-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 30px;
  padding: 0 10px 0 12px;
  border: 1px solid var(--border-soft);
  border-radius: 999px;
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    border-color 0.16s ease,
    color 0.16s ease;
}

.home-text-btn i {
  font-size: 15px;
  line-height: 1;
  transition: transform 0.16s ease;
}

.home-text-btn:hover {
  background: var(--primary-soft);
  border-color: rgba(59, 130, 246, 0.3);
  color: var(--primary-text);
}

.home-text-btn:hover i {
  transform: translateX(2px);
}

.home-loading {
  padding: 36px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.home-meeting-groups {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 8px 8px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.home-meeting-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.group-label {
  padding: 10px 10px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}

.home-meeting-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.home-meeting-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 10px;
  border-radius: 12px;
  transition: background 0.15s ease;
}

.home-meeting-item:hover {
  background: var(--bg-hover);
}

.home-meeting-time {
  flex-shrink: 0;
  width: 108px;
  text-align: right;
}

.time-start {
  font-size: 13.5px;
  font-weight: 650;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
  white-space: nowrap;
}

.time-end {
  margin-top: 3px;
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.2;
  white-space: nowrap;
}

.home-meeting-rail {
  width: 3px;
  align-self: stretch;
  min-height: 28px;
  border-radius: 999px;
  background: var(--border-color);
  flex-shrink: 0;
}

.home-meeting-rail.live {
  background: var(--success);
}

.home-meeting-info {
  flex: 1;
  min-width: 0;
}

.home-meeting-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.home-meeting-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.home-kind {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 550;
  padding: 1px 7px;
  border-radius: 999px;
  line-height: 1.5;
  color: var(--text-secondary);
  background: var(--bg-hover);
}

.home-status {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 999px;
  line-height: 1.5;
}

.home-rec.rec-ready {
  color: var(--success-text, #15803d);
}
.home-rec.rec-planned {
  color: var(--text-muted);
}

.hm-btn-minutes {
  background: var(--primary-soft, rgba(22, 93, 255, 0.1));
  border-color: transparent;
  color: var(--primary-text, #165dff);
}

.home-status.is-live {
  color: var(--success-text);
  background: rgba(34, 197, 94, 0.12);
}

.home-status.is-pending {
  color: var(--warning-text);
  background: var(--warning-bg);
}

.home-status.is-muted {
  color: var(--text-muted);
  background: var(--bg-hover);
}

.home-meeting-meta {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.home-meeting-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.hm-btn {
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 550;
  cursor: pointer;
  white-space: nowrap;
}

.hm-btn:hover {
  border-color: var(--primary);
  color: var(--primary-text);
}

.hm-btn-primary {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}

.hm-btn-primary:hover {
  background: var(--primary-dark);
  border-color: var(--primary-dark);
  color: #fff;
}

.hm-btn-ghost {
  border-color: transparent;
  background: transparent;
  color: var(--text-muted);
}

.hm-btn-ghost:hover {
  background: var(--danger-bg);
  color: var(--danger-text);
  border-color: transparent;
}

.hm-btn-joined {
  background: var(--primary-soft);
  border-color: transparent;
  color: var(--primary-text);
  cursor: default;
}

.home-empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.6;
  flex: 1;
  min-height: 0;
  overflow: auto;
}

@media (max-width: 860px) {
  .home-hero {
    flex-direction: column;
    align-items: stretch;
    gap: 16px;
  }

  .home-launch {
    justify-content: space-between;
    width: 100%;
    gap: 0;
  }
}

@media (max-width: 767px) {
  .home-page {
    padding: 8px 10px calc(10px + var(--safe-bottom, 0px));
    gap: 10px;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  .home-hero {
    padding: 12px 14px;
    border-radius: 16px;
    gap: 12px;
  }

  .home-hero-left {
    flex-wrap: nowrap;
    align-items: center;
    gap: 12px;
  }

  .home-weather {
    border-left: 1px solid var(--border-soft);
    padding-left: 12px;
    width: auto;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }

  .home-day {
    font-size: 34px;
    line-height: 1;
  }

  /* 手机端原生 App 风格：3 列圆角图标宫格，带触控回弹 */
  .home-launch {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .launch-orb {
    width: 48px;
    height: 48px;
    border-radius: 14px;
    font-size: 21px;
  }

  .launch-item {
    min-width: 0;
    padding: 10px 4px 8px;
    border-radius: 14px;
    background: var(--bg-input);
    transition:
      transform 0.14s cubic-bezier(0.32, 0.72, 0, 1),
      background-color 0.14s ease;
  }
  .launch-item:active {
    transform: scale(0.95);
  }

  .launch-label {
    font-size: 12px;
  }

  .home-secondary {
    flex-wrap: wrap;
    gap: 8px;
    padding: 0;
  }

  .sec-join {
    margin-left: 0;
    width: 100%;
    min-width: 0;
    order: 3;
    flex: 1 1 100%;
    height: 42px;
    border-radius: 999px;
  }

  .home-schedule {
    border-radius: 16px;
    padding: 12px;
  }

  .home-meeting-item {
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px 10px;
    border-radius: 12px;
    transition:
      transform 0.14s ease,
      background-color 0.14s ease;
  }
  .home-meeting-item:active {
    transform: scale(0.99);
  }

  .home-meeting-meta {
    font-size: 12px;
  }

  .home-meeting-actions {
    width: 100%;
    padding-left: 0;
    justify-content: flex-start;
    gap: 8px;
  }

  .hm-btn {
    border-radius: 999px;
    min-height: 36px;
    padding: 0 12px;
  }
}

/* 折叠屏展开态（600px ~ 960px）：紧凑 4 列入口 + 自适应间距，避免拉伸空洞 */
@media (min-width: 600px) and (max-width: 960px) {
  .home-page {
    padding: 10px 14px calc(12px + var(--safe-bottom, 0px));
  }

  .home-launch {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
  }
}
.home-end-reason {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}
.home-end-reason.is-normal {
  background: var(--bg-hover);
  color: var(--text-muted);
}
.home-end-reason.is-abnormal {
  background: rgba(245, 158, 11, 0.14);
  color: var(--warning-text, #b45309);
}
/* ── 手机端独立 App 形态首页（参照腾讯会议 App） ── */
.m-app-home {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-dark);
  overflow: hidden;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}
.m-app-actions {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  padding: 16px 14px 12px;
  background: var(--bg-card);
  flex-shrink: 0;
}
.m-app-key {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  border: 0;
  background: transparent;
  padding: 4px 0;
  cursor: pointer;
  transition: transform 0.14s cubic-bezier(0.32, 0.72, 0, 1);
}
.m-app-key:active {
  transform: scale(0.92);
}
.m-app-key:disabled {
  opacity: 0.55;
}
.m-app-key-ic {
  width: 54px;
  height: 54px;
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 25px;
  color: #fff;
  box-shadow: 0 6px 16px rgba(15, 23, 42, 0.12);
}
.m-app-key-ic.is-blue {
  background: linear-gradient(135deg, #2563eb, #3b82f6);
}
.m-app-key-ic.is-indigo {
  background: linear-gradient(135deg, #4f46e5, #6366f1);
}
.m-app-key-ic.is-green {
  background: linear-gradient(135deg, #059669, #10b981);
}
.m-app-key-ic.is-orange {
  background: linear-gradient(135deg, #ea580c, #f97316);
}
.m-app-key-txt {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
}
.m-app-subbar {
  display: flex;
  gap: 10px;
  padding: 0 14px 14px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-soft);
  flex-shrink: 0;
}
.m-app-pill {
  flex: 1;
  height: 36px;
  border-radius: 10px;
  border: 1px solid var(--border-soft);
  background: var(--bg-input);
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.m-app-pill:active {
  background: var(--bg-hover);
}
.m-app-list-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.m-app-list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px 8px;
  flex-shrink: 0;
}
.m-app-list-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
}
.m-app-list-title small {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
}
.m-app-all-btn {
  border: 0;
  background: transparent;
  color: var(--primary-text);
  font-size: 13px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  cursor: pointer;
}
.m-app-groups {
  flex: 1;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 0 14px calc(16px + var(--safe-bottom, 0px));
}
.m-app-group {
  margin-bottom: 12px;
}
.m-app-group-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  padding: 6px 2px;
}
.m-app-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 13px 14px;
  margin-bottom: 8px;
  border-radius: 14px;
  background: var(--bg-card);
  border: 1px solid var(--border-soft);
  transition: transform 0.12s ease;
}
.m-app-card:active {
  transform: scale(0.985);
}
.m-app-card-main {
  min-width: 0;
  flex: 1;
}
.m-app-card-top {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.m-app-card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.m-app-card-status {
  flex-shrink: 0;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 6px;
  font-weight: 500;
}
.m-app-card-status.st-running {
  background: rgba(16, 185, 129, 0.14);
  color: #059669;
}
.m-app-card-status.st-scheduled {
  background: var(--primary-soft);
  color: var(--primary-text);
}
.m-app-card-status.st-ended {
  background: var(--bg-input);
  color: var(--text-muted);
}
.m-app-card-meta {
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 4px;
  font-variant-numeric: tabular-nums;
}
.m-app-card-ops {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.m-app-op-icon {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: 1px solid var(--border-soft);
  background: var(--bg-input);
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  cursor: pointer;
}
.m-app-op-join {
  height: 34px;
  padding: 0 14px;
  border-radius: 10px;
  border: 0;
  background: var(--primary);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.m-app-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-muted);
  padding: 36px 20px;
}
.m-app-empty-ic {
  font-size: 40px;
  opacity: 0.45;
}
.m-app-empty-cta {
  margin-top: 4px;
  height: 38px;
  padding: 0 20px;
  border-radius: 999px;
  border: 0;
  background: var(--primary);
  color: #fff;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
}
</style>
