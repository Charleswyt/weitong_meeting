import { sitePath } from '@/utils/sitePath'
import type { MeetingVo } from '@/api/meeting'
import { businessClock, businessDayKey } from '@/utils/time'

// 入会只有一个入口：过渡页。它只确认这场会能加入，然后直接进入。
// 摄像头、麦克风、扬声器、虚拟背景、人脸增强都用已保存的设置，不在进会前再问一遍。
//
// 本系统有预约单的会按 id 进（过渡页能拿到会议主题），只在三方存在的会（手机/板卡发起）
// 库里没有单，按 id 查详情必然失败，只能按会议号进 —— 这个判别用后端给的 managed 标记，
// 不在前端复刻后端的会话键规则。
export function preJoinPath(m: Pick<MeetingVo, 'id' | 'meetingNo' | 'managed'>): string {
  return m.managed ? `/meeting/pre/${m.id}` : `/meeting/pre/no/${m.meetingNo}`
}

// 按用户手输的会议号进过渡页：这条路上不知道该会的归属，统一按会议号走。
// micOn / cameraOn / autoAudio / name 由加入弹层带上。
export function preJoinPathByNumber(
  meetingNo: string,
  opts: { micOn?: boolean; cameraOn?: boolean; autoAudio?: boolean; name?: string } = {},
): string {
  const no = encodeURIComponent(meetingNo.replace(/\s/g, ''))
  const q = new URLSearchParams()
  if (opts.micOn !== undefined) q.set('micOn', opts.micOn ? '1' : '0')
  if (opts.cameraOn !== undefined) q.set('cameraOn', opts.cameraOn ? '1' : '0')
  if (opts.autoAudio !== undefined) q.set('autoAudio', opts.autoAudio ? '1' : '0')
  if (opts.name) q.set('name', opts.name.slice(0, 32))
  const qs = q.toString()
  return qs ? `/meeting/pre/no/${no}?${qs}` : `/meeting/pre/no/${no}`
}

const SHARE_ORIGIN_KEY = 'conference.shareOrigin'

/** 本机回环：微信/他机打不开，分享链接必须换成局域网 IP。 */
export function isLoopbackHost(host = typeof location !== 'undefined' ? location.hostname : ''): boolean {
  const h = String(host || '').toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
}

function isPrivateIpv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return false
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/** 分享优先 Wi‑Fi/有线常见段：192.168 > 10 > 172（后者常是 Hyper-V/WSL 虚口，手机到不了）。 */
function lanIpRank(ip: string): number {
  const m = /^(\d{1,3})\.(\d{1,3})\./.exec(ip)
  if (!m) return 99
  const a = Number(m[1])
  const b = Number(m[2])
  if (a === 192 && b === 168) return 0
  if (a === 10) return 1
  if (a === 172 && b >= 16 && b <= 31) return 2
  return 9
}

/** WebRTC host 候选取本机局域网 IPv4（不连 STUN，不外泄到公网）。 */
function probeLanIpv4(): Promise<string> {
  return new Promise((resolve) => {
    if (typeof RTCPeerConnection === 'undefined') {
      resolve('')
      return
    }
    let settled = false
    const done = (ip: string) => {
      if (settled) return
      settled = true
      try {
        pc.close()
      } catch {
        /* ignore */
      }
      resolve(ip)
    }
    const pc = new RTCPeerConnection({ iceServers: [] })
    try {
      pc.createDataChannel('share-origin')
    } catch {
      /* ignore */
    }
    const found: string[] = []
    pc.onicecandidate = (ev) => {
      const line = ev.candidate?.candidate || ''
      const m = /(?:candidate:\S+\s+\d+\s+\S+\s+\d+\s+)([0-9]{1,3}(?:\.[0-9]{1,3}){3})\s/i.exec(line)
        || /\b([0-9]{1,3}(?:\.[0-9]{1,3}){3})\b/.exec(line)
      if (!m) {
        if (!ev.candidate && found.length) done(pickBestLanIp(found))
        return
      }
      const ip = m[1]
      if (ip.startsWith('127.') || ip.startsWith('0.')) return
      found.push(ip)
      // 不立刻 settle：多网卡时先收齐，再按优先级挑，避免抢到 Hyper-V 的 172.x。
    }
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => done(''))
    window.setTimeout(() => done(pickBestLanIp(found)), 1200)
  })
}

function pickBestLanIp(ips: string[]): string {
  const uniq = [...new Set(ips)].filter((ip) => isPrivateIpv4(ip) || !ip.startsWith('127.'))
  if (!uniq.length) return ''
  return [...uniq].sort((a, b) => lanIpRank(a) - lanIpRank(b))[0] || ''
}

/** 邀请/分享一律 https：手机麦克风与剪贴板都要安全上下文；dev 由 basicSsl 提供。 */
function httpsOrigin(host: string, port = typeof location !== 'undefined' ? location.port : ''): string {
  const p = port ? `:${port}` : ''
  return `https://${host}${p}`
}

function originWithHost(host: string): string {
  return httpsOrigin(host)
}

/**
 * 分享用 origin：地址栏已是 IP/域名时用其 host 拼 https；若是 localhost 则用已探测到的局域网 IP。
 * 探测未完成时仍可能短暂落到 localhost —— 调用方应先 `await ensureShareOrigin()`。
 */
export function shareOrigin(): string {
  if (typeof location === 'undefined') return ''
  if (!isLoopbackHost()) return httpsOrigin(location.hostname, location.port)
  try {
    const cached = sessionStorage.getItem(SHARE_ORIGIN_KEY)
    if (cached) {
      const u = new URL(cached)
      if (u.protocol === 'https:' && !isLoopbackHost(u.hostname)) return u.origin
    }
  } catch {
    /* ignore */
  }
  return httpsOrigin(location.hostname, location.port)
}

/** 回环访问时探测并缓存局域网 origin；非回环直接返回可分享的 https origin。 */
export async function ensureShareOrigin(): Promise<string> {
  if (typeof location === 'undefined') return ''
  if (!isLoopbackHost()) return shareOrigin()
  // 每次邀请前重探：多网卡时旧缓存可能是 Hyper-V 的 172.x，手机同 Wi‑Fi 也打不开。
  const ip = await probeLanIpv4()
  if (!ip) return shareOrigin()
  const origin = originWithHost(ip)
  try {
    sessionStorage.setItem(SHARE_ORIGIN_KEY, origin)
  } catch {
    /* private mode */
  }
  return origin
}

// 分享/邀请用的入会链接 = 可被他机打开的前端地址 + 按会议号的预检入口。
// 会议号嵌在路径里（/meeting/pre/no/{no}），邀请正文不再单独展示会议号行；
// 粘贴回系统时仍从路径解析（见 parseMeetingNoFromText）。
export function joinUrlFor(meetingNo: string): string {
  if (!meetingNo) return ''
  return `${shareOrigin()}${sitePath(preJoinPathByNumber(meetingNo))}`
}

/** 邀请文案里的会议号：三位一组、短横线分隔（旧粘贴兼容 / 系统内展示仍可用）。 */
export function formatInviteMeetingNo(meetingNo: string): string {
  const digits = String(meetingNo ?? '').replace(/\D/g, '')
  if (!digits) return ''
  return digits.replace(/(\d{3})(?=\d)/g, '$1-')
}

/** 邀请文案里的时段：`2026/11/12 16:30-17:30 (GMT+08:00) 中国标准时间 - 北京` */
export function formatInviteTimeRange(startTime?: string, durationMinutes?: number): string {
  if (!startTime) return ''
  const start = new Date(startTime)
  if (Number.isNaN(start.getTime())) return ''
  const mins = durationMinutes && durationMinutes > 0 ? durationMinutes : 60
  const end = new Date(start.getTime() + mins * 60_000)
  const day = businessDayKey(start).replace(/-/g, '/')
  const from = businessClock(start)
  const to = businessClock(end)
  if (!day || !from || !to) return ''
  return `${day} ${from}-${to} (GMT+08:00) 中国标准时间 - 北京`
}

export type InviteFields = {
  hostName?: string
  title?: string
  meetingNo: string
  startTime?: string
  durationMinutes?: number
}

/**
 * 可转发邀请全文：入会靠链接路径里的会议号识别，正文不再单列「#会议号」
 * （微信里会议号无法跳转；系统内粘贴仍从 `/meeting/pre/no/{no}` 解析）。
 */
export function inviteTextFor(f: InviteFields): string {
  const no = String(f.meetingNo || '').replace(/\D/g, '')
  if (!no) return ''
  const host = (f.hostName || '').trim() || '主持人'
  const title = (f.title || '').trim() || '会议'
  const link = joinUrlFor(no)
  const lines = [`${host} 请您参加卫通会议`, `会议主题：${title}`]
  const timeLine = formatInviteTimeRange(f.startTime, f.durationMinutes)
  if (timeLine) lines.push(`会议时间：${timeLine}`)
  lines.push('', '点击链接入会，或添加至会议列表：', link, '', '复制该信息，打开卫通会议即可参与')
  return lines.join('\n')
}

/**
 * 从粘贴的邀请全文 / 入会链接 / 纯会议号里抽出 6–12 位会议号。
 * 优先认路径 `/meeting/pre/no/{no}`（现行邀请正文只带链接），
 * 其次兼容旧文案 `#会议号：` / `会议号：`，避免误吃主题里的数字。
 */
export function parseMeetingNoFromText(text: string): string {
  const raw = String(text ?? '').trim()
  if (!raw) return ''

  const fromPath = raw.match(/\/meeting\/pre\/no\/(\d{6,12})\b/)
  if (fromPath) return fromPath[1]

  const labeled = raw.match(/#?\s*会议号\s*[:：]\s*([0-9][0-9\-\s]{4,20}[0-9])/)
  if (labeled) {
    const digits = labeled[1].replace(/\D/g, '')
    if (digits.length >= 6 && digits.length <= 12) return digits
  }

  const compact = raw.replace(/[\s\-]/g, '')
  if (/^\d{6,12}$/.test(compact) && /^[\d\s\-]+$/.test(raw)) return compact

  return ''
}

/** 输入框展示用：三位一组空格（加入会议弹层沿用）。 */
export function formatJoinInputMeetingNo(meetingNo: string): string {
  const digits = String(meetingNo ?? '').replace(/\D/g, '').slice(0, 12)
  return digits.replace(/(\d{3})(?=\d)/g, '$1 ')
}

/** 一键复制会议邀请全文（含标题、预约时间、入会链接），不依赖先进入会议。 */
export async function copyMeetingInvite(f: InviteFields): Promise<boolean> {
  await ensureShareOrigin()
  const text = inviteTextFor(f)
  if (!text) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

// 快速会议的旧地址。新的「开始会议」先建会、再按会议号进入，刷新不会再开一场。
// 查询参数都可选：缺了就用已保存的设置和账号显示名。
export function quickJoinPath(input: {
  title?: string
  cloudRecord?: boolean
  micOn?: boolean
  cameraOn?: boolean
  displayName?: string
} = {}): string {
  const q = new URLSearchParams({ quick: '1' })
  if (input.title) q.set('title', input.title)
  if (input.cloudRecord !== undefined) q.set('cloudRecord', input.cloudRecord ? '1' : '0')
  if (input.micOn !== undefined) q.set('micOn', input.micOn ? '1' : '0')
  if (input.cameraOn !== undefined) q.set('cameraOn', input.cameraOn ? '1' : '0')
  if (input.displayName) q.set('name', input.displayName)
  return `/meeting/pre/quick?${q.toString()}`
}
