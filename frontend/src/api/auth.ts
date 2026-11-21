import { get, post } from '@/utils/request'
import { ApiError } from '@/utils/request'
import { buildLoginPayload, fetchSm2Descriptor, isRetryableReason } from '@/utils/sm2'
import type { components } from '@/types/api.gen'

// 线格式类型取自契约生成物（../contracts/api.openapi.yaml → src/types/api.gen.ts），不手写第二份。
// 接线时暴露的分叉：旧手写版把 avatar/positionCode/positionName 标为可选，
// 契约（按后端运行时）三个键恒出现（空值是 ""）—— 消费点只读不构造，收窄无破坏。
export type UserInfo = components['schemas']['UserVo']

// 旧手写版与契约同形；契约里 linkReason 带 omitempty（与旧声明一致）。
export type LoginResult = components['schemas']['LoginData']

// login 走 SM2 信封；challenge 失效时重取公钥重试一次（契约 §5.1），仍失败则抛出。
export async function login(username: string, password: string): Promise<LoginResult> {
  const attempt = async () => {
    const desc = await fetchSm2Descriptor()
    return post<LoginResult>('/api/v1/auth/login', buildLoginPayload(desc, username, password), { silent: true })
  }

  let res
  try {
    res = await attempt()
  } catch (err) {
    if (err instanceof ApiError && isRetryableReason(err.reason)) {
      res = await attempt()
    } else {
      throw err
    }
  }
  return res.data!
}

export function logout() {
  return post('/api/v1/auth/logout')
}

// autoLogin 免登录（临时方案，契约 §5.1）：公开端点、不带任何凭据，用哪个账号由服务端配置决定。
// silent：开关没开时后端回的那句"免登录未开启"不是故障 —— 前端的动作是安静落回登录页，不该弹一条红。
export async function autoLogin(): Promise<LoginResult> {
  const res = await post<LoginResult>('/api/v1/auth/auto-login', {}, { silent: true })
  return res.data!
}

export function getMe() {
  return get<UserInfo>('/api/v1/auth/me')
}

export type SmsPurpose = 'login' | 'reset'

export interface SmsSendResult {
  cooldownSeconds: number
  provider: string
  /** 仅 console 通道回填，正式短信通道不会出现 */
  debugCode?: string
}

export async function sendSmsCode(mobile: string, purpose: SmsPurpose): Promise<SmsSendResult> {
  const res = await post<SmsSendResult>('/api/v1/auth/sms/send', { mobile, purpose }, { silent: true })
  return res.data!
}

export async function loginBySms(mobile: string, code: string): Promise<LoginResult> {
  const res = await post<LoginResult>('/api/v1/auth/sms/login', { mobile, code }, { silent: true })
  return res.data!
}

/** 新口令走 SM2 信封（与账号密码登录同形），明文口令不过网。 */
export async function resetPasswordBySms(mobile: string, code: string, newPassword: string): Promise<void> {
  const attempt = async () => {
    const desc = await fetchSm2Descriptor()
    const payload = buildLoginPayload(desc, mobile, newPassword)
    return post('/api/v1/auth/sms/reset-password', { mobile, code, ...payload }, { silent: true })
  }
  try {
    await attempt()
  } catch (err) {
    if (err instanceof ApiError && isRetryableReason(err.reason)) {
      await attempt()
      return
    }
    throw err
  }
}

export type EmailPurpose = 'login' | 'reset'

export interface EmailSendResult {
  cooldownSeconds: number
  provider: string
  debugCode?: string
}

export async function sendEmailCode(email: string, purpose: EmailPurpose): Promise<EmailSendResult> {
  const res = await post<EmailSendResult>('/api/v1/auth/email/send', { email, purpose }, { silent: true })
  return res.data!
}

export async function loginByEmail(
  email: string,
  code: string,
  opts?: { displayName?: string; registerAs?: 'user' | 'temp' },
): Promise<LoginResult> {
  const res = await post<LoginResult>(
    '/api/v1/auth/email/login',
    {
      email,
      code,
      displayName: opts?.displayName || undefined,
      registerAs: opts?.registerAs || undefined,
    },
    { silent: true },
  )
  return res.data!
}
