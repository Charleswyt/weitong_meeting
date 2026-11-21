package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/emmansun/gmsm/sm2"
	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/os/gcache"

	"cloud-conference-backend/internal/service/thirdparty"
)

// Sm2LoginService 是本系统自己的登录信封服务：下发一次性 challenge + 公钥，
// 前端用 sm-crypto 加密 {username,password,challenge,issuedAtMs,nonce}，后端解密后走口令校验。
// 与三方那套 SM2 无共享代码 —— 两边密钥独立，只是编码约定刻意保持一致，便于前端复用实现。
type Sm2LoginService struct {
	mu         sync.Mutex
	key        *sm2.PrivateKey
	keyId      string
	challenges *gcache.Cache
}

// demoSm2PrivateKeyHex 是**演示系统内置**的一把 SM2 私钥（D 值）。
//
// 为什么要有内置值：本系统没有创建用户的入口，登录信封的公钥却是"取一次用一次"的 ——
// 原来私钥留空就每次启动现生成一把，于是重启前取过公钥的那个页面再点登录就必然解不开，
// 症状是"我什么都没改，登录突然坏了"。钉死一把跨重启稳定的钥匙，把这个假故障消掉。
//
// 代价要说清：这把值公开在仓库里，**只够演示用**。正式环境必须在 config.yaml 的
// auth.sm2.privateKey 里填现场自己生成的一把（留空时下面会打 WARN，不静默上线）。
const demoSm2PrivateKeyHex = "e654bcaadc170a4f24ba22f8854777fd2ff0fd5bb47e3ab2a4361f9a5a905618"

func NewSm2LoginService(ctx context.Context) (*Sm2LoginService, error) {
	svc := &Sm2LoginService{challenges: gcache.New()}

	configured := g.Cfg().MustGet(ctx, "auth.sm2.privateKey", "").String()
	if configured == "" {
		configured = demoSm2PrivateKeyHex
		g.Log().Warningf(ctx, "未配置 auth.sm2.privateKey，已改用内置演示密钥（跨重启稳定，但值公开在仓库里）；正式环境请换成现场生成的一把")
	}
	priv, err := thirdparty.Sm2KeyFromHex(configured)
	if err != nil {
		return nil, err
	}
	svc.key = priv
	svc.keyId = g.Cfg().MustGet(ctx, "auth.sm2.keyId", "v1").String()
	return svc, nil
}

type Sm2Descriptor struct {
	Algorithm          string `json:"algorithm"`
	Curve              string `json:"curve"`
	CipherMode         string `json:"cipherMode"`
	CiphertextEncoding string `json:"ciphertextEncoding"`
	PublicKey          string `json:"publicKey"`
	KeyId              string `json:"keyId"`
	Challenge          string `json:"challenge"`
	ExpiresIn          int    `json:"expiresInSeconds"`
}

type LoginEnvelope struct {
	Username   string `json:"username"`
	Password   string `json:"password"`
	Challenge  string `json:"challenge"`
	IssuedAtMs int64  `json:"issuedAtMs"`
	Nonce      string `json:"nonce"`
}

// Issue 生成一次性 challenge（5 分钟），同 keyId 下重复取会作废前一张。
func (s *Sm2LoginService) Issue(ctx context.Context) (*Sm2Descriptor, error) {
	buf := make([]byte, 18)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	challenge := hex.EncodeToString(buf)
	if err := s.challenges.Set(ctx, challenge, "used", 5*time.Minute); err != nil {
		return nil, err
	}
	return &Sm2Descriptor{
		Algorithm:          "SM2",
		Curve:              "sm2p256v1",
		CipherMode:         "C1C3C2",
		CiphertextEncoding: "c1c3c2-hex",
		PublicKey:          thirdparty.Sm2PublicKeyHex(s.key),
		KeyId:              s.keyId,
		Challenge:          challenge,
		ExpiresIn:          300,
	}, nil
}

// Decrypt 校验 challenge 一次性并还原信封。错误串供 controller 映射成本域提示。
func (s *Sm2LoginService) Decrypt(ctx context.Context, keyId, challenge, ciphertext string) (*LoginEnvelope, error) {
	if keyId != "" && keyId != s.keyId {
		return nil, fmt.Errorf("key_mismatch")
	}
	v, err := s.challenges.Remove(ctx, challenge)
	// gcache.Remove 对不存在的键返回空值而非 nil，必须按空判定，否则重放检测形同虚设。
	if err != nil || v == nil || v.String() == "" {
		return nil, fmt.Errorf("challenge_invalid_or_used")
	}

	raw, err := thirdparty.DecryptSm2Envelope(s.key, ciphertext)
	if err != nil {
		return nil, fmt.Errorf("crypto_failed")
	}
	env := &LoginEnvelope{}
	if err := json.Unmarshal(raw, env); err != nil {
		return nil, fmt.Errorf("crypto_failed")
	}
	if env.Username == "" || env.Password == "" {
		// 信封本身是好的，只是里面没装凭据。这跟"密文解不开"是两回事：
		// 混进 crypto_failed 会让用户被告知「凭证失效，请重试」，而真因是他没输口令。
		return nil, fmt.Errorf("envelope_incomplete")
	}
	if env.Challenge != challenge {
		return nil, fmt.Errorf("challenge_invalid_or_used")
	}
	return env, nil
}
