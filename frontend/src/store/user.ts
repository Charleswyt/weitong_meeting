import { defineStore } from 'pinia'
import { ref } from 'vue'
import * as authApi from '@/api/auth'
import { useMeetingStore } from '@/store/meeting'
import type { UserInfo } from '@/api/auth'

export { type UserInfo }

export const useUserStore = defineStore('user', () => {
  const token = ref(localStorage.getItem('token') || '')
  const userInfo = ref<UserInfo | null>(null)
  const linkSynced = ref(true)
  const linkReason = ref('')

  // 记住的只是登录账号名（口令绝不落本地），用于下次预填。
  const rememberedUsername = ref(localStorage.getItem('rememberedUsername') || '')

  // 免登录模式（临时方案）：这一台以配置里那一个固定账号在服务，界面上不该出现登录页。
  // 为什么要记在 localStorage 而不是每次问后端：刷新后仍要知道"退出入口该不该藏"，
  // 而此时守卫因为手里有令牌就不会再打 auto-login 了。手动口令登录成功会把它清掉。
  const autoLoginMode = ref(localStorage.getItem('autoLogin') === '1')

  // 本轮页面加载内只试一次免登录：后端没起或开关关着时，每次导航都重打一回就是
  // 每跳一页白等一个 10 秒超时 —— 那看着像页面死了。刷新才重新试。
  let autoLoginTried = false
  let autoLoginInflight: Promise<boolean> | null = null

  // bootstrapSession 在没有令牌时试一次免登录，返回"现在有没有登录态"。
  // 失败不是故障：开关关着 / 配置的账号不可用，就照原样落回登录页（契约 §5.1）。
  //
  // 免登录模式下**每次加载都重签**，不认手里那份令牌：身份由服务端配置决定（前端不配账号），
  // 旧令牌只代表"当时配置的那个账号"。不重签的后果实测过（2026-10-10）：把免登录账号从
  // `wangqiang` 换成 `chenfang` 后，浏览器仍以 wangqiang 在跑 —— 页面进得去，但一发起会议
  // 就被船端网关 401 拒掉，看着像功能坏了。手动登录过的那台（autoLogin 位已清）照旧不重签。
  async function bootstrapSession(): Promise<boolean> {
    const autoLoginBefore = localStorage.getItem('autoLogin') === '1'
    if (token.value && !autoLoginBefore) return true
    if (autoLoginInflight) return autoLoginInflight
    if (autoLoginTried) return false

    autoLoginInflight = (async () => {
      autoLoginTried = true
      try {
        const res = await authApi.autoLogin()
        token.value = res.token
        localStorage.setItem('token', res.token)
        userInfo.value = res.user || null
        linkSynced.value = res.linkSynced !== false
        linkReason.value = res.linkReason || ''
        autoLoginMode.value = true
        localStorage.setItem('autoLogin', '1')
        return true
      } catch {
        autoLoginMode.value = false
        localStorage.removeItem('autoLogin')
        return false
      } finally {
        autoLoginInflight = null
      }
    })()
    return autoLoginInflight
  }

  function applyLoginResult(res: authApi.LoginResult) {
    token.value = res.token
    localStorage.setItem('token', res.token)
    userInfo.value = res.user || null
    linkSynced.value = res.linkSynced !== false
    linkReason.value = res.linkReason || ''
    // 有人主动登录，这一台就不再是免登录那台了：模式位必须跟着清，
    // 否则「退出登录」会被继续藏起来，点不到的按钮留着就是骗人。
    autoLoginMode.value = false
    localStorage.removeItem('autoLogin')
  }

  async function login(username: string, password: string, remember = false) {
    const res = await authApi.login(username, password)
    applyLoginResult(res)
    if (remember) {
      rememberedUsername.value = username
      localStorage.setItem('rememberedUsername', username)
    } else {
      rememberedUsername.value = ''
      localStorage.removeItem('rememberedUsername')
    }
    if (!userInfo.value) {
      await fetchUserInfo()
    }
  }

  async function loginBySms(mobile: string, code: string) {
    const res = await authApi.loginBySms(mobile, code)
    applyLoginResult(res)
    if (!userInfo.value) {
      await fetchUserInfo()
    }
  }

  async function loginByEmail(
    email: string,
    code: string,
    opts?: { displayName?: string; registerAs?: 'user' | 'temp' },
  ) {
    const res = await authApi.loginByEmail(email, code, opts)
    applyLoginResult(res)
    if (!userInfo.value) {
      await fetchUserInfo()
    }
  }

  async function fetchUserInfo() {
    const res = await authApi.getMe()
    userInfo.value = res.data!
  }

  // 录制归属判据要先知道"我是谁"。MainLayout 里那句 fetchUserInfo() 是不 await 的，
  // 而恢复链路、录制列表在同一拍就跑 —— 那时 username 还是空，按"不匹配"处理会一次隐藏全部本机录制。
  // 这里复用同一条在飞的请求，不额外打后端。
  let identityInflight: Promise<void> | null = null
  async function ensureIdentity(): Promise<string> {
    if (userInfo.value?.username) return userInfo.value.username
    if (!token.value) return ''
    if (!identityInflight) {
      identityInflight = fetchUserInfo()
        .catch(() => {})
        .finally(() => {
          identityInflight = null
        })
    }
    await identityInflight
    return userInfo.value?.username?.trim() || ''
  }

  async function logout() {
    try {
      await authApi.logout()
    } finally {
      token.value = ''
      userInfo.value = null
      linkSynced.value = true
      linkReason.value = ''
      autoLoginMode.value = false
      localStorage.removeItem('token')
      localStorage.removeItem('autoLogin')
      // 会议态和登录态同生共死：不清它就会在下一次登录后直接落进一场已结束的会中页。
      useMeetingStore().clear()
    }
  }

  return {
    token,
    userInfo,
    linkSynced,
    linkReason,
    rememberedUsername,
    autoLoginMode,
    bootstrapSession,
    login,
    loginBySms,
    loginByEmail,
    fetchUserInfo,
    ensureIdentity,
    logout,
  }
})
