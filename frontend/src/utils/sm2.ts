import { sm2 } from 'sm-crypto'
import { get } from '@/utils/request'

interface Sm2Descriptor {
  algorithm: string
  curve: string
  cipherMode: string
  ciphertextEncoding: string
  publicKey: string
  keyId: string
  challenge: string
  expiresInSeconds: number
}

export interface Sm2LoginPayload {
  username: string
  algorithm: string
  keyId: string
  challenge: string
  cipherMode: string
  ciphertextEncoding: string
  ciphertext: string
}

function nonce(): string {
  const bytes = new Uint8Array(18)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function fetchSm2Descriptor(): Promise<Sm2Descriptor> {
  const res = await get<Sm2Descriptor>('/api/v1/auth/sm2-public-key')
  return res.data!
}

// buildLoginPayload 按后端契约把口令封成 SM2/C1C3C2 信封。
// sm-crypto 的 doEncrypt(msg, key, 1) 输出即为「C1 无 04 前缀 + C3 + C2」的小写 hex，
// 与后端 DecryptSm2Envelope 的约定一致。
export function buildLoginPayload(desc: Sm2Descriptor, username: string, password: string): Sm2LoginPayload {
  const envelope = JSON.stringify({
    username,
    password,
    challenge: desc.challenge,
    issuedAtMs: Date.now(),
    nonce: nonce(),
  })
  return {
    username,
    algorithm: desc.algorithm,
    keyId: desc.keyId,
    challenge: desc.challenge,
    cipherMode: desc.cipherMode,
    ciphertextEncoding: desc.ciphertextEncoding,
    ciphertext: sm2.doEncrypt(envelope, desc.publicKey, 1),
  }
}

export const SM2_RETRY_REASONS = ['key_mismatch', 'challenge_invalid_or_used']

export function isRetryableReason(reason: string | undefined): boolean {
  return !!reason && SM2_RETRY_REASONS.includes(reason)
}
