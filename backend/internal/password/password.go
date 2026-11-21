// Package password 只管一件事：本地登录口令在库里长什么样。
//
// 落库形态是 PBKDF2-HMAC-SHA256 + 每用户随机盐，格式自描述（算法/迭代/盐/摘要），
// 这样将来调迭代次数不用整库重灌。三方链路口令**不在这里** —— 那串要原样发给三方换令牌，
// 哈希过一次就再也用不了，所以它仍按明文存放（只存在于被 gitignore 的凭据脚本里）。
package password

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
)

const (
	algorithm  = "pbkdf2-sha256"
	iterations = 100000
	keyLength  = 32
	saltLength = 16

	// 列宽 128 是建库脚本里的既有定义；这里把它写成可断言的常量，
	// 免得哪天换了编码格式悄悄溢出，症状是"谁都登不进去"。
	MaxStoredLen = 128
)

// Hash 返回自描述的哈希串。明文为空直接报错：空串一旦进了哈希，
// 就等于给这一行开了一个"空口令也能过"的后门。
func Hash(plain string) (string, error) {
	if plain == "" {
		return "", fmt.Errorf("口令为空，不生成哈希")
	}
	salt := make([]byte, saltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("生成盐失败: %w", err)
	}
	dk, err := pbkdf2.Key(sha256.New, plain, salt, iterations, keyLength)
	if err != nil {
		return "", fmt.Errorf("派生密钥失败: %w", err)
	}
	return algorithm + "$" + strconv.Itoa(iterations) + "$" + b64(salt) + "$" + b64(dk), nil
}

// Stored 报告这一列是不是本包写的形态。
func Stored(v string) bool { return strings.HasPrefix(v, algorithm+"$") }

// Verify 比对落库值与用户刚输入的明文。
//
// 不带本包前缀的历史值（明文列）按明文比：迁移分两步跑，种库脚本写明文、随后才换哈希，
// 中间那一步没跑成不能让所有人登不进去。比对用 hmac.Equal，不提前返回长度差。
func Verify(stored, plain string) bool {
	if stored == "" || plain == "" {
		return false
	}
	if !Stored(stored) {
		return hmac.Equal([]byte(stored), []byte(plain))
	}
	parts := strings.Split(stored, "$")
	if len(parts) != 4 {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter <= 0 {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[3])
	if err != nil {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, plain, salt, iter, len(want))
	return err == nil && hmac.Equal(want, got)
}

// NeedsUpgrade 用来在登录成功后顺手把遗留明文列换成哈希。
func NeedsUpgrade(stored string) bool { return stored != "" && !Stored(stored) }

func b64(b []byte) string { return base64.RawStdEncoding.EncodeToString(b) }
