<template>
  <Teleport to="body">
    <div
      class="modal-overlay"
      :class="{ show: modelValue }"
      @click.self="close"
    >
      <div
        class="schedule-modal iv-modal"
        role="dialog"
        aria-modal="true"
        aria-label="创建"
      >
        <div class="schedule-header">
          <div class="wt-dlg-head-left">
            <i class="wt-dlg-icon ri-user-voice-line" />
            <h3>{{ createdResult ? "面试工坊已创建" : "创建" }}</h3>
          </div>
          <button
            type="button"
            class="modal-close"
            aria-label="关闭"
            @click="close"
          >
            <i class="ri-close-line" />
          </button>
        </div>

        <!-- 创建成功结果视图 -->
        <div v-if="createdResult" class="schedule-body iv-body">
          <div class="iv-summary">
            <div class="iv-sum-main">
              <div class="iv-sum-title">{{ createdResult.title }}</div>
              <div class="iv-sum-meta">
                <span
                  ><i class="ri-hashtag" />会议号：<strong>{{
                    formatMeetingNo(createdResult.meetingNo) || "待同步"
                  }}</strong></span
                >
                <span
                  ><i class="ri-time-line" />{{ createdResult.startTime }}（{{
                    createdResult.durationMinutes
                  }}
                  分钟）</span
                >
              </div>
            </div>
            <button type="button" class="iv-copy-all" @click="copyAllAccounts">
              <i class="ri-file-copy-line" />
              <span>复制全部凭证</span>
            </button>
          </div>

          <div class="iv-table-wrap">
            <table class="iv-table">
              <thead>
                <tr>
                  <th>面试者</th>
                  <th>登录用户名</th>
                  <th>登录密码</th>
                  <th>可开会次数</th>
                  <th>截止有效期</th>
                  <th class="iv-col-act">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="acc in createdResult.accounts" :key="acc.username">
                  <td class="iv-td-name">{{ acc.candidateName }}</td>
                  <td class="iv-td-mono">{{ acc.username }}</td>
                  <td class="iv-td-mono">{{ acc.password }}</td>
                  <td class="iv-td-mono">{{ acc.maxJoins }} 次</td>
                  <td class="iv-td-mono">{{ acc.expiresAt }}</td>
                  <td class="iv-col-act">
                    <button
                      type="button"
                      class="iv-mini-btn"
                      @click="copyOneAccount(acc)"
                    >
                      <i class="ri-file-copy-line" />复制
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- 创建表单视图（严格对齐 ScheduleMeetingDialog 布局规范） -->
        <div v-else class="schedule-body iv-body">
          <div class="form-group-modal">
            <label>会议名称 <span class="required">*</span></label>
            <input
              v-model="form.title"
              type="text"
              maxlength="64"
              placeholder="例如：前端研发工程师一面"
            />
          </div>

          <div class="form-row-2">
            <div class="form-group-modal">
              <label>开始时间 <span class="required">*</span></label>
              <el-date-picker
                v-model="form.startTime"
                type="datetime"
                format="YYYY-MM-DD HH:mm"
                value-format="YYYY-MM-DD HH:mm:ss"
                :disabled-date="disabledPastDate"
                :clearable="false"
                placeholder="选择面试开始时间"
                class="iv-picker"
              />
            </div>
            <div class="form-group-modal">
              <label>预计时长</label>
              <select v-model.number="form.durationMinutes" class="form-select">
                <option :value="30">30 分钟</option>
                <option :value="45">45 分钟</option>
                <option :value="60">1 小时</option>
                <option :value="90">1.5 小时</option>
                <option :value="120">2 小时</option>
              </select>
            </div>
          </div>

          <div class="form-group-modal">
            <label>面试者姓名 <span class="required">*</span></label>
            <div class="iv-add-row">
              <input
                ref="candidateInputEl"
                v-model="candidateInput"
                type="text"
                placeholder="输入姓名后回车，支持逗号 / 顿号 / 换行批量粘贴"
                @keydown.enter="onCandidateEnter"
                @paste="onCandidatePaste"
              />
              <button type="button" class="iv-add-btn" @click="addCandidates">
                <i class="ri-add-line" />添加
              </button>
              <button
                type="button"
                class="iv-add-btn"
                title="导入 .txt / .csv 名单，每行一个姓名"
                @click="fileInputEl?.click()"
              >
                <i class="ri-upload-2-line" />导入
              </button>
              <input
                ref="fileInputEl"
                type="file"
                accept=".txt,.csv,text/plain,text/csv"
                hidden
                @change="onImportFile"
              />
            </div>
            <div class="iv-add-hint">
              登录用户名按姓名全拼自动生成（如 张三 → zhangsan，重名追加序号），已添加
              {{ form.candidates.length }} / {{ MAX_CANDIDATES }} 人
            </div>
            <div v-if="form.candidates.length" class="iv-chips">
              <span
                v-for="(name, idx) in form.candidates"
                :key="`${name}-${idx}`"
                class="iv-chip"
              >
                <i class="ri-user-3-line" />
                <span>{{ name }}</span>
                <button
                  type="button"
                  class="iv-chip-del"
                  aria-label="移除"
                  @click="removeCandidate(idx)"
                >
                  <i class="ri-close-line" />
                </button>
              </span>
            </div>
          </div>

          <div class="form-row-2">
            <div class="form-group-modal">
              <label>可开会次数</label>
              <input
                v-model.number="form.maxJoins"
                type="number"
                min="1"
                max="100"
                placeholder="超过次数禁止登录"
              />
            </div>
            <div class="form-group-modal">
              <label>账号截止期限 <span class="required">*</span></label>
              <el-date-picker
                v-model="form.expiresAt"
                type="datetime"
                format="YYYY-MM-DD HH:mm"
                value-format="YYYY-MM-DD HH:mm:ss"
                :disabled-date="disabledPastDate"
                :clearable="false"
                placeholder="选择账号过期时间"
                class="iv-picker"
              />
            </div>
          </div>

          <div class="iv-rule-banner">
            <i class="ri-shield-check-line" />
            <span
              >每位面试者将自动生成独立用户名与密码；同场面试最多同时进入
              <strong>1 名</strong
              >面试者；超过可开会次数或截止期限将禁止登录并提示「当前账户已经过期」，过期账号由服务端每天自动清理。</span
            >
          </div>
        </div>

        <div class="modal-footer">
          <template v-if="createdResult">
            <button type="button" class="btn-cancel" @click="resetToForm">
              继续创建
            </button>
            <button type="button" class="btn-confirm" @click="close">
              完成
            </button>
          </template>
          <template v-else>
            <button
              type="button"
              class="btn-cancel"
              :disabled="submitting"
              @click="close"
            >
              取消
            </button>
            <button
              type="button"
              class="btn-confirm"
              :disabled="submitting"
              @click="handleSubmit"
            >
              {{ submitting ? "创建中..." : "创建" }}
            </button>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import {
  createInterviewRoom,
  type InterviewAccountVo,
  type InterviewCreateRes,
} from "@/api/meeting";
import { formatMeetingNo } from "@/utils/meetingNo";
import { copyText } from "@/utils/clipboard";

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  (e: "update:modelValue", v: boolean): void;
  (e: "created", res: InterviewCreateRes): void;
}>();

const MAX_CANDIDATES = 50;
const submitting = ref(false);
const candidateInput = ref("");
const candidateInputEl = ref<HTMLInputElement | null>(null);
const fileInputEl = ref<HTMLInputElement | null>(null);
const createdResult = ref<InterviewCreateRes | null>(null);

const form = reactive({
  title: "",
  startTime: "",
  durationMinutes: 60,
  candidates: [] as string[],
  maxJoins: 1,
  expiresAt: "",
});

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function fmtDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`;
}

function initDefaults() {
  const now = new Date();
  const next = new Date(now.getTime() + 5 * 60 * 1000);
  next.setMinutes(Math.ceil(next.getMinutes() / 5) * 5, 0, 0);
  const exp = new Date(next.getTime() + 24 * 60 * 60 * 1000);

  form.title = "";
  form.startTime = fmtDateTime(next);
  form.durationMinutes = 60;
  form.candidates = [];
  form.maxJoins = 1;
  form.expiresAt = fmtDateTime(exp);
  candidateInput.value = "";
  createdResult.value = null;
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) initDefaults();
  },
);

function disabledPastDate(date: Date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date.getTime() < today.getTime();
}

function splitNames(raw: string): string[] {
  return raw
    .split(/[,，、;；\r\n\t]+/)
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s && !/^(姓名|名字|name)$/i.test(s));
}

function pushNames(names: string[]): number {
  let added = 0;
  for (const name of names) {
    if (form.candidates.length >= MAX_CANDIDATES) {
      ElMessage.warning(`单次最多添加 ${MAX_CANDIDATES} 位面试者`);
      break;
    }
    form.candidates.push(name.slice(0, 32));
    added++;
  }
  return added;
}

function addCandidates() {
  const raw = (candidateInputEl.value?.value ?? candidateInput.value).trim();
  if (!raw) {
    ElMessage.warning("请先输入面试者姓名");
    candidateInputEl.value?.focus();
    return;
  }
  pushNames(splitNames(raw));
  candidateInput.value = "";
  if (candidateInputEl.value) candidateInputEl.value.value = "";
  candidateInputEl.value?.focus();
}

function onCandidateEnter(e: KeyboardEvent) {
  if (e.isComposing) return;
  e.preventDefault();
  addCandidates();
}

function onCandidatePaste(e: ClipboardEvent) {
  const text = e.clipboardData?.getData("text") || "";
  if (!/[\r\n]/.test(text)) return;
  e.preventDefault();
  const added = pushNames(splitNames(text));
  if (added) ElMessage.success(`已批量添加 ${added} 位面试者`);
}

async function onImportFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > 256 * 1024) {
    ElMessage.warning("名单文件过大，请控制在 256KB 以内");
    return;
  }
  const text = await file.text();
  const names = text
    .split(/\r?\n/)
    .map((line) => line.split(/[,，\t]/)[0] || "")
    .flatMap((cell) => splitNames(cell));
  if (!names.length) {
    ElMessage.warning("未在文件中识别到姓名，请每行填写一个姓名");
    return;
  }
  const added = pushNames(names);
  if (added) ElMessage.success(`已从名单导入 ${added} 位面试者`);
}

function removeCandidate(idx: number) {
  form.candidates.splice(idx, 1);
}

async function handleSubmit() {
  if ((candidateInputEl.value?.value ?? candidateInput.value).trim()) addCandidates();
  const title = form.title.trim();
  if (!title) {
    ElMessage.warning("请输入会议名称");
    return;
  }
  if (!form.startTime) {
    ElMessage.warning("请选择开始时间");
    return;
  }
  if (!form.candidates.length) {
    ElMessage.warning("请至少添加一位面试者姓名");
    return;
  }
  const maxJoins = Math.max(
    1,
    Math.min(100, Math.round(Number(form.maxJoins) || 1)),
  );
  if (!form.expiresAt) {
    ElMessage.warning("请选择账号截止期限");
    return;
  }
  if (new Date(form.expiresAt.replace(" ", "T")).getTime() <= Date.now()) {
    ElMessage.warning("账号截止期限必须晚于当前时间");
    return;
  }

  submitting.value = true;
  try {
    const res = await createInterviewRoom({
      title,
      startTime: form.startTime,
      durationMinutes: form.durationMinutes,
      candidates: [...form.candidates],
      maxJoins,
      expiresAt: form.expiresAt,
      cloudRecord: true,
    });
    if (res.data) {
      createdResult.value = res.data;
      emit("created", res.data);
      ElMessage.success(
        `面试工坊已创建，共生成 ${res.data.accounts.length} 个面试账号`,
      );
    }
  } finally {
    submitting.value = false;
  }
}

function buildAccountText(acc: InterviewAccountVo): string {
  const r = createdResult.value;
  return [
    `【卫通会议 · 面试邀请】`,
    `面试主题：${r?.title || ""}`,
    `会议号：${r?.meetingNo ? formatMeetingNo(r.meetingNo) : "待同步"}`,
    `面试时间：${r?.startTime || ""}`,
    `面试者：${acc.candidateName}`,
    `登录用户名：${acc.username}`,
    `登录密码：${acc.password}`,
    `可开会次数：${acc.maxJoins} 次`,
    `账号有效期至：${acc.expiresAt}`,
  ].join("\n");
}

async function copyOneAccount(acc: InterviewAccountVo) {
  await copyText(buildAccountText(acc));
  ElMessage.success(`已复制 ${acc.candidateName} 的面试登录信息`);
}

async function copyAllAccounts() {
  if (!createdResult.value) return;
  const all = createdResult.value.accounts
    .map(buildAccountText)
    .join("\n\n────────────────\n\n");
  await copyText(all);
  ElMessage.success("已复制全部面试者登录凭证");
}

function resetToForm() {
  initDefaults();
}

function close() {
  emit("update:modelValue", false);
}
</script>

<style scoped>
.iv-modal {
  width: 600px;
  max-width: calc(100vw - 32px);
}

.iv-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.form-row-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.form-row-2 .form-group-modal {
  margin-bottom: 0;
}

.iv-body .form-group-modal {
  margin-bottom: 0;
}

.iv-picker,
.iv-body :deep(.el-date-editor.el-input) {
  width: 100% !important;
}

.iv-picker :deep(.el-input__wrapper) {
  height: 38px;
  border-radius: 8px;
}

.form-select {
  width: 100%;
  height: 38px;
  padding: 0 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
}

.form-select:focus {
  border-color: var(--primary);
}

.required {
  color: #ef4444;
}

.iv-add-row {
  display: flex;
  gap: 8px;
}

.iv-add-row input {
  flex: 1;
  min-width: 0;
}

.iv-add-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 14px;
  height: 38px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-soft);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}

.iv-add-btn:hover {
  border-color: var(--primary);
  color: var(--primary-text);
}

.iv-add-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-muted);
}

.iv-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.iv-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--primary-soft);
  color: var(--primary-text);
  font-size: 13px;
  font-weight: 500;
}

.iv-chip-del {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 0;
}

.iv-chip-del:hover {
  background: rgba(15, 23, 42, 0.12);
}

.iv-rule-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--bg-soft);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.55;
}

.iv-rule-banner i {
  font-size: 16px;
  color: var(--primary-text);
  flex-shrink: 0;
  margin-top: 1px;
}

.iv-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--bg-soft);
  border: 1px solid var(--border-color);
  flex-wrap: wrap;
}

.iv-sum-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.iv-sum-meta {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 12px;
  color: var(--text-secondary);
  flex-wrap: wrap;
}

.iv-sum-meta i {
  margin-right: 4px;
}

.iv-copy-all {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 34px;
  padding: 0 14px;
  border-radius: 8px;
  border: 0;
  background: var(--primary);
  color: #ffffff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.iv-table-wrap {
  max-height: 290px;
  overflow: auto;
  border: 1px solid var(--border-color);
  border-radius: 10px;
}

.iv-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.iv-table th,
.iv-table td {
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border-color);
  white-space: nowrap;
}

.iv-table th {
  background: var(--bg-soft);
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 12px;
}

.iv-table tr:last-child td {
  border-bottom: 0;
}

.iv-td-name {
  font-weight: 600;
  color: var(--text-primary);
}

.iv-td-mono {
  font-family: "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}

.iv-col-act {
  text-align: right !important;
}

.iv-mini-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}

.iv-mini-btn:hover {
  border-color: var(--primary);
  color: var(--primary-text);
}

@media (max-width: 600px) {
  .form-row-2 {
    grid-template-columns: 1fr;
  }
}
</style>
