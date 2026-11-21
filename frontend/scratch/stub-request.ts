// 桩：`@/utils/request` 会拖进 axios + element-plus + router（router 顶层就 createWebHistory），
// Node 里都没有。被测的开录/清单形状根本不碰网络层，所以每个导出都抛 ——
// 真走到了就炸成显式错误，不许静默当成通过（scratch 的桩纪律）。
function touched(name: string) {
  return () => {
    throw new Error(`桩被调用（${name}）：说明这条用例并不纯，别把它当成通过`)
  }
}

export class ApiError extends Error {
  reason = 'stub'
}

export const get = touched('get')
export const post = touched('post')
export const put = touched('put')
export const del = touched('del')
export const getPage = touched('getPage')
export const assetUrl = touched('assetUrl')
