package password

import (
	"strings"
	"testing"
)

func TestHashVerifyRoundTrip(t *testing.T) {
	hashed, err := Hash("S3cret!本地")
	if err != nil {
		t.Fatalf("Hash 报错: %v", err)
	}
	if !Stored(hashed) {
		t.Fatalf("Hash 结果没带算法前缀: %s", hashed[:20])
	}
	if len(hashed) > MaxStoredLen {
		t.Fatalf("哈希串 %d 字节，超出列宽 %d", len(hashed), MaxStoredLen)
	}
	if strings.Contains(hashed, "S3cret") {
		t.Fatal("明文出现在落库串里")
	}
	if !Verify(hashed, "S3cret!本地") {
		t.Fatal("同一口令验不过")
	}
	if Verify(hashed, "S3cret!本地 ") {
		t.Fatal("多一个空格也验过了")
	}
	if Verify(hashed, "wrong") {
		t.Fatal("错口令验过了")
	}
}

// 同一口令两次哈希必须不同（盐是随机的），且两个结果都能验过原口令。
func TestHashIsSalted(t *testing.T) {
	a, _ := Hash("同一个口令")
	b, _ := Hash("同一个口令")
	if a == b {
		t.Fatal("两次哈希完全相同，盐没生效")
	}
	if !Verify(a, "同一个口令") || !Verify(b, "同一个口令") {
		t.Fatal("加盐后验不过原口令")
	}
}

// 迁移分两步跑，中间态（库里还是明文）必须还能登录，否则一步没跑成就把所有人锁在门外。
func TestVerifyLegacyPlaintext(t *testing.T) {
	if !Verify("旧版明文", "旧版明文") {
		t.Fatal("明文列没按明文比")
	}
	if Verify("旧版明文", "猜的") {
		t.Fatal("明文比对放过了错口令")
	}
	if !NeedsUpgrade("旧版明文") || NeedsUpgrade("pbkdf2-sha256$1$a$b") || NeedsUpgrade("") {
		t.Fatal("NeedsUpgrade 判错")
	}
}

// 空串两侧都不能过：sqlite_create.sql 用空串占位，"没配口令"不等于"口令是空"。
func TestEmptyNeverMatches(t *testing.T) {
	if Verify("", "") || Verify("", "x") || Verify("x", "") {
		t.Fatal("空值放行了")
	}
	if _, err := Hash(""); err == nil {
		t.Fatal("空口令竟然生成了哈希")
	}
}

// 落库串被人改过一位（迭代数、盐、摘要任一）都不能验过。
func TestTamperedStoredRejected(t *testing.T) {
	hashed, _ := Hash("口令")
	parts := strings.Split(hashed, "$")
	tampered := []string{
		strings.Join([]string{parts[0], "1", parts[2], parts[3]}, "$"),
		strings.Join([]string{parts[0], parts[1], parts[2], strings.Repeat("A", len(parts[3]))}, "$"),
		"pbkdf2-sha256$abc$" + parts[2] + "$" + parts[3],
		"pbkdf2-sha256$100000$" + parts[2],
	}
	for i, s := range tampered {
		if Verify(s, "口令") {
			t.Fatalf("第 %d 个被改过的落库串验过了", i)
		}
	}
}
