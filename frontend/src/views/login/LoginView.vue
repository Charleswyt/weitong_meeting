<template>
  <div class="login-page">
    <div class="login-top-actions">
      <button
        class="login-icon-btn"
        title="设置"
        @click="settingsOpen = true"
      >
        <i class="ri-settings-3-line" />
      </button>
      <button
        class="login-theme-btn"
        :title="appStore.isDarkTheme ? '切换白昼模式' : '切换夜间模式'"
        @click="appStore.toggleTheme()"
      >
        <i
          class="toggle-icon"
          :class="appStore.isDarkTheme ? 'ri-sun-line' : 'ri-moon-line'"
        />
        <span class="theme-label">{{
          appStore.isDarkTheme ? "白昼模式" : "夜间模式"
        }}</span>
      </button>
    </div>

    <div class="login-stage">
      <div class="login-brand">
        <div class="brand-logo">
          <img :src="appIcon" alt="卫通会议" width="64" height="64" />
        </div>
        <div class="brand-title">卫通会议</div>
        <div class="brand-slogan">跨站协同 · 高效沟通</div>
      </div>

      <div class="login-form" :class="{ 'login-form--enter': formEnter }">
        <h2>{{ titleText }}</h2>
        <p class="subtitle">{{ subtitleText }}</p>

        <div
          class="login-fields"
          :class="{ 'login-fields--reset': mode === 'reset' }"
        >
          <template v-if="mode === 'phone'">
            <div class="form-group">
              <label>手机号</label>
              <input
                v-model="phoneForm.mobile"
                type="tel"
                maxlength="11"
                placeholder="请输入手机号"
                @keyup.enter="onPrimary"
              />
            </div>
            <div class="form-group">
              <label>验证码</label>
              <div class="login-code-row">
                <input
                  v-model="phoneForm.code"
                  type="text"
                  maxlength="6"
                  placeholder="请输入验证码"
                  @keyup.enter="onPrimary"
                />
                <button
                  type="button"
                  class="btn-send-code"
                  :disabled="codeCooldowning > 0 || sendingCode"
                  @click="sendCode('login')"
                >
                  {{ codeBtnLabel }}
                </button>
              </div>
            </div>
            <div class="form-row">
              <label class="checkbox-label"
                ><input type="checkbox" v-model="rememberPhone" /> 记住账号</label
              >
            </div>
          </template>

          <template v-else-if="mode === 'email'">
            <div class="form-group">
              <label>邮箱</label>
              <input
                v-model="emailForm.email"
                type="email"
                placeholder="请输入邮箱（未注册将自动创建账号）"
                @keyup.enter="onPrimary"
              />
            </div>
            <div class="form-group">
              <label>验证码</label>
              <div class="login-code-row">
                <input
                  v-model="emailForm.code"
                  type="text"
                  maxlength="6"
                  placeholder="请输入验证码"
                  @keyup.enter="onPrimary"
                />
                <button
                  type="button"
                  class="btn-send-code"
                  :disabled="codeCooldowning > 0 || sendingCode"
                  @click="sendEmailCode('login')"
                >
                  {{ codeBtnLabel }}
                </button>
              </div>
            </div>
            <div class="form-row">
              <label class="checkbox-label"
                ><input type="checkbox" v-model="rememberEmail" /> 记住账号</label
              >
            </div>
          </template>

          <template v-else-if="mode === 'password'">
            <div class="form-group">
              <label>账号</label>
              <input
                v-model="form.username"
                type="text"
                placeholder="请输入用户名/工号"
                @keyup.enter="onPrimary"
              />
            </div>
            <div class="form-group">
              <label>密码</label>
              <input
                v-model="form.password"
                type="password"
                placeholder="请输入密码"
                @keyup.enter="onPrimary"
              />
            </div>
            <div class="form-row">
              <label class="checkbox-label"
                ><input type="checkbox" v-model="remember" /> 记住账号</label
              >
              <a
                href="#"
                style="font-size: 13px; color: var(--primary-text)"
                @click.prevent="goReset"
                >忘记密码？</a
              >
            </div>
          </template>

          <template v-else>
            <div class="form-group">
              <label>手机号</label>
              <input
                v-model="resetForm.mobile"
                type="tel"
                maxlength="11"
                placeholder="请输入绑定手机号"
                @keyup.enter="onPrimary"
              />
            </div>
            <div class="form-group">
              <label>验证码</label>
              <div class="login-code-row">
                <input
                  v-model="resetForm.code"
                  type="text"
                  maxlength="6"
                  placeholder="请输入验证码"
                  @keyup.enter="onPrimary"
                />
                <button
                  type="button"
                  class="btn-send-code"
                  :disabled="codeCooldowning > 0 || sendingCode"
                  @click="sendCode('reset')"
                >
                  {{ codeBtnLabel }}
                </button>
              </div>
            </div>
            <div class="form-group">
              <label>新密码</label>
              <input
                v-model="resetForm.password"
                type="password"
                placeholder="请输入新密码"
                @keyup.enter="onPrimary"
              />
            </div>
            <div class="form-group">
              <label>确认新密码</label>
              <input
                v-model="resetForm.confirm"
                type="password"
                placeholder="请再次输入新密码"
                @keyup.enter="onPrimary"
              />
            </div>
          </template>
        </div>

        <div class="login-actions">
          <button class="btn-login" :disabled="loading" @click="onPrimary">
            {{ primaryLabel }}
          </button>
          <p class="login-alt">
            <template v-if="mode === 'phone'">
              <a href="#" @click.prevent="mode = 'email'">邮箱验证码登录</a>
              <span class="login-alt-sep">·</span>
              <a href="#" @click.prevent="mode = 'password'">账号密码登录</a>
            </template>
            <template v-else-if="mode === 'email'">
              <a href="#" @click.prevent="mode = 'phone'">手机验证码登录</a>
              <span class="login-alt-sep">·</span>
              <a href="#" @click.prevent="mode = 'password'">账号密码登录</a>
            </template>
            <template v-else-if="mode === 'password'">
              <a href="#" @click.prevent="mode = 'phone'">手机验证码登录</a>
              <span class="login-alt-sep">·</span>
              <a href="#" @click.prevent="mode = 'email'">邮箱验证码登录</a>
            </template>
            <template v-else>
              <a href="#" @click.prevent="mode = 'password'"
                >返回账号密码登录</a
              >
              <span class="login-alt-sep">·</span>
              <a href="#" @click.prevent="mode = 'phone'">手机验证码登录</a>
              <span class="login-alt-sep">·</span>
              <a href="#" @click.prevent="mode = 'email'">邮箱验证码登录</a>
            </template>
          </p>
        </div>
      </div>
    </div>

    <div class="login-footer">
      <p class="login-footer-support">
        Supported by 卫通边云协同架构 · 卫星应用创新研究院
      </p>
      <p class="login-footer-links">
        <a href="#" @click.prevent="openLegal('terms')">服务协议</a>
        <span class="login-alt-sep">|</span>
        <a href="#" @click.prevent="openLegal('privacy')">隐私政策</a>
      </p>
    </div>

    <LoginSettingsDialog
      v-model="settingsOpen"
      @open-legal="openLegal"
      @open-changelog="changelogOpen = true"
    />
    <LegalDocDialog v-model="legalOpen" :doc-id="legalDocId" />
    <VersionDialog v-model="changelogOpen" />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { ApiError } from "@/utils/request";
import * as authApi from "@/api/auth";
import { useUserStore } from "@/store/user";
import { useAppStore } from "@/store/app";
import appIcon from "@/assets/icon.png";
import type { LegalDocId } from "@/data/legal";
import LoginSettingsDialog from "@/components/dialogs/LoginSettingsDialog.vue";
import LegalDocDialog from "@/components/dialogs/LegalDocDialog.vue";
import VersionDialog from "@/components/dialogs/VersionDialog.vue";

const router = useRouter();
const route = useRoute();
function afterLogin() {
  const path = route.query.meeting;
  return typeof path === "string" && /^\/meeting\/pre\/(?:no\/)?[0-9]{1,20}$/.test(path) ? path : "/";
}
const userStore = useUserStore();
const appStore = useAppStore();
const loading = ref(false);
/** 首屏入场动画；挂载后关掉，切换登录方式时字段不再重播动画 */
const formEnter = ref(true);
const settingsOpen = ref(false);
const legalOpen = ref(false);
const legalDocId = ref<LegalDocId>("terms");
const changelogOpen = ref(false);
/** 现阶段默认邮箱验证码；reset 为忘记密码找回 */
const mode = ref<"phone" | "email" | "password" | "reset">("email");
const remember = ref(!!userStore.rememberedUsername);
const rememberPhone = ref(!!localStorage.getItem("rememberedMobile"));
const rememberEmail = ref(!!localStorage.getItem("rememberedEmail"));
const form = reactive({
  username: userStore.rememberedUsername || "",
  password: "",
});
const phoneForm = reactive({
  mobile: localStorage.getItem("rememberedMobile") || "",
  code: "",
});
const emailForm = reactive({
  email: localStorage.getItem("rememberedEmail") || "",
  code: "",
});
const resetForm = reactive({
  mobile: "",
  code: "",
  password: "",
  confirm: "",
});
const sendingCode = ref(false);
const codeCooldowning = ref(0);
let cooldownTimer: ReturnType<typeof setInterval> | null = null;

const titleText = computed(() => {
  if (mode.value === "reset") return "找回密码";
  return "欢迎登录";
});
const subtitleText = computed(() => {
  if (mode.value === "reset") return "通过手机验证码重置登录密码";
  return "卫通会议";
});
const primaryLabel = computed(() => {
  if (loading.value) {
    if (mode.value === "reset") return "提交中…";
    return "登录中…";
  }
  if (mode.value === "reset") return "重置密码";
  return "登 录";
});
const codeBtnLabel = computed(() => {
  if (codeCooldowning.value > 0) return `${codeCooldowning.value}s 后重发`;
  if (sendingCode.value) return "发送中…";
  return "获取验证码";
});

function openLegal(id: LegalDocId) {
  legalDocId.value = id;
  legalOpen.value = true;
}

function goReset() {
  resetForm.mobile = phoneForm.mobile;
  resetForm.code = "";
  resetForm.password = "";
  resetForm.confirm = "";
  mode.value = "reset";
}

function clearCooldown() {
  if (cooldownTimer) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
}

onMounted(() => {
  window.setTimeout(() => {
    formEnter.value = false;
  }, 900);
});
onBeforeUnmount(clearCooldown);

function assertMobile(mobile: string): boolean {
  if (!/^1\d{10}$/.test(mobile)) {
    ElMessage.warning("请输入正确的 11 位手机号");
    return false;
  }
  return true;
}

function assertEmail(email: string): boolean {
  if (!/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email)) {
    ElMessage.warning("请输入正确的邮箱地址");
    return false;
  }
  return true;
}

function startCooldown(seconds: number) {
  clearCooldown();
  codeCooldowning.value = Math.max(1, seconds | 0);
  cooldownTimer = setInterval(() => {
    codeCooldowning.value -= 1;
    if (codeCooldowning.value <= 0) clearCooldown();
  }, 1000);
}

async function sendCode(purpose: "login" | "reset") {
  const mobile =
    mode.value === "reset" ? resetForm.mobile.trim() : phoneForm.mobile.trim();
  if (!assertMobile(mobile)) return;
  sendingCode.value = true;
  try {
    const res = await authApi.sendSmsCode(mobile, purpose);
    startCooldown(res.cooldownSeconds || 60);
    if (res.debugCode) {
      ElMessage.success(`验证码已生成（开发通道）：${res.debugCode}`);
    } else {
      ElMessage.success("验证码已发送，请查收短信");
    }
  } catch (err) {
    if (err instanceof ApiError)
      ElMessage.error({ message: err.message, grouping: true });
    else
      ElMessage.error({
        message: "连不上会控服务，请确认后端已启动后再获取验证码",
        grouping: true,
      });
  } finally {
    sendingCode.value = false;
  }
}

async function sendEmailCode(purpose: "login" | "reset") {
  const email = emailForm.email.trim();
  if (!assertEmail(email)) return;
  sendingCode.value = true;
  try {
    const res = await authApi.sendEmailCode(email, purpose);
    startCooldown(res.cooldownSeconds || 60);
    if (res.debugCode) {
      ElMessage.success(`验证码已生成（开发通道）：${res.debugCode}`);
    } else {
      ElMessage.success("验证码已发送，请查收邮箱");
    }
  } catch (err) {
    if (err instanceof ApiError)
      ElMessage.error({ message: err.message, grouping: true });
    else
      ElMessage.error({
        message: "连不上会控服务，请确认后端已启动后再获取验证码",
        grouping: true,
      });
  } finally {
    sendingCode.value = false;
  }
}

function onPrimary() {
  if (mode.value === "phone") return handlePhoneLogin();
  if (mode.value === "email") return handleEmailLogin();
  if (mode.value === "password") return handleLogin();
  return handleReset();
}

function persistRemembered(
  key: "rememberedMobile" | "rememberedEmail",
  value: string,
  on: boolean,
) {
  if (on) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

async function handlePhoneLogin() {
  const mobile = phoneForm.mobile.trim();
  if (!assertMobile(mobile)) return;
  if (!phoneForm.code.trim()) {
    ElMessage.warning("请输入验证码");
    return;
  }
  loading.value = true;
  try {
    await userStore.loginBySms(mobile, phoneForm.code.trim());
    persistRemembered("rememberedMobile", mobile, rememberPhone.value);
    ElMessage.success("登录成功");
    if (userStore.linkSynced === false) {
      ElMessage.warning(
        userStore.linkReason || "会议链路未打通，录制、会中等功能暂不可用",
      );
    }
    router.replace(afterLogin());
  } catch (err) {
    if (err instanceof ApiError)
      ElMessage.error({ message: err.message, grouping: true });
  } finally {
    loading.value = false;
  }
}

async function handleEmailLogin() {
  const email = emailForm.email.trim();
  if (!assertEmail(email)) return;
  if (!emailForm.code.trim()) {
    ElMessage.warning("请输入验证码");
    return;
  }
  loading.value = true;
  try {
    await userStore.loginByEmail(email, emailForm.code.trim());
    persistRemembered("rememberedEmail", email, rememberEmail.value);
    ElMessage.success("登录成功");
    if (userStore.linkSynced === false) {
      ElMessage.warning(
        userStore.linkReason || "会议链路未打通，录制、会中等功能暂不可用",
      );
    }
    router.replace(afterLogin());
  } catch (err) {
    if (err instanceof ApiError)
      ElMessage.error({ message: err.message, grouping: true });
  } finally {
    loading.value = false;
  }
}

async function handleReset() {
  const mobile = resetForm.mobile.trim();
  if (!assertMobile(mobile)) return;
  if (!resetForm.code.trim()) {
    ElMessage.warning("请输入验证码");
    return;
  }
  if (resetForm.password.length < 6) {
    ElMessage.warning("新密码至少 6 位");
    return;
  }
  if (resetForm.password !== resetForm.confirm) {
    ElMessage.warning("两次输入的新密码不一致");
    return;
  }
  loading.value = true;
  try {
    await authApi.resetPasswordBySms(
      mobile,
      resetForm.code.trim(),
      resetForm.password,
    );
    ElMessage.success("密码已重置，请使用新密码登录");
    mode.value = "password";
  } catch (err) {
    if (err instanceof ApiError)
      ElMessage.error({ message: err.message, grouping: true });
  } finally {
    loading.value = false;
  }
}

async function handleLogin() {
  if (!form.username || !form.password) {
    ElMessage.warning("请输入账号和密码");
    return;
  }
  loading.value = true;
  try {
    await userStore.login(form.username, form.password, remember.value);
    ElMessage.success("登录成功");
    if (userStore.linkSynced === false) {
      ElMessage.warning(
        userStore.linkReason || "会议链路未打通，录制、会中等功能暂不可用",
      );
    }
    router.replace(afterLogin());
  } catch (err) {
    if (err instanceof ApiError)
      ElMessage.error({ message: err.message, grouping: true });
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  /* 顶对齐 + 有上限的顶垫：书签栏时给图标留位；F11 全屏不再被 center 顶出大块空白 */
  justify-content: flex-start;
  height: 100vh;
  height: 100dvh;
  width: 100%;
  position: relative;
  overflow-x: hidden;
  overflow-y: auto;
  padding-top: calc(
    max(12px, var(--safe-top, 0px)) + 44px + clamp(4px, 2.5vh, 28px)
  );
  padding-right: var(--safe-right, 0);
  padding-bottom: max(16px, var(--safe-bottom, 0px));
  padding-left: var(--safe-left, 0);
  box-sizing: border-box;
}

@media (max-height: 820px) {
  .login-page {
    padding-top: calc(max(10px, var(--safe-top, 0px)) + 44px + 6px);
  }
}

@media (max-width: 767px) {
  .login-page {
    padding-top: calc(max(12px, var(--safe-top, 0px)) + 48px + 8px);
  }

  :deep(.login-stage) {
    width: min(100%, 420px);
    padding: 0 20px 24px;
  }

  :deep(.login-form) {
    width: 100%;
  }

  :deep(.theme-label) {
    display: none;
  }
}
</style>
