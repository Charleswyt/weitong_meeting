package model_test

import (
	"context"
	"strings"
	"testing"

	"github.com/gogf/gf/v2/frame/g"

	"cloud-conference-backend/internal/model"
)

// 目标码率的取值域必须**每一档都有实测证据**，所以这里钉两端：
//   - 1500 必须被拒。上限原先是 8000，但那是 `1d8e5b6` 建文件时带来的悬空值
//     （`git log -L 12,13:settings.go` 证 c4325b5 只动了下限 100→20），设置页从来只到 1000，
//     三方页两处硬校验也是 20–1000，1000–8000 既无我方实测也无三方接受证据。
//   - 20 / 150 / 1000 必须收得下 —— 边界被误收是这类收紧最常见的回归。
//
// 基线用 DefaultPreferenceVo()：它本身是合法值，所以只有码率这一维能左右结果。
// 规则还没收到 1000 之前，1500 会被安静收下 —— 这条断言当时就是红的。
func TestVideoTargetBitrateRange(t *testing.T) {
	ctx := context.Background()
	base := model.DefaultPreferenceVo()
	if base.VideoTargetBitrateKbps != 0 {
		t.Fatalf("default browser video encoding cap = %d kbps, want 0 (adaptive)", base.VideoTargetBitrateKbps)
	}
	if err := g.Validator().Data(base).Run(ctx); err != nil {
		t.Fatalf("默认偏好本身应当合法，否则这个测试测不到码率那一维：%s", errText(err))
	}

	cases := []struct {
		name   string
		kbps   int
		wantOK bool
	}{
		{"0 自适应要收", 0, true},
		{"下边界 20 要收", 20, true},
		{"三方多出的 150 档要收", 150, true},
		{"上边界 1000 要收", 1000, true},
		{"1001 要拒", 1001, false},
		{"1500 要拒（原先 between:20,8000 会安静收下）", 1500, false},
		{"负数要拒", -1, false},
	}
	for _, c := range cases {
		p := *base
		p.VideoTargetBitrateKbps = c.kbps
		err := g.Validator().Data(&p).Run(ctx)
		if got := err == nil; got != c.wantOK {
			t.Errorf("%s: 期望通过=%v，实得通过=%v（err=%s）", c.name, c.wantOK, got, errText(err))
		}
	}
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return strings.ReplaceAll(err.Error(), "\n", " ")
}
