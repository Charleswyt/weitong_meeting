<template>
  <div
    class="app-shell"
    :class="{
      'is-phone': isPhone,
      'is-tablet': isTablet,
      'is-desktop': isDesktop,
      'in-meeting': immersiveMeeting,
      'drawer-open': drawerOpen,
    }"
  >
    <!-- 手机顶栏：会中全沉浸时收起，把高度还给画面 -->
    <header v-if="isPhone && !immersiveMeeting" class="mobile-top">
      <button class="mobile-top-btn" type="button" aria-label="打开菜单" @click="drawerOpen = true">
        <i class="ri-menu-line" />
      </button>
      <div class="mobile-top-brand">
        <img :src="appIcon" alt="" width="28" height="28" />
        <span>卫通会议</span>
      </div>
      <button
        class="mobile-top-btn"
        type="button"
        :title="appStore.isDarkTheme ? '切换白昼模式' : '切换夜间模式'"
        @click="appStore.toggleTheme()"
      >
        <i :class="appStore.isDarkTheme ? 'ri-sun-line' : 'ri-moon-line'" />
      </button>
    </header>

    <div
      v-if="isPhone && drawerOpen"
      class="drawer-mask"
      @click="drawerOpen = false"
      @touchmove.prevent
    />

    <aside class="sidebar" :class="{ 'is-drawer': isPhone }">
      <div class="sidebar-header">
        <div class="sidebar-logo">
          <div class="sidebar-logo-icon">
            <img :src="appIcon" alt="" width="32" height="32" />
          </div>
          <div class="sidebar-brand-text">
            <span class="sidebar-logo-text">卫通会议</span>
            <span class="sidebar-subtitle">Weitong Meeting</span>
          </div>
        </div>
        <button
          v-if="isPhone"
          class="drawer-close"
          type="button"
          aria-label="关闭菜单"
          @click="drawerOpen = false"
        >
          <i class="ri-close-line" />
        </button>
      </div>

      <nav class="sidebar-nav">
        <div
          v-for="m in menus"
          :key="m.path"
          class="nav-item"
          :class="{ active: isActive(m) }"
          @click="goMenu(m.path)"
        >
          <i class="nav-item-icon" :class="m.icon" />
          <span class="nav-item-label">{{ m.label }}</span>
          <span v-if="m.badge" class="nav-item-badge">{{ m.badge }}</span>
        </div>
      </nav>

      <!-- 原型：会议信息卡只属于会议中页面；其余页面（含会中用户点进设置/录制）侧栏底部都是设备状态 -->
      <div v-if="!showMeetingInfo" class="device-status">
        <div class="device-status-title">
          <span><i class="ri-headphone-line" /> 设备状态</span>
          <!-- 进页/刷新已静默自检；按钮保留给用户手动再测一次 -->
          <button class="device-check-btn" :disabled="deviceBusy" @click="openDeviceAuth">
            {{ deviceBusy ? '检测中' : (deviceChecked ? '重新检测' : '检测') }}
          </button>
        </div>
        <div class="device-row">
          <i class="device-icon ri-camera-line" />
          <span class="device-label">摄像头</span>
          <span class="device-value">{{ deviceState.camera.text }}</span>
          <i v-if="deviceChecked" class="device-dot" :class="deviceState.camera.ok ? 'dot-ok' : 'dot-missing'"></i>
        </div>
        <div class="device-row">
          <i class="device-icon ri-mic-line" />
          <span class="device-label">麦克风</span>
          <span class="device-value">{{ deviceState.mic.text }}</span>
          <i v-if="deviceChecked" class="device-dot" :class="deviceState.mic.ok ? 'dot-ok' : 'dot-missing'"></i>
        </div>
        <div class="device-row">
          <i class="device-icon ri-volume-up-line" />
          <span class="device-label">扬声器</span>
          <span class="device-value">{{ deviceState.speaker.text }}</span>
          <i v-if="deviceChecked" class="device-dot" :class="deviceState.speaker.ok ? 'dot-ok' : 'dot-missing'"></i>
        </div>
      </div>

      <div v-else class="device-status">
        <div class="device-status-title"><i class="ri-vidicon-line" /> 会议信息</div>
        <div class="device-row">
          <span class="device-label">会议号</span>
          <span class="device-value">{{ meetingStore.meetingNo || '—' }}</span>
        </div>
        <div class="device-row">
          <span class="device-label">参会人数</span>
          <span class="device-value">{{ meetingStore.participants.length }}</span>
        </div>
        <div class="device-row">
          <span class="device-label">会议时长</span>
          <span class="device-value">{{ meetingDurationText }}</span>
        </div>
        <div class="device-row">
          <span class="device-label">本端媒体上行</span>
          <span class="device-value">{{ measuredRateText(meetingStore.mediaStats?.upKbps) }}</span>
        </div>
        <div class="device-row">
          <span class="device-label">本端媒体下行</span>
          <span class="device-value">{{ measuredRateText(meetingStore.mediaStats?.downKbps) }}</span>
        </div>

      </div>

      <div class="sidebar-footer">
        <div class="sidebar-theme-toggle" :title="appStore.isDarkTheme ? '切换白昼模式' : '切换夜间模式'" @click="appStore.toggleTheme()">
          <i :class="appStore.isDarkTheme ? 'ri-sun-line' : 'ri-moon-line'" />
          <span class="theme-label">{{ appStore.isDarkTheme ? '白昼模式' : '夜间模式' }}</span>
        </div>
        <el-dropdown trigger="click" @command="onUserCommand" placement="top-start">
          <div class="sidebar-user">
            <div class="sidebar-avatar">
              <img v-if="avatarSrc" :src="avatarSrc" alt="头像" @error="avatarBroken = true" />
              <span v-else class="sidebar-avatar-letter">{{ avatarChar }}</span>
            </div>
            <div class="sidebar-user-info">
              <span class="sidebar-user-name">{{ userStore.userInfo?.displayName || '用户' }}</span>
            </div>
          </div>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="settings">个人设置</el-dropdown-item>
              <!-- 免登录模式下藏着「退出登录」：点了它，下一次导航又被自动登回来 ——
                   一个只能把人留在原地的按钮不如没有（退出入口随 auth.autoLogin.enabled 一起回退）。 -->
              <el-dropdown-item v-if="!userStore.autoLoginMode" command="logout" divided>退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </aside>

    <main class="main-content">
      <button
        v-if="meetingStore.inMeeting && route.name !== 'InMeeting'"
        type="button"
        class="return-meeting-banner"
        @click="router.push(`/meeting/${meetingStore.meetingId}`)"
      >
        <span class="return-meeting-dot" />
        <span class="return-meeting-text">
          正在会议中{{ meetingStore.title ? `：${meetingStore.title}` : '' }}
        </span>
        <span class="return-meeting-cta">返回会议 <i class="ri-arrow-right-s-line" /></span>
      </button>
      <div v-if="!userStore.linkSynced" class="link-sync-banner">
        <i class="ri-error-warning-line" /> 会议服务连接异常：录制与会中状态暂不可用。
        <span v-if="userStore.linkReason" class="link-sync-reason">{{ userStore.linkReason }}</span>
      </div>
      <div class="content-scroll">
        <router-view />
      </div>
    </main>

    <!-- 手机底栏：会中沉浸时不占高度；入口与侧栏同源，少一层信息即可稳定进出会 -->
    <nav v-if="isPhone && !immersiveMeeting" class="mobile-tabbar" aria-label="主导航">
      <button
        v-for="m in mobileTabs"
        :key="m.path"
        type="button"
        class="mobile-tab"
        :class="{ active: isActive(m) }"
        @click="goMenu(m.path)"
      >
        <i :class="m.icon" />
        <span>{{ m.short }}</span>
        <em v-if="m.badge" class="mobile-tab-dot" />
      </button>
    </nav>

    <!-- 合成任务浮标：任务活在 store 里，换页面也照跑（这正是后台合成要买的东西）。
         只在还有未终态任务时出现，结果走一次性提示，不在页头挂常驻状态条。 -->
    <!-- 设备授权：应用内面板引导；真正取流仍须浏览器放行（无法用自绘 UI 替代系统权限） -->
    <div
      v-if="deviceAuthOpen"
      class="device-auth-mask"
      role="presentation"
      @click.self="deviceAuthOpen = false"
    >
      <div class="device-auth-panel" role="dialog" aria-modal="true" aria-labelledby="device-auth-title">
        <h3 id="device-auth-title">检测摄像头与麦克风</h3>
        <p>需要确认本机设备是否可用，以便会中正常开关画面与声音。</p>
        <ul class="device-auth-list">
          <li><i class="ri-camera-line" /> 摄像头：用于本地预览与推送画面</li>
          <li><i class="ri-mic-line" /> 麦克风：用于发言与本地录制</li>
        </ul>
        <p class="device-auth-note">点击「允许检测」后开始；若地址栏再次询问，请选择允许。</p>
        <div class="device-auth-actions">
          <button type="button" class="device-auth-btn" @click="deviceAuthOpen = false">取消</button>
          <button type="button" class="device-auth-btn primary" :disabled="deviceBusy" @click="confirmDeviceAuth">
            {{ deviceBusy ? '检测中…' : '允许检测' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="visibleComposeTasks.length" class="compose-float" role="status" aria-live="polite">
      <div v-for="t in visibleComposeTasks" :key="t.id" class="compose-float-row">
        <i class="compose-float-icon ri-movie-line" />
        <div class="compose-float-body">
          <div class="compose-float-title">{{ t.label }}</div>
          <div class="compose-float-bar">
            <span class="compose-float-bar-fill" :style="{ width: `${Math.round((t.ratio || 0) * 100)}%` }" />
          </div>
          <div class="compose-float-meta">{{ composeStateText(t) }}</div>
        </div>
        <button class="compose-float-cancel" @click="composeStore.cancel(t.id)">取消</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { assetUrl } from '@/utils/request'
import { playbackResumePath } from '@/utils/playbackResume'
import { measuredRateText } from '@/utils/compression'
import { ensureStoragePersisted } from '@/utils/localRecorder'
import { ensureRecordingsRecovered } from '@/utils/recordingRecovery'
import { useUserStore } from '@/store/user'
import { useMeetingStore } from '@/store/meeting'
import { useAppStore } from '@/store/app'
import appIcon from '@/assets/icon.png'
import { useComposeStore } from '@/store/compose'
import type { ComposeTaskRecord } from '@/utils/offlineCompose/composeQueue'
import type { ComposeOutcome } from '@/utils/offlineCompose/engine'
import { useMediaSettings } from '@/composables/useMediaSettings'
import { useViewport } from '@/composables/useViewport'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const appStore = useAppStore()
const meetingStore = useMeetingStore()
const composeStore = useComposeStore()
const { isPhone, isTablet, isDesktop } = useViewport()

/** 会中页全屏沉浸：不占顶栏/底栏/侧栏，把可视高度全给画面与主控。 */
const immersiveMeeting = computed(() => meetingStore.inMeeting && route.name === 'InMeeting')
const drawerOpen = ref(false)

watch(
  () => route.fullPath,
  () => {
    drawerOpen.value = false
  },
)

function goMenu(path: string) {
  drawerOpen.value = false
  if (route.path !== path) router.push(path)
}

/** 浮标只显示还没跑完的任务：跑完的那条已经用一次性提示说过结果，留着就成了常驻状态条 */
const visibleComposeTasks = computed(() =>
  composeStore.tasks.filter((t) => t.state === 'queued' || t.state === 'running'),
)

function composeStateText(t: ComposeTaskRecord<ComposeOutcome>): string {
  if (t.state === 'queued') return '排队中，前面还有事情在跑'
  // 收尾那几秒进度已经是 100%，不给一句"正在生成成品"就像卡死在这台电脑上
  if (t.phase === 'wrap') return '正在生成成品…'
  const pct = Math.round((t.ratio || 0) * 100)
  // 后台合成只报"已到第几秒"，不报"还要多久"：那个数要靠没标定的吞吐算，写出来就是承诺
  if (t.engine === 'realtime') {
    const left = Math.max(0, Math.round((t.expectedSec || 0) - t.coveredSec))
    return `合成中 ${pct}% · 约剩 ${left} 秒`
  }
  return `合成中 ${pct}% · 已到第 ${Math.round(t.coveredSec || 0)} 秒`
}
const { devices, captureIssue, mediaAccess, checkDeviceAccess } = useMediaSettings()

// 进页：已授权则静默刷新设备名；未询问不弹框（显示「待授权」）。点「检测」才请求权限。
const deviceChecked = ref(false)
const deviceBusy = ref(false)
const deviceAuthOpen = ref(false)

async function runDeviceCheck(interactive = false) {
  if (deviceBusy.value) return
  deviceBusy.value = true
  try {
    await checkDeviceAccess({ interactive })
    deviceChecked.value = true
  } finally {
    deviceBusy.value = false
  }
}

function openDeviceAuth() {
  if (deviceBusy.value) return
  deviceAuthOpen.value = true
}

async function confirmDeviceAuth() {
  deviceAuthOpen.value = false
  await runDeviceCheck(true)
}

// label 非空 = 本页已拿到授权证据；否则用 Permissions / 探测结果区分「待授权」与「未授权」。
function deviceLabel(list: MediaDeviceInfo[], access: 'unknown' | 'granted' | 'denied' | 'prompt') {
  if (!deviceChecked.value) return '未检测'
  if (list.some((d) => d.label) || access === 'granted') return '正常'
  if (list.length === 0) return '未检测到'
  if (access === 'denied') return '未授权'
  return '待授权'
}

const deviceState = computed(() => ({
  camera: {
    ok:
      !captureIssue.value.camera &&
      (devices.value.cameras.some((d) => d.label) || mediaAccess.value.camera === 'granted'),
    text: captureIssue.value.camera || deviceLabel(devices.value.cameras, mediaAccess.value.camera),
  },
  mic: {
    ok:
      !captureIssue.value.mic &&
      (devices.value.microphones.some((d) => d.label) || mediaAccess.value.mic === 'granted'),
    text: captureIssue.value.mic || deviceLabel(devices.value.microphones, mediaAccess.value.mic),
  },
  speaker: {
    ok: devices.value.speakers.length > 0,
    text: deviceChecked.value ? (devices.value.speakers.length ? '正常' : '未检测到') : '未检测',
  },
}))

// 「会议信息」是**会中页**的东西，不是"账号在某场会里"的东西：
// 会中用户切到设置/录制/所有会议时，原型那几页的侧栏底部同样是设备状态卡。
const showMeetingInfo = computed(() => meetingStore.inMeeting && route.name === 'InMeeting')

// computed 里的 Date.now() 不是响应依赖，会中时长会停在第一次渲染值；
// 会中信息卡可见时每秒推一次 nowTick，让时长跟着走。
const nowTick = ref(Date.now())
let durationTimer: number | undefined
watch(
  showMeetingInfo,
  (on) => {
    if (durationTimer !== undefined) {
      window.clearInterval(durationTimer)
      durationTimer = undefined
    }
    if (!on) return
    nowTick.value = Date.now()
    durationTimer = window.setInterval(() => {
      nowTick.value = Date.now()
    }, 1000)
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  if (durationTimer !== undefined) window.clearInterval(durationTimer)
})

const meetingDurationText = computed(() => {
  void nowTick.value
  const started = meetingStore.state?.startedAt
  if (!started) return '—'
  const ms = new Date(started).getTime()
  if (isNaN(ms)) return '—'
  const total = Math.max(0, Math.floor((nowTick.value - ms) / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
})

onMounted(() => {
  if (userStore.token && !userStore.userInfo) {
    userStore.fetchUserInfo().catch(() => {})
  }
  // 恢复出来的会议 id 可能早已作废（后端重启、会已在别处结束）：先校验再决定挂不挂"已入会"。
  void meetingStore.validateRestored()
  // 上一次没点「停止」就关掉的那场：分片其实都在这台设备上，启动时重建回列表（工作 A）。
  // 只在真恢复出东西时说一句，不挂常驻状态条。
  void ensureRecordingsRecovered().then((rows) => {
    if (rows.length) ElMessage.success('上次未正常结束的录制已恢复到列表')
  })
  // D7：顺便把本机录制库标成"别回收"。批不下来不影响录制，但少了它，磁盘吃紧时浏览器会连分片一起清 ——
  // 那时自愈也救不回来（它只收真取得到字节的那一路）。这里不问用户，也不在界面上报状态。
  void ensureStoragePersisted()
  // 进页静默检测：已授权会刷新设备名；未询问不弹框。
  void runDeviceCheck(false)
})

const menus = computed(() => {
  // 「录制会议」在离开列表页之后指向**上次看的那条回放**（续看）。存的是整条地址（含查询串），
  // 所以本机录制的 `?local=` 不会丢；读到脏值就落回列表页（见 utils/playbackResume.ts）。
  const resumePath = route.name === 'Recordings' ? '' : playbackResumePath()
  return [
    { path: '/', active: ['/', '/meetings'], icon: 'ri-clipboard-line', label: '会议管理', short: '首页' },
    { path: meetingStore.inMeeting ? `/meeting/${meetingStore.meetingId}` : '/meeting-empty', active: ['/meeting/*', '/meeting-empty'], icon: 'ri-vidicon-line', label: '卫通会议', short: '会议', badge: meetingStore.inMeeting ? '已入会' : '' },
    { path: '/all-meetings', active: ['/all-meetings'], icon: 'ri-calendar-line', label: '所有会议', short: '全部' },
    { path: resumePath || '/recordings', active: ['/recordings', '/recordings/*'], icon: 'ri-clapperboard-line', label: '录制会议', short: '录制' },
    { path: '/settings', active: ['/settings'], icon: 'ri-settings-3-line', label: '设置', short: '设置' },
  ]
})

/** 底栏四格：首页 / 会议 / 录制 / 设置；「全部」只在侧栏抽屉，避免五个标签挤成一条。 */
const mobileTabs = computed(() => {
  const all = menus.value
  return [all[0], all[1], all[3], all[4]].filter(Boolean)
})

const avatarChar = computed(() => (userStore.userInfo?.displayName || '用').charAt(0))

const avatarBroken = ref(false)
const avatarSrc = computed(() => {
  const a = userStore.userInfo?.avatar
  return a && !avatarBroken.value ? assetUrl(a) : ''
})

function isActive(menu: { active: string[] }) {
  // '/*' 结尾按前缀命中（会中/会前页都算"卫通会议"），其余按整段路径精确命中。
  return menu.active.some((p) => (p.endsWith('/*') ? route.path.startsWith(p.slice(0, -1)) : route.path === p))
}

async function onUserCommand(cmd: string) {
  if (cmd === 'settings') {
    router.push('/settings')
  } else if (cmd === 'logout') {
    try {
      await ElMessageBox.confirm('确定退出登录？', '提示', { type: 'warning' })
    } catch {
      return
    }
    await userStore.logout()
    // 合成队列是内存态、不跟着身份走：不清的话下一个人登录上来能在浮标上
    // 看见并下载上一个人合成的那一场
    composeStore.forgetAll()
    router.push('/login')
  }
}
</script>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: row;
  /* 100vh 在平板浏览器的地址栏下**高于可视视口**：底部内容够不到，滚动条也看不到底。
     dvh 跟着工具栏收放；不支持的浏览器沿用上一行 100vh。 */
  height: 100vh;
  height: 100dvh;
  /* 100vw 把滚动条宽度也算进去 → 出横向溢出，整页能左右晃。 */
  width: 100%;
  overflow: hidden;
  background: var(--bg-dark);
}

.sidebar {
  width: 264px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-soft);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-header {
  height: 64px;
  padding: 0 18px;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.sidebar-logo {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 只展示圆形徽章本体：裁掉外圈暗底/底部纹理，不加底板光晕 */
.sidebar-logo-icon {
  width: 36px;
  height: 36px;
  padding: 0;
  box-sizing: border-box;
  background: transparent;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border: 0;
  box-shadow: none;
  overflow: hidden;
}
.sidebar-logo-icon img {
  width: 40px;
  height: 40px;
  object-fit: cover;
  object-position: center 42%;
  border-radius: 0;
  display: block;
  box-shadow: none;
  filter: none;
}

.sidebar-brand-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.sidebar-logo-text {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
}

.sidebar-subtitle {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  font-weight: 400;
  color: var(--text-muted);
  line-height: 1.2;
}

.sidebar-nav {
  flex: 1;
  padding: 18px 16px;
  overflow-y: auto;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 46px;
  padding: 0 16px;
  border-radius: var(--radius);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
  font-size: 14px;
  position: relative;
}

.nav-item:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.nav-item.active {
  background: var(--primary-soft);
  color: var(--primary-text);
  font-weight: 500;
}

.nav-item-icon {
  font-size: 19px;
  width: 22px;
  text-align: center;
  flex-shrink: 0;
}

.nav-item-label {
  flex: 1;
}

.nav-item-badge {
  padding: 2px 8px;
  background: var(--primary);
  color: #fff;
  font-size: 11px;
  font-weight: 500;
  border-radius: 10px;
  line-height: 1.4;
}

.sidebar-footer {
  padding: 16px;
  border-top: 1px solid var(--border-color);
}

.device-status {
  overflow-y: auto; min-height: 0;
  margin: 0 16px 12px;
  padding: 14px;
  background: var(--bg-hover);
  border-radius: var(--radius);
}

.device-status-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 10px;
}
.device-auth-mask {
  position: fixed;
  inset: 0;
  z-index: 1200;
  background: rgba(8, 14, 28, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.device-auth-panel {
  width: min(420px, 100%);
  background: var(--bg-card, var(--bg-dark));
  border: 1px solid var(--border-color);
  border-radius: 14px;
  padding: 22px 22px 18px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35);
  color: var(--text-primary);
}
.device-auth-panel h3 {
  margin: 0 0 10px;
  font-size: 18px;
  font-weight: 700;
}
.device-auth-panel > p {
  margin: 0 0 12px;
  font-size: 14px;
  line-height: 1.55;
  color: var(--text-secondary);
}
.device-auth-list {
  margin: 0 0 12px;
  padding: 12px 14px;
  list-style: none;
  background: var(--bg-hover);
  border-radius: 10px;
  font-size: 13px;
  color: var(--text-primary);
}
.device-auth-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  line-height: 1.5;
}
.device-auth-list li + li { margin-top: 8px; }
.device-auth-note {
  margin: 0 0 16px !important;
  font-size: 12px !important;
  color: var(--text-secondary);
}
.device-auth-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}
.device-auth-btn {
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  padding: 8px 14px;
  border-radius: 8px;
  cursor: pointer;
}
.device-auth-btn.primary {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
.device-auth-btn:disabled { opacity: 0.6; cursor: not-allowed; }

/* 「重新检测」键：颜色全部取既有 token，不引新色值（第 20 项的口径纪律） */
.device-check-btn {
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.device-check-btn:hover:not(:disabled) {
  color: var(--primary-text);
  border-color: var(--primary);
}
.device-check-btn:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
.device-check-btn:disabled {
  cursor: default;
  opacity: 0.6;
}

.device-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.device-icon {
  width: 18px;
  text-align: center;
}

.device-label {
  flex: 0 0 auto;
}

.device-value {
  flex: 1;
  text-align: right;
  color: var(--text-muted);
}

.device-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-ok {
  background: var(--success);
}

.dot-missing {
  background: var(--text-muted);
}

.sidebar-theme-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 13px;
  transition: all 0.2s ease;
  margin-bottom: 8px;
}

.sidebar-theme-toggle:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.theme-label {
  flex: 1;
}

.sidebar-user {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sidebar-user:hover {
  background: var(--bg-hover);
}

.sidebar-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--primary-soft);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
}

.sidebar-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.sidebar-avatar-letter {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  color: var(--primary-text);
  /* 中文/西文字形基线不一，微调使视觉落在圆心 */
  transform: translateY(0.5px);
}

.sidebar-user-info {
  display: flex;
  align-items: center;
  min-width: 0;
}

.sidebar-user-name {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.link-sync-banner {
  flex-shrink: 0;
  padding: 8px 24px;
  background: rgba(255, 152, 0, 0.1);
  border-bottom: 1px solid rgba(255, 152, 0, 0.3);
  color: var(--orange, #FF9800);
  font-size: 13px;
}

.link-sync-reason {
  margin-left: 8px;
  color: var(--text-muted);
  font-size: 12px;
}

.content-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
}

/* 首页：外层不滚，把滚动留给「近期会议」面板 */
.content-scroll:has(> .home-page) {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.content-scroll:has(> .home-page) > .home-page {
  flex: 1;
  min-height: 0;
}

/* 合成任务浮标：token 全用本仓已定义的（check:tokens 会抓不存在的 var） */
.compose-float {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2000;
  width: 300px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 45vh;
  overflow-y: auto;
}
.compose-float-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
}
.compose-float-icon {
  color: var(--primary-text);
  font-size: 18px;
  flex: 0 0 auto;
}
.compose-float-body {
  flex: 1;
  min-width: 0;
}
.compose-float-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.compose-float-bar {
  margin-top: 6px;
  height: 4px;
  border-radius: 2px;
  background: var(--bg-soft);
  overflow: hidden;
}
.compose-float-bar-fill {
  display: block;
  height: 100%;
  background: var(--primary);
  transition: var(--transition);
}
.compose-float-meta {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}
.compose-float-cancel {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  color: var(--danger-text);
  font-size: 12px;
  cursor: pointer;
}

.drawer-close {
  display: none;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 10px;
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-size: 18px;
  cursor: pointer;
}
.drawer-mask {
  display: none;
}
.mobile-top,
.mobile-tabbar {
  display: none;
}

/* 平板：264px 侧栏在 8~11 寸横屏吃掉近三分之一宽度 → 收成图标栏，把宽度还给画面。 */
.app-shell.is-tablet .sidebar {
  width: 68px;
}
.app-shell.is-tablet .sidebar-brand-text,
.app-shell.is-tablet .nav-item-label,
.app-shell.is-tablet .nav-item-badge,
.app-shell.is-tablet .device-status,
.app-shell.is-tablet .theme-label,
.app-shell.is-tablet .sidebar-user-info {
  display: none;
}
.app-shell.is-tablet .sidebar-header { justify-content: center; padding: 0 8px; }
.app-shell.is-tablet .sidebar-logo { gap: 0; }
.app-shell.is-tablet .sidebar-nav { padding: 14px 8px; }
.app-shell.is-tablet .nav-item { justify-content: center; padding: 0; gap: 0; height: 44px; }
.app-shell.is-tablet .sidebar-footer { padding: 10px 6px; }
.app-shell.is-tablet .sidebar-theme-toggle,
.app-shell.is-tablet .sidebar-user { justify-content: center; }

/* 手机：侧栏改抽屉；顶栏 + 底栏；会中全沉浸不占 chrome */
.app-shell.is-phone {
  flex-direction: column;
}
.app-shell.is-phone .mobile-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
  height: calc(var(--mobile-top-h) + var(--safe-top));
  padding: var(--safe-top) 12px 0;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border-soft);
  z-index: 20;
}
.mobile-top-btn {
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 20px;
  cursor: pointer;
}
.mobile-top-btn:active { background: var(--bg-hover); }
.mobile-top-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 650;
  color: var(--text-primary);
}
.mobile-top-brand img {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  object-position: center 42%;
}

.app-shell.is-phone .drawer-mask {
  display: block;
  position: fixed;
  inset: 0;
  z-index: 40;
  background: rgba(15, 23, 42, 0.45);
  backdrop-filter: blur(2px);
}
.app-shell.is-phone .sidebar.is-drawer {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: 50;
  width: min(300px, 86vw);
  transform: translateX(-105%);
  transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
  box-shadow: none;
}
.app-shell.is-phone.drawer-open .sidebar.is-drawer {
  transform: translateX(0);
  box-shadow: 8px 0 32px rgba(0, 0, 0, 0.28);
}
.app-shell.is-phone .sidebar-header {
  justify-content: space-between;
  padding: calc(12px + var(--safe-top)) 14px 12px;
  height: auto;
}
.app-shell.is-phone .drawer-close { display: inline-flex; align-items: center; justify-content: center; }
.app-shell.is-phone .sidebar-brand-text {
  display: flex;
}
.app-shell.is-phone .device-status { display: block; }
.app-shell.is-phone .theme-label,
.app-shell.is-phone .nav-item-label { display: block; }
.app-shell.is-phone .sidebar-user-info { display: flex; }
.app-shell.is-phone .nav-item-badge { display: inline-block; }
.app-shell.is-phone .nav-item {
  justify-content: flex-start;
  padding: 0 16px;
  gap: 12px;
  height: 48px;
}
.app-shell.is-phone .sidebar-nav { padding: 12px 14px; }
.app-shell.is-phone .sidebar-footer { padding: 14px; padding-bottom: calc(14px + var(--safe-bottom)); }

.app-shell.is-phone .main-content {
  flex: 1;
  min-height: 0;
}
.app-shell.is-phone .link-sync-banner {
  padding: 8px 14px;
  font-size: 12px;
}

.app-shell.is-phone .mobile-tabbar {
  display: flex;
  align-items: stretch;
  justify-content: space-around;
  flex-shrink: 0;
  height: calc(var(--mobile-nav-h) + var(--safe-bottom));
  padding: 0 4px var(--safe-bottom);
  background: var(--bg-sidebar);
  border-top: 1px solid var(--border-soft);
  z-index: 20;
}
.mobile-tab {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 11px;
  cursor: pointer;
  min-height: var(--mobile-nav-h);
  -webkit-tap-highlight-color: transparent;
}
.mobile-tab > i { font-size: 20px; line-height: 1; }
.mobile-tab.active { color: var(--primary-text); font-weight: 600; }
.mobile-tab-dot {
  position: absolute;
  top: 8px;
  right: calc(50% - 14px);
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--primary);
}

/* 会中沉浸：侧栏完全让出（平板图标栏也收），手机无顶/底栏 */
.app-shell.in-meeting.is-phone .sidebar,
.app-shell.in-meeting.is-tablet .sidebar {
  display: none;
}
.app-shell.in-meeting .compose-float {
  bottom: calc(12px + var(--safe-bottom));
}

.return-meeting-banner {
  flex-shrink: 0;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border: 0;
  background: linear-gradient(90deg, #16a34a, #15803d);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
}
.return-meeting-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #bbf7d0;
  flex-shrink: 0;
  box-shadow: 0 0 0 3px rgba(187, 247, 208, 0.3);
}
.return-meeting-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.return-meeting-cta {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.2);
  font-size: 12px;
  font-weight: 600;
}
</style>
