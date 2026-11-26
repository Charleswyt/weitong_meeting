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

export async function fetchGeoWeather(signal?: AbortSignal): Promise<GeoWeather> {
  // ipapi.co：HTTPS、免 key、日限约 1000；失败再试 ipwho.is。
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
      return { ...EMPTY }
    }
  }
  if (!lat || !lon) return { ...EMPTY, place }

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m` +
      `&daily=sunrise,sunset&forecast_days=1&timezone=auto`
    const wx = await fetch(url, { signal }).then((r) => r.json())
    const cur = wx?.current
    if (!cur) return { ...EMPTY, place }
    const code = Number(cur.weather_code)
    const temp = cur.temperature_2m
    const label = WMO[code] || '天气'
    const t = typeof temp === 'number' ? `${Math.round(temp)}°C` : ''
    const sunrise = hhmmOf(wx?.daily?.sunrise?.[0])
    const sunset = hhmmOf(wx?.daily?.sunset?.[0])
    const windDirection = windDirLabel(cur.wind_direction_10m)
    const windScale = windScaleLabel(cur.wind_speed_10m)
    return {
      place,
      weather: [label, t].filter(Boolean).join(' '),
      sunrise,
      sunset,
      windDirection,
      windScale,
    }
  } catch {
    return { ...EMPTY, place }
  }
}
