/**
 * 磁盘真源那条路径的用例：目录层级错一层，「本地录制」整栏就空，而且**一条日志都不打**
 * （`localRecorder.ts` 旧实现在 `if (!blob) continue` 上静默跳完所有场次）。
 * 之所以必须用桩目录树跑真函数：这条分支在浏览器里只在"授权目录 + 已落盘"时才进得去，
 * 以前没有任何用例覆盖它，于是少一层 `hxt` 这个缺陷在四门禁全绿下活了一整轮。
 *
 * 层级口径来自真机（已 ls 核实）：`C:/Users/zhengqi/Videos/hxt/{账号}/{时刻}/{会议号}/`，
 * manifest.json 用盘上那份真文件，不自己编。
 *
 * 跑法：node scratch/verify-disk-path.ts
 */
import { register } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'

register('./ts-alias-hooks.mjs', import.meta.url)

const { setStubAccount } = await import('./stub-user-store.ts')
setStubAccount('chenfang')

const lr = await import('../src/utils/localRecorder.ts')

let failures = 0
let checks = 0
function eq(got: unknown, want: unknown, label: string) {
  checks++
  if (got !== want) {
    failures++
    console.error(`  ✗ ${label}\n      期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`)
  }
}

// ── 盘上真物：缺了就报错，不许静默跳过（跳过=这轮根本没验任何东西）
const REAL_DIR = 'C:/Users/zhengqi/Videos/hxt/chenfang/20260930203404/21501555'
if (!existsSync(`${REAL_DIR}/manifest.json`)) {
  console.error(`✗ 用例依赖盘上真 manifest（${REAL_DIR}），当前读不到 —— 先确认那份录制还在，别改断言`)
  process.exit(1)
}
const manifestBytes = readFileSync(`${REAL_DIR}/manifest.json`)
const manifest = JSON.parse(manifestBytes.toString('utf8'))
const USER = 'chenfang'
const STAMP = '20260930203404'
const MEET = '21501555'
const START_MS = manifest.timeline.startAtMs

// ── 桩目录树：照真机层级搭，hxt 与账号目录都在
type Stub = Record<string, unknown>
function fileHandle(name: string, data: Uint8Array, type: string) {
  return { kind: 'file', name, getFile: async () => new Blob([data.slice()], { type }) }
}
function dirHandle(name: string, kids: Array<Record<string, unknown>>) {
  const map = new Map<string, Record<string, unknown>>(kids.map((k) => [(k as { name: string }).name, k]))
  return {
    kind: 'directory',
    name,
    getDirectoryHandle: async (n: string) => {
      const h = map.get(n)
      if (!h) throw new Error(`NotFoundError: ${n}`)
      return h
    },
    getFileHandle: async (n: string) => {
      const h = map.get(n)
      if (!h) throw new Error(`NotFoundError: ${n}`)
      return h
    },
    [Symbol.asyncIterator]: () => [...map.entries()][Symbol.iterator](),
  }
}
const meetingDir = dirHandle(MEET, [
  fileHandle('manifest.json', manifestBytes, 'application/json'),
  ...manifest.streams.map((s: { fileName: string }) =>
    fileHandle(s.fileName, new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 'video/webm'),
  ),
])
// 多放一个"别人"的账号目录：扫描只许进当前账号那一层
const authRoot = dirHandle('Videos', [
  dirHandle('hxt', [
    dirHandle(USER, [dirHandle(STAMP, [meetingDir])]),
    dirHandle('wangqiang', [dirHandle('20261009191729', [dirHandle('49659119', [
      fileHandle('manifest.json', manifestBytes, 'application/json'),
    ])])]),
  ]),
])

// —— 1. 层级单一真源：读的那一层与写的那一层必须是同一个算式
eq(lr.RECORDING_ROOT_DIR, 'hxt', '目录根段常量就是 hxt')
eq(lr.recordingRelParts(USER, STAMP, MEET).join('/'), `hxt/${USER}/${STAMP}/${MEET}`, '扫描用的层级含 hxt')

// —— 2. 真函数扫真层级：这条就是那个缺陷的命中点（修复前实得 0 条）
const scan = await lr.scanRecordingsInDir(authRoot, USER)
const rows = scan.rows as Array<Record<string, unknown>>
eq(scan.reason, 'ok', '当前账号那一层在 → 成因报 ok')
eq(rows.length, 1, `扫到当前账号那一场（盘上就一份 manifest，实得 ${rows.length}）`)
const row = rows[0] as Record<string, unknown> | undefined
eq(row?.dirPath, `hxt/${USER}/${STAMP}/${MEET}`, 'dirPath 存的是相对授权目录的完整层级（含 hxt）')
eq(row?.recorderAccount, USER, '扫描当场把账号写下：目录结构就是归属证据')
eq(row?.id, `disk-${START_MS}`, '磁盘派生行的 id 由清单起始时刻给出')
eq(((row?.tracks as unknown[]) || []).length, manifest.streams.length, '每一路都进了清单')

// —— 3. 账号隔离：树里明明有两个账号的场次，扫当前账号只许出一条；换个没录过的账号就是空
const none = await lr.scanRecordingsInDir(authRoot, 'zhaoling')
eq(none.rows.length, 0, '这个账号没录过 → 空数组，不是报错')
eq(none.reason, 'no_user_dir', '成因如实报"当前账号那一层不存在"，不跟"没授权"混成一回事')
const bare = await lr.scanRecordingsInDir(dirHandle('Videos', []), USER)
eq(bare.reason, 'no_hxt', '授权目录里没有 hxt 那一层 → 成因与"账号没录过"分得开')

// —— 4. dirPath 两种历史形状都要能读回真层级（旧行存的是不含 hxt 的那一种）
const WANT = `hxt/${USER}/${STAMP}/${MEET}`
eq(lr.dirPathRelParts(WANT).join('/'), WANT, '新形状（含 hxt）原样解析')
eq(lr.dirPathRelParts(`${USER}/${STAMP}/${MEET}`).join('/'), WANT, '旧形状（缺 hxt）补回该层，历史行还能读')
eq(lr.accountFromDirPath(WANT), USER, '从 dirPath 取出账号段（新形状）')
eq(lr.accountFromDirPath(`${USER}/${STAMP}/${MEET}`), USER, '从 dirPath 取出账号段（旧形状）')
eq(lr.accountFromDirPath(null), '', '没有 dirPath 就是没有证据，不许猜')

// —— 5. 变异自证：若扫描被改成"读到就算我的"（不看目录那一层），本文件必须红
checks++
if ((row?.recorderAccount as string) !== USER) {
  failures++
  console.error('  ✗ 扫描没写账号 → 这条会落进"判不出归属"，用户看不见自己录的东西')
}
checks++
if (checks < 10) {
  failures++
  console.error(`  ✗ 断言数少得可疑（${checks}），判据大概根本没跑到`)
}

console.log(failures ? `✗ 磁盘真源路径 ${failures}/${checks} 条不符` : `✓ 磁盘真源路径全绿：${checks} 条断言`)
process.exit(failures ? 1 : 0)
