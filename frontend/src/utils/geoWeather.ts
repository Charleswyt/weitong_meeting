/**
 * 基于公网 IP 解析地点，再用 Open-Meteo 取当前气温（均免费、免 key）。
 * 失败时返回空串，调用方自行隐藏，不造假城市/天气。
 */

export type GeoWeather = {
  place: string
  weather: string
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
      return { place: '', weather: '' }
    }
  }
  if (!lat || !lon) return { place, weather: '' }

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code&timezone=auto`
    const wx = await fetch(url, { signal }).then((r) => r.json())
    const cur = wx?.current
    if (!cur) return { place, weather: '' }
    const code = Number(cur.weather_code)
    const temp = cur.temperature_2m
    const label = WMO[code] || '天气'
    const t = typeof temp === 'number' ? `${Math.round(temp)}°C` : ''
    return { place, weather: [label, t].filter(Boolean).join(' ') }
  } catch {
    return { place, weather: '' }
  }
}
