import { sitePath } from '@/utils/sitePath'
import { FilesetResolver } from '@mediapipe/tasks-vision'

// MediaPipe 运行时的共用部分：wasm fileset、初始化超时与遥测屏蔽。
// 分割（bgBlur）与人脸检测（faceRoi）共用一个 wasm 实例，不各拉一份 5MB+ 的包。

type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>

// 模型与 wasm 全部本地化（public/mediapipe/）—— 边端环境可能没有外网，运行期不许回源 CDN。
const WASM_BASE_PATH = sitePath('/mediapipe/wasm')

// 初始化必须**有界**。GPU delegate 在拿不到可用 GPU 的浏览器里会直接挂住 ——
// 实测本端 100 秒既不 resolve 也不 reject、也不发一条降级原因，
// 而 startPreview() 是 await 它的：用户点「背景虚化」看到的就是预览永久不动了。
// 每一步各自限时，超时当作"这一种 delegate 不可用"，退到下一种；全部失败才由调用方降级。
export const INIT_STEP_TIMEOUT_MS = 5000

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${what}超过 ${ms / 1000} 秒未就绪`)), ms)
    p.then(
      (v) => { window.clearTimeout(timer); resolve(v) },
      (e) => { window.clearTimeout(timer); reject(e) },
    )
  })
}

let wasmFileset: Promise<WasmFileset> | null = null

export function getWasmFileset(): Promise<WasmFileset> {
  if (!wasmFileset) {
    wasmFileset = FilesetResolver.forVisionTasks(WASM_BASE_PATH).catch((e) => {
      // 失败不缓存，允许用户重试时重新拉取
      wasmFileset = null
      throw e
    })
  }
  return wasmFileset
}

// tasks-vision 1.0.1 内建用量日志：GraphRunner 每次创建都会起一个 60s 定时器向
// Google 的日志端点发 fetch。边端/船载环境要么发不出去、要么根本不该发 —— 按 URL
// 精准拦截这一条请求，其余 fetch 原样放行（模型与 wasm 的本地加载不受影响）。
export function blockUsageTelemetry() {
  if (typeof window === 'undefined' || (window.fetch as { __mpTelemetryBlocked?: boolean }).__mpTelemetryBlocked) return
  const original = window.fetch.bind(window)
  const patched = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url && url.includes('odml.pa.googleapis.com')) {
      // 报非 200 让库内部置错并停掉后续 flush，而不是伪装成功后它继续重试发送。
      return Promise.resolve(new Response('', { status: 204 }))
    }
    return original(input as RequestInfo, init)
  }
  ;(patched as { __mpTelemetryBlocked?: boolean }).__mpTelemetryBlocked = true
  window.fetch = patched
}
