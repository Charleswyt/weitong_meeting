import { ref } from 'vue'
import { assetUrl } from './request'

const AVATAR_SIZE = 256

/**
 * 头像取不到时（票参过期、后端已删旧文件而浏览器还拿着缓存）不能留一个空白圆圈：
 * 记下行号，让调用方回落到首字占位 —— 与设置页/预入会页的 avatarBroken 兜底同一口径。
 * 整页共用一份即可：键是"这个人"，不是"这一格"，同一张坏图在成员面板和聊天里都一样坏。
 */
const broken = ref<Set<string>>(new Set())

export function markAvatarBroken(key: string): void {
  if (!key || broken.value.has(key)) return
  broken.value = new Set(broken.value).add(key)
}

/** 有头像且没被判坏才给地址；返回空串表示"这一格该画首字占位"。 */
export function avatarSrcFor(key: string, avatar: string | undefined | null): string {
  if (!avatar || broken.value.has(key)) return ''
  return assetUrl(avatar)
}

// 在浏览器里等比裁成正方形并缩到 256px 再上传：
// 宿机是 RK3588 + 卫星链路，原图直传既慢又没必要。
export async function toAvatarBlob(file: File): Promise<Blob> {
  const bitmap = await readBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const sx = (bitmap.width - side) / 2
  const sy = (bitmap.height - side) / 2

  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_SIZE
  canvas.height = AVATAR_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('当前浏览器不支持画布缩放')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
  if ('close' in bitmap) bitmap.close()

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/png'),
  )
  if (!blob) throw new Error('头像编码失败')
  return blob
}

async function readBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file)
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片解码失败'))
    }
    img.src = url
  })
}
