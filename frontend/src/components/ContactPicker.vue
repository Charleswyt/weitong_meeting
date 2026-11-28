<template>
  <div class="cpk">
    <div class="cpk-head">
      <span class="cpk-title"><i class="ri-contacts-book-line" />从通讯录邀请</span>
      <span v-if="selected.length" class="cpk-picked">已选 {{ selected.length }} 人<template v-if="emailCount">，其中 {{ emailCount }} 人会收到邮件邀请</template></span>
    </div>
    <div v-if="contacts.length > 6" class="cpk-search">
      <i class="ri-search-line" />
      <input v-model="keyword" type="text" placeholder="搜索好友" />
    </div>
    <div class="cpk-list" :style="{ maxHeight: maxHeight }">
      <div v-if="loading" class="cpk-hint">加载中…</div>
      <template v-else-if="filtered.length">
        <label v-for="c in filtered" :key="c.userId" class="cpk-row" :class="{ on: isPicked(c.userId) }">
          <input type="checkbox" :checked="isPicked(c.userId)" @change="toggle(c.userId)" />
          <span class="cpk-avatar">
            <img v-if="avatarSrcFor(String(c.userId), c.avatar)" :src="avatarSrcFor(String(c.userId), c.avatar)" :alt="c.displayName" @error="markAvatarBroken(String(c.userId))" />
            <em v-else>{{ contactLabel(c).charAt(0) }}</em>
          </span>
          <span class="cpk-name">{{ contactLabel(c) }}</span>
          <span v-if="c.hasEmail" class="cpk-mail" title="已绑定邮箱，会自动发送邀请邮件"><i class="ri-mail-send-line" />邮件</span>
        </label>
      </template>
      <div v-else-if="contacts.length" class="cpk-hint">没有匹配的好友</div>
      <div v-else class="cpk-hint">
        通讯录还是空的，<router-link to="/contacts" class="cpk-link" @click="$emit('navigate')">去添加好友</router-link>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { contactLabel, listContacts, type ContactVo } from '@/api/contact'
import { avatarSrcFor, markAvatarBroken } from '@/utils/avatarImage'

const props = withDefaults(defineProps<{ maxHeight?: string; excludeIds?: number[] }>(), {
  maxHeight: '180px',
  excludeIds: () => [],
})
defineEmits<{ (e: 'navigate'): void }>()
const selected = defineModel<number[]>({ default: () => [] })

const contacts = ref<ContactVo[]>([])
const loading = ref(false)
const keyword = ref('')

const visibleContacts = computed(() => {
  const ex = new Set(props.excludeIds)
  return contacts.value.filter((c) => !ex.has(c.userId))
})
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return visibleContacts.value
  return visibleContacts.value.filter((c) =>
    [c.remark, c.displayName, c.username].some((v) => (v || '').toLowerCase().includes(kw)),
  )
})
const emailCount = computed(() =>
  contacts.value.filter((c) => c.hasEmail && selected.value.includes(c.userId)).length,
)

function isPicked(id: number) {
  return selected.value.includes(id)
}
function toggle(id: number) {
  selected.value = isPicked(id) ? selected.value.filter((x) => x !== id) : [...selected.value, id]
}

async function load() {
  loading.value = true
  try {
    contacts.value = (await listContacts()).data || []
  } catch {
    /* 拦截器已提示 */
  } finally {
    loading.value = false
  }
}

onMounted(load)
defineExpose({ reload: load })
</script>

<style scoped>
.cpk { display: flex; flex-direction: column; gap: 8px; }
.cpk-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.cpk-title { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 600; color: var(--text-primary); }
.cpk-title i { color: var(--primary-text); }
.cpk-picked { font-size: 12px; color: var(--primary-text); }
.cpk-search { position: relative; }
.cpk-search i { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font-size: 13px; color: var(--text-muted); }
.cpk-search input {
  width: 100%; height: 32px; padding: 0 10px 0 30px; font-size: 13px; outline: none; color: var(--text-primary);
  background: var(--bg-input); border: 1px solid var(--border-color); border-radius: 8px;
}
.cpk-search input:focus { border-color: var(--primary); }
.cpk-list {
  overflow-y: auto; border: 1px solid var(--border-soft); border-radius: 10px; padding: 4px;
  display: flex; flex-direction: column; gap: 2px;
}
.cpk-row {
  display: flex; align-items: center; gap: 9px; padding: 6px 8px; border-radius: 8px; cursor: pointer;
}
.cpk-row:hover { background: var(--bg-hover); }
.cpk-row.on { background: var(--primary-soft); }
.cpk-row input { accent-color: var(--primary); width: 15px; height: 15px; margin: 0; flex-shrink: 0; }
.cpk-avatar {
  width: 28px; height: 28px; border-radius: 50%; overflow: hidden; flex-shrink: 0;
  background: var(--primary-soft); display: flex; align-items: center; justify-content: center;
}
.cpk-avatar img { width: 100%; height: 100%; object-fit: cover; }
.cpk-avatar em { font-style: normal; font-size: 12px; font-weight: 600; color: var(--primary-text); }
.cpk-name { flex: 1; min-width: 0; font-size: 13px; color: var(--text-primary); word-break: break-all; }
.cpk-mail { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: var(--primary-text); flex-shrink: 0; }
.cpk-hint { padding: 14px 8px; text-align: center; font-size: 12.5px; color: var(--text-muted); }
.cpk-link { color: var(--primary-text); }
</style>
