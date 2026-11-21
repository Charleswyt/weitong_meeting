// 媒体播放器的加载与类型声明 —— 前端只认这一层，不关心它由谁实现。
//
// 资产经我方后端同源代理加载：浏览器 <script> 带不了鉴权头，且平台证书自签，
// 直连会被拦。不自己解析容器格式是刻意的（见 shared/contracts/edge-to-edge/
// vendor-assets.md 第 4 条：该资产由平台托管、仓内不留副本）。

export interface MediaPlayOptions {
  canvas: HTMLCanvasElement
  codec?: string
  headers?: Record<string, string>
  satelliteOptimization?: boolean
  onRate?: (kbps: number) => void
  onTraffic?: (bytes: number) => void
  onState?: (state: string) => void
  onFirstFrame?: () => void
  onFrame?: (f: MediaFrame) => void
  onError?: (e: unknown) => void
}

export interface AudioPlayOptions {
  headers?: Record<string, string>
  outputToSpeakers?: boolean
  muted?: boolean
  onRate?: (kbps: number) => void
  onTraffic?: (bytes: number) => void
  onState?: (state: string) => void
  onStream?: (stream: MediaStream) => void
}

// 播放器每渲染一帧回吐：timestamp=帧 PTS（timebase 单位），session=容器会话头。
export interface MediaFrame {
  timestamp: number
  session: {
    flags: number
    epoch: bigint
    baseUnixNs: bigint
    width: number
    height: number
    fpsMilli: number
    timebase: number
  }
}

export interface MediaStreamPlayer {
  start: (url: string) => Promise<void>
  stop: (resetRate?: boolean) => void
}

export interface MediaPlayer {
  /** 浏览器直发那一路（videoCodec='h264'）用这个探。 */
  detectH264Codec: (width?: number, height?: number) => Promise<string>
  /**
   * 经边端 RKMPP 处理的那一路（videoCodec='hevc'）用这个探。
   * 用哪一个是后端按三方 sourceType 判好下发的，前端不许自己猜 —— 猜错这条腿时
   * 上游不回"编码不对"而回 425，页面表现就是那一格永远"还在准备中"。
   */
  detectHevcCodec: (width?: number, height?: number) => Promise<string>
  detectAacSupport: () => Promise<unknown>
  DirectVideoPlayer: new (options: MediaPlayOptions) => MediaStreamPlayer
  DirectAudioPlayer: new (options: AudioPlayOptions) => MediaStreamPlayer
}

const PLAYER_ASSET_PATH = '/assets/media-player.js'

// 资产注册的全局符号由平台命名，前端无法改；除此之外不在页面代码里出现厂商词。
declare const window: Window & { ZwtDirectMedia?: MediaPlayer }

let loading: Promise<MediaPlayer> | null = null

export function loadMediaPlayer(): Promise<MediaPlayer> {
  if (window.ZwtDirectMedia) return Promise.resolve(window.ZwtDirectMedia)
  if (loading) return loading
  loading = new Promise<MediaPlayer>((resolve, reject) => {
    const el = document.createElement('script')
    el.src = PLAYER_ASSET_PATH
    el.async = true
    el.onload = () => {
      if (window.ZwtDirectMedia) resolve(window.ZwtDirectMedia)
      else reject(new Error('媒体播放器未就绪'))
    }
    el.onerror = () => reject(new Error('媒体播放器加载失败（服务不可达或证书不受信）'))
    document.head.appendChild(el)
  }).catch((e) => {
    // 失败要能重试：缓存一个已失败的 Promise 会让整个会议再也起不了媒体。
    loading = null
    throw e
  })
  return loading
}

export function authHeaders(): Record<string, string> {
  return { Authorization: 'Bearer ' + (localStorage.getItem('token') || '') }
}
