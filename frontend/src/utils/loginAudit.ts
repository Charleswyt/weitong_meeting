export interface LoginAuditDisplay {
  time: string
  ip: string
  location: string
}

// 上次登录时间、IP 与归属地全部由后端记录与解析（user_login_audit），前端只负责展示，
// 不再在浏览器里调第三方 IP 定位或用 localStorage 记时间 —— 那样换设备就对不上。
export function resolveLoginAudit(
  userInfo: {
    lastLoginAt?: string
    lastLoginIp?: string
    lastLoginLocation?: string
  } | null | undefined,
): LoginAuditDisplay {
  return {
    time: (userInfo?.lastLoginAt || '').trim() || '首次登录',
    ip: (userInfo?.lastLoginIp || '').trim() || '—',
    location: (userInfo?.lastLoginLocation || '').trim() || '未知位置',
  }
}
