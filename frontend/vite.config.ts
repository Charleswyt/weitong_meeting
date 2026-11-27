import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { resolve } from 'path'

// 云端对拍默认打到 18082（DEPLOYMENT_SIDE=cloud 的边端后端副本）。
// 只影响 dev server，现场镜像里 nginx 反代与此无关。
const BACKEND = process.env.VITE_BACKEND ?? 'http://localhost:8082'
// 连云端公网入口（如 https://47.114.83.151/zwt-meeting）时证书不受信任，设 VITE_BACKEND_INSECURE=1 跳过校验。
// 默认关闭：只在明确连云端调试时打开，本机后端不需要。
const INSECURE = process.env.VITE_BACKEND_INSECURE === '1'

export default defineConfig({
  // basicSsl：手机 getUserMedia / 剪贴板需要安全上下文；HTTP 局域网会被浏览器直接拒麦克风。
  plugins: [vue(), basicSsl()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    // 端口不许走 env：`platform/facts.yaml` 的生成器按 `port:` 后的数字字面量抓它，
    // 包进表达式就等于把这份真源从检查里藏起来。多实例要换端口用 `vite --port`。
    port: 5176,
    // 默认只绑 localhost：手机扫码/微信点局域网链接会「无法打开页面」。
    // true = 0.0.0.0，同网段设备才能打到本机开发服。
    host: true,
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: true,
        secure: !INSECURE,
      },
      // 会议助手接口（转录、术语库、材料包、加密云录、纪要），生产由 nginx 反代到 assist 服务。
      '/assist': {
        target: BACKEND,
        changeOrigin: true,
        secure: !INSECURE,
      },
      // 媒体播放器资产由后端同源代理（生产同源），dev 下不代理就加载不到播放器。
      '/assets': {
        target: BACKEND,
        changeOrigin: true,
        secure: !INSECURE,
      },
      '/ws': {
        target: BACKEND.replace(/^http/, 'ws'),
        ws: true,
        secure: !INSECURE,
      },
    },
  },
  build: {
    outDir: 'dist',
    // 生产包默认关闭 sourcemap，避免安全检测报告前端源码泄露
    sourcemap: false,
  },
})
