import { sitePath } from '@/utils/sitePath'
import type { paths } from '@/types/api.gen'
export type AssistantState =
  paths['/assist/v1/meetings/{assistantMeetingId}/state']['get']['responses'][200]['content']['application/json']

export async function assistantRequest(path: string, options: RequestInit = {}, number?: string) {
  const url = new URL(sitePath('/assist/v1/' + path), location.origin)
  if (number) url.searchParams.set('number', number)
  const headers = new Headers(options.headers)
  headers.set('Authorization', 'Bearer ' + (localStorage.getItem('weitong.token') || ''))
  const response = await fetch(url, { ...options, headers, cache: 'no-store' })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    console.warn('[assistant] 请求失败', response.status, error)
    throw new Error(error.message || '会议助手请求失败，请稍后重试')
  }
  const ct = response.headers.get('content-type') || ''
  if (ct.includes('text/html')) {
    throw new Error('会议助手服务未就绪或代理未配置')
  }
  return response
}
export function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}
