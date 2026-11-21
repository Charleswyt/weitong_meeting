declare module 'sm-crypto' {
  export const sm2: {
    doEncrypt(msg: string, publicKeyHex: string, cipherMode?: 0 | 1): string
    doDecrypt(cipherHex: string, privateKeyHex: string, cipherMode?: 0 | 1): string
    generateKeyPairHex(): { publicKey: string; privateKey: string }
  }
  export const sm3: (msg: string) => string
  export const sm4: {
    encrypt(msg: string, key: string): string
    decrypt(msg: string, key: string): string
  }
}
