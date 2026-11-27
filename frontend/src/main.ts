import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus, { ElMessage } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
// 原型图标体系是 remixicon，全局引一次，组件里只用 `ri-*` 字形类。
import 'remixicon/fonts/remixicon.css'

// 全局消息提示防刷屏：每次弹出新消息前先关闭旧消息，且固定顶部位置，
// 保证屏幕上最多只有 1 条提示，新消息原地替换旧消息、不向下堆叠。
const MESSAGE_TYPES = ['success', 'warning', 'error', 'info'] as const
for (const type of MESSAGE_TYPES) {
  const raw = ElMessage[type].bind(ElMessage)
  ;(ElMessage as any)[type] = (options: any, appContext?: any) => {
    ElMessage.closeAll()
    const normalized =
      typeof options === 'string'
        ? { message: options, type, offset: 16, grouping: true }
        : { offset: 16, grouping: true, ...options, type }
    return raw(normalized, appContext)
  }
}

import App from './App.vue'
import router from './router'
import { useUserStore } from '@/store/user'
import './styles/prototype.css'
import './styles/overrides.css'
import './styles/responsive.css'
import { ensureShareOrigin } from '@/utils/joinFlow'

// 本机用 localhost 打开时，提前把分享 origin 换成局域网 IP（微信/他机打不开 localhost）。
void ensureShareOrigin()

const app = createApp(App)

// 全局错误捕获：统一记录未处理的组件渲染错误与异步 Rejection，避免异常静默导致白屏或无从排查。
app.config.errorHandler = (err, instance, info) => {
  console.error('[app-error]', {
    component: instance?.$options?.name || instance?.$options?.__name || 'anonymous',
    info,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  })
}
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  console.error('[unhandled-rejection]', reason instanceof Error ? reason.message : reason)
})

const pinia = createPinia()
app.use(pinia)
app.use(ElementPlus, { locale: zhCn, message: { max: 1, grouping: true } })

// 免登录（2026-10-08 起的临时方案，契约 §5.1）：先问一次后端"这台免不免登录"，再挂路由。
// 为什么答案必须由后端给：前端产物是构建期烘死的，容器运行时的环境变量改不动它。
// 为什么 router 也要等这一步：vue-router 的 install() 会当场发起首次导航，先装 router 就是让
// 守卫在答案出来之前跑 —— 第一次访问会被判"无令牌"送进登录页，得刷第二次才进得去（实测踩过）。
// 后端没开这个开关时这里回 403，落回原来的登录页，不是故障、不弹提示。
void useUserStore(pinia)
  .bootstrapSession()
  .finally(() => {
    app.use(router)
    app.mount('#app')
  })
