import { post, put, del } from '@/utils/request'
import type { ApiResponse } from '@/utils/request'
import type { components } from '@/types/api.gen'

// 线格式类型取自契约生成物（../contracts/api.openapi.yaml → src/types/api.gen.ts），不手写第二份。
export type AvatarRes = components['schemas']['AvatarData']

// PUT display-name 的 data（旧手写版是内联 { displayName: string }，与契约同形）。
export type DisplayNameRes = components['schemas']['DisplayNameData']

// 头像上传：字段名必须是 file，与后端 /api/v1/users/me/avatar 约定一致。
export function uploadAvatar(file: Blob, filename = 'avatar.png'): Promise<ApiResponse<AvatarRes>> {
  const fd = new FormData()
  fd.append('file', file, filename)
  return post<AvatarRes>('/api/v1/users/me/avatar', fd)
}

export function clearAvatar(): Promise<ApiResponse<AvatarRes>> {
  return del<AvatarRes>('/api/v1/users/me/avatar')
}

export function updateDisplayName(displayName: string): Promise<ApiResponse<DisplayNameRes>> {
  return put<DisplayNameRes>('/api/v1/users/me/display-name', { displayName })
}
