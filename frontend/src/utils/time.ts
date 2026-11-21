// 会议时间是"船/岸业务时区"的墙钟，不是浏览器系统时区的墙钟：
// 线格式每条都带显式偏移（见 contracts/api-contract.md），所以这里固定按业务时区渲染，
// 客户端系统时区是 UTC 时也不会把 09:30 的会显示成 01:30。
export const BUSINESS_TIME_ZONE = 'Asia/Shanghai'

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

// 按业务时区拆出"墙上时间"，不读浏览器系统时区。
// sv-SE 这个 locale 的输出就是 "YYYY-MM-DD HH:mm:ss"，是 Intl 指定时区格式化最稳的一种。
function wallParts(value: string | number | Date): { date: string; hh: string; mm: string; ss: string } | null {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return null
  const [date, time = ''] = d.toLocaleString('sv-SE', { timeZone: BUSINESS_TIME_ZONE }).split(' ')
  return { date, hh: time.slice(0, 2), mm: time.slice(3, 5), ss: time.slice(6, 8) }
}

export function businessClock(value: string | number | Date): string {
  const p = wallParts(value)
  return p ? p.hh + ':' + p.mm : ''
}

export function businessDayKey(value: string | number | Date): string {
  return wallParts(value)?.date || ''
}

export function businessWeekdayLabel(value: string | number | Date): string {
  const key = businessDayKey(value)
  if (!key) return ''
  // 用当天正午解析星期，避开夏令时/时区边界把日期挪一天
  return WEEKDAY_CN[new Date(key + 'T12:00:00Z').getUTCDay()] || ''
}

// 文件名用的时间戳：必须是业务时区的墙上时间。
// 之前直接 toISOString()，本地录制文件名带的是 UTC 串，和界面上看到的时刻差 8 小时。
export function businessFileStamp(value: string | number | Date = Date.now()): string {
  const p = wallParts(value)
  if (!p) return ''
  const [y, m, d] = p.date.split('-')
  return `${y}${m}${d}-${p.hh}${p.mm}${p.ss}`
}

// 落盘目录层用的是"年月日时分秒"连写的一层目录名（第 14 项要的 hxt/{yyyyMMddHHmmss}/ 形状），
// 不能带 - 和 :，否则 Windows 资源管理器里的层级形状和规约不一致。仍是业务时区的墙上时间。
export function businessDirStamp(value: string | number | Date = Date.now()): string {
  const p = wallParts(value)
  if (!p) return ''
  return p.date.replace(/-/g, '') + p.hh + p.mm + p.ss
}

export function formatDateTime(isoString?: string | null): string {
  if (!isoString) return ''
  const d = new Date(isoString)
  if (isNaN(d.getTime())) return isoString
  return d.toLocaleString('zh-CN', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// 短横线版的时间戳（`YYYY-MM-DD HH:mm`，业务时区）。
// 与上面的 formatDateTime（zh-CN 斜杠格式）区分：版本信息那类"发布日期 + 构建时间"
// 并排显示的地方要**同一种**格式，否则 `2026-10-14` 和 `2026/11/13 08:31` 并排
// 看着像两套数据。复用 wallParts，时区口径与全仓一致。
export function dashDateTime(value?: string | null): string {
  if (!value) return ''
  const p = wallParts(value)
  return p ? `${p.date} ${p.hh}:${p.mm}` : ''
}

export function formatDate(isoString?: string | null): string {
  if (!isoString) return ''
  const d = new Date(isoString)
  if (isNaN(d.getTime())) return isoString
  return d.toLocaleDateString('zh-CN', { timeZone: BUSINESS_TIME_ZONE })
}

export function formatTime(isoString?: string | null): string {
  if (!isoString) return ''
  const d = new Date(isoString)
  if (isNaN(d.getTime())) return isoString
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: BUSINESS_TIME_ZONE })
}

export function toIsoString(date: Date): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  const local = new Date(date.getTime() - offset * 60000)
  const iso = local.toISOString().replace('Z', '')
  return `${iso}${sign}${hh}:${mm}`
}

export function humanizeDuration(seconds: number): string {
  if (!seconds || seconds < 0) return '00:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function humanizeSize(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

export function relativeTime(isoString: string): string {
  const target = new Date(isoString).getTime()
  const diff = target - Date.now()
  const abs = Math.abs(diff)
  const mins = Math.floor(abs / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (mins < 60) return diff > 0 ? `${mins} 分钟后` : `${mins} 分钟前`
  if (hours < 24) return diff > 0 ? `${hours} 小时后` : `${hours} 小时前`
  return diff > 0 ? `${days} 天后` : `${days} 天前`
}
