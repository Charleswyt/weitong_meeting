package thirdparty

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/hex"
	"fmt"

	"github.com/emmansun/gmsm/sm2"
)

// EncryptSm2Password 用三方下发的 SM2 公钥加密登录信封，返回 c1c3c2-hex 密文。
//
// 三方（其前端 sm2.min.js doEncrypt）约定的密文格式为：C1C3C2 拼接、
// 但 C1 为不带 0x04 前缀的非压缩点坐标（仅 X‖Y），整体小写 hex。
// Go 侧 sm2.Encrypt 的 MarshalUncompressed 会在 C1 前补 0x04，
// 这里按三方约定把首个 0x04 字节去掉后再 hex 编码。
func EncryptSm2Envelope(envelope []byte, pubKeyHex string) (string, error) {
	raw, err := hex.DecodeString(pubKeyHex)
	if err != nil {
		return "", fmt.Errorf("decode sm2 public key: %w", err)
	}
	curve := sm2.P256()
	x, y := elliptic.Unmarshal(curve, raw)
	if x == nil {
		return "", fmt.Errorf("invalid sm2 public key point")
	}
	pub := &ecdsa.PublicKey{Curve: curve, X: x, Y: y}
	opts := sm2.NewPlainEncrypterOpts(sm2.MarshalUncompressed, sm2.C1C3C2)
	ct, err := sm2.Encrypt(rand.Reader, pub, envelope, opts)
	if err != nil {
		return "", fmt.Errorf("sm2 encrypt: %w", err)
	}
	if len(ct) > 0 && ct[0] == 0x04 {
		ct = ct[1:]
	}
	return hex.EncodeToString(ct), nil
}
