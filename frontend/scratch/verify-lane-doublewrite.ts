/**
 * 并写护栏与"跨容器不拼接"的真源用例（`node scratch/verify-lane-doublewrite.ts`）。
 *
 * 钉的是盘上那份坏件（`Videos/hxt/chenfang/20260930185052/14969610`）：
 *   camera 路 60 片，片号序列 `0,0,1,1,2,2,3,3,4,4,0..49`，`offsetSeconds` 全程单调；
 *   成出的 `.webm` 里有 3 个 EBML 头（实测第 2、3 个头正好落在第 1 片末尾与第 10 片末尾），
 *   且**逐对字节完全相同**（`seg0 == seg1`）—— 那就是同一条清单条目被列了两遍，
 *   拼文件时同一个 blobKey 被读了两次，不是两台编码器各写了一份。
 * 于是判据要同时管住两侧：
 *   ① 开录侧：一路一个在录编码器；同一路的清单终态只能登记一次；收尾**绝不把两条路的分片并成一条**；
 *   ② 读取侧：这种形状的路要标成损坏，不能当作一份完整文件交给回放或下载。
 * 两侧都要有"好数据不许误伤"的那一半：487 片单调的那一路（同一台机器上的健康样本）必须零异常码。
 */
import { register } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// 这条用例要靠桩顶掉 IndexedDB 持久层（Node 里没有 indexedDB），所以显式申请桩；
// 不申请时 hook 走真实现 —— 见 ts-alias-hooks.mjs 里那条假绿的教训。
process.env.STUB_LOCAL_RECORDER = '1'
register('./ts-alias-hooks.mjs', import.meta.url)

// —— DOM 侧的替身：只补"开录这条路真的会读的东西"，语义照抄浏览器可观察的那几条 ——
const recorderLog: FakeRecorder[] = []
class FakeRecorder {
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  mimeType = 'video/webm;codecs=vp9'
  static isTypeSupported(t: string): boolean {
    return String(t).startsWith('video/webm') || String(t).startsWith('audio/webm')
  }
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  stream: FakeStream
  constructor(stream: FakeStream, opts?: { mimeType?: string }) {
    this.stream = stream
    this.mimeType = opts?.mimeType || this.mimeType
    recorderLog.push(this)
  }
  start() { this.state = 'recording' }
  pause() { this.state = 'paused' }
  resume() { this.state = 'recording' }
  /** 真 stop()：先吐末片，再 onstop（这里的同步顺序比浏览器更严格，足够覆盖被测形状） */
  stop() {
    if (this.state === 'inactive') throw new Error('InvalidStateError')
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob([`tail-${recorderLog.length}`]) })
    this.onstop?.()
  }
  /** 浏览器在源轨结束时**自己**把编码器停掉：只发 onstop，不给末片 */
  selfStop() {
    this.state = 'inactive'
    this.onstop?.()
  }
  /** 模拟一次 timeslice 出片 */
  emitChunk(tag: string) { this.ondataavailable?.({ data: new Blob([tag]) }) }
}
class FakeStream {
  tracks: FakeTrack[]
  constructor(tracks: FakeTrack[]) { this.tracks = tracks }
}
type FakeTrack = { kind: string; label: string; readyState: string; getSettings: () => Record<string, number>; addEventListener: () => void; stop: () => void }
function fakeTrack(kind = 'video'): FakeTrack {
  return {
    kind,
    label: kind === 'video' ? '本机摄像头' : '本机麦克风',
    readyState: 'live',
    getSettings: () => (kind === 'video' ? { width: 1280, height: 720, frameRate: 15 } : { sampleRate: 48000, channelCount: 1 }),
    addEventListener: () => {},
    stop: () => {},
  }
}
const g = globalThis as Record<string, unknown>
g.MediaRecorder = FakeRecorder
g.MediaStream = FakeStream
g.requestAnimationFrame = () => 0
g.cancelAnimationFrame = () => {}

const stub = await import('./stub-local-recorder.ts')
const {
  TrackRecorderSession, LaneAlreadyLiveError, trackIsDamaged, assembleTrackBlob,
  downloadLocalRecordingTracks, describeTrackDownload,
} = await import('@/utils/trackRecorder')
const { splitContainers, laneAnomalies, laneIsDamaged } = await import('../src/utils/offlineCompose/segmentSource.ts')
const { ReplayEngine, groupTracksByLane } = await import('@/utils/replayEngine')
// 这一路要的是**真**的磁盘清单解析（桩顶替的是另一份，见 ts-alias-hooks）
const { trackSegmentsFromManifest } = await import('../src/utils/localRecorder.ts')

let ran = 0
const fails: string[] = []
function ok(name: string, cond: boolean, detail = ''): void {
  ran++
  if (!cond) fails.push(`${name}${detail ? ' — ' + detail : ''}`)
}
function eq(name: string, got: unknown, want: unknown): void {
  ok(name, got === want, `got=${String(got)} want=${String(want)}`)
}

const srcOf = (kind: 'camera' | 'microphone') => ({
  ownerId: 'self',
  ownerName: '陈芳',
  kind,
  mediaLabel: kind === 'camera' ? '本机摄像头' : '本机麦克风',
  video: kind === 'camera' ? { track: fakeTrack('video') } : undefined,
  audioTracks: kind === 'microphone' ? [fakeTrack('audio')] : undefined,
})

// 盘上那份坏件的**逐片形状**（偏移与片号与 manifest.json 一致）：
// 前 10 片是同一批片被列了两遍（同一个 blobKey），末尾再接上重开的那条路（片号又从 0 起）。
const PAIR_OFFSETS = [0.001, 2.033, 4.049, 6.051, 8.101]
const observedSlices = () => {
  const out: Array<{ blobKey: string; seq: number; offsetSec: number; durationSec: number; sizeBytes: number }> = []
  PAIR_OFFSETS.forEach((off, i) => {
    const slice = { blobKey: `self-camera-munziih0#${i}`, seq: i, offsetSec: off, durationSec: 2.016, sizeBytes: 407768 + i * 1000 }
    // 同一条清单条目被列了两遍 ⇒ 两个 blobKey、两份字节引用
    out.push(slice, { ...slice })
  })
  for (let i = 0; i < 50; i++) {
    out.push({ blobKey: `self-camera-munziih1#${i}`, seq: i, offsetSec: 24.002 + i * 2.004, durationSec: 2.004, sizeBytes: 416726 })
  }
  return out
}
const cleanSlices = (n = 487) =>
  Array.from({ length: n }, (_, i) => ({ blobKey: `ok#${i}`, seq: i, offsetSec: i * 2.028, durationSec: 2.028, sizeBytes: 456000 }))

// —— 1. 判据抓得住那份坏件，且不误伤好件 ——
{
  const bad = splitContainers('self-camera', observedSlices())
  const a = bad.anomalies
  ok('坏件报 seq_restart', a.includes('seq_restart'), a.join(','))
  ok('坏件报 duplicate_blob_key', a.includes('duplicate_blob_key'), a.join(','))
  ok('坏件切出多于一个容器', bad.containerCount > 1, String(bad.containerCount))
  ok('坏件判成损坏', laneIsDamaged(observedSlices()))
  const fine = splitContainers('ok', cleanSlices())
  eq('487 片单调的好件零异常码', fine.anomalies.length, 0)
  eq('好件只有一个容器', fine.containerCount, 1)
  ok('好件不判成损坏', !laneIsDamaged(cleanSlices()))
  // seq_gap（中间少一片）是缺口不是损坏：回放本来就该在那儿断成两块区
  const gapped = [{ blobKey: 'g#0', seq: 0, offsetSec: 0, durationSec: 2, sizeBytes: 10 }, { blobKey: 'g#2', seq: 2, offsetSec: 4, durationSec: 2, sizeBytes: 10 }]
  ok('片号跳跃只报 seq_gap', laneAnomalies(gapped).join(',') === 'seq_gap', laneAnomalies(gapped).join(','))
  ok('片号跳跃不算损坏', !laneIsDamaged(gapped))
}

// —— 2. 护栏：一路一个在录编码器 ——
{
  const s = new TrackRecorderSession({ t0: Date.now(), userName: '陈芳', meetingNo: '14969610', title: '测试' })
  const first = s.open('self-camera', srcOf('camera'))
  ok('第一次开这一路成功', !!first)
  let threw: unknown = null
  try { s.open('self-camera', srcOf('camera')) } catch (e) { threw = e }
  ok('同一键再开必须抛类型化错误（不许静默并写）', threw instanceof LaneAlreadyLiveError, String(threw))
  eq('错误里带的是那一个键', (threw as InstanceType<typeof LaneAlreadyLiveError>)?.laneKey, 'self-camera')
  eq('抛出后没有多出第二条在录的路', s.liveKeys().length, 1)
  s.close('self-camera', 'track_disabled')
  const again = s.open('self-camera', srcOf('camera'))
  ok('关掉之后同一键可以重开（重开 = 新的一条路）', !!again)
  ok('重开的那条不是同一个 recordingId', again.recordingId !== first.recordingId, `${again.recordingId} vs ${first.recordingId}`)
  // 同一毫秒重开：时间戳基的 id 会撞，撞了就是一条路的字节写进另一条的键空间
  const realNow = Date.now
  Date.now = () => realNow() + 60_000
  const pinnedA = s.open('self-microphone', srcOf('microphone'))
  s.close('self-microphone', 'track_disabled')
  const pinnedB = s.open('self-microphone', srcOf('microphone'))
  Date.now = realNow
  ok('同一毫秒重开的两条路 recordingId 不同', pinnedA.recordingId !== pinnedB.recordingId)
  ok('同一毫秒重开的两条路文件名不同', pinnedA.fileName !== pinnedB.fileName)
  await s.finish()
}

// —— 3. 定稿不幂等 + 收尾合并 = 那份坏件；两侧各自拦住 ——
{
  stub.resetStub()
  recorderLog.length = 0
  const s = new TrackRecorderSession({ t0: Date.now(), userName: '陈芳', meetingNo: '14969610', title: '测试' })
  const a = s.open('self-camera', srcOf('camera'))
  const recA = recorderLog[recorderLog.length - 1]
  recA.emitChunk('a0')
  recA.emitChunk('a1')
  recA.emitChunk('a2')
  // 浏览器先把编码器自己停了（源轨结束就是这样）：onstop → 清单定稿
  recA.selfStop()
  // 随后应用侧那两条监听/对账路径才关到这一路：这条**不许**再定第二次
  s.close('self-camera', 'track_disabled')
  const b = s.open('self-camera', srcOf('camera'))
  const recB = recorderLog[recorderLog.length - 1]
  recB.emitChunk('b0')
  recB.emitChunk('b1')
  await s.finish()

  eq('库里没有 blobKey 被覆盖过', stub.overwrites(), 0)
  const meta = stub.registered.at(-1) as { tracks: Array<{ recordingId: string; fileName: string; segments: unknown[] }> }
  const ids = meta.tracks.map((t) => t.recordingId)
  eq('清单里是两条路（不是被并成一条）', meta.tracks.length, 2)
  ok('两条路各自有独立的 recordingId', ids[0] !== ids[1])
  eq('第一条路的片数', meta.tracks[0].segments.length, 3)
  // 第二条路是 3 片不是 2 片：收尾那次 `stop()` 会先吐末片再 `onstop` —— 这是本用例 FakeRecorder
  // 自己写明（第 40 行）的浏览器语义。把它当 2 片去断言，等于断言"末片该被丢掉"，
  // 而丢掉末片就是每条录制少最后 2 秒内容。
  eq('第二条路的片数（含 stop() 吐出的末片）', meta.tracks[1].segments.length, 3)
  ok('第二条路的片全部是自己的 blobKey（没有串进第一条的键空间）',
    (meta.tracks[1].segments as Array<{ blobKey: string }>).every((s) => s.blobKey.startsWith(meta.tracks[1].recordingId)),
    (meta.tracks[1].segments as Array<{ blobKey: string }>).map((s) => s.blobKey).join(','))
  ok('每一条路都是单一容器（没有 seq_restart/duplicate）',
    meta.tracks.every((t) => laneAnomalies(t.segments as never[]).length === 0),
    meta.tracks.map((t) => laneAnomalies(t.segments as never[]).join('|')).join(' / '))
  // 落盘计数只看路文件：会话清单 `manifest.json` 走的是同一个 `writeRecordingAt` 出口，
  // 把它一起数就会得到 3 —— 那是桩的记账口径，不是"多写了一份视频"。
  const trackWrites = stub.diskWrites.filter((w) => w.fileName.endsWith('.webm'))
  eq('落盘写了两个路文件', trackWrites.length, 2)
  eq('两个路文件的名字不同', new Set(trackWrites.map((w) => w.fileName)).size, 2)
  ok('清单也落了一次盘（与路文件同一出口，分开数）',
    stub.diskWrites.filter((w) => w.fileName === 'manifest.json').length === 1)
  ok('定稿只跑了一次（第二次 close 没再推同一份清单）',
    trackWrites.filter((w) => w.fileName === meta.tracks[0].fileName).length === 1)
}

// —— 3b. 定稿之后**还在飞的末片**：不许追加进已定稿的清单 ——
// 这条是被真件形状逼出来的：`finalizeClosed` 会把编码器的回调摘掉，所以下一个 timeslice
// 不会再进来；但**已经派发出去的那一次**（回调引用还在调用方手里）仍会落到 onChunk。
// 追加的后果是清单里有片而库里没有、`endOffsetSec` 与实际字节不一致 ⇒ 拼出来的文件缺尾。
{
  stub.resetStub()
  recorderLog.length = 0
  const s = new TrackRecorderSession({ t0: Date.now(), userName: '陈芳', meetingNo: '14969610', title: '测试' })
  const a = s.open('self-camera', srcOf('camera'))
  const recA = recorderLog[recorderLog.length - 1]
  recA.emitChunk('a0')
  // 先取走回调引用（模拟浏览器已经派发了这一次 dataavailable），随后这一路自己定稿
  const inFlight = recA.ondataavailable!
  recA.selfStop()
  inFlight.call(recA, { data: new Blob(['late']) })
  await new Promise((r) => setTimeout(r, 0))
  await s.finish()
  const meta = stub.registered.at(-1) as { tracks: Array<{ recordingId: string; segments: unknown[]; endOffsetSec: number }> }
  eq('定稿后的在飞末片被丢弃，这一路仍是 1 片', meta.tracks[0].segments.length, 1)
  ok('库里没有因为追加而多出一片', stub.segmentRecords.length === 1, String(stub.segmentRecords.length))
  ok('清单里没有 blobKey 指向库里没有的字节',
    (meta.tracks[0].segments as Array<{ blobKey: string }>).every((seg) => stub.blobs.has(seg.blobKey)),
    (meta.tracks[0].segments as Array<{ blobKey: string }>).map((x) => x.blobKey).join(','))
}

// —— 3c. 配额耗尽：播报一次就够，但失败的分片不许留在清单里 ——
// 口径 §八之一 2：写不进去不是"这一片丢了"，是这一场从此写不进去 —— 静默继续录就等于
// 给用户一个"看着完整、缺一半"的条目。
{
  stub.resetStub()
  recorderLog.length = 0
  let fired = 0
  const s = new TrackRecorderSession({
    t0: Date.now(), userName: '陈芳', meetingNo: '14969610', title: '测试',
    onQuotaExhausted: () => { fired++ },
  })
  const a = s.open('self-camera', srcOf('camera'))
  const recA = recorderLog[recorderLog.length - 1]
  stub.failNextWrites(3)
  recA.emitChunk('q0')
  recA.emitChunk('q1')
  recA.emitChunk('q2')
  recA.emitChunk('q3')
  await s.finish()
  eq('配额耗尽只播报一次（连着三条失败也只播一次）', fired, 1)
  // 清单里 2 片而不是 1 片：q0..q2 被配额打回，q3 与收尾 `stop()` 吐的末片写成功了
  // （`failNextWrites(3)` 只吃掉前三次）。少算末片那次就是这个用例上一版的错法。
  eq('写失败的分片不留在清单里', a.segments.length, 2)
  eq('清单里的每一片库里都有字节', stub.segmentRecords.length, 2)
}

// —— 4. 读取侧：损坏那一路不交出文件，也不许说成"读不到字节" ——
{
  const damagedTrack = {
    recordingId: 'self-camera-munziih0',
    ownerId: 'self', ownerName: '陈芳', kind: 'camera', mediaLabel: '本机摄像头',
    hasVideo: true, hasAudio: false, startOffsetSec: 0, endOffsetSec: null, closedAtMs: null,
    closeReason: 'track_disabled', mime: 'video/webm;codecs=vp9', fileName: '陈芳-camera.webm',
    segments: observedSlices().map((s) => ({ ...s, mime: 'video/webm;codecs=vp9' })),
  }
  ok('坏件那一路判成损坏', trackIsDamaged(damagedTrack))
  const assembled = await assembleTrackBlob(damagedTrack as never)
  ok('坏件不拼成一份文件', assembled === null, String(assembled?.size))
  const cleanTrack = {
    ...damagedTrack,
    segments: cleanSlices(4).map((s) => ({ ...s, mime: 'video/webm' })),
  }
  ok('好件不判成损坏', !trackIsDamaged(cleanTrack))
  for (const s of cleanSlices(4)) await stub.putSegmentWithRecord({ blobKey: s.blobKey, trackId: 'ok', seq: s.seq, offsetSec: s.offsetSec, durationSec: s.durationSec, sizeBytes: s.sizeBytes, mime: 'video/webm' }, new Blob(['x'.repeat(10)]))
  const good = await assembleTrackBlob(cleanTrack as never)
  ok('好件仍能拼出文件', !!good && good.size > 0)

  const note = describeTrackDownload({ ok: 0, failed: 0, damaged: 2 })
  eq('全是坏件时的语气', note.tone, 'error')
  ok('说的是"坏"而不是"读不到"', note.text.includes('坏') && !note.text.includes('不可读取'), note.text)
  const mixed = describeTrackDownload({ ok: 3, failed: 1, damaged: 2 })
  eq('部分坏时的语气', mixed.tone, 'warning')
  ok('两种损失分开说', mixed.text.includes('2 路的原片是坏的') && mixed.text.includes('1 路的分片已不可读取'), mixed.text)
  eq('一路都好且只有一路时不弹', describeTrackDownload({ ok: 1, failed: 0, damaged: 0 }).text, '')

  // 整场下载：坏的那一路不参与，也不会被拼出来
  stub.resetStub()
  // resetStub 把上一段放进去的分片字节也清了；这里不重放的话，那一路好件会因为"读不到字节"
  // 落进 failed，于是这条断言测的就成了桩的空库状态，而不是"坏/失败分开算"这件真正要钉的事。
  for (const s of cleanSlices(4)) await stub.putSegmentWithRecord({ blobKey: s.blobKey, trackId: 'ok', seq: s.seq, offsetSec: s.offsetSec, durationSec: s.durationSec, sizeBytes: s.sizeBytes, mime: 'video/webm' }, new Blob(['x'.repeat(10)]))
  const res = await downloadLocalRecordingTracks({ tracks: [damagedTrack, cleanTrack] } as never)
  eq('坏件算进 damaged 而不是 failed', `${res.ok}/${res.failed}/${res.damaged}`, '1/0/1')
}

// —— 5. 回放的读取侧：坏件不再被当成一整块可播区 ——
{
  const mk = (segments: Array<{ seq: number; blobKey: string; offsetSec: number; durationSec: number; sizeBytes: number }>, id: string) => ({
    recordingId: id, ownerId: 'self', ownerName: '陈芳', kind: 'camera', mediaLabel: '本机摄像头',
    hasVideo: true, hasAudio: false, startOffsetSec: 0, endOffsetSec: 100, closedAtMs: 1, closeReason: 'track_disabled',
    mime: 'video/webm', fileName: `${id}.webm`, segments: segments.map((s) => ({ ...s, mime: 'video/webm' })),
  })
  const build = (id: string, segments: never[]) => new ReplayEngine({
    tracks: groupTracksByLane([mk(segments as never, id)] as never),
    durationSec: 130,
    startAtMs: Date.now(),
    resolveUrl: async () => '',
    assembleRuns: true,
  })
  const badRow = build('self-camera-munziih0', observedSlices() as never).rows[0]
  ok('坏件那一路在回放里标成损坏', badRow.damaged === true)
  ok('坏件不再是一整块可播区', badRow.spans.length > 1, String(badRow.spans.length))
  ok('每个可播区内部片号单调', badRow.spans.every((sp) => sp.segments.every((x, i) => i === 0 || x.seq > sp.segments[i - 1]!.seq)))
  const goodRow = build('ok-lane', cleanSlices(40) as never).rows[0]
  eq('好件不标损坏', goodRow.damaged, false)
  eq('好件仍并成一块可播区', goodRow.spans.length, 1)
}

// —— 6. 真夹具：盘上那 23 场 / 51 路，只该抓到已知那两条 ——
{
  const ROOT = 'C:/Users/zhengqi/Videos/hxt'
  if (!existsSync(ROOT)) {
    console.log('（跳过真夹具：盘上没有', ROOT, '）')
  } else {
    const files: string[] = []
    const walk = (d: string, depth: number) => {
      if (depth > 5) return
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p, depth + 1)
        else if (e.name === 'manifest.json') files.push(p)
      }
    }
    walk(ROOT, 0)
    let lanes = 0
    const flagged: string[] = []
    for (const f of files) {
      const j = JSON.parse(readFileSync(f, 'utf8'))
      for (const s of j.streams || []) {
        if (!(s.segments || []).length) continue
        lanes++
        // 走**真解析出口**：清单里那个 `#segment=N` 是唯一现场证据，别在测试里再拼一遍
        const segs = trackSegmentsFromManifest(s)
        if (laneIsDamaged(segs as never)) flagged.push(`${f}#${s.fileName}:${laneAnomalies(segs as never).join('|')}`)
      }
    }
    ok('盘上有清单可看', lanes > 0, String(lanes))
    eq('盘上被判损坏的路数（只剩已知那两条）', flagged.length, 2)
    ok('判到的两条都在 20260930185052 那一场', flagged.every((x) => x.includes('20260930185052')), flagged.join(' '))
    ok('其余 49 条好路一条没被误伤', flagged.every((x) => x.includes('14969610')))
  }
}

if (ran < 30) {
  console.error(`用例自证失败：只跑了 ${ran} 条（判据没覆盖到被测形状）`)
  process.exit(2)
}
if (fails.length) {
  console.error(`✗ ${fails.length} 条失败（共 ${ran}）:`)
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log(`✓ 并写护栏 + 跨容器不拼接 全绿：${ran} 条断言`)
