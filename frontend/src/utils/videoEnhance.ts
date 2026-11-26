// WebGL 实时视频画质增强与保边降噪：
// 笔记本/普通外接摄像头在室内弱光下会自动拉高 ISO，浏览器拿到的原始帧通常带有明显颗粒噪点与发灰感。
// 本模块在 GPU 上单 Pass 执行：
//   1. 保边双边滤波（Bilateral Filter）：抹平墙面/皮肤/暗部颗粒噪点，同时保留五官、发丝与文字边缘；
//   2. 柔和暗部提亮与对比度微调：去灰蒙感、提升通透度；
//   3. 轻度边缘锐化（Unsharp Mask）：补回降噪后的细节清晰度。
// 处理结果输出为新的 MediaStreamTrack，本地预览与远端推流共用同一条干净画面。

const STORAGE_KEY = 'weitong.videoEnhance'
const INIT_TIMEOUT_MS = 4000

export function readVideoEnhanceEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === '0' || raw === 'false') return false
    return true
  } catch {
    return true
  }
}

export function saveVideoEnhanceEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    /* 忽略无痕模式或存储受限 */
  }
}

export interface VideoEnhanceSession {
  track: MediaStreamTrack
  sourceFrames: () => number | null
  dispose: () => void
}

export interface VideoEnhanceOptions {
  fps?: number
}

const VERT_SRC = `
attribute vec2 a_pos;
attribute vec2 a_uv;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`

// 单 Pass 保边双边滤波 + 弱光提亮 + 轻度锐化
const FRAG_SRC = `
precision mediump float;
uniform sampler2D u_tex;
uniform vec2 u_texel;
varying vec2 v_uv;

float luma(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}

void main() {
  vec3 center = texture2D(u_tex, v_uv).rgb;

  // 1. 9 点 + 外圈 4 点保边双边滤波（对色差敏感：平坦噪点区强平滑，边缘强保留）
  // sigma_range 设在 0.085 左右，刚好抹掉室内高 ISO 颗粒且不糊五官。
  const float invRange = 1.0 / (2.0 * 0.085 * 0.085);

  vec3 sum = center * 1.4;
  float wSum = 1.4;

  // 近邻 8 点（距离 1.2 texel）
  vec2 d1 = u_texel * 1.25;
  vec2 offsets1[8];
  offsets1[0] = vec2(-d1.x, 0.0);
  offsets1[1] = vec2( d1.x, 0.0);
  offsets1[2] = vec2(0.0, -d1.y);
  offsets1[3] = vec2(0.0,  d1.y);
  offsets1[4] = vec2(-d1.x, -d1.y);
  offsets1[5] = vec2( d1.x, -d1.y);
  offsets1[6] = vec2(-d1.x,  d1.y);
  offsets1[7] = vec2( d1.x,  d1.y);

  for (int i = 0; i < 8; i++) {
    vec3 s = texture2D(u_tex, v_uv + offsets1[i]).rgb;
    vec3 diff = s - center;
    float rangeW = exp(-dot(diff, diff) * invRange);
    float spatialW = (i < 4) ? 0.95 : 0.72;
    float w = spatialW * rangeW;
    sum += s * w;
    wSum += w;
  }

  // 外圈 4 点（距离 2.4 texel，进一步抑制中频色度噪点斑块）
  vec2 d2 = u_texel * 2.4;
  vec2 offsets2[4];
  offsets2[0] = vec2(-d2.x, 0.0);
  offsets2[1] = vec2( d2.x, 0.0);
  offsets2[2] = vec2(0.0, -d2.y);
  offsets2[3] = vec2(0.0,  d2.y);

  for (int i = 0; i < 4; i++) {
    vec3 s = texture2D(u_tex, v_uv + offsets2[i]).rgb;
    vec3 diff = s - center;
    float rangeW = exp(-dot(diff, diff) * invRange);
    float w = 0.52 * rangeW;
    sum += s * w;
    wSum += w;
  }

  vec3 denoised = sum / wSum;

  // 2. 轻度边缘锐化（仅对大梯度边缘做轻微增强，避免把刚抹掉的噪点再拉回来）
  vec3 detail = center - denoised;
  float edgeEnergy = smoothstep(0.035, 0.14, length(detail));
  vec3 color = clamp(denoised + detail * (0.28 * edgeEnergy), 0.0, 1.0);

  // 3. 柔和弱光提亮（提亮暗部、保护高光不过曝）
  float y = luma(color);
  float shadowLift = (1.0 - y) * (1.0 - y) * 0.065;
  color = clamp(color + shadowLift, 0.0, 1.0);

  // 4. 极克制的通透对比度与自然饱和度微调
  color = clamp((color - 0.5) * 1.04 + 0.5, 0.0, 1.0);
  float y2 = luma(color);
  color = clamp(mix(vec3(y2), color, 1.05), 0.0, 1.0);

  gl_FragColor = vec4(color, 1.0);
}
`

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function waitForFirstFrame(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('video frame timeout'))
    }, INIT_TIMEOUT_MS)
    const onReady = () => {
      if (video.videoWidth > 0) {
        cleanup()
        resolve()
      }
    }
    const cleanup = () => {
      window.clearTimeout(timer)
      video.removeEventListener('loadeddata', onReady)
      video.removeEventListener('canplay', onReady)
    }
    video.addEventListener('loadeddata', onReady)
    video.addEventListener('canplay', onReady)
  })
}

export async function createVideoEnhanceTrack(
  sourceTrack: MediaStreamTrack,
  options: VideoEnhanceOptions = {},
): Promise<VideoEnhanceSession | null> {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  if (typeof canvas.captureStream !== 'function') return null

  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  })
  if (!gl) return null

  const vert = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC)
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC)
  if (!vert || !frag) {
    if (vert) gl.deleteShader(vert)
    if (frag) gl.deleteShader(frag)
    return null
  }

  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vert)
    gl.deleteShader(frag)
    return null
  }
  gl.attachShader(program, vert)
  gl.attachShader(program, frag)
  gl.linkProgram(program)
  gl.deleteShader(vert)
  gl.deleteShader(frag)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }

  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = new MediaStream([sourceTrack])
  try {
    await video.play()
    await waitForFirstFrame(video)
  } catch {
    video.srcObject = null
    gl.deleteProgram(program)
    return null
  }

  let width = video.videoWidth || 1280
  let height = video.videoHeight || 720
  canvas.width = width
  canvas.height = height
  gl.viewport(0, 0, width, height)

  // 全屏四边形顶点（含翻转后的 UV，直接对齐 video 坐标系）
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      -1, -1, 0, 1,
       1, -1, 1, 1,
      -1,  1, 0, 0,
       1,  1, 1, 0,
    ]),
    gl.STATIC_DRAW,
  )

  gl.useProgram(program)
  const aPos = gl.getAttribLocation(program, 'a_pos')
  const aUv = gl.getAttribLocation(program, 'a_uv')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0)
  gl.enableVertexAttribArray(aUv)
  gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8)

  const uTex = gl.getUniformLocation(program, 'u_tex')
  const uTexel = gl.getUniformLocation(program, 'u_texel')
  gl.uniform1i(uTex, 0)
  gl.uniform2f(uTexel, 1 / width, 1 / height)

  const texture = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  const outTrack = canvas.captureStream(0).getVideoTracks()[0]
  if (!outTrack) {
    video.srcObject = null
    gl.deleteTexture(texture)
    gl.deleteBuffer(buffer)
    gl.deleteProgram(program)
    return null
  }
  const manualTrack = outTrack as MediaStreamTrack & { requestFrame?: () => void }

  const fps = Math.min(30, Math.max(10, options.fps ?? 30))
  const minInterval = 1000 / fps
  let running = true
  let lastDraw = 0
  let rafId = 0
  let rvfcId = 0
  let renderedFrames = 0

  type VideoWithRvfc = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number
    cancelVideoFrameCallback?: (id: number) => void
  }
  const rvfcVideo = video as VideoWithRvfc

  function renderFrame() {
    if (!running || video.readyState < 2) return
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh) return
    if (vw !== width || vh !== height) {
      width = vw
      height = vh
      canvas.width = width
      canvas.height = height
      gl!.viewport(0, 0, width, height)
      gl!.uniform2f(uTexel, 1 / width, 1 / height)
    }
    gl!.bindTexture(gl!.TEXTURE_2D, texture)
    gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, video)
    gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4)
    manualTrack.requestFrame?.()
    renderedFrames++
  }

  // 先渲染首帧，避免编码器读到空黑帧
  renderFrame()

  if (typeof rvfcVideo.requestVideoFrameCallback === 'function') {
    const onVideoFrame = () => {
      if (!running) return
      const now = performance.now()
      if (now - lastDraw >= minInterval * 0.85) {
        lastDraw = now
        renderFrame()
      }
      rvfcId = rvfcVideo.requestVideoFrameCallback!(onVideoFrame)
    }
    rvfcId = rvfcVideo.requestVideoFrameCallback(onVideoFrame)
  } else {
    const onRaf = (now: number) => {
      if (!running) return
      if (now - lastDraw >= minInterval) {
        lastDraw = now
        renderFrame()
      }
      rafId = requestAnimationFrame(onRaf)
    }
    rafId = requestAnimationFrame(onRaf)
  }

  function dispose() {
    if (!running) return
    running = false
    if (rafId) cancelAnimationFrame(rafId)
    if (rvfcId && typeof rvfcVideo.cancelVideoFrameCallback === 'function') {
      try { rvfcVideo.cancelVideoFrameCallback(rvfcId) } catch { /* ignore */ }
    }
    try { outTrack.stop() } catch { /* ignore */ }
    try { sourceTrack.stop() } catch { /* ignore */ }
    video.srcObject = null
    try {
      gl!.deleteTexture(texture)
      gl!.deleteBuffer(buffer)
      gl!.deleteProgram(program)
      gl!.getExtension('WEBGL_lose_context')?.loseContext()
    } catch { /* ignore */ }
  }

  return {
    track: outTrack,
    sourceFrames: () => renderedFrames,
    dispose,
  }
}
