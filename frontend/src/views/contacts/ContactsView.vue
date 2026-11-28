<template>
  <div class="ct-page">
    <div class="ct-topbar">
      <div class="ct-title">
        <span class="ct-title-text">通讯录</span>
        <span class="ct-count">{{ contacts.length }}</span>
      </div>
      <div class="ct-toolbar">
        <div class="ct-search-wrap">
          <i class="ri-search-line ct-search-ic" aria-hidden="true" />
          <input v-model="keyword" class="ct-search" type="text" placeholder="搜索好友姓名、备注、用户名" />
        </div>
        <button type="button" class="ct-primary" @click="openAdd">
          <i class="ri-user-add-line" />添加好友
        </button>
      </div>
    </div>

    <div class="ct-body">
      <section class="ct-list-pane">
        <div v-if="loading" class="ct-hint">加载中…</div>
        <template v-else-if="filtered.length">
          <button
            v-for="c in filtered"
            :key="c.userId"
            type="button"
            class="ct-row"
            :class="{ active: selected?.userId === c.userId }"
            @click="selectedId = c.userId"
          >
            <span class="ct-avatar">
              <img v-if="avatarSrcFor(String(c.userId), c.avatar)" :src="avatarSrcFor(String(c.userId), c.avatar)" :alt="c.displayName" @error="markAvatarBroken(String(c.userId))" />
              <em v-else>{{ contactLabel(c).charAt(0) }}</em>
            </span>
            <span class="ct-row-main">
              <span class="ct-row-name">{{ contactLabel(c) }}</span>
              <span class="ct-row-sub">
                <template v-if="c.remark">{{ c.displayName }} · </template>@{{ c.username }}
              </span>
            </span>
            <span v-if="c.hasEmail" class="ct-badge" title="已绑定邮箱，邀请时会收到邮件"><i class="ri-mail-line" /></span>
          </button>
        </template>
        <div v-else class="ct-empty">
          <div class="ct-empty-icon ri-contacts-book-line" />
          <div class="ct-empty-title">{{ keyword ? '没有匹配的好友' : '通讯录还是空的' }}</div>
          <div class="ct-empty-sub">{{ keyword ? '换个关键词试试' : '添加好友后，开会时可以直接从通讯录邀请' }}</div>
          <button v-if="!keyword" type="button" class="ct-primary ct-empty-btn" @click="openAdd">
            <i class="ri-user-add-line" />添加好友
          </button>
        </div>
      </section>

      <section class="ct-detail-pane">
        <template v-if="selected">
          <div class="ct-detail-head">
            <span class="ct-avatar ct-avatar-lg">
              <img v-if="avatarSrcFor(String(selected.userId), selected.avatar)" :src="avatarSrcFor(String(selected.userId), selected.avatar)" :alt="selected.displayName" @error="markAvatarBroken(String(selected.userId))" />
              <em v-else>{{ contactLabel(selected).charAt(0) }}</em>
            </span>
            <div class="ct-detail-names">
              <div class="ct-detail-name">{{ contactLabel(selected) }}</div>
              <div class="ct-detail-user">@{{ selected.username }}</div>
            </div>
          </div>

          <dl class="ct-fields">
            <div class="ct-field">
              <dt>显示名</dt>
              <dd>{{ selected.displayName || '—' }}</dd>
            </div>
            <div class="ct-field">
              <dt>备注</dt>
              <dd class="ct-remark">
                <template v-if="!editingRemark">
                  <span>{{ selected.remark || '未设置' }}</span>
                  <button type="button" class="ct-link" @click="startEditRemark"><i class="ri-edit-line" />修改</button>
                </template>
                <template v-else>
                  <input ref="remarkInput" v-model="remarkDraft" class="ct-input" maxlength="32" placeholder="给好友起个备注" @keyup.enter="saveRemark" @keyup.esc="editingRemark = false" />
                  <button type="button" class="ct-link" :disabled="savingRemark" @click="saveRemark">保存</button>
                  <button type="button" class="ct-link ct-link-muted" @click="editingRemark = false">取消</button>
                </template>
              </dd>
            </div>
            <div class="ct-field">
              <dt>邮箱</dt>
              <dd>
                {{ selected.email || '未绑定' }}
                <span v-if="selected.hasEmail" class="ct-tip">邀请入会时会自动发送邮件</span>
              </dd>
            </div>
            <div class="ct-field">
              <dt>手机号</dt>
              <dd>{{ selected.mobile || '未绑定' }}</dd>
            </div>
            <div class="ct-field">
              <dt>账号类型</dt>
              <dd>{{ accountTypeText(selected.accountType) }}</dd>
            </div>
            <div class="ct-field">
              <dt>添加时间</dt>
              <dd>{{ selected.addedAt || '—' }}</dd>
            </div>
          </dl>

          <div class="ct-detail-actions">
            <button type="button" class="ct-danger" @click="confirmRemove(selected)">
              <i class="ri-user-unfollow-line" />删除好友
            </button>
          </div>
        </template>
        <div v-else class="ct-hint ct-detail-empty">
          <i class="ri-user-line" />选择左侧好友查看详细信息
        </div>
      </section>
    </div>

    <el-dialog v-model="addOpen" width="520px" class="ct-add-dialog" :show-close="false" align-center>
      <template #header>
        <div class="wt-dlg-head-left">
          <i class="wt-dlg-icon ri-user-add-line" />
          <h3 class="el-dialog__title">添加好友</h3>
        </div>
        <button class="modal-close" type="button" aria-label="关闭" @click="addOpen = false">
          <i class="ri-close-line" />
        </button>
      </template>
      <div class="ct-add-search">
        <input
          ref="addInput"
          v-model="addKeyword"
          class="ct-input ct-add-input"
          placeholder="输入用户名、姓名，或完整的邮箱 / 手机号"
          @keyup.enter="runSearch"
          @input="debounceSearch"
        />
        <button type="button" class="ct-primary" :disabled="searching" @click="runSearch">搜索</button>
      </div>
      <div class="ct-add-results">
        <div v-if="searching" class="ct-hint">搜索中…</div>
        <template v-else-if="results.length">
          <div v-for="u in results" :key="u.userId" class="ct-add-row">
            <span class="ct-avatar">
              <img v-if="avatarSrcFor(String(u.userId), u.avatar)" :src="avatarSrcFor(String(u.userId), u.avatar)" :alt="u.displayName" @error="markAvatarBroken(String(u.userId))" />
              <em v-else>{{ (u.displayName || u.username).charAt(0) }}</em>
            </span>
            <span class="ct-row-main">
              <span class="ct-row-name">{{ u.displayName }}</span>
              <span class="ct-row-sub">@{{ u.username }}<template v-if="u.email"> · {{ u.email }}</template></span>
            </span>
            <span v-if="u.isContact" class="ct-added">已添加</span>
            <button v-else type="button" class="ct-primary ct-small" :disabled="adding === u.userId" @click="add(u)">
              {{ adding === u.userId ? '添加中…' : '添加' }}
            </button>
          </div>
        </template>
        <div v-else-if="searched" class="ct-hint">没有找到匹配的用户</div>
        <div v-else class="ct-hint">搜索系统中已注册的用户，把他们加入通讯录</div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  addContact, contactLabel, listContacts, removeContact, searchUsers, updateContactRemark,
  type ContactVo,
} from '@/api/contact'
import { avatarSrcFor, markAvatarBroken } from '@/utils/avatarImage'

const contacts = ref<ContactVo[]>([])
const loading = ref(false)
const keyword = ref('')
const selectedId = ref<number | null>(null)

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return contacts.value
  return contacts.value.filter((c) =>
    [c.remark, c.displayName, c.username].some((v) => (v || '').toLowerCase().includes(kw)),
  )
})
const selected = computed(() => contacts.value.find((c) => c.userId === selectedId.value) || null)

async function load() {
  loading.value = true
  try {
    contacts.value = (await listContacts()).data || []
    if (selectedId.value && !contacts.value.some((c) => c.userId === selectedId.value)) selectedId.value = null
    if (!selectedId.value && contacts.value.length) selectedId.value = contacts.value[0].userId
  } catch {
    /* 拦截器已提示 */
  } finally {
    loading.value = false
  }
}

function accountTypeText(t: string) {
  switch (t) {
    case 'super_admin': return '超级管理员'
    case 'device_admin': return '设备管理员'
    case 'meeting_participant': return '参会用户'
    default: return t || '普通用户'
  }
}

const editingRemark = ref(false)
const remarkDraft = ref('')
const savingRemark = ref(false)
const remarkInput = ref<HTMLInputElement | null>(null)
watch(selectedId, () => { editingRemark.value = false })
async function startEditRemark() {
  remarkDraft.value = selected.value?.remark || ''
  editingRemark.value = true
  await nextTick()
  remarkInput.value?.focus()
}
async function saveRemark() {
  const c = selected.value
  if (!c || savingRemark.value) return
  savingRemark.value = true
  try {
    await updateContactRemark(c.userId, remarkDraft.value.trim())
    c.remark = remarkDraft.value.trim()
    editingRemark.value = false
  } catch {
    /* 拦截器已提示 */
  } finally {
    savingRemark.value = false
  }
}

async function confirmRemove(c: ContactVo) {
  try {
    await ElMessageBox.confirm(`确定把「${contactLabel(c)}」从通讯录中删除？`, '删除好友', {
      type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    await removeContact(c.userId)
    ElMessage.success('已从通讯录删除')
    selectedId.value = null
    await load()
  } catch {
    /* 拦截器已提示 */
  }
}

const addOpen = ref(false)
const addKeyword = ref('')
const results = ref<ContactVo[]>([])
const searching = ref(false)
const searched = ref(false)
const adding = ref<number | null>(null)
const addInput = ref<HTMLInputElement | null>(null)
let searchTimer: number | null = null
let searchSeq = 0

async function openAdd() {
  addOpen.value = true
  addKeyword.value = ''
  results.value = []
  searched.value = false
  await nextTick()
  addInput.value?.focus()
}
function debounceSearch() {
  if (searchTimer) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(runSearch, 350)
}
async function runSearch() {
  if (searchTimer) { window.clearTimeout(searchTimer); searchTimer = null }
  const kw = addKeyword.value.trim()
  if (!kw) { results.value = []; searched.value = false; return }
  const seq = ++searchSeq
  searching.value = true
  try {
    const list = (await searchUsers(kw)).data || []
    if (seq === searchSeq) { results.value = list; searched.value = true }
  } catch {
    /* 拦截器已提示 */
  } finally {
    if (seq === searchSeq) searching.value = false
  }
}
async function add(u: ContactVo) {
  adding.value = u.userId
  try {
    await addContact(u.userId)
    u.isContact = true
    ElMessage.success(`已添加「${u.displayName}」`)
    await load()
    selectedId.value = u.userId
  } catch {
    /* 拦截器已提示 */
  } finally {
    adding.value = null
  }
}

onMounted(load)
</script>

<style scoped>
.ct-page { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: 16px 24px 24px; gap: 16px; }
.ct-topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.ct-title { display: flex; align-items: center; gap: 8px; }
.ct-title-text { font-size: 18px; font-weight: 600; color: var(--text-primary); }
.ct-count {
  min-width: 22px; height: 20px; padding: 0 7px; line-height: 20px; text-align: center;
  border-radius: var(--radius-pill); background: var(--bg-hover); font-size: 12px; color: var(--text-tertiary);
}
.ct-toolbar { display: flex; align-items: center; gap: 10px; }
.ct-search-wrap { position: relative; }
.ct-search-ic { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--text-muted); font-size: 14px; }
.ct-search {
  width: 260px; height: 36px; padding: 0 12px 0 32px; font-size: 13px; outline: none;
  background: var(--bg-input); border: 1px solid var(--border-color); border-radius: var(--radius); color: var(--text-primary);
}
.ct-search:focus, .ct-input:focus { border-color: var(--primary); }
.ct-primary {
  display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 16px; border: 0;
  border-radius: var(--radius); background: var(--primary); color: #fff; font-size: 13px; cursor: pointer; white-space: nowrap;
}
.ct-primary:hover { background: var(--primary-dark); }
.ct-primary:disabled { opacity: 0.6; cursor: not-allowed; }
.ct-small { height: 30px; padding: 0 12px; font-size: 12.5px; }

.ct-body { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(260px, 360px) 1fr; gap: 16px; }
.ct-list-pane, .ct-detail-pane {
  min-height: 0; overflow-y: auto; background: var(--bg-card);
  border: 1px solid var(--border-soft); border-radius: 12px;
}
.ct-list-pane { padding: 8px; display: flex; flex-direction: column; gap: 2px; }
.ct-row {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; text-align: left;
  border: 1px solid transparent; border-radius: 10px; background: transparent; cursor: pointer; color: inherit;
}
.ct-row:hover { background: var(--bg-hover); }
.ct-row.active { background: var(--primary-soft); border-color: rgba(59, 130, 246, 0.3); }
.ct-avatar {
  width: 38px; height: 38px; border-radius: 50%; overflow: hidden; flex-shrink: 0;
  background: var(--primary-soft); display: flex; align-items: center; justify-content: center;
}
.ct-avatar img { width: 100%; height: 100%; object-fit: cover; }
.ct-avatar em { font-style: normal; font-size: 15px; font-weight: 600; color: var(--primary-text); }
.ct-avatar-lg { width: 64px; height: 64px; }
.ct-avatar-lg em { font-size: 24px; }
.ct-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ct-row-name { font-size: 13.5px; font-weight: 600; color: var(--text-primary); word-break: break-all; }
.ct-row-sub { font-size: 12px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ct-badge { color: var(--primary-text); font-size: 14px; flex-shrink: 0; }

.ct-hint { padding: 24px 12px; text-align: center; font-size: 13px; color: var(--text-muted); }
.ct-empty { display: flex; flex-direction: column; align-items: center; padding: 48px 16px; gap: 8px; text-align: center; }
.ct-empty-icon { font-size: 40px; color: var(--text-muted); opacity: 0.7; }
.ct-empty-title { font-size: 14px; font-weight: 600; color: var(--text-secondary); }
.ct-empty-sub { font-size: 12.5px; color: var(--text-muted); }
.ct-empty-btn { margin-top: 8px; }

.ct-detail-pane { padding: 24px 28px; }
.ct-detail-empty { display: flex; align-items: center; justify-content: center; gap: 6px; height: 100%; }
.ct-detail-head { display: flex; align-items: center; gap: 16px; padding-bottom: 20px; border-bottom: 1px solid var(--border-soft); }
.ct-detail-names { min-width: 0; }
.ct-detail-name { font-size: 20px; font-weight: 600; color: var(--text-primary); word-break: break-all; }
.ct-detail-user { margin-top: 4px; font-size: 13px; color: var(--text-muted); }
.ct-fields { margin: 8px 0 0; }
.ct-field { display: grid; grid-template-columns: 88px 1fr; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border-soft); }
.ct-field dt { font-size: 13px; color: var(--text-muted); }
.ct-field dd { margin: 0; font-size: 13.5px; color: var(--text-primary); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; word-break: break-all; }
.ct-tip { font-size: 12px; color: var(--primary-text); background: var(--primary-soft); padding: 1px 8px; border-radius: 999px; }
.ct-remark .ct-input { width: 200px; }
.ct-input {
  height: 32px; padding: 0 10px; font-size: 13px; outline: none; color: var(--text-primary);
  background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 8px;
}
.ct-link {
  display: inline-flex; align-items: center; gap: 3px; border: 0; background: transparent; padding: 0;
  font-size: 12.5px; color: var(--primary-text); cursor: pointer;
}
.ct-link-muted { color: var(--text-muted); }
.ct-detail-actions { margin-top: 24px; display: flex; gap: 10px; }
.ct-danger {
  display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 16px; cursor: pointer;
  border-radius: var(--radius); border: 1px solid rgba(239, 68, 68, 0.4); background: transparent; color: var(--danger-text); font-size: 13px;
}
.ct-danger:hover { background: rgba(239, 68, 68, 0.1); }

.ct-add-search { display: flex; gap: 8px; }
.ct-add-input { flex: 1; height: 36px; }
.ct-add-results { margin-top: 12px; max-height: 360px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.ct-add-row { display: flex; align-items: center; gap: 10px; padding: 8px 6px; border-radius: 10px; }
.ct-add-row:hover { background: var(--bg-hover); }
.ct-added { font-size: 12px; color: var(--text-muted); }

@media (max-width: 767px) {
  .ct-page { padding: 12px; }
  .ct-body { grid-template-columns: 1fr; }
  .ct-search { width: 100%; }
  .ct-toolbar { width: 100%; }
  .ct-search-wrap { flex: 1; }
  .ct-detail-pane { padding: 16px; }
}
</style>
