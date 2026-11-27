/**
 * 基于公网 IP 解析地点，再用 Open-Meteo 取当前气温、风力风向与今日日出日落（均免费、免 key）。
 * 失败时返回空串，调用方自行隐藏，不造假城市/天气。
 */

export type GeoWeather = {
  place: string
  weather: string
  sunrise: string
  sunset: string
  windDirection: string
  windScale: string
}

const EMPTY: GeoWeather = {
  place: '',
  weather: '',
  sunrise: '',
  sunset: '',
  windDirection: '',
  windScale: '',
}

const WMO: Record<number, string> = {
  0: '晴',
  1: '大部晴朗',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  80: '阵雨',
  81: '强阵雨',
  82: '暴雨',
  95: '雷阵雨',
  96: '雷阵雨伴冰雹',
  99: '强雷暴冰雹',
}

const WIND_DIRS = ['北风', '东北风', '东风', '东南风', '南风', '西南风', '西风', '西北风']

function windDirLabel(deg: unknown): string {
  const n = Number(deg)
  if (!Number.isFinite(n)) return ''
  const idx = Math.round((((n % 360) + 360) % 360) / 45) % 8
  return WIND_DIRS[idx] || ''
}

// Open-Meteo wind_speed_10m 默认单位为 km/h，按标准蒲福风力表换算级数。
function windScaleLabel(kmh: unknown): string {
  const v = Number(kmh)
  if (!Number.isFinite(v) || v < 0) return ''
  const thresholds = [1, 5, 11, 19, 28, 38, 49, 61, 74, 88, 102, 117]
  let level = 12
  for (let i = 0; i < thresholds.length; i++) {
    if (v <= thresholds[i]!) {
      level = i
      break
    }
  }
  return `${level}级`
}

function hhmmOf(iso: unknown): string {
  if (typeof iso !== 'string') return ''
  const m = iso.match(/T(\d{2}:\d{2})/)
  return m ? m[1]! : ''
}

function placeOf(city?: string, region?: string): string {
  const c = (city || '').trim()
  const r = (region || '').trim()
  if (c && r && c !== r) return `${r} · ${c}`
  return c || r || ''
}

const CACHE_KEY = 'wt.geoWeather.v1'
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 小时内只刷新一次，避免频繁调用公网接口
const FAIL_COOLDOWN_KEY = 'wt.geoWeather.lastAttempt'
let inflightPromise: Promise<GeoWeather> | null = null

function readLastAttempt(): number {
  try {
    return Number(window.localStorage.getItem(FAIL_COOLDOWN_KEY) || '0') || 0
  } catch {
    return 0
  }
}

function markAttemptNow() {
  try {
    window.localStorage.setItem(FAIL_COOLDOWN_KEY, String(Date.now()))
  } catch {
    /* ignore */
  }
}

function readCache(): { ts: number; data: GeoWeather } | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { ts?: number; data?: GeoWeather }
    if (!parsed?.data || typeof parsed.ts !== 'number') return null
    if (!parsed.data.place && !parsed.data.weather) return null
    return { ts: parsed.ts, data: parsed.data }
  } catch {
    return null
  }
}

function writeCache(data: GeoWeather) {
  if (!data.place && !data.weather) return
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }))
  } catch {
    /* ignore storage errors */
  }
}

export async function fetchGeoWeather(signal?: AbortSignal): Promise<GeoWeather> {
  const cached = readCache()
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data
  }
  // 1 小时内已尝试过（即使上次失败）则不再重复打公网接口，避免频繁调用触发限流
  if (Date.now() - readLastAttempt() < CACHE_TTL_MS) {
    return cached ? cached.data : { ...EMPTY }
  }
  if (inflightPromise) return inflightPromise

  markAttemptNow()
  inflightPromise = (async () => {
    // ipapi.co → ipwho.is → geojs.io 三级兜底，避免频繁刷新触发单源限流
    let lat = 0
    let lon = 0
    let place = ''
    try {
      const geo = await fetch('https://ipapi.co/json/', { signal }).then((r) => r.json())
      if (geo && !geo.error) {
        lat = Number(geo.latitude) || 0
        lon = Number(geo.longitude) || 0
        place = placeOf(geo.city, geo.region)
      }
    } catch {
      /* 换备用 */
    }
    if (!place || !lat || !lon) {
      try {
        const geo = await fetch('https://ipwho.is/', { signal }).then((r) => r.json())
        if (geo?.success !== false) {
          lat = Number(geo.latitude) || lat
          lon = Number(geo.longitude) || lon
          place = place || placeOf(geo.city, geo.region)
        }
      } catch {
        /* 换备用 */
      }
    }
    if (!place || !lat || !lon) {
      try {
        const geo = await fetch('https://get.geojs.io/v1/ip/geo.json', { signal }).then((r) => r.json())
        if (geo) {
          lat = Number(geo.latitude) || lat
          lon = Number(geo.longitude) || lon
          place = place || placeOf(geo.city, geo.region)
        }
      } catch {
        if (cached) return cached.data
        return { ...EMPTY }
      }
    }
    if (!lat || !lon) {
      if (cached) return cached.data
      return { ...EMPTY, place }
    }

    try {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m` +
        `&daily=sunrise,sunset&forecast_days=1&timezone=auto`
      const wx = await fetch(url, { signal }).then((r) => r.json())
      const cur = wx?.current
      if (!cur) return cached ? cached.data : { ...EMPTY, place }
      const code = Number(cur.weather_code)
      const temp = cur.temperature_2m
      const label = WMO[code] || '天气'
      const t = typeof temp === 'number' ? `${Math.round(temp)}°C` : ''
      const sunrise = hhmmOf(wx?.daily?.sunrise?.[0])
      const sunset = hhmmOf(wx?.daily?.sunset?.[0])
      const windDirection = windDirLabel(cur.wind_direction_10m)
      const windScale = windScaleLabel(cur.wind_speed_10m)
      const result: GeoWeather = {
        place,
        weather: [label, t].filter(Boolean).join(' '),
        sunrise,
        sunset,
        windDirection,
        windScale,
      }
      writeCache(result)
      return result
    } catch {
      return cached ? cached.data : { ...EMPTY, place }
    }
  })().finally(() => {
    inflightPromise = null
  })

  return inflightPromise
}
