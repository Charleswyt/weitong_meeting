import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/login/LoginView.vue'),
    meta: { requiresAuth: false },
  },
  {
    // 被别的页面嵌着时，只有顶层窗口能打开目录选择器，所以单独给这个小窗一条路。
    // 它只写 IndexedDB 里那个目录句柄，不碰账号数据，因此不需要登录态。
    path: '/recording-dir-picker',
    name: 'RecordingDirPicker',
    component: () => import('@/views/settings/RecordingDirPickerView.vue'),
    meta: { requiresAuth: false },
  },
  {
    path: '/',
    component: () => import('@/layout/MainLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'Dashboard',
        component: () => import('@/views/dashboard/DashboardView.vue'),
      },
      {
        path: 'meetings',
        name: 'Meetings',
        component: () => import('@/views/meeting/MeetingListView.vue'),
      },
      {
        path: 'all-meetings',
        name: 'AllMeetings',
        component: () => import('@/views/meeting/AllMeetingsView.vue'),
      },
      {
        path: 'meeting-empty',
        name: 'MeetingEmpty',
        component: () => import('@/views/meeting/EmptyMeetingView.vue'),
      },
      {
        path: 'meeting/pre/:id',
        name: 'PreMeeting',
        component: () => import('@/views/meeting/PreMeetingView.vue'),
      },
      {
        // 只在三方存在的会（手机/板卡发起）本库没有预约单，按 id 查详情必然 404；
        // 入会本来就只认会议号，所以这类会走这条路进预检。
        path: 'meeting/pre/no/:meetingNo',
        name: 'PreMeetingByNo',
        component: () => import('@/views/meeting/PreMeetingView.vue'),
      },
      {
        path: 'meeting/:id',
        name: 'InMeeting',
        component: () => import('@/views/meeting/InMeetingView.vue'),
      },
      {
        path: 'recordings',
        name: 'Recordings',
        component: () => import('@/views/recording/RecordingListView.vue'),
      },
      {
        path: 'recordings/play/:meetingId',
        name: 'RecordingPlayback',
        component: () => import('@/views/recording/RecordingPlaybackView.vue'),
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('@/views/settings/SettingsView.vue'),
      },
    ],
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to, _from, next) => {
  const token = localStorage.getItem('token')
  if (to.meta.requiresAuth && !token) {
    next('/login')
    return
  }
  if (to.path === '/login' && token) {
    next('/')
    return
  }
  // 会中页只认"当前确实在这场会里"。会议一结束会话态就没了，此时刷新或直接进
  // /meeting/:id 只会让页面去拉一个已不存在的会话，弹「系统异常」并卡在会中页。
  if (to.name === 'InMeeting') {
    const meetingId = sessionStorage.getItem('meetingId') || ''
    if (!meetingId || meetingId !== String(to.params.id)) {
      next('/meeting-empty')
      return
    }
  }
  next()
})

export default router
