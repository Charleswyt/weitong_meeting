package thirdparty

import (
	"crypto/elliptic"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"

	"github.com/emmansun/gmsm/sm2"
)

// DecryptSm2Envelope 解开本系统登录信封：密文为 c1c3c2 拼接、C1 去掉前导 0x04 的小写 hex
// （与 EncryptSm2Envelope 及三方前端 sm2.doEncrypt 的编码约定对称）。
func DecryptSm2Envelope(priv *sm2.PrivateKey, ciphertextHex string) ([]byte, error) {
	raw, err := hex.DecodeString(ciphertextHex)
	if err != nil {
		return nil, fmt.Errorf("decode ciphertext: %w", err)
	}
	if len(raw) < 65 {
		return nil, fmt.Errorf("密文长度不足")
	}
	withPrefix := make([]byte, 0, len(raw)+1)
	withPrefix = append(withPrefix, 0x04)
	withPrefix = append(withPrefix, raw...)
	return priv.Decrypt(rand.Reader, withPrefix, sm2.NewPlainDecrypterOpts(sm2.C1C3C2))
}

// Sm2KeyFromHex 从配置里的私钥 D 值（hex）恢复密钥对。
func Sm2KeyFromHex(dHex string) (*sm2.PrivateKey, error) {
	d, ok := new(big.Int).SetString(dHex, 16)
	if !ok {
		return nil, fmt.Errorf("sm2 私钥 hex 非法")
	}
	priv := new(sm2.PrivateKey)
	priv.PublicKey.Curve = sm2.P256()
	priv.D = d
	priv.PublicKey.X, priv.PublicKey.Y = priv.PublicKey.Curve.ScalarBaseMult(d.Bytes())
	if priv.PublicKey.X == nil {
		return nil, fmt.Errorf("sm2 公钥推导失败")
	}
	return priv, nil
}

// Sm2PublicKeyHex 返回 04||X||Y 的 130 位 hex（与三方下发格式一致）。
func Sm2PublicKeyHex(priv *sm2.PrivateKey) string {
	raw := elliptic.Marshal(priv.PublicKey.Curve, priv.PublicKey.X, priv.PublicKey.Y)
	return hex.EncodeToString(raw)
}

var _ = elliptic.Marshal
