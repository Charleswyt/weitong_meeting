// 本地录制的客户端保存目录：File System Access API 选目录，句柄存 IndexedDB，
// 之后每次录制直写该目录；浏览器不支持时回退普通下载并如实标注。
//
// 另外记一份**本机清单**（recordings + blobs）：原型把"本地录制"定义为"仅录制者本人可查看与下载"，
// 而这些文件后端从头到尾不知道它们存在（写盘/下载都发生在浏览器里）。没有这份清单，
// 「本地录制」这一栏就永远是真的空 —— 第 33 项的"一条记录都没有"就是这么来的。
//
// schema 2（第 15 项）把"一条混合流"改成"每路原始轨道 + 按时片落的分片"：分片**每 2 秒一片立即入库**。
// 〔2026-09-30 更正〕原先这里写"所以崩溃/关页只丢最后一片，不丢整场"——**那句是错的**：
// 清单（`recordings`）过去只在 `finish()` 里写一次，中途崩溃/关页会让整场从列表消失，
// 盘上只剩永远读不到的孤儿分片。schema 3 起改成"开录写 session 头 + 每片写一条 segment 记录"，
// 清单因此可从落库的记录重建（`sessions` / `segments` 两个 store 是本层的出口，
// 重建那条路在 `recordingRecovery.ts`）。
// 清单里的 tracks/segments 仍是这份事实的真源，回放与合成下载都只读它，不再回推。
import { ApiError } from '@/utils/request'
import { useUserStore } from '@/store/user'
import { finalizeWebmDuration } from '@/utils/webmDuration'
import { laneIsDamaged } from '@/utils/offlineCompose/segmentSource'
import { loginAccount, ownerStateOf, type OwnerState } from '@/utils/recordingAccount'

const DB_NAME = 'conference-local'
/** schema 3 的版本号。旧三表与 blobs 的键格式一概不动，只新增两个 store。 */
const DB_VERSION = 3
const STORE = 'handles'
const META_STORE = 'recordings'
const BLOB_STORE = 'blobs'
/** 会话头：开录即写，收尾置 open=false。崩溃自愈只认这里的 trackIds 白名单。 */
const SESSION_STORE = 'sessions'
/** 每片一条 O(1) 记录（键与 blobs 同），取代"整份清单只在 finish 写一次"。 */
const SEGMENT_STORE = 'segments'
const KEY = 'recordingDir'

/**
 * 开录时落的会话头，收尾置 `open=false`。崩溃自愈只认这里的 `tracks` ——
 * 不许靠字符串猜 blobs 的键前缀（`recordingId` 是时间基 base36，会撞别的录制）。
 * `tracks` 带每路的元数据，这样重建清单时不必再去猜 ownerName/kind/起点；开一路就更新一次（次数极少）。
 */
export interface RecordingSession {
  id: string
  t0: number
  meetingNo: string
  title: string
  open: boolean
  /** 每次落片都刷新；启动时只处理"open 且 heartbeat 过期"的 */
  heartbeatAt: number
  tracks: Record<string, Omit<RecordedTrack, 'segments'>>
  /** 发起这场录制的登录账号。自愈只重建本人的会话，所以必须在建会话头时就写，事后补不回来 */
  recorderAccount?: string
}

/** 心跳最小间隔：每片都重写会话头会和分片事务抢同一条序列，实测会拖出片间空洞。 */
export const SESSION_HEARTBEAT_MIN_MS = 5000

/**
 * 心跳超过这个值就判"那场已经不在录了"（3 个心跳周期）。
 * 边界要认下来：崩溃后 15 秒内就重开页面，这一场还不会被重建，等下一次进列表才恢复。
 * 把这个值压到心跳间隔以下就会顶掉**另一个标签页正在录的那场**。
 */
export const SESSION_STALE_MS = SESSION_HEARTBEAT_MIN_MS * 3

/** 一片的独立记录 —— 与 blobs 的键一一对应，因此重建清单时可以逐片验"库里真取到字节"。 */
export interface SegmentRecord {
  blobKey: string
  trackId: string
  seq: number
  offsetSec: number
  durationSec: number
  sizeBytes: number
  mime: string
}

/** 一路录制里的一片：offset/duration 都相对整场的 t0（=会话开始的 epoch 毫秒）。 */
export interface TrackSegment {
  seq: number
  offsetSec: number
  durationSec: number
  sizeBytes: number
  /** blobs 表的外置键：`${recordingId}#${seq}` */
  blobKey: string
  mime: string
}

export type RecordedTrackKind = 'camera' | 'screen' | 'microphone'

/**
 * 关闭原因只有这几种真源，缺省态必须能对上其中一种，不许留空当"正常"。
 * （原先还挂着 `no_media`「这一路没被渲染出来」：全仓从未赋值，回放页却在渲染它 ——
 * 而"开不起来的那一路"根本不会成为清单里的一条（`finish()` 只收有分片的路），
 * 所以那个状态没有真源，D6 已删。别在没有生产方之前把它加回来。）
 */
export type TrackCloseReason =
  | 'session_end'        // 用户点了停止录制
  | 'publisher_left'     // 该参会者离会 / 该路发布消失
  | 'track_disabled'     // 关了摄像头、共享结束
  | 'recorder_error'     // 编码器自己报错
  | 'leave_page'         // 这一路没被干净收尾：崩溃/关页时自愈重建出来就是这么标

export interface RecordedTrack {
  /** 一路 = 一个 recordingId；同一个人再入会是**新的一条路**，但 offset 仍排同一条 t0 */
  recordingId: string
  ownerId: string
  ownerName: string
  kind: RecordedTrackKind
  /** 该路的通路说明（摄像头/共享/麦克风），界面用它 */
  mediaLabel: string
  hasVideo: boolean
  hasAudio: boolean
  /** 该路第一片的起始时刻（相对 t0） */
  startOffsetSec: number
  /** null = 会话结束时仍在录（没有实测到的关闭时刻就不写终值） */
  endOffsetSec: number | null
  closedAtMs: number | null
  closeReason: TrackCloseReason | ''
  mime: string
  fileName: string
  segments: TrackSegment[]
  /**
   * 解码参数（D9）：离线合成侧按 `VideoDecoder.configure` 要的字段直接读，不必先解容器头。
   * 四个值都来自**采集侧实测**（`track.getSettings()` 或画布真实尺寸），取不到就不写 ——
   * 不许拿设置页那个"清晰度档位"充数，档位承诺的是采集约束、不是这条轨实际拿到的像素。
   */
  width?: number
  height?: number
  /** 帧率：本端取 `getSettings().frameRate`，远端那一路取我方给这一路的推帧速率 */
  frameRate?: number
  sampleRate?: number
  channelCount?: number
}

/**
 * 容器由各路**实际协商出来的 mime** 判，不写死:
 * 本机 `MediaRecorder` 目前只会走到 WebM（`pickVideoMime`/`pickAudioMime` 只试 webm 系），
 * 但 `mimeType` 传空时浏览器可能改主意，所以判读据留在数据上而不是代码里。
 */
export function containerOf(tracks: Array<Pick<RecordedTrack, 'mime'>>): 'webm' | 'mp4' {
  return tracks.length > 0 && tracks.every((t) => (t.mime || '').includes('mp4')) ? 'mp4' : 'webm'
}

export interface LocalRecording {
  id: string
  title: string
  meetingNo: string
  fileName: string
  /** 录制开始的毫秒时间戳（本机时钟，展示时按业务时区格式化） */
  startedAt: number
  durationSec: number
  sizeBytes: number
  // 这里原本有个顶层 `mime: 'application/x-multi-track'`（D9 已删，全仓零读取点）：
  // 它不代表任何真容器 —— 分片本身是 WebM，整场又不是"一个文件"，交给桌面端只会误导。
  // 要判容器就从各路自己的 `tracks[].mime` 判（见 `containerOf`），
  // 存一份顶层容器等于造第二个事实源，会与真源打架。
  /** 1 = 旧的单条混合流产物；2 = 分轨道分片 */
  schema?: 1 | 2
  tracks?: RecordedTrack[]
  /** 授权目录内的相对层级（`hxt/{登录账号}/{时刻}/{会议号}`，真源 `trackRecorder.recordingDirParts`）；没真的写出来就是 null */
  dirPath?: string | null
  /** 是否真的写进了用户授权的目录；false 时产物只在浏览器里，界面必须这么说 */
  dirHandle?: boolean
  /** 有轨道提前中断/存在缺口 */
  partial?: boolean
  /**
   * 录制者**登录账号**（不是显示名 —— `tracks[].ownerName` 记的是"这一路是谁"，只有姓名，不能当归属键）。
   *
   * 只在写的时候记，**历史条目一律不回填**：本轮字段之前落库的条目没有这份证据，
   * 按现有值"看着像我的"就补一行，违反工作区"不许造行"的硬规则，代价是把不一致变成看不见的债。
   * 没有这个字段的条目归 `unknown`：不进列表，但在底部如实计数（见 `recordingAccount.ownerStateOf`）。
   *
   * 存的是**未清洗的登录名**；目录段那份是 `sanitizePathPart` 之后的值，两者不要互相比对。
   */
  recorderAccount?: string
  /**
   * 产物到底在哪：省略=本机（IndexedDB + 可选的授权目录）。
   * 云端回看用同一套引擎，但那份条目是**从回放清单合成的**，本机没有对应文件 ——
   * 界面据此说"云端存储"，不能沿用"仅保存在这台浏览器里"那句。
   */
  storage?: 'local' | 'cloud'
}

interface DirHandleLike {
  name: string
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>
  getFileHandle: (name: string, opts?: { create?: boolean }) => Promise<unknown>
  getDirectoryHandle: (name: string, opts?: { create?: boolean }) => Promise<DirHandleLike>
}

/**
 * 目录选择器不可用的成因。**只列有依据、可以事前断定的两条** ——
 * "被别的页面嵌着"不在其中：同源嵌入、或带用户手势时浏览器仍可能放行，
 * 事前一律拒绝会误伤本来能用的场景。那条只在调用真的被拒之后用来解释成因。
 */
export type DirPickerBlocker = 'ok' | 'unsupported' | 'insecure-context'

type DirPickerHost = {
  showDirectoryPicker?: unknown
  isSecureContext?: boolean
  self?: unknown
  top?: unknown
}

export function dirPickerBlocker(
  host: DirPickerHost | undefined = typeof window === 'undefined' ? undefined : window,
): DirPickerBlocker {
  if (!host || !('showDirectoryPicker' in host)) return 'unsupported'
  if (!host.isSecureContext) return 'insecure-context'
  return 'ok'
}

/**
 * 当前文档是不是被**不同源**的页面嵌着。判据是"能不能摸到顶层"：同源时 `top.location` 读得到，
 * 跨源时那一行就抛 —— 抛与不抛才是"选择器能不能在这一层打开"的分界。
 *
 * 只拿 `self !== top` 判会多拦一类：**同源子帧里选择器本来就能用**，弹新窗口纯属白折腾人。
 * 只用于"调用被拒之后说清下一步"和"该不该走顶层窗口"，不参与能不能点的判定。
 */
export function inCrossOriginFrame(
  host?: { self?: unknown; top?: { location?: { origin?: string } } | null },
): boolean {
  const win = host ?? (typeof window === 'undefined' ? undefined : window)
  if (!win) return false
  try {
    if (win.self === win.top) return false
    void win.top?.location?.origin
    return false
  } catch {
    return true
  }
}

/** 选择器打不开时的成因；界面按 blocker 挑那句实话，不渲染本条 message。 */
export class DirPickerBlockedError extends Error {
  // 不用构造器参数属性（`constructor(readonly blocker…)`）：本仓源码要能被 `node 某用例.ts` 直跑真源，
  // 而 Node 的 strip-only TS 模式不认那个语法，vue-tsc 过了它照样炸。
  readonly blocker: Exclude<DirPickerBlocker, 'ok'>

  constructor(blocker: Exclude<DirPickerBlocker, 'ok'>) {
    super(`directory picker unavailable: ${blocker}`)
    this.blocker = blocker
    this.name = 'DirPickerBlockedError'
  }
}

// 分片每 2 秒写一次、几路并行 —— 每次再 open() 一遍会让"打开连接"排在请求路径上，
// 实测并发写时会拖出成片间空洞。连接复用一条（IndexedDB 的连接可以跨事务长期持有）。
let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE)
      if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE, { keyPath: 'id' })
      // segments 是 v3 新建的表，索引在创建时一次建好；不必处理"表已存在但没索引"（那只能是同一版本建的）
      if (!db.objectStoreNames.contains(SEGMENT_STORE)) {
        db.createObjectStore(SEGMENT_STORE, { keyPath: 'blobKey' }).createIndex('byTrack', 'trackId')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  dbPromise = opening
  // 打不开要能重试：缓存一条已失败的 Promise 会让本地录制永久失效
  opening.catch(() => {
    if (dbPromise === opening) dbPromise = null
  })
  return opening
}

async function idbPut(value: unknown, key = KEY, store = STORE) {
  const db = await openDb()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function idbGet<T>(key = KEY, store = STORE): Promise<T | null> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(key)
    req.onsuccess = () => resolve((req.result as T) ?? null)
    req.onerror = () => reject(req.error)
  })
}

// in-line 主键（keyPath: 'id'）的表**不能再传第二个 key 参数**，否则直接 DataError；
// 外置键的表（blobs）则必须传。这里按"传不传 key"分开，而不是让调用方记这条规则。
export async function idbPutValue(store: string, value: unknown, key?: IDBValidKey) {
  const db = await openDb()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    if (key === undefined) tx.objectStore(store).put(value)
    else tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** 一片分片入库（崩溃不丢已录部分的关键：每片到手立刻写，不等整场结束）。 */
export function putSegmentBlob(key: string, blob: Blob) {
  return idbPutValue(BLOB_STORE, blob, key)
}

export function getSegmentBlob(key: string): Promise<Blob | null> {
  return idbGet<Blob>(key, BLOB_STORE)
}

/**
 * 一片落库：**分片字节与它的清单记录走同一个事务**。
 * 分开写会出现"segments 有记录而 blobs 没字节"，重建出的清单就指向不存在的键 ——
 * 回放会永久卡在「正在加载此路」，这正是 `onChunk` 里那条摘除逻辑要防的形态。
 */
export async function putSegmentWithRecord(rec: SegmentRecord, blob: Blob): Promise<void> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction([BLOB_STORE, SEGMENT_STORE], 'readwrite')
    tx.objectStore(BLOB_STORE).put(blob, rec.blobKey)
    tx.objectStore(SEGMENT_STORE).put(rec)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export function putSession(session: RecordingSession): Promise<void> {
  // sessions 是 inline 主键（keyPath: 'id'），**不能再传 key**：传了浏览器直接抛 DataError。
  // 这一条曾经真把会话头写废过（探针抓到 "the key parameter was provided"），别改回去。
  return idbPutValue(SESSION_STORE, session)
}

/** 列出"还开着且心跳过期"的会话 —— 心跳阈值由调用方给（应当 > 3×timeslice，避免误伤正在录的）。 */
export async function listCrashedSessions(staleAfterMs: number, now = Date.now()): Promise<RecordingSession[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = db.transaction(SESSION_STORE, 'readonly').objectStore(SESSION_STORE).getAll()
    req.onsuccess = () => {
      const all = (req.result as RecordingSession[]) ?? []
      // 只重建本人的会话：否则 A 登录时会把 B 那台浏览器里没点停止的场次当成自己的重建出来，
      // 并且还能删掉它
      const account = loginAccount()
      resolve(
        all.filter(
          (s) => s.open && now - s.heartbeatAt > staleAfterMs && !!account && (s.recorderAccount || '') === account,
        ),
      )
    }
    req.onerror = () => reject(req.error)
  })
}

/** 按轨取已落库的片记录（seq 升序）。自愈重建清单用它，并逐片回验 blobs 真取得到字节。 */
export async function listSegmentRecords(trackId: string): Promise<SegmentRecord[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const idx = db.transaction(SEGMENT_STORE, 'readonly').objectStore(SEGMENT_STORE).index('byTrack')
    const req = idx.getAll(IDBKeyRange.only(trackId))
    req.onsuccess = () => resolve((((req.result as SegmentRecord[]) ?? []).slice()).sort((a, b) => a.seq - b.seq))
    req.onerror = () => reject(req.error)
  })
}

/**
 * 开录前问一句"这台电脑还写得下吗"。返回 `null` = 这个浏览器不给估算 ——
 * 那就照常让人录，不许因为量不出来而拦人。
 *
 * 为什么只报余量、不预估"这场要用多少"：用量随人数、时长、码率走，
 * 拍一个换算系数就会上桌变成承诺（`docs/录制方案可行性与合轨性能.md` §2 那条 1.80 Mbps 的实测是 720p@15fps 一路的，
 * 换档位就不成立）。所以这里只比一个地板值。
 */
export async function storageHeadroom(): Promise<{ availableBytes: number; quotaBytes: number } | null> {
  try {
    const est = await navigator.storage?.estimate?.()
    if (!est || typeof est.quota !== 'number' || typeof est.usage !== 'number') return null
    return { availableBytes: Math.max(0, est.quota - est.usage), quotaBytes: est.quota }
  } catch {
    return null
  }
}

/**
 * 开录的余量地板：1 GiB。
 * 依据是实测最省的那一档 —— 720p@15fps 一路 14.5 MB/分钟，1 GiB 够一路录 70 分钟；
 * 低于这个数再开录，多半是录到一半写不进去，那比不让开更糟。
 */
export const MIN_FREE_BYTES_TO_RECORD = 1 << 30

/** 配额耗尽的判据：浏览器抛的就是 QuotaExceededError（各家同名） */
export function isQuotaError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'QuotaExceededError'
}

/**
 * 求浏览器把这台设备的本机录制库标成"别回收"（D7）。
 * Chromium 在存储**未被授予持久化**时会在磁盘吃紧时清掉 IndexedDB，那正是"清单在、分片没了"的成因之一
 * —— 而分片没了之后，启动自愈也重建不出内容（它只收真取得到字节的那一路）。
 * 这个请求不需要用户手势（浏览器按启发式自己批），批不下来也只是少一层保护，不影响录制本身。
 */
export async function ensureStoragePersisted(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false
  try {
    if (await navigator.storage.persisted?.()) return true
    return (await navigator.storage.persist()) === true
  } catch (e) {
    console.warn('[localRecorder] 存储持久化请求没走成', e)
    return false
  }
}

/**
 * 录制相关错误的用户文案。浏览器抛的是 DOMException，message 是英文且不可操作
 * （实测 "NotAllowedError: Permission is denied"、"User activation is required..."），
 * 直接进弹窗就违反了"页面不露技术细节"；原始 name/message 只进控制台。
 * 后端的 ApiError 例外 —— 它的 msg 已经是本域中文，要原样给用户。
 */
export function describeRecorderError(e: any): string {
  if (e instanceof ApiError) return e.message
  switch (e?.name) {
    case 'NotAllowedError':
      return '浏览器没有授权录制，请在弹窗里选择「允许」后重试'
    case 'NotReadableError':
      return '摄像头/麦克风被占用，先关掉占用它的软件或标签页'
    case 'NotSupportedError':
      return '该浏览器不支持录制，请换 Edge 或 Chrome'
    case 'SecurityError':
      return '浏览器安全限制拒绝了录制，请用受信任的地址打开本页'
  }
  console.warn('[localRecorder] 未识别的录制错误', e?.name, e?.message)
  return '本地录制启动失败，请重试'
}

export async function pickRecordingDir(): Promise<string> {
  const blocker = dirPickerBlocker()
  if (blocker !== 'ok') throw new DirPickerBlockedError(blocker)
  // 网页无权自己写进系统「视频」目录，只能请用户授权一次；但选择器可以从那里打开 ——
  // startIn:'videos' 让第 14 项的"默认路径"落在系统真源上（用户改过 Videos 位置也照样对），
  // id 让这个授权点记住上次位置，别每次开录都把人甩回根目录。
  const handle = (await (window as any).showDirectoryPicker({
    mode: 'readwrite',
    id: 'conference-local-recording',
    startIn: 'videos',
  })) as DirHandleLike
  await idbPut(handle)
  return handle.name
}

export async function getRecordingDirName(): Promise<string | null> {
  const handle = await idbGet<DirHandleLike>(KEY)
  return handle?.name ?? null
}

export async function clearRecordingDir() {
  await idbPut(null)
}

/**
 * 在**用户手势里**把授权目录的读写权限要到手，返回最终状态。
 *
 * 为什么必须有这一步（第 36 项那个"授权了却没有 hxt 目录"的根因）：目录句柄存在 IndexedDB 里，
 * 跨页面重载还在，但它的 readwrite 权限**不在** —— 重载后 `queryPermission` 实测回到 `prompt`，
 * 而 `requestPermission` 只有在用户刚点下按钮的那几秒里才被浏览器接受。
 * 录制收尾（等编码器 onstop + 末片落库）和宫格合成（要陪整场放一遍）都远在点击之后，
 * 那时才想起来要权限已经来不及，于是整场录制的目录写入静默失败。
 * 所以：**点击那一刻先调它一次**；拿到 granted 之后整个页面会话内都有效，后面的写就不再需要手势。
 */
export async function ensureRecordingDirAccess(): Promise<'granted' | 'prompt' | 'none'> {
  const handle = await idbGet<DirHandleLike>(KEY)
  if (!handle) return 'none'
  const dir = handle as unknown as {
    queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState | string>
    requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState | string>
  }
  if ((await dir.queryPermission?.({ mode: 'readwrite' })) === 'granted') return 'granted'
  return (await dir.requestPermission?.({ mode: 'readwrite' })) === 'granted' ? 'granted' : 'prompt'
}

/**
 * 在授权目录内**逐层建子目录**再写文件（第 14 项的 `hxt/{登录账号}/{时刻}/{会议号}/` 层级）。
 * 浏览器只能在用户授权的那个目录里面建，不能自己挑绝对路径 —— 所以返回的是
 * "相对授权目录的路径"，界面把实际写入的相对路径显示给用户，不说它是绝对位置。
 * 任何一步失败都返回 false：写没写进去只有一个判据，就是这一趟真的走完没有。
 */
export async function writeRecordingAt(
  relParts: string[],
  fileName: string,
  blob: Blob,
): Promise<boolean> {
  const handle = await idbGet<DirHandleLike>(KEY)
  if (!handle) return false
  try {
    const dir = handle as unknown as {
      queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState | string>
      requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState | string>
    }
    const perm = await dir.queryPermission?.({ mode: 'readwrite' })
    if (perm !== 'granted' && (await dir.requestPermission?.({ mode: 'readwrite' })) !== 'granted') {
      return false
    }
    let parent: DirHandleLike = handle
    for (const part of relParts) {
      parent = await parent.getDirectoryHandle(part, { create: true })
    }
    const fileHandle = (await parent.getFileHandle(fileName, { create: true })) as {
      createWritable: () => Promise<{ write: (d: Blob) => Promise<void>; close: () => Promise<void> }>
    }
    const writable = await fileHandle.createWritable()
    await writable.write(blob)
    await writable.close()
    return true
  } catch (e) {
    // 名字里有非法字符（用户昵称带 / : 等）时 FS Access 直接抛错：吞掉会让人以为写成功了。
    console.warn('[localRecorder] 写入授权目录失败', relParts.join('/'), fileName, e)
    return false
  }
}

/** 目录层里的一个名字不能带路径分隔符与保留字符，否则整条层级建不出来；这里就地削掉。 */
export function sanitizePathPart(raw: string, fallback: string): string {
  const s = String(raw || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
  return s && s !== '.' && s !== '..' ? s : fallback
}

/** 授权目录内我方自建那一层的根段。写入方与扫描方都必须取自这里，各写一遍就会差一层。 */
export const RECORDING_ROOT_DIR = 'hxt'

/** 一场录制在授权目录内的完整层级：`hxt/{账号}/{时刻}/{会议号}` */
export function recordingRelParts(userSafe: string, stamp: string, meetingNo: string): string[] {
  return [RECORDING_ROOT_DIR, userSafe, stamp, meetingNo]
}

/**
 * 把清单里存的 `dirPath` 归一成相对授权目录的层级。
 * 历史行存的是**缺 `hxt` 那一层**的那一种（扫描方当时少拼一层，见契约 ADR-0083），
 * 不补回来就永远读不到文件 —— 归一只认根段，不做别的事。
 */
export function dirPathRelParts(dirPath: string): string[] {
  const parts = String(dirPath || '').split('/').filter(Boolean)
  if (!parts.length) return []
  return parts[0] === RECORDING_ROOT_DIR ? parts : [RECORDING_ROOT_DIR, ...parts]
}

/** `dirPath` 里那一段账号（sanitize 之后的形态）；取不到给空串 = 没有证据，不许猜一个 */
export function accountFromDirPath(dirPath?: string | null): string {
  return dirPathRelParts(dirPath || '')[1] || ''
}

export function downloadBlob(fileName: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * 一条本机录制的 id。**开录那一刻就要定下来**：会话头（`sessions`）用它当键，
 * 这样崩溃后重建出的条目、以及 `removeLocalRecording` 连带清掉的会话头才是同一个 id。
 */
export function makeLocalRecordingId(startedAt: number): string {
  return `local-${startedAt}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 登记一条本机录制：元数据与产物一起进 IndexedDB。
 *
 * 产物在本机存两份是有意为之：写盘（或浏览器下载）满足"保存位置"，
 * IndexedDB 这份才是「本地录制」这一栏能播放/再下载的唯一依据 —— 后端不知道这些文件的存在。
 *
 * schema 2（blob 省略）走另一条路：分片已经一片一片落在 blobs 表里了，
 * 这里只登记清单；再存一份整场产物就等于把同一部片子放两遍。
 *
 * `meta.id` 不给就现生成；自愈重建时必须给（要与会话头同键，见 `makeLocalRecordingId`）。
 */
export async function addLocalRecording(
  meta: Omit<LocalRecording, 'id'> & { id?: string },
  blob?: Blob,
): Promise<string> {
  const id = meta.id || makeLocalRecordingId(meta.startedAt)
  // 归属在登记这一刻定，之后不再改：账号拿不到就**留空**（→ unknown 桶），
  // 既不猜一个，也不等到"哪天知道了"再补 —— 补的时候已经无法证明它是谁录的。
  const stamped: LocalRecording = { ...meta, id }
  if (!stamped.recorderAccount) {
    const account = loginAccount()
    if (account) stamped.recorderAccount = account
  }
  if (blob) await idbPutValue(BLOB_STORE, blob, id)
  await idbPutValue(META_STORE, stamped)
  return id
}

/**
 * 清单先登记、磁盘事实后回填（第 39 项）。
 *
 * 列表可见性只能取决于"分片到手了没有"，不能取决于"文件写出去慢了没有"：
 * 实测授权目录里的单个文件写入会被环境侧拖到约一分钟一个（盘上 mtime：同一条录制的
 * camera/microphone/manifest 相隔各 60 秒），而登记排在最后 → 用户点完停止立刻去录制页
 * 就是空的，中途页面重载更是永久消失。
 */
export async function updateLocalRecording(id: string, patch: Partial<Omit<LocalRecording, 'id'>>): Promise<void> {
  const meta = await idbGet<LocalRecording>(id, META_STORE)
  if (!meta) return
  await idbPutValue(META_STORE, { ...meta, ...patch, id })
}

/**
 * 从媒体本身读真实时长（秒）。界面上那一栏写的是"视频时长"，就必须是媒体自己的时长：
 * 拿"点了开始到点了停止"的墙上时钟凑数会偏（实测标签 27 秒、webm 实际 19.07 秒）。
 * MediaRecorder 出的 webm 头里 duration 常是 Infinity，用"seek 到极远再读"这一招逼出真值
 * （Chromium 实测可行）；3 秒内读不到就回 null，由调用方决定兜底，不硬造一个数。
 */
export function probeBlobDurationSec(blob: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const v = document.createElement('video')
    let settled = false
    const finish = (n: number | null) => {
      if (settled) return
      settled = true
      URL.revokeObjectURL(url)
      v.removeAttribute('src')
      v.load()
      resolve(n)
    }
    const timer = window.setTimeout(() => finish(null), 3000)
    const readReal = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) {
        window.clearTimeout(timer)
        finish(Math.round(v.duration))
      }
    }
    v.preload = 'metadata'
    v.onloadedmetadata = () => {
      if (Number.isFinite(v.duration) && v.duration > 0) return readReal()
      v.currentTime = 1e7
    }
    v.ondurationchange = readReal
    v.onerror = () => {
      window.clearTimeout(timer)
      finish(null)
    }
    v.src = url
  })
}

/**
 * 列表加载：磁盘为真源，但**缓存里磁盘上没有的行不能被删**。
 *
 * 只交出 `mine`（见 `recordingAccount.OwnerState`）：判不出归属与别人的条目都不进界面 ——
 * 用户口径是"别人的录制我看不到也不需要提示，因为本来就不应该看到"。它们在控制台留一行计数，
 * 因为对排查的人而言"有 N 条静默不存在"才是要知道的事，而界面不该替开发者说话。
 *
 * ⚠️ 旧实现在这里有一句无条件 `store.clear()`，两个后果都很坏：
 * ① 只要当前账号扫到 ≥1 条，就把整张表**连别人的条目一起**物理删掉（跨账号删数据）；
 * ② 磁盘扫描只覆盖"授权目录 + 真落盘"那部分，**从没写过盘的降级条目**（`dirHandle=false`，
 *    产物只在浏览器里）会被一起删掉，且返回值只给磁盘那批 —— 于是这类录制永久消失。
 * 现在改成：只删"磁盘派生（id 前缀 `disk-`）且已不在盘上/已被合并"的缓存行，其余见 `planLocalRecordingSync`。
 */
export async function listLocalRecordings(): Promise<LocalRecording[]> {
  // 先要身份再判归属：账号还没水合时 ownerStateOf 一律返回"不能判"，直接往下走会把全部本机录制藏掉
  await useUserStore().ensureIdentity()
  const diskRecordings = await scanDiskRecordings()
  const db = await openDb()
  const cached = await new Promise<LocalRecording[]>((resolve, reject) => {
    const req = db.transaction(META_STORE, 'readonly').objectStore(META_STORE).getAll()
    req.onsuccess = () => resolve((req.result as LocalRecording[]) ?? [])
    req.onerror = () => reject(req.error)
  })

  const plan = planLocalRecordingSync(cached, diskRecordings)
  if (plan.put.length || plan.removeIds.length) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(META_STORE, 'readwrite')
      const store = tx.objectStore(META_STORE)
      for (const rec of plan.put) store.put(rec)
      for (const id of plan.removeIds) store.delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }
  // 界面对"判不出归属"和"不属于当前账号"都不说话（用户口径），但"为什么是空的"必须能查出来
  console.info(
    `[localRecorder] 本机条目：我的 ${plan.mine.length} 条，判不出归属 ${plan.unattributed.length} 条，不属于当前账号 ${plan.others} 条`,
  )
  return plan.mine
}

/**
 * 一行的归属：字段里记了账号就比账号（原样、大小写敏感），为空时退回"目录段就是证据"。
 * 列表与按 id 直取（`?local=<id>`）两处读点都走这一个算式 —— 分两处比字符串就会漂移。
 */
function resolveOwnerState(
  rec: Pick<LocalRecording, 'recorderAccount' | 'dirPath'> | null | undefined,
): OwnerState | null {
  const state = ownerStateOf(rec?.recorderAccount)
  if (state !== 'unknown' || !rec) return state
  const segment = accountFromDirPath(rec.dirPath)
  if (!segment) return 'unknown'
  return segment === sanitizePathPart(loginAccount(), 'unknown') ? 'mine' : 'others'
}

/**
 * 这条本机录制是否属于当前登录者。
 */
function isMine(rec: Pick<LocalRecording, 'id' | 'recorderAccount' | 'dirPath'> | null | undefined): boolean {
  return resolveOwnerState(rec) === 'mine'
}

/** 归属判据的唯一出口：视图算 `deletable` 也走它，不在第二处重比一次账号 */
export const recordingIsMine = isMine

/** 是不是同一片录制：会议号相同、起始时刻在同一秒内（磁盘清单那份的 startAtMs 就是录制时的 t0） */
function sameSession(a: LocalRecording, b: LocalRecording): boolean {
  return !!a.meetingNo && a.meetingNo === b.meetingNo && Math.abs(a.startedAt - b.startedAt) <= 2000
}

/**
 * 把"缓存里的行 + 磁盘扫到的行"算成一份视图。纯函数，IndexedDB 只做搬运 ——
 * 因为"磁盘扫描非空"那条分支正是旧实现销毁数据的地方，而它在 Node 里根本进不去
 * （要真目录授权），不抽出来就永远测不到。
 *
 * 三件事在这里办完，缺一件就回到用户报的那个样子：
 * ① **同一片录制的两份行合到一起**：录完当场登记的那条 id 是 `local-…`，扫描重建的是 `disk-…`，
 *    合之前列表里同一片出现两条、"共 x 个录制"跟着错。合并保留 `local-…` 那个 id ——
 *    分片字节存在 BLOB_STORE 里、键就是它，换成 `disk-…` 等于把产物也换了主人。
 * ② **从目录结构回填账号**：本轮字段之前的条目没记 `recorderAccount`，但它们带着 `dirPath`，
 *    而 `dirPath` 的账号段就是"谁录的"的硬证据。这条不依赖授权目录、也不依赖用户手势，
 *    所以从前那 29 条靠它就能回来（不靠"重新连接保存目录"那个按钮）。
 * ③ 分归属三态：只有 `mine` 进列表（口径见 `recordingAccount.ownerStateOf`）。
 *
 * 返回要写回缓存的行、要删的缓存行，以及分好类的视图。
 */
export function planLocalRecordingSync(
  cached: LocalRecording[],
  diskRows: LocalRecording[],
): {
  put: LocalRecording[]
  removeIds: string[]
  mine: LocalRecording[]
  unattributed: LocalRecording[]
  /** 判成"别人的"条数：只给数，不把行交出去 */
  others: number
} {
  const current = loginAccount()
  const currentSafe = sanitizePathPart(current, 'unknown')
  const onDisk = new Set(diskRows.map((r) => r.id))

  // 磁盘行对上它那条缓存行（只认非 disk- 的：缓存里 disk- 行同 id 会自己重合，不需要合并）
  const diskByCacheId = new Map<string, LocalRecording>()
  const absorbedDiskIds = new Set<string>()
  for (const d of diskRows) {
    const hit = cached.find((c) => !c.id.startsWith('disk-') && sameSession(c, d))
    if (hit && !diskByCacheId.has(hit.id)) {
      diskByCacheId.set(hit.id, d)
      absorbedDiskIds.add(d.id)
    }
  }

  // 回收两种 disk- 缓存行：盘上已经没有了（文件被手动删），以及被并进 local- 行的那份重复。
  // 别人的行、以及从没写过盘的降级行（dirHandle=false）都不在该删除之列。
  const removeIds = diskRows.length
    ? cached
        .filter((r) => r.id.startsWith('disk-') && (!onDisk.has(r.id) || absorbedDiskIds.has(r.id)))
        .map((r) => r.id)
    : []

  // 按 id 收成一份，磁盘优先覆盖 —— **必须按 id 去重**：上一轮扫描写下的 `disk-X` 缓存行
  // 与这一轮扫到的 `disk-X` 是同一条，直接并排推进数组就会出两行，卡片只出一张而计数算两条
  // （页头"共 17 个录制"对上"已显示 15"，且"加载更多"点了没反应 —— 2026-10-10 现场）。
  const byId = new Map<string, LocalRecording>()
  for (const rec of cached) {
    if (removeIds.includes(rec.id)) continue
    const d = diskByCacheId.get(rec.id)
    // 磁盘那份只补"落在哪儿、是不是真落盘了"这两个它缺的事实。
    // tracks 仍用缓存那份：清单里的 blobKey 是浏览器侧取分片的唯一依据，换掉就播不出来了；
    // partial 也不改口 —— "有路内断流"是录制当场就知道的，扫描无从判断
    byId.set(rec.id, d ? { ...rec, dirPath: d.dirPath || rec.dirPath, dirHandle: true } : rec)
  }
  // 没被合并的磁盘行：那是这个浏览器从没登记过的场次（换过浏览器、清过数据但盘还在），
  // 或与缓存里同 id 的旧扫描行重合 —— 重合时以盘上这份为准
  for (const d of diskRows) if (!absorbedDiskIds.has(d.id)) byId.set(d.id, d)
  const merged = [...byId.values()]

  // 回填账号：只在字段为空、且目录段与当前账号（同一 sanitize 口径）逐字相等时才写
  const withAccount = merged.map((rec) => {
    if (rec.recorderAccount || !current) return rec
    const segment = accountFromDirPath(rec.dirPath)
    return segment && segment === currentSafe ? { ...rec, recorderAccount: current } : rec
  })

  const before = new Map(cached.map((r) => [r.id, r]))
  const put = withAccount.filter((rec) => {
    const old = before.get(rec.id)
    return !old || JSON.stringify(old) !== JSON.stringify(rec)
  })

  const mine: LocalRecording[] = []
  const unattributed: LocalRecording[] = []
  let others = 0
  for (const rec of withAccount) {
    const state = resolveOwnerState(rec)
    if (state === 'mine') mine.push(rec)
    else if (state === 'unknown') unattributed.push(rec)
    else if (state === 'others') others++
    // "身份还没就绪"不该出现：ensureIdentity 在前面挡着
  }
  const byTime = (a: LocalRecording, b: LocalRecording) => b.startedAt - a.startedAt
  return {
    put,
    removeIds,
    mine: mine.sort(byTime),
    unattributed: unattributed.sort(byTime),
    others,
  }
}

/**
 * 按 id 取一条本机录制，并**分辨取不到的成因**。
 *
 * `null` 一个值不够用：「字节被浏览器回收了」和「这条不是你的」用户接下来要做的事完全不同
 * （前者该去重录或找原片，后者什么都不该做）。回放页 `?local=<id>` 是个能直接拼出来的地址，
 * 必须在这里分清，不能统一报"已不可读取"。
 */
export type LocalRecordingAccess =
  | { state: 'mine'; rec: LocalRecording }
  | { state: 'others' | 'unknown' | 'missing'; rec: null }

export async function inspectLocalRecording(id: string): Promise<LocalRecordingAccess> {
  const rec = await idbGet<LocalRecording>(id, META_STORE)
  if (!rec) return { state: 'missing', rec: null }
  if (isMine(rec)) return { state: 'mine', rec }
  return { state: resolveOwnerState(rec) === 'unknown' ? 'unknown' : 'others', rec: null }
}

export async function getLocalRecording(id: string): Promise<LocalRecording | null> {
  const rec = await idbGet<LocalRecording>(id, META_STORE)
  // 谓词挂在取数上而不是只挂在列表上：`?local=<id>` 是个能直接拼出来的地址，
  // 只在列表里过滤等于"藏起来但地址还在"
  return isMine(rec) ? rec : null
}

export async function getLocalRecordingBlob(id: string): Promise<Blob | null> {
  if (!(await getLocalRecording(id))) return null
  return idbGet<Blob>(id, BLOB_STORE)
}

/**
 * 删除本机录制：磁盘 + IndexedDB 双清。
 * 磁盘有目录 → 递归删目录（连同各路 .webm 和 manifest.json）；
 * IndexedDB 里的分片/清单/会话头一并清掉。
 * 磁盘删除失败不阻塞 IndexedDB 清理（文件可以手动删，但列表条目必须先消失）。
 */
export async function removeLocalRecording(id: string): Promise<void> {
  const meta = await idbGet<LocalRecording>(id, META_STORE)
  // 删是比看更重的动作，谓词不能只挂在列表上。抛机器码而不是静默返回 ——
  // 静默会让调用方以为删成功了，而界面上那条还在
  if (!isMine(meta)) throw new Error('not_owner')

  // 磁盘目录删除：dirHandle=true 且 dirPath 有值时，递归删 hxt/{user}/{stamp}/{meeting}/
  if (meta?.dirHandle && meta?.dirPath) {
    try {
      const root = await getRootDirHandle()
      if (root) {
        const parts = meta.dirPath.split('/')
        // 进入倒数第二层，删最后一层目录
        if (parts.length >= 2) {
          const parent = await resolveSubDir(root, parts.slice(0, -1))
          if (parent) {
            await (parent as unknown as { removeEntry: (name: string, opts: { recursive: boolean }) => Promise<void> })
              .removeEntry(parts[parts.length - 1], { recursive: true })
          }
        }
      }
    } catch (e) {
      console.warn('[localRecorder] 删磁盘目录失败，继续清缓存', e)
    }
  }

  const blobKeys = [id, ...(meta?.tracks || []).flatMap((t) => t.segments.map((s) => s.blobKey))]
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction([BLOB_STORE, META_STORE, SEGMENT_STORE, SESSION_STORE], 'readwrite')
    for (const key of blobKeys) {
      tx.objectStore(BLOB_STORE).delete(key)
      tx.objectStore(SEGMENT_STORE).delete(key)
    }
    tx.objectStore(META_STORE).delete(id)
    tx.objectStore(SESSION_STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// —— 磁盘为真源（schema 3 存储重构）————————————————————————————————

/**
 * 从 IndexedDB 读目录句柄（`handles` store 里那一个）。
 * 扫描磁盘和播放都从它出发；返回 null 表示用户从没选过目录、或句柄已失效。
 */
export async function getRootDirHandle(): Promise<DirHandleLike | null> {
  return idbGet<DirHandleLike>(KEY)
}

/**
 * 沿 `relParts` 逐级进入子目录，任何一级不存在就返回 null（`create: false`）。
 * 扫描和播放都走这条路径，区别只在最后一步是读 manifest 还是读 .webm。
 */
async function resolveSubDir(
  root: DirHandleLike,
  relParts: string[],
): Promise<DirHandleLike | null> {
  let cur: DirHandleLike = root
  for (const part of relParts) {
    try {
      cur = await cur.getDirectoryHandle(part, { create: false })
    } catch {
      return null
    }
  }
  return cur
}

/**
 * 从授权目录里读一个文件为 Blob。文件不存在或没权限 → null，不抛。
 */
async function readFileFromDir(
  root: DirHandleLike,
  relParts: string[],
  fileName: string,
): Promise<Blob | null> {
  const dir = await resolveSubDir(root, relParts)
  if (!dir) return null
  try {
    const fh = await dir.getFileHandle(fileName, { create: false })
    return await (fh as { getFile: () => Promise<Blob> }).getFile()
  } catch {
    return null
  }
}

interface ManifestStream {
  recordingId: string
  ownerId: string
  ownerName: string
  kind: RecordedTrackKind
  streamLabel?: string
  hasVideo?: boolean
  hasAudio?: boolean
  fileName: string
  mime: string
  width?: number
  height?: number
  frameRate?: number
  sampleRate?: number
  channelCount?: number
  offsetSeconds?: number
  closeReason?: TrackCloseReason | ''
  segments?: Array<{
    offsetSeconds: number
    durationSeconds: number
    bytes: number
    file: string
    mime: string
  }>
}

interface ManifestJson {
  schema: number
  meeting: { meetingNo: string; title: string }
  timeline: { startAt: number; startAtMs: number }
  container: string
  streams: ManifestStream[]
}

/**
 * 磁盘清单里的一片 → `TrackSegment`。
 *
 * `seq` 与 `blobKey` 取清单里的**真值**（`file` 形如 `名字#segment=N`），不拿位置下标充当：
 * 位置下标恒单调，会把"片号回绕 / 同一片出现两次"这份唯一证据抹掉 ——
 * 盘上那份坏件在读取侧就看不出坏了，回放与下载照样把只有前十几秒的文件交给用户。
 * 单独出口是为了这条判据能被真夹具直接喂进单测（见 `scratch/verify-lane-doublewrite.ts`）。
 */
export function trackSegmentsFromManifest(
  stream: Pick<ManifestStream, 'fileName' | 'mime'> & { segments?: ManifestStream['segments'] },
): TrackSegment[] {
  return (stream.segments || []).map((seg, i) => {
    const at = (seg.file || '').lastIndexOf('#segment=')
    const rawSeq = at >= 0 ? Number((seg.file as string).slice(at + 9)) : NaN
    return {
      seq: Number.isFinite(rawSeq) ? rawSeq : i,
      offsetSec: seg.offsetSeconds,
      durationSec: seg.durationSeconds,
      sizeBytes: seg.bytes,
      // 磁盘那一路不按键取字节（整路是一个文件），这个键只用来做逐片的身份判定
      blobKey: seg.file || `${stream.fileName}#${i}`,
      mime: seg.mime || stream.mime,
    }
  })
}

/**
 * 把磁盘上的 manifest.json 转成 `LocalRecording`。
 * `relativePath` 是**相对授权目录**的完整层级（`hxt/{账号}/{时刻}/{会议号}`），存进 `dirPath` 供播放时定位文件。
 * manifest 格式不对或 schema 不识别 → null，调用方跳过。
 */
function manifestToLocalRecording(
  manifest: ManifestJson,
  relativePath: string,
): LocalRecording | null {
  if (manifest.schema !== 2) return null

  const tracks: RecordedTrack[] = (manifest.streams || []).map((s) => {
    const segs = trackSegmentsFromManifest(s)
    return {
      recordingId: s.recordingId,
      ownerId: s.ownerId,
      ownerName: s.ownerName,
      kind: s.kind,
      mediaLabel: s.streamLabel || '',
      hasVideo: s.hasVideo ?? (s.kind !== 'microphone'),
      hasAudio: s.hasAudio ?? true,
      fileName: s.fileName,
      mime: s.mime,
      width: s.width,
      height: s.height,
      frameRate: s.frameRate,
      sampleRate: s.sampleRate,
      channelCount: s.channelCount,
      startOffsetSec: s.offsetSeconds || 0,
      endOffsetSec: null,
      closedAtMs: null,
      closeReason: s.closeReason || '',
      segments: segs,
    }
  })

  const durationSec = tracks.reduce((max, t) => {
    const trackEnd = t.startOffsetSec + t.segments.reduce((sum, s) => sum + s.durationSec, 0)
    return Math.max(max, trackEnd)
  }, 0)

  const sizeBytes = tracks.reduce(
    (sum, t) => sum + t.segments.reduce((s, seg) => s + seg.sizeBytes, 0),
    0,
  )

  return {
    id: `disk-${manifest.timeline.startAtMs}`,
    title: manifest.meeting.title || `会议 ${manifest.meeting.meetingNo}`,
    meetingNo: manifest.meeting.meetingNo,
    fileName: `recording-${manifest.meeting.meetingNo || 'meeting'}`,
    startedAt: manifest.timeline.startAtMs,
    durationSec: Math.max(1, Math.round(durationSec)),
    sizeBytes,
    schema: 2,
    tracks,
    dirPath: relativePath,
    dirHandle: true,
    partial: false,
    storage: 'local',
  }
}

/**
 * 扫描磁盘 `hxt/{currentUser}/` 下的所有 manifest.json，返回解析出的录制清单。
 * 未授权目录 / 未登录 / 权限没到手 → 空数组，并把**卡在哪一步**写进控制台：
 * 这条路径从前有五处静默 `return []`，界面只表现为"本地录制空了"，排查的人只能猜。
 * 旧目录结构（`hxt/{时刻}/{账号}/`）不兼容，直接跳过。
 */
export async function scanDiskRecordings(): Promise<LocalRecording[]> {
  const root = await getRootDirHandle()
  if (!root) {
    console.info('[localRecorder] 磁盘没扫：这台浏览器没有授权过保存目录')
    return []
  }

  const user = loginAccount()
  if (!user) return []

  // 请求读权限：跨页面重载后权限回到 prompt，不请求一次就读不到子目录
  const dir = root as unknown as {
    queryPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState | string>
    requestPermission?: (d: { mode: 'read' | 'readwrite' }) => Promise<PermissionState | string>
  }
  try {
    const perm = await dir.queryPermission?.({ mode: 'read' })
    if (perm !== 'granted') {
      // requestPermission 只在用户刚点下按钮的那几秒里被接受（见 ensureRecordingDirAccess 的说明）
      if ((await dir.requestPermission?.({ mode: 'read' })) !== 'granted') {
        console.info('[localRecorder] 磁盘没扫：保存目录的读权限没到手（需要在用户手势里重新连接）')
        return []
      }
    }
  } catch (e) {
    console.info('[localRecorder] 磁盘没扫：查询保存目录权限异常', e)
    return []
  }

  const { rows, reason } = await scanRecordingsInDir(root, user)
  if (reason === 'no_hxt') {
    console.info('[localRecorder] 磁盘没扫：授权目录里没有 hxt 那一层（目录被挪走或从没录过）')
  } else if (reason === 'no_user_dir') {
    console.info(`[localRecorder] 磁盘没扫：授权目录里没有当前账号那一层（这个账号没在本机落过盘）`)
  } else if (rows.length) {
    console.info(`[localRecorder] 磁盘扫到 ${rows.length} 场`)
  }
  return rows
}

/**
 * 进 `hxt/{sanitize(账号)}/` 逐场次读清单，账号当场写进每条结果。
 * 拆成"外部传 root + 账号"的这一层，是为了能在 Node 里用桩目录树跑到它 —— 这条分支从前只有
 * 浏览器进得去，于是层级少写一层也无人知晓（用例见 scratch/verify-disk-path.ts，驱动的就是这里）。
 * 只进**这个账号**那一层：别人的场次连扫都不扫，账号隔离在结构上就成立。
 * 记的是原样登录名而不是目录段 —— 目录段 sanitize 过，与 `ownerStateOf` 那句比对口径
 * （原样、大小写敏感）不是同一个东西。
 *
 * `reason` 是给排查的人看的：从前这里只返回空数组，"没授权 / 目录被挪走 / 这个账号没录过"
 * 三种完全不同的下场在界面上长得一模一样。
 */
export async function scanRecordingsInDir(
  root: DirHandleLike,
  account: string,
): Promise<{ rows: LocalRecording[]; reason: 'ok' | 'no_hxt' | 'no_user_dir' }> {
  const userSafe = sanitizePathPart(account, 'unknown')
  const hxt = await resolveSubDir(root, [RECORDING_ROOT_DIR])
  if (!hxt) return { rows: [], reason: 'no_hxt' }
  const userDir = await resolveSubDir(hxt, [userSafe])
  if (!userDir) return { rows: [], reason: 'no_user_dir' }

  const recordings: LocalRecording[] = []
  try {
    for await (const [stamp, stampDir] of userDir as unknown as AsyncIterable<[string, DirHandleLike]>) {
      if ((stampDir as any).kind !== 'directory') continue
      for await (const [meetingNo, meetingDir] of stampDir as unknown as AsyncIterable<[string, DirHandleLike]>) {
        if ((meetingDir as any).kind !== 'directory') continue
        const relParts = recordingRelParts(userSafe, stamp, meetingNo)
        const blob = await readFileFromDir(root, relParts, 'manifest.json')
        if (!blob) continue
        const relPath = relParts.join('/')
        try {
          const manifest = JSON.parse(await blob.text()) as ManifestJson
          const rec = manifestToLocalRecording(manifest, relPath)
          if (rec) recordings.push({ ...rec, recorderAccount: account })
        } catch (e) {
          console.warn('[localRecorder] manifest 解析失败', relPath, e)
        }
      }
    }
  } catch (e) {
    console.warn('[localRecorder] 扫描磁盘异常', e)
  }

  return { rows: recordings.sort((a, b) => b.startedAt - a.startedAt), reason: 'ok' }
}

/**
 * 从磁盘读整路 .webm 文件（`dirHandle=true` 的录制走这条）。
 * `dirPath` 是 `hxt/{账号}/{时刻}/{会议号}`，相对授权目录；历史行缺 `hxt` 那一层，由 `dirPathRelParts` 补回。
 */
export async function getTrackBlobFromDisk(
  recording: LocalRecording,
  track: RecordedTrack,
): Promise<Blob | null> {
  if (!recording.dirPath) return null
  const root = await getRootDirHandle()
  if (!root) return null
  return readFileFromDir(root, dirPathRelParts(recording.dirPath), track.fileName)
}

/**
 * 交给用户手的 webm 必须带 Duration（`utils/webmDuration.ts`）：MediaRecorder 产的 webm 头里没有它，
 * 播放器读到 `duration=Infinity` —— 进度条拖不动、倍速也失效（"下载的视频不能调倍速"就是这个）。
 * 磁盘上今天之前写下的产物是裸拼接的（那时还没在写盘出口补），所以下载出口再兜一次。
 * mp4 不许过：它自带 `mvhd` 时长，往 mp4 里塞 EBML 会把合法文件改坏。
 * 时长按各片之和 = 这一路文件自己的长度（不是它在整场里的跨度：缺口不在文件里）。
 */
async function withMediaDuration(blob: Blob, track: RecordedTrack): Promise<Blob> {
  if ((track.mime || '').includes('mp4')) return blob
  const mediaMs = Math.round((track.segments || []).reduce((a, s) => a + s.durationSec * 1000, 0))
  return mediaMs > 0 ? finalizeWebmDuration(blob, mediaMs) : blob
}

/**
 * 播放/下载入口：磁盘优先，降级到 IndexedDB 分片拼接。
 * `dirHandle=true` 且有 `dirPath` → 磁盘上有整路 .webm，直接读；
 * 否则（授权目录写入失败、或旧 schema 1 的录制）→ 回退到 `assembleTrackBlob` 从分片拼。
 *
 * `assemble` 回调由调用方注入，避免本模块反向依赖 trackRecorder.ts（循环依赖）。
 *
 * 清单里片号回绕或同一个键出现两次的那一路**不交出文件**：盘上那份与拼出来那份都带着多于一个
 * 容器头（实测解不出时长与帧），交出去只得到"下载成功但只有前十几秒"。这里不修字节，
 * 只拒绝，由调用方按"已损坏"说实话；判据与入料层同一处。
 */
export async function getTrackBlob(
  recording: LocalRecording,
  track: RecordedTrack,
  assemble: (track: RecordedTrack) => Promise<Blob | null>,
): Promise<Blob | null> {
  if (laneIsDamaged(track.segments || [])) return null
  if (recording.dirHandle && recording.dirPath) {
    const blob = await getTrackBlobFromDisk(recording, track)
    if (blob) return withMediaDuration(blob, track)
  }
  return assemble(track)
}
