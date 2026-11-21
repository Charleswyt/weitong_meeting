import { sitePath } from '@/utils/sitePath'
import axios from 'axios'
import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { ElMessage } from 'element-plus'
import router from '@/router'

export interface ApiResponse<T = any> {
  code: number
  msg: string
  data?: T
  rows?: T
  total?: number
  reason?: string
}

export interface PageResponse<T> {
  code: number
  msg: string
  rows: T[]
  total: number
}

export interface RequestOptions extends AxiosRequestConfig {
  // 由调用方自行处理错误（如 SM2 challenge 过期要重取公钥重试），拦截器不再弹提示。
  silent?: boolean
}

export class ApiError extends Error {
  code: number
  reason?: string

  constructor(message: string, code: number, reason?: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.reason = reason
  }
}

const service: AxiosInstance = axios.create({
  baseURL: import.meta.env.BASE_URL,
  // 超时上限 10 秒：请求要么在这个时间里回来，要么由后端回一个可重试的中间态。
  // 不允许把用户挂在「转圈几十秒」上。
  timeout: 10000,
})

service.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('weitong.token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// 同一条错误只出现一个弹窗：多个请求同时失败时（比如本端两条发布），用户会看到
// 一模一样的提示叠好几条，读起来像系统出了好几个问题。grouping 让 Element 合并成一条并计数。
function failToast(message: string) {
  ElMessage.error({ message, grouping: true })
}

// 免登录端点的路径（契约 §5.1）。同一个常量供两处用：重签请求本身，以及"重签不许递归"那条判定。
const AUTO_LOGIN_PATH = '/api/v1/auth/auto-login'

/** 重签过的请求打的那个标记；只许重放一次，第二次 401 就按普通失效处理。 */
interface RetriedConfig extends AxiosRequestConfig {
  __autoLoginRetried?: boolean
}

// renewAutoLoginToken 免登录模式下令牌到期时静默重签一次，返回新令牌（拿不到就回空串）。
//
// 为什么这里直接用本模块的 post 而不是 import '@/api/auth'：那个模块的 post 就是从这个文件取的，
// 反向引用会让两边互相依赖。为什么这一步必须有：令牌有效期 24 小时，板卡在船上跑满一天
// 就会全部回 401 —— 而免登录模式下的用户手里没有口令，把他踢回登录页等于把人锁在门外。
async function renewAutoLoginToken(config: RetriedConfig): Promise<string> {
  if (localStorage.getItem('weitong.autoLogin') !== '1') return ''
  if (config.__autoLoginRetried) return ''
  // 重签请求自己绝不能再触发重签，否则后端哪天对这条路径也回个 401 就成无限递归。
  if (config.url === AUTO_LOGIN_PATH) return ''
  try {
    const res = await post<{ token: string }>(AUTO_LOGIN_PATH, {}, { silent: true })
    return res.data?.token || ''
  } catch {
    // 开关被关掉、配置的账号被停用 —— 都落回下面的普通失效处理，这里不额外弹一句。
    return ''
  }
}

service.interceptors.response.use(
  async (response: AxiosResponse<ApiResponse>) => {
    const res = response.data
    if (res.code !== 200) {
      const silent = (response.config as RequestOptions).silent === true
      // reason=not_in_meeting 表示本端已经不在这场会里了（刚离会/被顶号/会散了）。
      // 这是正常收尾信号不是故障：不弹提示，只留控制台便于排查；reason 仍挂在
      // ApiError 上，调用方（如 store.leave / validateRestored）据此静默收尾。
      if (res.reason === 'not_in_meeting') {
        console.warn('[http] 本端已不在会中（正常收尾）:', response.config.url, res.msg)
      } else if (!silent) {
        failToast(res.msg || '请求失败')
      }
      if (res.code === 401) {
        const renewed = await renewAutoLoginToken(response.config as RetriedConfig)
        if (renewed) {
          localStorage.setItem('weitong.token', renewed)
          const retry: RetriedConfig = {
            ...response.config,
            __autoLoginRetried: true,
            headers: { ...response.config.headers, Authorization: `Bearer ${renewed}` },
          }
          // 重签成功就别让这一次点击白失败：原请求带着新令牌重来一次，用户不需要知道
          // 中间换了令牌（第 1 项口径：能自己收的尾不要报给用户）。
          return service.request(retry) as any
        }
        localStorage.removeItem('weitong.token')
        localStorage.removeItem('weitong.autoLogin')
        router.push('/login')
      }
      return Promise.reject(new ApiError(res.msg || '请求失败', res.code, res.reason))
    }
    return res as any
  },
  (error) => {
    // 后端用非 2xx 表达业务冲突（如 409 challenge 失效），响应体仍是统一信封，须解析出来。
    const envelope = error.response?.data as ApiResponse | undefined
    if (envelope && typeof envelope.code === 'number') {
      const silent = (error.config as RequestOptions | undefined)?.silent === true
      if (envelope.reason === 'not_in_meeting') {
        console.warn('[http] 本端已不在会中（正常收尾）:', error.config?.url, envelope.msg)
      } else if (!silent) {
        failToast(envelope.msg || '请求失败')
      }
      return Promise.reject(new ApiError(envelope.msg || '请求失败', envelope.code, envelope.reason))
    }
    // 走到这里说明响应不是统一信封（网关 5xx、HTML 错误页）或请求根本没出去。
    // 原始报错只留控制台，弹窗不外泄：有响应 = 系统异常，无响应 = 链路问题。
    // silent 必须同样生效：登录页探测免登录、发验证码等调用方会自己处理，不能再弹一条「系统异常」。
    const silent = (error.config as RequestOptions | undefined)?.silent === true
    if (error.response) {
      console.error('[http] 非信封响应', error.response.status, error.response.data)
      if (!silent) failToast('系统异常')
    } else {
      console.error('[http] 请求未送达', error.message)
      if (!silent) failToast('网络连接失败，请检查链路与后端服务')
    }
    return Promise.reject(error)
  }
)

export default service

export function get<T = any>(url: string, config?: RequestOptions): Promise<ApiResponse<T>> {
  return service.get(url, config) as any
}

export function post<T = any>(url: string, data?: any, config?: RequestOptions): Promise<ApiResponse<T>> {
  return service.post(url, data, config) as any
}

export function put<T = any>(url: string, data?: any, config?: RequestOptions): Promise<ApiResponse<T>> {
  return service.put(url, data, config) as any
}

export function del<T = any>(url: string, config?: RequestOptions): Promise<ApiResponse<T>> {
  return service.delete(url, config) as any
}

export function getPage<T = any>(url: string, config?: RequestOptions): Promise<PageResponse<T>> {
  return service.get(url, config) as any
}

// assetUrl 给浏览器原生加载器（<img>/<video>/fetch 直挂 src）补上登录票。
// 这类请求走不了 axios 拦截器，带不了 Authorization 头；后端只对**只读资产**放行票参。
export function assetUrl(path: string | undefined | null): string {
  if (!path) return ''
  const token = localStorage.getItem('weitong.token') || ''
  const sep = path.includes('?') ? '&' : '?'
  if (!path.startsWith('/') || path.startsWith('//')) return ''
  return `${sitePath(path)}${sep}token=${encodeURIComponent(token)}`
}
