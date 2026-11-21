// 让 Node 直接 import 仓内 .ts 真源：补 @/ 别名、补无扩展名的 .ts，
// 并把与被测形状无关的重依赖换成同名桩（IndexedDB 层、Pinia、只吃浏览器的 WebAudio/EBML 补丁）。
// 桩的纪律见 scratch/AGENTS 口径：**每个导出都如实反映"这条路真被走过了"**，
// 给不出真语义的一律抛，绝不静默返回一个看着像通过的值。
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const srcRoot = resolvePath(here, '../src')
const STUBS = new Map([
  ['@/utils/request', resolvePath(here, 'stub-request.ts')],
  ['@/store/user', resolvePath(here, 'stub-user-store.ts')],
  ['@/utils/webmDuration', resolvePath(here, 'stub-webm-duration.ts')],
  ['@/utils/audioBus', resolvePath(here, 'stub-audio-bus.ts')],
])

// `@/utils/localRecorder` 的桩必须由用例显式申请（STUB_LOCAL_RECORDER=1），不许全局默认开：
// Node 里没有 indexedDB，verify-lane-doublewrite 要靠桩顶掉持久层；而 verify-recording-judgments
// 要测的正是真实现里的 containerOf —— 全局打桩会让它拿桩的返回值测出假绿
// （2026-10-10 合一两个检出时炸出来的就是这条）。
if (process.env.STUB_LOCAL_RECORDER === '1') {
  STUBS.set('@/utils/localRecorder', resolvePath(here, 'stub-local-recorder.ts'))
}

export async function resolve(specifier, context, next) {
  if (STUBS.has(specifier)) return { url: pathToFileURL(STUBS.get(specifier)).href, shortCircuit: true }
  if (specifier.startsWith('@/')) {
    const rel = specifier.slice(2)
    for (const cand of [rel + '.ts', rel + '.js', rel + '/index.ts']) {
      const p = resolvePath(srcRoot, cand)
      if (existsSync(p)) return { url: pathToFileURL(p).href, shortCircuit: true }
    }
    throw new Error('alias 未命中: ' + specifier)
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/i.test(specifier)) {
    const base = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : srcRoot
    for (const cand of ['.ts', '.js', '/index.ts']) {
      const p = resolvePath(base, specifier + cand)
      if (existsSync(p)) return { url: pathToFileURL(p).href, shortCircuit: true }
    }
  }
  return next(specifier, context)
}
