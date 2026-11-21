package thirdparty

import "testing"

func TestNormalizeTimeText(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"实测三方格式", "2026-09-12 17:47:37 +0800", "2026-09-12T17:47:37+08:00"},
		{"零时长行的空文本", "", ""},
		{"空白", "   ", ""},
		{"已经是 RFC3339 就原样走", "2026-09-12T17:47:37+08:00", "2026-09-12T17:47:37+08:00"},
		// 认不出来不许猜时区：那是在造时间。
		{"认不出的串原样返回", "昨天下午", "昨天下午"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := NormalizeTimeText(c.in); got != c.want {
				t.Fatalf("NormalizeTimeText(%q) = %q，期望 %q", c.in, got, c.want)
			}
		})
	}
}
