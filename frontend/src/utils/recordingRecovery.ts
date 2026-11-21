// 崩溃自愈（工作 A 的行为改变就在这里，存储层只是地基）。
//
// 治的是这个形态：分片每 2 秒一片落在本机库里，但清单只在 `finish()` 里登记一次 ——
// 录制中途崩溃或直接关标签页，库里字节全在、列表里一条都没有，那些字节从此再没有入口能读到。
// schema 3 起开录写会话头、每片写一条片级记录，于是"这场录制存在过"有了可被查到的证据：
// 下次进页面时扫 `open` 且心跳过期的会话头，按其中的 trackIds 白名单逐片回验字节，重建出一条条目。
//
// 两条不许违背的判据（推导见 contracts/api-contract.md ADR-0068）：
// 1. **只认白名单，不猜键前缀** —— recordingId 是时间基的 base36，字符串前缀会撞上别的录制，
//    猜就会把别人的分片拼进这一场。
// 2. **逐片真取到字节才算数** —— onChunk 写失败时会从清单里摘掉该片，若 segments 有记录而 blobs 没字节，
//    重建出的清单就指向不存在的键，回放永久卡在「正在加载此路」。
import {
  addLocalRecording,
  getLocalRecording,
  getSegmentBlob,
  listCrashedSessions,
  listSegmentRecords,
  putSession,
  SESSION_STALE_MS,
  type LocalRecording,
  type RecordedTrack,
  type RecordingSession,
  type TrackSegment,
} from '@/utils/localRecorder'
import { businessDirStamp } from '@/utils/time'

/** 崩溃那场必然缺"最后一片之后"的那段，界面上要能看出来这是不完整的 */
function recoveredFileName(meetingNo: string, startedAt: number): string {
  return `recording-${meetingNo || 'meeting'}-${businessDirStamp(startedAt)}`
}

/**
 * 按会话头的白名单把一路的分片重建出来。
 * 终值只到**最后一片实测到的末尾**：崩溃之后那段没有任何证据，不许拿墙钟或"重启此刻"补成"录到了"。
 */
async function buildTrack(
  trackId: string,
  head: Omit<RecordedTrack, 'segments'>,
): Promise<RecordedTrack | null> {
  const segments: TrackSegment[] = []
  for (const rec of await listSegmentRecords(trackId)) {
    const blob = await getSegmentBlob(rec.blobKey)
    if (!blob) {
      console.warn('[recordingRecovery] 该分片在库里取不到字节，重建时跳过', rec.blobKey)
      continue
    }
    segments.push({
      seq: rec.seq,
      offsetSec: rec.offsetSec,
      durationSec: rec.durationSec,
      sizeBytes: rec.sizeBytes,
      blobKey: rec.blobKey,
      mime: rec.mime,
    })
  }
  if (!segments.length) return null
  const last = segments[segments.length - 1]
  return {
    ...head,
    segments,
    endOffsetSec: Math.round((last.offsetSec + last.durationSec) * 1000) / 1000,
    // 关闭时刻只有"这一路当时真的干净收过尾"才有实测值；崩溃的那一路没有，留 null 而不是填重建时刻
    closedAtMs: head.closedAtMs,
    closeReason: head.closeReason || 'leave_page',
  }
}

/**
 * 把一条崩溃遗留的会话头重建成本机录制条目；没有可用分片就只把会话头关掉（不留空条目）。
 * id 沿用会话头的，因此与 `removeLocalRecording` 的连带清理、与"同一条录制只登记一次"都对得上。
 */
export async function rebuildRecoveredRecording(session: RecordingSession): Promise<LocalRecording | null> {
  if (await getLocalRecording(session.id)) {
    // 已经有条目了（上次重建过，或那次 `finish()` 其实登记成功了只是没来得及置 open）：只关会话头
    await putSession({ ...session, open: false })
    return null
  }
  const tracks: RecordedTrack[] = []
  for (const [trackId, head] of Object.entries(session.tracks)) {
    const track = await buildTrack(trackId, head)
    if (track) tracks.push(track)
  }
  if (!tracks.length) {
    console.warn('[recordingRecovery] 该会话没有可用分片，按无内容收掉', session.id)
    await putSession({ ...session, open: false })
    return null
  }
  tracks.sort((a, b) => a.startOffsetSec - b.startOffsetSec)
  const ends = tracks.flatMap((t) => t.segments.map((s) => s.offsetSec + s.durationSec))
  const spanSec = Math.max(...ends) - Math.min(...tracks.map((t) => t.startOffsetSec))
  const meta: LocalRecording = {
    id: session.id,
    title: session.title,
    meetingNo: session.meetingNo,
    fileName: recoveredFileName(session.meetingNo, session.t0),
    startedAt: session.t0,
    durationSec: Math.max(1, Math.round(spanSec)),
    sizeBytes: tracks.reduce((a, t) => a + t.segments.reduce((x, s) => x + s.sizeBytes, 0), 0),
    schema: 2,
    tracks,
    dirPath: null,
    dirHandle: false,
    partial: true,
    // 会话头带着"谁按的开始"，重建出来的条目就继承它 —— 不继承的话这条会在列表里
    // 归到"无法判定归属"那一批，用户明明能看见它是自己那场，却被告知判不出来
    recorderAccount: session.recorderAccount,
  }
  await addLocalRecording(meta)
  await putSession({ ...session, open: false })
  console.info('[recordingRecovery] 已重建未正常结束的录制', meta.id, `${tracks.length} 路`, `${Math.round(spanSec)}s`)
  return meta
}

/**
 * 扫一遍崩溃会话并重建。每次页面加载只跑一遍（列表页与主框架共享同一条在途 Promise），
 * 且整体不抛错：库里读不动时最多是"这次没恢复出来"，不该把页面卡在加载态。
 */
let run: Promise<LocalRecording[]> | null = null

export function ensureRecordingsRecovered(): Promise<LocalRecording[]> {
  if (!run) {
    run = listCrashedSessions(SESSION_STALE_MS)
      .then(async (sessions) => {
        const out: LocalRecording[] = []
        for (const s of sessions) {
          try {
            const meta = await rebuildRecoveredRecording(s)
            if (meta) out.push(meta)
          } catch (e) {
            // 一条重建失败既不带走别的，也不把会话头置成已关 —— 下次进页面还有机会
            console.warn('[recordingRecovery] 重建失败，本场保持待恢复', s.id, e)
          }
        }
        return out
      })
      .catch((e) => {
        console.warn('[recordingRecovery] 崩溃会话扫描没跑成', e)
        return [] as LocalRecording[]
      })
  }
  return run
}
