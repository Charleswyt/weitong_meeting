import { get, put } from '@/utils/request'
import type { components } from '@/types/api.gen'

// UserSettingsVo 与后端 model.PreferenceVo 一一对应，线格式取自契约生成物。
// 契约真源：edge/conference/contracts/api.openapi.yaml（口径见 api-contract.md §6.6）。
// 接线时暴露的分叉：旧手写版把 videoResolution/vbMode/recordingQuality 记成 string、
// faceEnhancement/cloudRecordDefault 记成 number、recordingFps 记成 number ——
// 契约按后端定义收窄为枚举（"480p"|"720p"|"1080p"、0|1、0|10|15|25 等），消费点已按枚举对齐。
export type UserSettingsVo = components['schemas']['PreferenceVo']
export type SettingsCapabilitiesVo = components['schemas']['SettingsCapabilitiesVo']

export function getPreferences() {
  return get<UserSettingsVo>('/api/v1/settings/')
}

// 能力表与偏好分开取：它是只读的部署事实，不是可保存的偏好。
export function getCapabilities() {
  return get<SettingsCapabilitiesVo>('/api/v1/settings/capabilities')
}

export function updatePreferences(data: UserSettingsVo) {
  return put('/api/v1/settings/', data)
}
