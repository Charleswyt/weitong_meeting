package thirdparty

import (
	"context"
	"strings"
	"sync"

	"github.com/gogf/gf/v2/os/glog"
)

// 这一路的视频编码，真源是三方逐路报的 `directVideoCodec`（缺失时回退 `directVideoFormat`），
// 不是发布声明的 sourceType —— 契约 §10.2 早就认定了这点，我方过去一直拿推断代替它。
// 推断对 `rk_browser_roi` 尤其靠不住：三方船端客户端恰恰是**强制浏览器编 H.264** 推给 RK 的
// （`preferH264ForSender(pc, sender, sourceType === "rk_browser_roi")`），HEVC 是否出现在
// 订阅侧取决于板卡有没有重编，而不是 sourceType 这个声明位。
var (
	videoCodecWarnMu = sync.Mutex{}
	videoCodecWarned = map[string]bool{}
)

func (p Publication) VideoCodec() string {
	if p.TransportMode != "" {
		if p.DirectVideoCodec == "h265" {
			return "hevc"
		}
		return p.DirectVideoCodec
	}
	if c := normalizeVideoCodec(p.DirectVideoCodec); c != "" {
		return c
	}
	if c := normalizeVideoCodec(p.DirectVideoFormat); c != "" {
		return c
	}
	// 两个真源键都没值：三方这份响应没报。回落过去一直用的 sourceType 推断，
	// 但这是"没验成的兜底"而不是等价判据 —— 报一次，别让它静默长期替代真源。
	warnVideoCodec("publication " + p.PublicationId + " 没有 directVideoCodec/directVideoFormat，按 sourceType=" + p.SourceType + " 推断")
	switch p.SourceType {
	case "rk_roi", "rk_browser_roi":
		return "hevc"
	default:
		return "h264"
	}
}

// normalizeVideoCodec 把三方报的编码词折成本域枚举；认不出来回空串，交给回落 —— 不猜。
func normalizeVideoCodec(value string) string {
	v := strings.ToLower(strings.TrimSpace(value))
	if v == "" {
		return ""
	}
	switch {
	case strings.Contains(v, "h264"), strings.Contains(v, "avc"):
		return "h264"
	case strings.Contains(v, "hevc"), strings.Contains(v, "h265"):
		return "hevc"
	}
	warnVideoCodec("未识别的视频编码 " + value)
	return ""
}

// warnVideoCodec 同一个串只报一次：这一路每秒都会被读，全量打会把日志淹掉。
func warnVideoCodec(msg string) {
	videoCodecWarnMu.Lock()
	defer videoCodecWarnMu.Unlock()
	if videoCodecWarned[msg] {
		return
	}
	videoCodecWarned[msg] = true
	glog.Warningf(context.Background(), "视频编码判定: %s", msg)
}
