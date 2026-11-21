// 桩：Pinia store 会连带 import router（顶层 createWebHistory），Node 里没有 window。
// `trackRecorder.loginAccountForDir()` 外面套着 try/catch，抛这里就是"没拿到账号"→
// 落盘层级回退到调用方传进来的显示名，被测形状不受影响。
//
// `setStubAccount()` 是给"归属判据"这类**必须知道我是谁**的用例用的显式开关：
// 没主动设过就照旧抛 —— 否则任何一条忘了处理登录态的用例都会拿到一个凭空出现的账号，
// 把"没走到这条路"伪装成"走到了且是对的"。传 '' 表示显式模拟"没登录/身份没水合"。
let account: string | null = null

export function setStubAccount(username: string | null): void {
  account = username
}

export function useUserStore(): { userInfo: { username: string } | null } {
  if (account === null) {
    throw new Error('桩被调用（useUserStore）：说明这条用例走到了登录态，别把它当成通过')
  }
  return { userInfo: account === '' ? null : { username: account } }
}
