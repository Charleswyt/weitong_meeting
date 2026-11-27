<template>
  <Teleport to="body">
    <div
      class="modal-overlay"
      :class="{ show: modelValue }"
      @click.self="close"
    >
      <div class="modal-box jm-modal-box">
        <div class="modal-header">
          <div class="wt-dlg-head-left">
            <i class="wt-dlg-icon ri-login-box-line" />
            <h3>加入会议</h3>
          </div>
          <button class="modal-close" type="button" aria-label="关闭" @click="close">
            <i class="ri-close-line" />
          </button>
        </div>

        <div class="modal-body jm-modal-body">
          <p class="jm-tip">请输入会议号，或直接粘贴完整邀请信息</p>
          <div class="jm-input-wrap">
            <input
              type="text"
              class="jm-input"
              :class="{ error: !!errorMsg }"
              v-model="rawNumber"
              placeholder="会议号或粘贴邀请信息"
              @input="onInput"
              @paste="onPaste"
            />
            <div class="jm-error-msg" :class="{ show: !!errorMsg }">
              {{ errorMsg }}
            </div>
          </div>
          <div class="jm-input-wrap">
            <input
              type="text"
              class="jm-input jm-input-name"
              v-model="displayName"
              maxlength="32"
              placeholder="输入您的入会名称"
            />
          </div>
          <div class="jm-options">
            <label class="jm-checkbox-row" for="jmMicOnCheckbox">
              <input
                type="checkbox"
                id="jmMicOnCheckbox"
                v-model="micOn"
                :disabled="!autoConnectAudio"
              />
              <span>入会开启麦克风</span>
            </label>
            <label class="jm-checkbox-row" for="jmCameraOnCheckbox">
              <input type="checkbox" id="jmCameraOnCheckbox" v-model="cameraOn" />
              <span>入会开启摄像头</span>
            </label>
            <label class="jm-checkbox-row" for="jmAutoAudioCheckbox">
              <input
                type="checkbox"
                id="jmAutoAudioCheckbox"
                v-model="autoConnectAudio"
              />
              <span>入会自动连接音频</span>
            </label>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-cancel" type="button" @click="close">取消</button>
          <button
            class="btn-confirm"
            type="button"
            :disabled="submitting"
            @click="submit"
          >
            <i v-if="!submitting" class="ri-login-circle-line" />
            {{ submitting ? "加入中…" : "进入会议" }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useRouter } from "vue-router";
import { precheckMeeting } from "@/api/meeting";
import { useUserStore } from "@/store/user";
import { guardSingleActiveMeeting } from "@/utils/startMeeting";
import {
  formatJoinInputMeetingNo,
  parseMeetingNoFromText,
  preJoinPathByNumber,
} from "@/utils/joinFlow";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ (e: "update:modelValue", v: boolean): void }>();

const router = useRouter();
const userStore = useUserStore();

const rawNumber = ref("");
const displayName = ref("");
const errorMsg = ref("");
/** 默认不勾选：入会不开麦 */
const micOn = ref(false);
/** 默认不勾选：入会不开摄像头 */
const cameraOn = ref(false);
/** 默认勾选：自动连接音频；关掉则不开麦、不采麦 */
const autoConnectAudio = ref(true);
const submitting = ref(false);

function applyInviteOrNumber(raw: string) {
  const parsed = parseMeetingNoFromText(raw);
  if (parsed) {
    rawNumber.value = formatJoinInputMeetingNo(parsed);
    if (errorMsg.value) errorMsg.value = "";
    return;
  }
  rawNumber.value = formatJoinInputMeetingNo(raw);
  if (errorMsg.value && rawNumber.value.replace(/\D/g, "").length >= 6)
    errorMsg.value = "";
}

function onInput() {
  applyInviteOrNumber(rawNumber.value);
}

function onPaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData("text") || "";
  if (!text || text.length < 6) return;
  if (/会议|http|卫通|#/.test(text) || text.length > 16) {
    e.preventDefault();
    applyInviteOrNumber(text);
  }
}

watch(autoConnectAudio, (on) => {
  if (!on) micOn.value = false;
});

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      rawNumber.value = "";
      errorMsg.value = "";
      micOn.value = false;
      cameraOn.value = false;
      autoConnectAudio.value = true;
      displayName.value = (userStore.userInfo?.displayName || "").slice(0, 32);
    }
  },
);

function close() {
  emit("update:modelValue", false);
}

async function submit() {
  if (!(await guardSingleActiveMeeting(router))) {
    close();
    return;
  }
  const number = rawNumber.value.replace(/\D/g, "");
  if (!/^\d{6,12}$/.test(number)) {
    errorMsg.value = "请输入正确的会议号（6-12 位数字）";
    return;
  }
  submitting.value = true;
  try {
    const res = await precheckMeeting(number);
    if (res.data && !res.data.joinable) {
      errorMsg.value = res.data.message || "会议不可加入";
      return;
    }
    const name = displayName.value.trim().slice(0, 32);
    const wantMic = autoConnectAudio.value && micOn.value;
    close();
    router.push(
      preJoinPathByNumber(number, {
        micOn: wantMic,
        cameraOn: cameraOn.value,
        autoAudio: autoConnectAudio.value,
        name: name || undefined,
      }),
    );
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.jm-modal-box {
  width: min(440px, 94vw);
}
.jm-modal-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.jm-tip {
  margin: 0 0 14px;
  font-size: 13px;
  color: var(--text-muted);
}
.jm-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--bg-soft);
  border: 1px solid var(--border-soft);
}
.jm-options .jm-checkbox-row {
  margin-bottom: 0;
  cursor: pointer;
}
</style>
