<template>
  <div v-if="modelValue" class="ls-mask" @click.self="close">
    <div class="ls-panel" role="dialog" aria-modal="true" aria-label="设置">
      <header class="ls-head">
        <h3>设置</h3>
        <button type="button" class="ls-close" title="关闭" @click="close">
          <i class="ri-close-line" />
        </button>
      </header>

      <div class="ls-body">
        <nav class="ls-nav">
          <button
            v-for="t in tabs"
            :key="t.id"
            type="button"
            class="ls-nav-item"
            :class="{ active: tab === t.id }"
            @click="tab = t.id"
          >
            <i :class="t.icon" />
            <span>{{ t.label }}</span>
          </button>
        </nav>

        <div class="ls-content">
          <!-- 视频检测 -->
          <section v-if="tab === 'video'" class="ls-section">
            <div class="ls-preview">
              <video
                v-show="previewOk"
                ref="videoRef"
                class="ls-video"
                autoplay
                muted
                playsinline
              />
              <div v-if="!previewOk" class="ls-preview-empty">
                {{ previewHint || "授权摄像头后可预览" }}
              </div>
            </div>
            <label class="ls-row">
              <span>摄像头</span>
              <select
                v-model="cameraId"
                class="ls-select"
                @change="restartPreview"
              >
                <option value="">系统默认</option>
                <option
                  v-for="d in cameras"
                  :key="d.deviceId"
                  :value="d.deviceId"
                >
                  {{ d.label || "摄像头" }}
                </option>
              </select>
            </label>
            <label class="ls-check">
              <input v-model="mirror" type="checkbox" />
              预览镜像（仅本机预览，不影响对端）
            </label>
            <button
              type="button"
              class="ls-btn"
              :disabled="previewBusy"
              @click="restartPreview"
            >
              {{ previewBusy ? "开启中…" : "重新开启预览" }}
            </button>
          </section>

          <!-- 音频检测 -->
          <section v-else-if="tab === 'audio'" class="ls-section">
            <h4>扬声器</h4>
            <div class="ls-row-stack">
              <select v-model="speakerId" class="ls-select">
                <option value="">系统默认</option>
                <option
                  v-for="d in speakers"
                  :key="d.deviceId"
                  :value="d.deviceId"
                >
                  {{ d.label || "扬声器" }}
                </option>
              </select>
              <button
                type="button"
                class="ls-btn ls-btn-fixed"
                :class="{ 'ls-btn-active': speakerBusy }"
                :disabled="speakerBusy"
                @click="testSpeaker"
              >
                检测扬声器
              </button>
            </div>
            <div class="ls-meter">
              <span>输出音量</span>
              <div class="ls-meter-bar ls-meter-out">
                <span class="ls-meter-fill" :style="{ width: speakerLevel + '%' }" />
              </div>
            </div>
            <h4>麦克风</h4>
            <div class="ls-row-stack">
              <select v-model="micId" class="ls-select">
                <option value="">系统默认</option>
                <option v-for="d in mics" :key="d.deviceId" :value="d.deviceId">
                  {{ d.label || "麦克风" }}
                </option>
              </select>
              <button
                type="button"
                class="ls-btn ls-btn-fixed"
                :class="{ 'ls-btn-active': micActive }"
                :disabled="micActive"
                @click="testMic"
              >
                检测麦克风
              </button>
            </div>
            <div class="ls-meter">
              <span>输入电平</span>
              <div class="ls-meter-bar">
                <span class="ls-meter-fill" :style="{ width: micLevel + '%' }" />
              </div>
            </div>
            <p class="ls-hint">
              音频设备列表来自本浏览器；入会后可在会中设置里再次调整。
            </p>
          </section>

          <!-- 网络 -->
          <section v-else-if="tab === 'network'" class="ls-section">
            <div class="ls-net-hero">
              <div>
                <h4>网络检测</h4>
                <p>{{ netSubtitle }}</p>
              </div>
              <button
                type="button"
                class="ls-btn ls-btn-primary"
                :disabled="netBusy"
                @click="runNetCheck"
              >
                {{ netBusy ? "检测中…" : "开始检测" }}
              </button>
            </div>
            <ul class="ls-net-list">
              <li v-for="item in netItems" :key="item.name">
                <span>{{ item.name }}</span>
                <em :class="item.level">{{ item.status }}</em>
              </li>
            </ul>
          </section>

          <!-- 关于 -->
          <section v-else class="ls-section ls-about">
            <img
              :src="appIcon"
              alt=""
              class="ls-about-logo"
              width="72"
              height="72"
            />
            <h4>卫通会议</h4>
            <p class="ls-about-en">Weitong Meeting</p>
            <p class="ls-about-ver">
              {{ release.version }} · {{ release.date }}
            </p>
            <div class="ls-about-actions">
              <button
                type="button"
                class="ls-btn ls-btn-primary"
                @click="emit('open-changelog')"
              >
                版本介绍
              </button>
              <button
                type="button"
                class="ls-btn"
                @click="emit('open-legal', 'terms')"
              >
                服务协议
              </button>
              <button
                type="button"
                class="ls-btn"
                @click="emit('open-legal', 'privacy')"
              >
                隐私政策
              </button>
              <div class="ls-about-half-row">
                <button
                  type="button"
                  class="ls-btn ls-btn-half"
                  :class="{ liked: liked }"
                  :disabled="liked"
                  @click="onLike"
                >
                  <i :class="liked ? 'ri-thumb-up-fill' : 'ri-thumb-up-line'" />
                  {{ liked ? `已赞 ${likeCount}` : "点个赞" }}
                </button>
                <button
                  type="button"
                  class="ls-btn ls-btn-half"
                  @click="feedbackOpen = true"
                >
                  <i class="ri-chat-smile-2-line" />
                  吐个槽
                </button>
              </div>
            </div>
            <p class="ls-about-copy">
              © {{ year }} 卫星应用创新研究院 · 浙江大学EmNets ·
              卫通边云协同架构
            </p>
          </section>
        </div>
      </div>
    </div>

    <!-- 吐个槽：典型问题半星评分 -->
    <div v-if="feedbackOpen" class="fb-mask" @click.self="feedbackOpen = false">
      <div class="fb-panel" role="dialog" aria-modal="true" aria-label="吐个槽">
        <header class="fb-head">
          <h4>吐个槽</h4>
          <button
            type="button"
            class="ls-close"
            title="关闭"
            @click="feedbackOpen = false"
          >
            <i class="ri-close-line" />
          </button>
        </header>
        <p class="fb-hint">请为下列典型问题打分，可点半星（1–5 星）</p>
        <ul class="fb-list">
          <li v-for="item in feedbackItems" :key="item.id">
            <span class="fb-label">{{ item.label }}</span>
            <el-rate
              v-model="item.score"
              allow-half
              :colors="rateColors"
              void-color="#CBD5E1"
              clearable
            />
          </li>
        </ul>
        <label class="fb-more">
          <span class="fb-more-label">更多意见</span>
          <textarea
            v-model="feedbackMore"
            class="fb-more-input"
            maxlength="300"
            rows="4"
            placeholder="欢迎补充具体建议或遇到的问题（选填，最多 300 字）"
          />
          <span class="fb-more-count">{{ feedbackMore.length }}/300</span>
        </label>
        <footer class="fb-foot">
          <button type="button" class="ls-btn" @click="feedbackOpen = false">
            取消
          </button>
          <button
            type="button"
            class="ls-btn ls-btn-primary"
            @click="submitFeedback"
          >
            提交
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import appIcon from "@/assets/icon.png";
import { currentRelease } from "@/data/changelog";
import type { LegalDocId } from "@/data/legal";
import { playMelodyToSink, probeNetwork } from "@/utils/mediaTest";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  "update:modelValue": [boolean];
  "open-legal": [LegalDocId];
  "open-changelog": [];
}>();

const release = currentRelease();
const tab = ref<"video" | "audio" | "network" | "about">("video");
const year = new Date().getFullYear();

const tabs = [
  { id: "video" as const, label: "视频", icon: "ri-vidicon-line" },
  { id: "audio" as const, label: "音频", icon: "ri-volume-up-line" },
  { id: "network" as const, label: "网络检测", icon: "ri-global-line" },
  { id: "about" as const, label: "关于我们", icon: "ri-information-line" },
];

const LIKE_FLAG_KEY = "weitong.about.liked";
const LIKE_COUNT_KEY = "weitong.about.likeCount";
const FEEDBACK_KEY = "weitong.about.feedback";

const liked = ref(localStorage.getItem(LIKE_FLAG_KEY) === "1");
const likeCount = ref(
  Math.max(0, Number(localStorage.getItem(LIKE_COUNT_KEY) || "0") || 0),
);
const feedbackOpen = ref(false);
const feedbackMore = ref("");
const rateColors = ["#F5B14C", "#F5B14C", "#165DFF"] as string[];

type FeedbackItem = { id: string; label: string; score: number };
const feedbackItems = ref<FeedbackItem[]>([
  { id: "login", label: "登录是否顺畅", score: 0 },
  { id: "av", label: "音视频清晰度", score: 0 },
  { id: "stable", label: "会议稳定性", score: 0 },
  { id: "ui", label: "界面易用性", score: 0 },
  { id: "overall", label: "整体满意度", score: 0 },
]);

function onLike() {
  if (liked.value) {
    ElMessage.info("您已经点过赞了");
    return;
  }
  liked.value = true;
  likeCount.value += 1;
  localStorage.setItem(LIKE_FLAG_KEY, "1");
  localStorage.setItem(LIKE_COUNT_KEY, String(likeCount.value));
  ElMessage.success("感谢点赞");
}

function submitFeedback() {
  const more = feedbackMore.value.trim().slice(0, 300);
  const rated = feedbackItems.value.filter((i) => i.score > 0);
  if (!rated.length && !more) {
    ElMessage.warning("请至少给一项打分，或填写更多意见");
    return;
  }
  const payload = {
    at: new Date().toISOString(),
    scores: feedbackItems.value.map((i) => ({
      id: i.id,
      label: i.label,
      score: i.score,
    })),
    more,
  };
  localStorage.setItem(FEEDBACK_KEY, JSON.stringify(payload));
  feedbackOpen.value = false;
  feedbackMore.value = "";
  ElMessage.success("已收到您的反馈，谢谢");
}

const cameras = ref<MediaDeviceInfo[]>([]);
const mics = ref<MediaDeviceInfo[]>([]);
const speakers = ref<MediaDeviceInfo[]>([]);
const cameraId = ref("");
const micId = ref("");
const speakerId = ref("");
const mirror = ref(true);
const previewOk = ref(false);
const previewBusy = ref(false);
const previewHint = ref("");
const videoRef = ref<HTMLVideoElement | null>(null);
let previewStream: MediaStream | null = null;

const speakerBusy = ref(false);
const speakerLevel = ref(0);
const micActive = ref(false);
const micLevel = ref(0);
let micStream: MediaStream | null = null;
let micTimer = 0;
let micAnalyser: AnalyserNode | null = null;
let micCtx: AudioContext | null = null;
let micStopTimer = 0;
let micPeak = 0;
const MIC_TEST_MS = 10000;

const netBusy = ref(false);
const netSubtitle = ref("检测本页到会控服务的连通与往返时延");
type NetLevel = "" | "good" | "fair" | "poor" | "pending";
const netItems = ref<{ name: string; status: string; level: NetLevel }[]>([
  { name: "浏览器在线状态", status: "待检测", level: "pending" },
  { name: "安全连接（HTTPS/本地）", status: "待检测", level: "pending" },
  { name: "会控服务可达性", status: "待检测", level: "pending" },
  { name: "往返时延", status: "待检测", level: "pending" },
]);

function close() {
  emit("update:modelValue", false);
}

async function refreshDevices() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    cameras.value = list.filter((d) => d.kind === "videoinput");
    mics.value = list.filter((d) => d.kind === "audioinput");
    speakers.value = list.filter((d) => d.kind === "audiooutput");
  } catch {
    /* 无权限时列表可能为空 */
  }
}

function stopPreview() {
  previewStream?.getTracks().forEach((t) => t.stop());
  previewStream = null;
  if (videoRef.value) videoRef.value.srcObject = null;
  previewOk.value = false;
}

async function restartPreview() {
  previewBusy.value = true;
  previewHint.value = "";
  stopPreview();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: cameraId.value ? { deviceId: { exact: cameraId.value } } : true,
      audio: false,
    });
    previewStream = stream;
    await refreshDevices();
    await nextTick();
    if (videoRef.value) {
      videoRef.value.srcObject = stream;
      videoRef.value.style.transform = mirror.value ? "scaleX(-1)" : "none";
      await videoRef.value.play().catch(() => undefined);
    }
    previewOk.value = true;
  } catch {
    previewHint.value = "无法打开摄像头，请检查浏览器权限或设备占用";
    previewOk.value = false;
  } finally {
    previewBusy.value = false;
  }
}

watch(mirror, (v) => {
  if (videoRef.value)
    videoRef.value.style.transform = v ? "scaleX(-1)" : "none";
});

async function testSpeaker() {
  if (speakerBusy.value) return;
  speakerBusy.value = true;
  speakerLevel.value = 0;
  try {
    const r = await playMelodyToSink(speakerId.value, (lv) => {
      speakerLevel.value = lv;
    });
    if (!r.ok) ElMessage.warning(r.reason || "无法播放试听曲");
  } finally {
    speakerBusy.value = false;
    speakerLevel.value = 0;
  }
}

function stopMicMeter() {
  if (micStopTimer) {
    window.clearTimeout(micStopTimer);
    micStopTimer = 0;
  }
  if (micTimer) {
    window.clearInterval(micTimer);
    micTimer = 0;
  }
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  micAnalyser = null;
  void micCtx?.close();
  micCtx = null;
  micPeak = 0;
  micLevel.value = 0;
  micActive.value = false;
}

async function testMic() {
  if (micActive.value) return;
  stopMicMeter();
  micActive.value = true;
  try {
    // 约束尽量宽松：部分 Windows 设备在关掉 EC/NS 或强制单声道时会拿到静音轨
    const audioConstraints: boolean | MediaTrackConstraints = micId.value
      ? { deviceId: { ideal: micId.value } }
      : true;

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    });
    const track = micStream.getAudioTracks()[0];
    if (!track || track.readyState !== "live") {
      throw new Error("mic track not live");
    }
    await refreshDevices();

    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    micCtx = new AC();
    if (micCtx.state !== "running") await micCtx.resume();

    const src = micCtx.createMediaStreamSource(micStream);
    const preGain = micCtx.createGain();
    preGain.gain.value = 8;
    micAnalyser = micCtx.createAnalyser();
    micAnalyser.fftSize = 512;
    micAnalyser.minDecibels = -90;
    micAnalyser.maxDecibels = -10;
    micAnalyser.smoothingTimeConstant = 0.5;
    // 接到静音 destination，避免部分浏览器对「未输出图」不做拉流，导致分析数据恒静音
    const mute = micCtx.createGain();
    mute.gain.value = 0;
    src.connect(preGain);
    preGain.connect(micAnalyser);
    micAnalyser.connect(mute);
    mute.connect(micCtx.destination);

    const timeData = new Uint8Array(micAnalyser.fftSize);
    const freqData = new Uint8Array(micAnalyser.frequencyBinCount);
    micTimer = window.setInterval(() => {
      if (!micAnalyser || !micActive.value) return;
      micAnalyser.getByteTimeDomainData(timeData);
      micAnalyser.getByteFrequencyData(freqData);
      let peak = 0;
      for (let i = 0; i < timeData.length; i++) {
        const d = Math.abs(timeData[i] - 128);
        if (d > peak) peak = d;
      }
      let freqSum = 0;
      for (let i = 0; i < freqData.length; i++) freqSum += freqData[i];
      const freqAvg = freqSum / freqData.length;
      // 时域峰值 + 频域均值，映射到 0–100；人声常见峰值约 8–40
      const instant = Math.max((peak / 128) * 100, (freqAvg / 255) * 140);
      micPeak = Math.max(instant, micPeak * 0.72);
      micLevel.value = Math.min(100, Math.round(micPeak));
    }, 50);

    micStopTimer = window.setTimeout(stopMicMeter, MIC_TEST_MS);
  } catch {
    stopMicMeter();
    ElMessage.warning("无法打开麦克风，请检查浏览器权限");
  }
}

async function runNetCheck() {
  netBusy.value = true;
  netSubtitle.value = "正在检测…";
  const secure =
    location.protocol === "https:" ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1";
  netItems.value = [
    {
      name: "浏览器在线状态",
      status: navigator.onLine ? "在线" : "离线",
      level: navigator.onLine ? "good" : "poor",
    },
    {
      name: "安全连接（HTTPS/本地）",
      status: secure ? "符合" : "非安全上下文",
      level: secure ? "good" : "fair",
    },
    { name: "会控服务可达性", status: "检测中…", level: "pending" },
    { name: "往返时延", status: "检测中…", level: "pending" },
  ];
  const probe = await probeNetwork();
  if (!probe.ok) {
    netItems.value[2] = {
      name: "会控服务可达性",
      status: "不可达",
      level: "poor",
    };
    netItems.value[3] = { name: "往返时延", status: "—", level: "poor" };
    netSubtitle.value = "未连接到会控服务，请确认后端已启动";
  } else {
    const grade =
      probe.rttMs < 150 ? "good" : probe.rttMs < 400 ? "fair" : "poor";
    netItems.value[2] = {
      name: "会控服务可达性",
      status: "可达",
      level: "good",
    };
    netItems.value[3] = {
      name: "往返时延",
      status: `${probe.rttMs} ms · 抖动 ${probe.jitterMs} ms`,
      level: grade,
    };
    netSubtitle.value =
      grade === "good"
        ? "网络良好，可流畅进行视频会议"
        : grade === "fair"
          ? "网络一般，建议减少同时上行路数"
          : "时延偏高，会议体验可能受影响";
  }
  netBusy.value = false;
}

watch(
  () => tab.value,
  async (t) => {
    if (t === "video") {
      await refreshDevices();
      await restartPreview();
      return;
    }
    stopPreview();
    if (t === "audio") await refreshDevices();
    else stopMicMeter();
  },
);

onBeforeUnmount(() => {
  stopPreview();
  stopMicMeter();
});

watch(
  () => props.modelValue,
  (open) => {
    if (!open) {
      stopPreview();
      stopMicMeter();
      feedbackOpen.value = false;
    } else {
      void refreshDevices();
      // 默认落在视频页：打开面板即申请摄像头并显示预览
      if (tab.value === "video") void restartPreview();
    }
  },
);
</script>

<style scoped>
.ls-mask {
  position: fixed;
  inset: 0;
  z-index: 1100;
  background: rgba(15, 23, 42, 0.5);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.ls-panel {
  width: min(920px, 100%);
  height: min(640px, 90vh);
  background: var(--bg-card);
  color: var(--text-primary);
  border-radius: 14px;
  border: 1px solid var(--border-color);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.28);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.ls-head {
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  border-bottom: 1px solid var(--border-soft);
}
.ls-head h3 {
  font-size: 16px;
  font-weight: 650;
}
.ls-close {
  position: absolute;
  right: 12px;
  top: 10px;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 18px;
}
.ls-close:hover {
  background: var(--bg-hover);
}
.ls-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.ls-nav {
  width: 168px;
  flex-shrink: 0;
  padding: 12px 10px;
  background: var(--bg-soft);
  border-right: 1px solid var(--border-soft);
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: auto;
}
.ls-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
  cursor: pointer;
  text-align: left;
}
.ls-nav-item i {
  font-size: 16px;
}
.ls-nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.ls-nav-item.active {
  background: var(--primary);
  color: #fff;
}
.ls-content {
  flex: 1;
  padding: 20px 24px;
  overflow: auto;
}
.ls-section h4 {
  font-size: 14px;
  font-weight: 650;
  margin: 14px 0 10px;
}
.ls-section h4:first-child {
  margin-top: 0;
}
.ls-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  font-size: 13px;
}
.ls-row-stack {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}
.ls-select {
  flex: 1;
  min-width: 0;
  height: 36px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-input);
  color: var(--text-primary);
  padding: 0 10px;
}
.ls-btn {
  height: 36px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.ls-btn:hover:not(:disabled) {
  background: var(--bg-hover);
}
.ls-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.ls-btn-fixed {
  min-width: 108px;
  box-sizing: border-box;
}
.ls-btn-active {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 28%, transparent);
}
.ls-btn-active:hover:not(:disabled) {
  background: var(--primary-dark, var(--primary));
}
.ls-btn-active:disabled {
  opacity: 1;
  cursor: default;
}
.ls-btn-primary {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.ls-btn-primary:hover:not(:disabled) {
  background: var(--primary-dark);
}
.ls-hint {
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-muted);
  margin-bottom: 10px;
}
.ls-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin: 10px 0 14px;
  color: var(--text-secondary);
}
.ls-preview {
  width: 100%;
  aspect-ratio: 16 / 9;
  min-height: 280px;
  max-height: min(420px, 48vh);
  border-radius: 12px;
  background: #0b1220;
  overflow: hidden;
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ls-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ls-preview-empty {
  color: #94a3b8;
  font-size: 13px;
  padding: 16px;
  text-align: center;
}
.ls-meter {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--text-secondary);
  margin: 8px 0 12px;
}
.ls-meter > span {
  flex: 0 0 56px;
}
.ls-meter-bar {
  flex: 1;
  height: 8px;
  border-radius: 999px;
  background: var(--bg-hover);
  overflow: hidden;
}
.ls-meter-fill {
  display: block;
  height: 100%;
  width: 0;
  background: linear-gradient(90deg, #38bdf8, #165dff);
  border-radius: inherit;
  transition: width 40ms linear;
}
.ls-meter-out .ls-meter-fill {
  background: linear-gradient(90deg, #34d399, #165dff);
}
.ls-net-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border-soft);
  margin-bottom: 8px;
}
.ls-net-hero p {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}
.ls-net-list {
  list-style: none;
}
.ls-net-list li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 0;
  border-bottom: 1px solid var(--border-soft);
  font-size: 13px;
}
.ls-net-list em {
  font-style: normal;
  color: var(--text-muted);
}
.ls-net-list em.good {
  color: var(--success-text);
}
.ls-net-list em.fair {
  color: var(--warning-text);
}
.ls-net-list em.poor {
  color: var(--danger-text);
}
.ls-about {
  text-align: center;
  padding-top: 12px;
}
.ls-about-logo {
  border-radius: 16px;
  margin-bottom: 10px;
  box-shadow: 0 0 20px rgba(0, 180, 255, 0.25);
}
.ls-about-en {
  font-size: 12px;
  color: var(--text-muted);
}
.ls-about-ver {
  margin: 10px 0 16px;
  font-size: 13px;
  color: var(--text-secondary);
}
.ls-about-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 240px;
  margin: 0 auto 18px;
}
.ls-about-actions .ls-btn {
  width: 100%;
}
.ls-about-half-row {
  display: flex;
  gap: 10px;
}
.ls-btn-half {
  flex: 1;
  width: auto !important;
  min-width: 0;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  font-size: 12px;
}
.ls-btn-half.liked {
  color: var(--primary-text);
  border-color: color-mix(in srgb, var(--primary) 40%, var(--border-color));
  background: var(--primary-soft);
}
.ls-about-copy {
  font-size: 11px;
  color: var(--text-muted);
}

.fb-mask {
  position: fixed;
  inset: 0;
  z-index: 1120;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.fb-panel {
  width: min(420px, 100%);
  background: var(--bg-card);
  color: var(--text-primary);
  border-radius: 14px;
  border: 1px solid var(--border-color);
  box-shadow: 0 20px 48px rgba(0, 0, 0, 0.28);
  padding: 16px 18px 18px;
}
.fb-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.fb-head h4 {
  font-size: 16px;
  font-weight: 650;
  margin: 0;
}
.fb-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 12px;
}
.fb-list {
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
}
.fb-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-soft);
}
.fb-list li:last-child {
  border-bottom: none;
}
.fb-label {
  font-size: 13px;
  color: var(--text-secondary);
  text-align: left;
  flex: 1;
  min-width: 0;
}
.fb-more {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 4px 0 16px;
  text-align: left;
}
.fb-more-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.fb-more-input {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  min-height: 88px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--border-color);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.55;
  outline: none;
}
.fb-more-input:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(22, 93, 255, 0.12);
}
.fb-more-input::placeholder {
  color: var(--text-muted);
}
.fb-more-count {
  align-self: flex-end;
  font-size: 11px;
  color: var(--text-muted);
}
.fb-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
</style>
