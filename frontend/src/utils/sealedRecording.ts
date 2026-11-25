const magic = new TextEncoder().encode('WTMREC01')
const headerSize = 48
const chunkSize = 1024 * 1024
const rounds = 310000
const kinds = ['video/mp4', 'video/webm', 'audio/mp4', 'audio/webm', 'audio/wav'] as const

async function derive(passphrase: string, salt: Uint8Array<ArrayBuffer>) {
  if (passphrase.length < 10) throw new Error('口令至少需要 10 个字符')
  const secret = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds },
    secret,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}
function params(header: Uint8Array<ArrayBuffer>, index: number) {
  const iv = new Uint8Array(12)
  iv.set(header.subarray(24, 32))
  new DataView(iv.buffer).setUint32(8, index)
  const aad = new Uint8Array(headerSize + 4)
  aad.set(header)
  new DataView(aad.buffer).setUint32(headerSize, index)
  return { name: 'AES-GCM', iv, additionalData: aad }
}
export async function sealRecording(file: Blob, passphrase: string): Promise<Blob> {
  const kind = kinds.findIndex((k) => k === file.type.split(';')[0])
  if (kind < 0 || file.size < 1 || file.size > 2 * 1024 ** 3)
    throw new Error('请选择 2 GiB 以内的 MP4、WebM 或 WAV 录制文件')
  const header = new Uint8Array(headerSize)
  header.set(magic)
  crypto.getRandomValues(header.subarray(8, 32))
  header[32] = kind
  new DataView(header.buffer).setBigUint64(36, BigInt(file.size))
  const key = await derive(passphrase, header.slice(8, 24))
  const chunks: BlobPart[] = [header.buffer]
  for (let offset = 0, i = 0; offset < file.size; offset += chunkSize, i++) {
    const clear = await file.slice(offset, offset + chunkSize).arrayBuffer()
    chunks.push(await crypto.subtle.encrypt(params(header, i), key, clear))
  }
  return new Blob(chunks, { type: 'application/octet-stream' })
}
export async function openRecording(file: Blob, passphrase: string): Promise<Blob> {
  const header = new Uint8Array(await file.slice(0, headerSize).arrayBuffer())
  if (header.length !== headerSize || !magic.every((x, i) => x === header[i]))
    throw new Error('文件不是中卫通加密录制')
  const size = Number(new DataView(header.buffer).getBigUint64(36)),
    type = kinds[header[32]!]
  if (
    !type ||
    size < 1 ||
    size > 2 * 1024 ** 3 ||
    file.size !== headerSize + size + Math.ceil(size / chunkSize) * 16
  )
    throw new Error('录制文件不完整')
  const key = await derive(passphrase, header.slice(8, 24))
  const chunks: BlobPart[] = []
  try {
    for (let clear = 0, at = headerSize, i = 0; clear < size; clear += chunkSize, i++) {
      const n = Math.min(chunkSize, size - clear) + 16
      chunks.push(
        await crypto.subtle.decrypt(params(header, i), key, await file.slice(at, at + n).arrayBuffer()),
      )
      at += n
    }
  } catch {
    throw new Error('口令不正确或文件校验失败')
  }
  return new Blob(chunks, { type })
}
