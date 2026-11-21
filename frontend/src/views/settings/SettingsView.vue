<template>
  <div class="settings-page">
    <div class="page-head"><h2>设置</h2></div>

    <div class="settings-body">
      <!-- 账号信息：原型这两行是矢量图层，头像/登录名是我方已有能力，保留在最前 -->
      <section class="settings-section">
        <h3 class="section-title">账号信息</h3>
        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">头像</span>
            <span class="setting-desc"
              >支持 PNG / JPEG / WebP，上传前自动裁成 256×256</span
            >
          </div>
          <div class="setting-right avatar-right">
            <span class="avatar-preview">
              <img
                v-if="avatarSrc"
                :src="avatarSrc"
                alt="当前头像"
                @error="onAvatarError"
              />
              <em v-else>{{ avatarChar }}</em>
            </span>
            <input
              ref="avatarInputRef"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              @change="onAvatarPicked"
            />
            <el-button size="small" :loading="avatarBusy" @click="pickAvatar">
              {{ avatarSrc ? "更换头像" : "上传头像" }}
            </el-button>
            <el-button
              v-if="avatarSrc"
              size="small"
              type="danger"
              plain
              :loading="avatarBusy"
              @click="removeAvatar"
            >
              移除
            </el-button>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">登录账号</span>
            <span class="setting-desc">{{
              userStore.userInfo?.username || "–"
            }}</span>
          </div>
          <div class="setting-right">
            <!-- 账号名不可改，改的是"别人看到的我"：显示名（失焦即存，空值不覆盖） -->
            <input
              v-model="displayName"
              class="setting-input"
              maxlength="32"
              placeholder="显示名"
              @change="onDisplayNameBlur"
            />
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h3 class="section-title">视频</h3>

        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">摄像头</span>
            <span class="setting-desc">选择入会时使用的摄像头设备</span>
          </div>
          <div class="setting-right">
            <select v-model="form.cameraDeviceId" class="setting-select">
              <option value="">默认摄像头</option>
              <option
                v-for="d in devices.cameras"
                :key="d.deviceId"
                :value="d.deviceId"
              >
                {{ d.label || "摄像头 " + d.deviceId.slice(0, 8) }}
              </option>
            </select>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">视频分辨率</span>
            <span class="setting-desc"
              >采集期望值，实际以设备能力为准；越高越清晰、占带宽也越多</span
            >
          </div>
          <div class="setting-right">
            <select v-model="form.videoResolution" class="setting-select">
              <option value="480p">480P 流畅</option>
              <option value="720p">720P 标清</option>
              <option value="1080p">1080P 高清（推荐）</option>
            </select>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">最大帧率</span>
            <span class="setting-desc">按本机摄像头能力列出可选档位</span>
          </div>
          <div class="setting-right">
            <select v-model.number="form.videoMaxFps" class="setting-select">
              <option v-for="fps in fpsOptions" :key="fps" :value="fps">
                {{ fps }} FPS
              </option>
            </select>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">目标码率</span>
            <span class="setting-desc"
              >自适应不设上限；选档位则限制上行码率，重新开启摄像头后生效</span
            >
          </div>
          <div class="setting-right">
            <select
              v-model.number="form.videoTargetBitrateKbps"
              class="setting-select"
            >
              <option :value="0">自适应</option>
              <option :value="20">20 Kbps</option>
              <option :value="40">40 Kbps</option>
              <option :value="60">60 Kbps</option>
              <option :value="80">80 Kbps</option>
              <option :value="100">100 Kbps</option>
              <option :value="150">150 Kbps</option>
              <option :value="200">200 Kbps</option>
              <option :value="300">300 Kbps</option>
              <option :value="400">400 Kbps</option>
              <option :value="500">500 Kbps</option>
              <option :value="600">600 Kbps</option>
              <option :value="700">700 Kbps</option>
              <option :value="800">800 Kbps</option>
              <option :value="900">900 Kbps</option>
              <option :value="1000">1000 Kbps</option>
            </select>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">镜像我的视频</span>
            <span class="setting-desc"
              >本地预览画面左右翻转，观看方不受影响</span
            >
          </div>
          <div class="setting-right">
            <div
              class="toggle-switch"
              :class="{ on: form.mirrorVideo }"
              @click="form.mirrorVideo = !form.mirrorVideo"
            ></div>
          </div>
        </div>

        <div v-if="BG_BLUR_AVAILABLE" class="setting-row">
          <div class="setting-left">
            <span class="setting-label">背景虚化</span>
            <span class="setting-desc">自动识别人像并虚化背景</span>
          </div>
          <div class="setting-right">
            <div
              class="toggle-switch"
              :class="{ on: form.vbMode === 'blur' }"
              @click="form.vbMode = form.vbMode === 'blur' ? 'off' : 'blur'"
            ></div>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">人脸增强</span>
            <span class="setting-desc">{{
              faceSupported ? "只影响对方看到的画面" : faceNotice
            }}</span>
          </div>
          <div class="setting-right">
            <div
              class="toggle-switch"
              :class="{ on: faceSupported && form.faceEnhancement === 1 }"
              @click="toggleFace"
            ></div>
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h3 class="section-title">音频</h3>

        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">麦克风</span>
            <span class="setting-desc">选择入会时使用的麦克风设备</span>
          </div>
          <div class="setting-right">
            <select v-model="form.microphoneDeviceId" class="setting-select">
              <option value="">默认麦克风</option>
              <option
                v-for="d in devices.microphones"
                :key="d.deviceId"
                :value="d.deviceId"
              >
                {{ d.label || "麦克风 " + d.deviceId.slice(0, 8) }}
              </option>
            </select>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">扬声器</span>
            <span class="setting-desc">选择播放会议声音的输出设备</span>
          </div>
          <div class="setting-right">
            <select v-model="form.speakerDeviceId" class="setting-select">
              <option value="">默认扬声器</option>
              <option
                v-for="d in devices.speakers"
                :key="d.deviceId"
                :value="d.deviceId"
              >
                {{ d.label || "扬声器 " + d.deviceId.slice(0, 8) }}
              </option>
            </select>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">麦克风音量</span>
            <span class="setting-desc">拖动滑块调整输入音量大小</span>
          </div>
          <div class="setting-right">
            <div class="volume-control">
              <input
                type="range"
                v-model.number="form.micVolume"
                min="0"
                max="100"
                class="volume-slider"
              />
              <span class="volume-value">{{ form.micVolume }}%</span>
            </div>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">自动调节麦克风音量</span>
            <span class="setting-desc">根据环境噪声自动调整输入音量</span>
          </div>
          <div class="setting-right">
            <div
              class="toggle-switch"
              :class="{ on: form.autoGain }"
              @click="form.autoGain = !form.autoGain"
            ></div>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">音频降噪</span>
            <span class="setting-desc">抑制键盘、风扇等背景噪声</span>
          </div>
          <div class="setting-right">
            <div
              class="toggle-switch"
              :class="{ on: form.noiseSuppression }"
              @click="form.noiseSuppression = !form.noiseSuppression"
            ></div>
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h3 class="section-title">录制</h3>

        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">本地录制保存位置</span>
            <span class="setting-desc">{{ saveDirDesc }}</span>
          </div>
          <div class="setting-right location-row">
            <span class="location-path" :class="{ unset: !pickedDirName }">{{
              saveDirText
            }}</span>
            <button
              v-if="dirBlocker === 'ok'"
              class="btn-ghost"
              @click="crossOriginFrame ? openDirPickerWindow() : changePath()"
            >
              {{ pickedDirName ? "更换位置" : "选择位置" }}
            </button>
            <button v-if="pickedDirName" class="btn-ghost" @click="resetPath">
              取消本机授权
            </button>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">本地录制画质</span>
            <span class="setting-desc"
              >只改本机这份录制的码率与体积，不影响别人在会里看到的画面</span
            >
          </div>
          <div class="setting-right">
            <select v-model="form.recordingQuality" class="setting-select">
              <option value="high">高（约 30 MB/分钟·路）</option>
              <option value="medium">中（约 15 MB/分钟·路）</option>
              <option value="low">低（约 8 MB/分钟·路）</option>
            </select>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">本地录制帧率</span>
            <span class="setting-desc"
              >每秒为每一路画几帧；源本身不足时不会补成重复帧</span
            >
          </div>
          <div class="setting-right">
            <select v-model.number="form.recordingFps" class="setting-select">
              <option :value="25">25 帧/秒</option>
              <option :value="30">30 帧/秒</option>
              <option :value="60">60 帧/秒</option>
              <option :value="120">120 帧/秒</option>
            </select>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">
              入会时自动本地录制
              <span class="todo-tag">暂未接入</span>
            </span>
            <span class="setting-desc">仅录制者本人可查看本机录制</span>
          </div>
          <div class="setting-right">
            <div
              class="toggle-switch disabled"
              title="入会自动开录暂未实现，请在会中手动开录"
            ></div>
          </div>
        </div>

        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">云端录制</span>
            <span class="setting-desc">录制自动上传至云端，会议成员可查看</span>
          </div>
          <div class="setting-right">
            <div
              class="toggle-switch"
              :class="{ on: form.cloudRecordDefault === 1 }"
              @click="
                form.cloudRecordDefault = form.cloudRecordDefault === 1 ? 0 : 1
              "
            ></div>
          </div>
        </div>
      </section>

      <section class="settings-section">
        <h3 class="section-title">网络检测</h3>

        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">网络质量检测</span>
            <span class="setting-desc"
              >测的是浏览器到本会议服务的链路（同机/局域网常达百兆级），不是运营商公网测速；会中画面仍走会议平台</span
            >
          </div>
          <div class="setting-right">
            <button class="btn-primary" :disabled="netBusy" @click="runNetTest">
              {{
                netBusy
                  ? `检测中 ${netElapsedText}`
                  : netResult
                    ? "重新检测"
                    : "开始检测"
              }}
            </button>
          </div>
        </div>

        <div v-if="!netResult && !netBusy" class="net-hint">
          <span class="net-hint-icon">ℹ️</span>
          <span>尚未检测，点击「开始检测」了解当前网络质量</span>
        </div>
        <div v-else-if="netError" class="net-hint warn">
          <span class="net-hint-icon ri-error-warning-line" />
          <span>{{ netError }}</span>
        </div>

        <template v-if="netResult">
          <div class="net-hint" :class="netResult.level">
            <span class="net-hint-icon" :class="netResultIcon" />
            <span>{{ netVerdict }}</span>
          </div>
          <div class="net-metrics">
            <div v-for="m in netMetrics" :key="m.label" class="net-metric">
              <span class="net-metric-label">{{ m.label }}</span>
              <span class="net-metric-value">{{ m.value }}</span>
            </div>
          </div>
          <p class="net-note">上下行测本机到会议服务的真实收发包；「会议链路延迟」是服务到三方平台的往返</p>
        </template>
      </section>

      <!-- 关于：只放"我这是什么版本、每版改了什么"。部署细节、镜像名、提交号一概不放 ——
           那些是给现场运维的发版说明里的事，用户读了只会更糊涂。 -->
      <section class="settings-section">
        <h3 class="section-title">关于</h3>
        <div class="setting-row">
          <div class="setting-left">
            <span class="setting-label">版本信息</span>
            <span class="setting-desc">{{ versionDesc }}</span>
          </div>
          <div class="setting-right">
            <button class="btn-ghost" @click="versionDialogVisible = true">
              查看更新日志
            </button>
          </div>
        </div>
      </section>
    </div>

    <VersionDialog v-model="versionDialogVisible" />
  </div>
</template>

<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from "vue";
import { ElMessage } from "element-plus";
import { ApiError, assetUrl } from "@/utils/request";
import { useMediaSettings } from "@/composables/useMediaSettings";
import { useUserStore } from "@/store/user";
import {
  DirPickerBlockedError,
  clearRecordingDir,
  dirPickerBlocker,
  getRecordingDirName,
  inCrossOriginFrame,
  pickRecordingDir,
  type DirPickerBlocker,
} from "@/utils/localRecorder";
import {
  measureNetwork,
  NET_TEST_DURATION_MS,
  type NetQuality,
} from "@/utils/mediaTest";
import { clearAvatar, updateDisplayName, uploadAvatar } from "@/api/user";
import { toAvatarBlob } from "@/utils/avatarImage";
import type { UserSettingsVo } from "@/api/settings";
import { BG_BLUR_AVAILABLE } from "@/utils/virtualBackground";
import { useFaceEnhancement } from "@/composables/useFaceEnhancement";
import VersionDialog from "@/components/dialogs/VersionDialog.vue";
import { currentRelease } from "@/data/changelog";
import { businessDayKey, dashDateTime } from "@/utils/time";

const { devices, loadPreferences, savePreferences, enumerateDevices } =
  useMediaSettings();
const {
  supported: faceSupported,
  notice: faceNotice,
  loadSupport: loadFaceSupport,
} = useFaceEnhancement();

const userStore = useUserStore();
const avatarInputRef = ref<HTMLInputElement | null>(null);
const avatarBusy = ref(false);

// 「关于」区块：版本号取自数据模块第一条（唯一来源），发布日期同源。
// 构建时间由构建期注入，拿不到就是"开发态"—— 不显示空白，也不编一个日期。
// 注入的是 ISO UTC 串（+00:00），**必须过 formatDateTime 转业务时区**再显示：
// 直接摆 UTC 串给用户看，08:13 打的包会显示成 00:13，差 8 小时（录制文件名踩过同样的坑）。
const versionDialogVisible = ref(false);
const versionDesc = computed(() => {
  const rel = currentRelease();
  // 发布日期与构建时间用**同一种短横线格式**：`2026-10-14` / `2026-11-13 08:31`。
  // 混用 `2026-10-14` 与 `2026/11/13` 读起来像两套来源的数据。
  const released = businessDayKey(rel.date);
  const built = dashDateTime(import.meta.env.VITE_BUILD_DATE);
  // 开发态必须说出来：本地跑的是源码，不是这个版本号的正式产物。
  // 显示成"v0.8.1"却不标开发态，排障时会把源码问题当成发布版问题。
  return built
    ? `${rel.version} · 发布于 ${released} · 构建于 ${built}`
    : `${rel.version} · 发布于 ${released} · 开发态`;
});
// 后端删掉了旧文件，浏览器却还可能拿缓存里的同名资源，所以失败时不自动重试。
const avatarBroken = ref(false);

const avatarSrc = computed(() => {
  const a = userStore.userInfo?.avatar;
  return a && !avatarBroken.value ? assetUrl(a) : "";
});
const avatarChar = computed(() =>
  (userStore.userInfo?.displayName || "用").charAt(0),
);

const displayName = ref("");
const displayNameBusy = ref(false);
watch(
  () => userStore.userInfo?.displayName,
  (v) => {
    displayName.value = v || "";
  },
  { immediate: true },
);

// 显示名同样"改完即存"，但要等失焦：一边打字一边请求会把半成品存进库
function onDisplayNameBlur() {
  const v = displayName.value.trim();
  if (!v || v === (userStore.userInfo?.displayName || "")) return;
  void saveDisplayName();
}

async function saveDisplayName() {
  displayNameBusy.value = true;
  try {
    const res = await updateDisplayName(displayName.value.trim());
    const saved = res.data!.displayName;
    if (userStore.userInfo) userStore.userInfo.displayName = saved;
    displayName.value = saved;
    ElMessage.success("显示名已更新");
  } catch {
    /* 后端 msg 由拦截器弹一次；这里把输入框收回真实值，别让页面显示一个没存上的名字 */
    displayName.value = userStore.userInfo?.displayName || "";
  } finally {
    displayNameBusy.value = false;
  }
}

function pickAvatar() {
  avatarInputRef.value?.click();
}

function onAvatarError() {
  avatarBroken.value = true;
  ElMessage.error("头像读取失败，请重新上传");
}

async function onAvatarPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  avatarBusy.value = true;
  let blob: Blob;
  try {
    blob = await toAvatarBlob(file);
  } catch (err) {
    // 本地图片解码/画布缩放失败，不经过后端，拦截器弹不到 —— 原始报错只进控制台，弹窗不露技术细节
    console.warn("[settings] 头像本地读取失败", err);
    ElMessage.error("头像读取失败，请换一张图片或重新选择");
    avatarBusy.value = false;
    return;
  }
  try {
    await uploadAvatar(blob);
    await userStore.fetchUserInfo();
    avatarBroken.value = false;
    ElMessage.success("头像已更新");
  } catch {
    /* 后端 msg 由 request 拦截器统一弹一次，这里只复位状态 */
  } finally {
    avatarBusy.value = false;
  }
}

async function removeAvatar() {
  avatarBusy.value = true;
  try {
    await clearAvatar();
    await userStore.fetchUserInfo();
    ElMessage.success("头像已移除");
  } catch {
    /* 后端 msg 由 request 拦截器统一弹一次，这里只复位状态 */
  } finally {
    avatarBusy.value = false;
  }
}

// 第 30 项：页面上不再有"保存/重置"总开关，每一项改动各自防抖后落库。
// 第 35 条：反馈走一次性提示（与「显示名已更新」同一套），不在页头挂常驻状态条。
const AUTOSAVE_DEBOUNCE_MS = 500;
let saveTimer: number | null = null;
// 首次装载与失败回滚都在写 form，这两段不能被判成"用户改动"再存回去
let hydrating = true;
let lastSaved: UserSettingsVo | null = null;

// 第 31 项：显示实际写入路径。硬约束是网页只能读出用户所选文件夹的名字，读不到绝对路径，
// 所以路径显示到"所选文件夹"这一层，hxt 层级是我方自己建的，可以照实写全。
const HXT_PATH = "hxt/{登录账号}/{录制时刻}/{会议编号}";
const pickedDirName = ref<string | null>(null);
const dirBlocker = ref<DirPickerBlocker>("ok");
const crossOriginFrame = ref(false);

/** 事前能断定的两种"选不了"，各对应一句实话；被嵌着不算其中之一（见 dirPickerBlocker 的说明）。 */
const BLOCKER_COPY: Record<
  Exclude<DirPickerBlocker, "ok">,
  { text: string; desc: string; fix: string }
> = {
  unsupported: {
    text: "本机浏览器不支持直接写目录",
    desc: "此浏览器不能直接写目录，产物留在本地录制库",
    fix: "这台设备的浏览器不能直接写目录，产物会留在本地录制库，可用下载取文件",
  },
  "insecure-context": {
    text: "需要加密连接才能选文件夹",
    desc: "当前地址不是加密连接，产物留在本地录制库",
    fix: "请用加密地址或本机地址打开本系统，再回来设置保存位置",
  },
};

const saveDirText = computed(() => {
  if (dirBlocker.value !== "ok") return BLOCKER_COPY[dirBlocker.value].text;
  if (pickedDirName.value) return `${pickedDirName.value}/${HXT_PATH}`;
  return `未授权 · 默认位置：系统「视频」文件夹/${HXT_PATH}`;
});

const saveDirDesc = computed(() => {
  if (dirBlocker.value !== "ok") return BLOCKER_COPY[dirBlocker.value].desc;
  if (pickedDirName.value) {
    return "录制写进该文件夹下的分层目录";
  }
  if (form.recordingSaveDir) {
    return "换设备或清站点数据后需重新授权";
  }
  return "默认在系统「视频」文件夹；未授权前只存本地库";
});

const netBusy = ref(false);
const netResult = ref<NetQuality | null>(null);
const netError = ref("");
const netElapsed = ref(0);
const netElapsedText = computed(
  () =>
    `${Math.min(netElapsed.value / 1000, NET_TEST_DURATION_MS / 1000).toFixed(1)}s / ${NET_TEST_DURATION_MS / 1000}s`,
);

const netVerdict = computed(() => {
  const r = netResult.value;
  if (!r) return "";
  if (r.level === "good") return "网络良好，可流畅开启高清卫通会议";
  if (r.level === "fair") return "网络一般，建议在会中调低分辨率或码率";
  return `网络延迟${r.label}，建议只保留音频入会`;
});

const netResultIcon = computed(() => {
  const level = netResult.value?.level;
  return level === "good"
    ? "ri-checkbox-circle-line"
    : level === "fair"
      ? "ri-error-warning-line"
      : "ri-forbid-line";
});

function formatMbps(v: number | null) {
  if (v === null) return "未测出";
  if (v >= 100) return `${Math.round(v)} Mbps`;
  if (v >= 10) return `${v.toFixed(1)} Mbps`;
  if (v >= 1) return `${v.toFixed(2)} Mbps`;
  return `${Math.round(v * 1000)} kbps`;
}

const netMetrics = computed(() => {
  const r = netResult.value;
  if (!r) return [];
  const rows = [
    { label: "到本服务上传", value: formatMbps(r.upMbps) },
    { label: "到本服务下载", value: formatMbps(r.downMbps) },
    { label: "网络延迟", value: r.rttMs === null ? "未测出" : `${r.rttMs} ms` },
    { label: "抖动", value: r.jitterMs === null ? "未测出" : `${r.jitterMs} ms` },
  ];
  if (r.upstreamRttMs !== null && r.upstreamRttMs !== undefined) {
    rows.push({ label: "会议链路延迟", value: `${r.upstreamRttMs} ms` });
  }
  return rows;
});

async function runNetTest() {
  netBusy.value = true;
  netError.value = "";
  netElapsed.value = 0;
  try {
    const r = await measureNetwork("/api/v1/dicts/meeting_status", (ms) => {
      netElapsed.value = ms;
    });
    netResult.value = r;
    if (r.rttMs === null && r.downMbps === null && r.upMbps === null) {
      netError.value = "检测未完成：会议后端不可达，请检查网络";
    }
  } catch (e: any) {
    // 检测面板给人看的也得是一句能行动的话：axios 的 'Network Error' / 'timeout of 10000ms exceeded'
    // 属于研发口径，只进控制台（第 7 项：隐藏技术细节不在前端做改写，也不外泄）。
    console.error("[netTest] 测速失败", e?.name, e?.message, e);
    netError.value =
      e instanceof ApiError ? e.message : "检测失败：会议后端不可达或超时";
  } finally {
    netBusy.value = false;
  }
}

const FPS_FALLBACK = [10, 15, 20, 25, 30];
const fpsOptions = ref<number[]>([...FPS_FALLBACK]);

const form = reactive<UserSettingsVo>({
  cameraDeviceId: "",
  microphoneDeviceId: "",
  speakerDeviceId: "",
  videoResolution: "1080p",
  videoMaxFps: 30,
  videoTargetBitrateKbps: 0,
  vbMode: "off",
  vbCustomImageUrl: "",
  faceEnhancement: 0,
  cloudRecordDefault: 1,
  recordingQuality: "high",
  recordingFps: 30,
  mirrorVideo: true,
  bgBlur: false,
  micVolume: 80,
  autoGain: true,
  noiseSuppression: true,
  recordingSaveDir: "",
});

/** 用本机摄像头 getCapabilities().frameRate 生成可选档；采不到则保留兜底列表。 */
async function probeCameraFpsOptions() {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return;
  }
  let stream: MediaStream | null = null;
  try {
    const video: MediaTrackConstraints = form.cameraDeviceId
      ? { deviceId: { ideal: form.cameraDeviceId } }
      : true;
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    const track = stream.getVideoTracks()[0];
    const caps = track?.getCapabilities?.() as
      | (MediaTrackCapabilities & { frameRate?: { min?: number; max?: number } })
      | undefined;
    const maxRaw = caps?.frameRate?.max;
    const max = maxRaw && Number.isFinite(maxRaw) ? Math.min(60, Math.round(maxRaw)) : 0;
    if (max < 5) return;
    const candidates = [10, 15, 20, 25, 30, 60].filter((f) => f >= 5 && f <= max);
    if (!candidates.length) {
      fpsOptions.value = [Math.max(5, Math.min(60, max))];
    } else {
      fpsOptions.value = candidates;
    }
    if (!fpsOptions.value.includes(form.videoMaxFps)) {
      const want = form.videoMaxFps;
      form.videoMaxFps = fpsOptions.value.reduce((best, cur) =>
        Math.abs(cur - want) < Math.abs(best - want) ? cur : best,
      );
    }
  } catch {
    /* 权限/占用：保持兜底档，不挡设置页 */
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}

async function load() {
  hydrating = true;
  const p = await loadPreferences(true);
  if (p) Object.assign(form, p);
  await loadFaceSupport();
  await probeCameraFpsOptions();
  lastSaved = { ...form };
  pickedDirName.value = await getRecordingDirName();
  await nextTick();
  hydrating = false;
}

/** 只有"用户按了取消"该静默；其余一律说清卡在哪 —— 从前这里吞掉一切，浏览器拒绝时就是"点了没反应"。 */
function dirPickerFailureCopy(e: unknown): string {
  if (e instanceof DirPickerBlockedError) return BLOCKER_COPY[e.blocker].fix;
  return "选择文件夹没成功，产物会先留在本地录制库";
}

async function changePath() {
  try {
    const name = await pickRecordingDir();
    pickedDirName.value = name;
    form.recordingSaveDir = name;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return;
    // 浏览器拒绝在这一层开选择器：不解释、不让人自己去开窗口，直接改走顶层小窗。
    // "哪种嵌入形态会被拒"是浏览器策略、我们说了不算，所以不在事前赌它，撞上了就地换路。
    if (e instanceof DOMException && e.name === "SecurityError") {
      openDirPickerWindow();
      return;
    }
    ElMessage.error(dirPickerFailureCopy(e));
  }
}

let pickerWinTimer: number | null = null;

/**
 * 被别的页面嵌着时，"选文件夹"这一步只能在顶层窗口做（浏览器不允许子帧打开选择器）。
 * 所以点一下就直接把那个小窗开出来，而不是先报一句错让人自己去想办法 —— 子帧里读写盘是通的，
 * 缺的只有这个选择器。
 */
function openDirPickerWindow() {
  const win = window.open(
    new URL("/recording-dir-picker", location.href).href,
    "conference-dir-picker",
    "width=430,height=250",
  );
  if (!win) {
    ElMessage.error("浏览器拦住了这个窗口，请允许弹出后重试");
    return;
  }
  win.focus();
  if (pickerWinTimer !== null) window.clearInterval(pickerWinTimer);
  pickerWinTimer = window.setInterval(() => {
    if (!win.closed) return;
    if (pickerWinTimer !== null) window.clearInterval(pickerWinTimer);
    pickerWinTimer = null;
    void adoptPickedDir();
  }, 400);
}

/** 小窗把句柄写进同源 IndexedDB 后就关了；这里只把它读回来，不另存第二份。 */
async function adoptPickedDir() {
  const name = await getRecordingDirName();
  if (!name || name === pickedDirName.value) return;
  pickedDirName.value = name;
  form.recordingSaveDir = name;
  ElMessage.success(`保存位置已更新：${name}`);
}

async function resetPath() {
  await clearRecordingDir();
  pickedDirName.value = null;
  // 本机授权已取消，账号里那条目录名就不再代表一个能用的位置，一并清掉
  form.recordingSaveDir = "";
}

function queueSave() {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void flushSave();
  }, AUTOSAVE_DEBOUNCE_MS);
}

function toggleFace() {
  if (!faceSupported.value) return;
  form.faceEnhancement = form.faceEnhancement === 1 ? 0 : 1;
}

async function flushSave() {
  try {
    await savePreferences({ ...form });
    lastSaved = { ...form };
    // grouping 让连点同一项时提示只留一条；后端 msg 才是失败时给用户的那句话。
    ElMessage.success({ message: "设置已更新", grouping: true });
  } catch {
    /* 后端 msg 由拦截器弹一次，这里不改写文案；值回滚到上一次真正保存成功的快照 */
    if (lastSaved) {
      hydrating = true;
      Object.assign(form, lastSaved);
      await nextTick();
      hydrating = false;
    }
  }
}

// 改了设备就重新枚举，保证下拉里的标签与真实设备一致；换摄像头后重探帧率档。
watch(
  () => [form.cameraDeviceId, form.microphoneDeviceId],
  async () => {
    await enumerateDevices();
  },
);
watch(
  () => form.cameraDeviceId,
  async () => {
    if (hydrating) return;
    await probeCameraFpsOptions();
  },
);

// 任意一项变更 → 防抖 → 落库；滑杆连续拖动只会存最后一次
watch(form, () => {
  if (!hydrating) queueSave();
});

onMounted(async () => {
  dirBlocker.value = dirPickerBlocker();
  crossOriginFrame.value = inCrossOriginFrame();
  try {
    await load();
  } finally {
    // 装载失败也必须解除闸门，否则这一页的自动保存从此再也不触发
    await nextTick();
    hydrating = false;
  }
  await enumerateDevices();
});

// 防抖窗口内就切走页面会丢改动，卸载时立刻补存一次
onBeforeUnmount(() => {
  if (pickerWinTimer !== null) {
    window.clearInterval(pickerWinTimer);
    pickerWinTimer = null;
  }
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
    void flushSave();
  }
});
</script>

<style scoped>
.settings-page {
  padding: 16px 20px 0;
  max-width: 900px;
}

.page-head h2 {
  margin: 0 0 8px;
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
}

.settings-body {
  display: flex;
  flex-direction: column;
}

/* 原型是"整页浅底 + 分区之间一条发丝线"，不是每块一个卡片盒 */
.settings-section {
  padding: 8px 0;
  border-bottom: 1px solid var(--border-color);
}

.section-title {
  margin: 0 0 8px;
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 14px 0;
}

.setting-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.setting-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-primary);
  font-weight: 600;
}

.setting-desc {
  font-size: 12px;
  color: var(--text-muted);
}

.setting-right {
  flex-shrink: 0;
}

.setting-input {
  width: 140px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 13px;
}
.setting-input:focus {
  outline: none;
  border-color: var(--primary);
}

.setting-value {
  font-size: 14px;
  color: var(--text-secondary);
}

.setting-select {
  width: 260px;
  height: 42px;
  padding: 0 12px;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 11px;
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
}

.setting-select:focus {
  border-color: var(--primary);
}

.volume-control {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 260px;
}

.volume-slider {
  flex: 1;
  accent-color: var(--primary);
}

.volume-value {
  font-size: 14px;
  color: var(--text-secondary);
  min-width: 40px;
  text-align: right;
}

.location-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  max-width: 560px;
}

.location-path {
  font-size: 13px;
  color: var(--text-secondary);
  font-family: monospace;
  line-height: 1.6;
  text-align: right;
  overflow-wrap: anywhere;
}

/* 未授权时这里是一句中文说明，不是路径，别用等宽字体装成路径 */
.location-path.unset {
  font-family: inherit;
  font-size: 12px;
  color: var(--warning-text);
  white-space: normal;
  line-height: 1.5;
}

.btn-ghost {
  padding: 8px 16px;
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  color: var(--text-primary);
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
}

.btn-primary {
  height: 42px;
  padding: 0 20px;
  background: var(--primary);
  border: none;
  border-radius: 11px;
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}

.btn-primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.toggle-switch {
  width: 44px;
  height: 26px;
  border-radius: 9999px;
  background: var(--border-color);
  position: relative;
  cursor: pointer;
  transition: background 0.2s;
}

.toggle-switch::after {
  content: "";
  position: absolute;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #fff;
  top: 3px;
  left: 3px;
  transition: transform 0.2s;
}

.toggle-switch.on {
  background: var(--primary);
}

.toggle-switch.on::after {
  transform: translateX(18px);
}

.toggle-switch.disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.todo-tag {
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--bg-hover);
  border: 1px solid var(--border-color);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 400;
}

.net-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 12px 16px;
  border-radius: 12px;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  font-size: 13px;
  color: var(--text-secondary);
}

.net-hint.good {
  background: rgba(34, 197, 94, 0.1);
  border-color: rgba(34, 197, 94, 0.35);
  color: var(--success-text);
}

.net-hint.fair {
  background: rgba(255, 152, 0, 0.1);
  border-color: rgba(255, 152, 0, 0.35);
  color: var(--orange);
}

.net-hint.poor {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.35);
  color: var(--danger-text);
}

.net-metrics {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-top: 12px;
}

.net-metric {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--bg-input);
  border: 1px solid var(--border-color);
}

.net-metric-label {
  font-size: 12px;
  color: var(--text-muted);
}

.net-metric-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.net-note {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}

.avatar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.avatar-preview {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--primary-soft);
  border: 1px solid var(--border-color);
  display: flex;
  align-items: center;
  justify-content: center;
}

.avatar-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.avatar-preview em {
  font-style: normal;
  font-size: 22px;
  font-weight: 600;
  line-height: 1;
  color: var(--primary-text);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  transform: translateY(0.5px);
}

@media (max-width: 767px) {
  .settings-page {
    padding: 12px 14px calc(16px + var(--safe-bottom, 0px));
    max-width: none;
  }

  .page-head h2 {
    font-size: 20px;
  }

  .settings-section {
    padding: 6px 0;
  }

  .setting-row {
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px;
  }
}
</style>
