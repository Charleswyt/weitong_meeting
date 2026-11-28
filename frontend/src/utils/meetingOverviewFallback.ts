import {
  getMeetingList,
  type MeetingOverviewExtremeItem,
  type MeetingOverviewStats,
  type MeetingVo,
  type StatsDimension,
} from '@/api/meeting'

/**
 * 仅在远端云服务尚未部署 `/api/v1/meetings/overview` 接口时的只读降级兼容。
 * 一旦后端已发布 `/api/v1/meetings/overview`，不会执行此逻辑。
 */
export async function fetchOverviewFallbackFromList(
  dimension: StatsDimension,
  now = new Date(),
): Promise<MeetingOverviewStats> {
  const res = await getMeetingList({ pageNum: 1, pageSize: 500 })
  const rows: MeetingVo[] = Array.isArray(res.rows) ? res.rows : []
  return buildOverviewFromRows(rows, dimension, now)
}

function getWindowRange(dimension: StatsDimension, now: Date): [number, number] {
  if (dimension === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0).getTime()
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0).getTime() - 1000
    return [start, end]
  }
  if (dimension === 'week') {
    const wd = now.getDay() === 0 ? 7 : now.getDay()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (wd - 1), 0, 0, 0, 0).getTime()
    const end = start + 7 * 86400000 - 1000
    return [start, end]
  }
  return [0, 0]
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function fmtDateTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function fmtHM(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

function containsAny(s: string, keywords: string[]): boolean {
  return keywords.some((k) => s.includes(k))
}

function classifyForm(title: string): 'online' | 'offline' | 'hybrid' {
  const t = title.toLowerCase()
  if (containsAny(t, ['线上线下', '融合', '混合', '联动', '会场+线上'])) return 'hybrid'
  if (containsAny(t, ['线下', '现场会', '实地', '座谈']) && !containsAny(t, ['线上', '视频', '远程'])) return 'offline'
  return 'online'
}

function isEdgeTitle(title: string): boolean {
  return containsAny(title.toLowerCase(), ['边缘', '边端', '卫星', '卫通', '板卡', '车载', '便携', '前指', '外场', 'edge'])
}

function classifyCategory(title: string): string {
  const t = title.toLowerCase()
  if (containsAny(t, ['评审', '验收', '立项', '复盘'])) return '评审会'
  if (containsAny(t, ['保障', '值守', '应急', '演练', '巡检'])) return '保障会'
  if (containsAny(t, ['调试', '联调', '对接', '排查', '测试', '排障'])) return '调试对接'
  if (containsAny(t, ['技术', '交流', '研讨', '方案', '架构', '培训', '宣贯'])) return '技术交流'
  if (containsAny(t, ['例会', '周会', '晨会', '月会', '同步', '汇报'])) return '例会同步'
  return '日常会议'
}

function buildOverviewFromRows(
  rows: MeetingVo[],
  dimension: StatsDimension,
  now: Date,
): MeetingOverviewStats {
  const [winStart, winEnd] = getWindowRange(dimension, now)

  let total = 0
  let hosted = 0
  let participated = 0
  let online = 0
  let offline = 0
  let hybrid = 0
  let scheduled = 0
  let quick = 0
  let voice = 0
  const activeDaySet = new Set<string>()

  let totalSeconds = 0
  let hostedSeconds = 0
  let participatedSeconds = 0
  let recordingSeconds = 0
  let recordingCount = 0

  let meetingCount = 0
  const meetingDur = { totalSeconds: 0, hostedSeconds: 0, participatedSeconds: 0, averageSeconds: 0, recordingSeconds: 0 }
  let voiceCount = 0
  const voiceDur = { totalSeconds: 0, hostedSeconds: 0, participatedSeconds: 0, averageSeconds: 0, recordingSeconds: 0 }

  let earliest: MeetingOverviewExtremeItem | null = null
  let earliestMs = Number.MAX_SAFE_INTEGER
  let longest: MeetingOverviewExtremeItem | null = null
  let longestSec = -1
  let longestMs = 0
  let latest: MeetingOverviewExtremeItem | null = null
  let latestMs = -1

  let edgeCount = 0
  let cloudCount = 0
  const catMap = new Map<string, number>()

  for (const m of rows) {
    if (m.status === 'cancelled' || m.status === 'failed') continue
    const startMs = m.startTime ? new Date(m.startTime).getTime() : NaN
    if (winStart > 0 && (!Number.isFinite(startMs) || startMs < winStart || startMs > winEnd)) {
      continue
    }

    total++
    if (m.isHost) hosted++
    else participated++

    const title = (m.title || '').trim() || '未命名会议'
    const form = classifyForm(title)
    if (form === 'hybrid') hybrid++
    else if (form === 'offline') offline++
    else online++

    const durSec = Math.max(0, Math.round(Number(m.durationMinutes) || 0)) * 60
    totalSeconds += durSec
    if (m.isHost) hostedSeconds += durSec
    else participatedSeconds += durSec

    const kind = (m as MeetingVo & { kind?: string; launchKind?: string }).kind || (m as MeetingVo & { launchKind?: string }).launchKind
    const isVoice = kind === 'voice' || containsAny(title.toLowerCase(), ['语音', '对讲', '音频通话'])
    if (isVoice) voice++
    else if (kind === 'scheduled') scheduled++
    else quick++
    if (Number.isFinite(startMs) && startMs > 0) {
      const d = new Date(startMs)
      activeDaySet.add(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`)
    }
    const bucket = isVoice ? voiceDur : meetingDur
    if (isVoice) voiceCount++
    else meetingCount++
    bucket.totalSeconds += durSec
    if (m.isHost) bucket.hostedSeconds += durSec
    else bucket.participatedSeconds += durSec

    if (m.cloudRecord) {
      recordingCount++
      recordingSeconds += durSec
      bucket.recordingSeconds += durSec
    }

    if (Number.isFinite(startMs) && startMs > 0) {
      const hostName = (m.creatorName || m.hostName || '').trim()
      const item: MeetingOverviewExtremeItem = {
        id: Number(m.id) || 0,
        title,
        hostName,
        meetingNo: m.meetingNo || '',
        startTime: fmtDateTime(startMs),
        endTime: fmtHM(startMs + durSec * 1000),
        durationSeconds: durSec,
      }
      if (startMs < earliestMs) {
        earliestMs = startMs
        earliest = item
      }
      if (startMs > latestMs) {
        latestMs = startMs
        latest = item
      }
      if (durSec > longestSec || (durSec === longestSec && startMs > longestMs)) {
        longestSec = durSec
        longestMs = startMs
        longest = item
      }
    }

    if (isEdgeTitle(title)) edgeCount++
    else cloudCount++
    const cat = classifyCategory(title)
    catMap.set(cat, (catMap.get(cat) ?? 0) + 1)
  }

  const averageSeconds = total > 0 ? Math.round(totalSeconds / total) : 0
  const coverageRate = total > 0 ? Math.round((recordingCount * 1000) / total) / 10 : 0
  meetingDur.averageSeconds = meetingCount > 0 ? Math.round(meetingDur.totalSeconds / meetingCount) : 0
  voiceDur.averageSeconds = voiceCount > 0 ? Math.round(voiceDur.totalSeconds / voiceCount) : 0

  const categories = [...catMap.entries()]
    .map(([label, count]) => ({ key: label, label, count }))
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.label.localeCompare(b.label)))

  return {
    dimension,
    volume: {
      total,
      hosted,
      participated,
      online,
      offline,
      hybrid,
      scheduled,
      quick,
      voice,
      activeDays: activeDaySet.size,
    },
    duration: {
      totalSeconds,
      hostedSeconds,
      participatedSeconds,
      averageSeconds,
      recordingSeconds,
    },
    durationByKind: {
      meeting: meetingDur,
      voice: voiceDur,
    },
    recording: { count: recordingCount, coverageRate },
    extremes: { earliest, longest, latest },
    tags: {
      accessModes: [
        { key: 'edge', label: '边缘入会', count: edgeCount },
        { key: 'cloud', label: '云端入会', count: cloudCount },
      ],
      categories,
    },
  }
}
