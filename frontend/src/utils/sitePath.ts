// Browser endpoints and share links belong to the same mount as the SPA.
export function sitePath(path: string): string {
  const prefix = import.meta.env.BASE_URL.replace(/\/$/, '')
  if (!path.startsWith('/') || path.startsWith('//') || (prefix && path.startsWith(prefix + '/'))) return path
  return prefix + path
}
