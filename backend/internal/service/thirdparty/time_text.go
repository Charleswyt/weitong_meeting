package thirdparty

import (
	"strings"
	"time"
)

// NormalizeTimeText 把三方的时间文本（实测 "2026-09-12 17:47:37 +0800"）换成本域契约的 RFC3339。
//
// 那是 Go 的排版习惯而不是我们的：契约 §1 规定对外一律 ISO 8601。把空格分隔的串原样丢给
// 前端，等于让浏览器去猜一个非标准格式 —— V8 恰好能解（实测），换个引擎就变成
// `new Date -> NaN -> 原样显示 +0800`。转换放在边界，一处解决。
//
// 认不出来就原样返回：时间文本只是展示字段，权威值另有 startedAt 的秒级时间戳，
// 把不认识的串硬塞进某个时区反而是在造数据。
func NormalizeTimeText(text string) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return ""
	}
	if t, err := time.Parse("2006-01-02 15:04:05 -0700", trimmed); err == nil {
		return t.Format(time.RFC3339)
	}
	return trimmed
}
