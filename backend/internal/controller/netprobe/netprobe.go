package netprobe

import (
	"crypto/rand"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"

	"cloud-conference-backend/internal/response"
)

const (
	defaultKiB = 2048
	maxKiB     = 8192
	chunkSize  = 32 * 1024
	drainLimit = 16 << 20
)

type Controller struct{}

func New() *Controller { return &Controller{} }

// Down 回不可压缩的随机载荷，供前端按真实收包计时算下行。
// 必须关 gzip：全零载荷会被中间层压成几 KB，浏览器解压后再数字节就会假成上千 Mbps。
func (c *Controller) Down(r *ghttp.Request) {
	kb, err := strconv.Atoi(r.GetQuery("kb", strconv.Itoa(defaultKiB)).String())
	if err != nil || kb <= 0 {
		kb = defaultKiB
	}
	if kb > maxKiB {
		kb = maxKiB
	}
	total := kb * 1024
	r.Response.Header().Set("Content-Type", "application/octet-stream")
	r.Response.Header().Set("Cache-Control", "no-store, no-transform")
	r.Response.Header().Set("Content-Encoding", "identity")
	r.Response.Header().Set("Content-Length", strconv.Itoa(total))
	// 显式禁止协商压缩，避免框架/反代按 Accept-Encoding 再压一遍。
	r.Response.Header().Set("Vary", "Accept-Encoding")

	buf := make([]byte, chunkSize)
	for remaining := total; remaining > 0; remaining -= len(buf) {
		n := len(buf)
		if remaining < n {
			n = remaining
			buf = buf[:n]
		}
		if _, err := rand.Read(buf); err != nil {
			// 随机源异常时退回伪随机填充，仍保持高熵，避免被压扁。
			for i := range buf {
				buf[i] = byte(i*31 + remaining)
			}
		}
		r.Response.Write(buf)
		if remaining < chunkSize {
			break
		}
	}
}

// Up 读完并丢弃请求体：只计时，不落盘也不回显。
func (c *Controller) Up(r *ghttp.Request) {
	if _, err := io.Copy(io.Discard, io.LimitReader(r.Request.Body, drainLimit)); err != nil {
		response.FailSystem(r, "读取网络探测请求体失败", err)
		return
	}
	response.OkWithMessage(r, "探测完成")
}

// Upstream 探测本机后端到三方会议平台的往返，反映会中真正走的那一段，而不是浏览器到本机回环。
func (c *Controller) Upstream(r *ghttp.Request) {
	ctx := r.Context()
	base, _ := g.Cfg().Get(ctx, "thirdParty.conference.baseUrl")
	target := base.String()
	if target == "" {
		response.Ok(r, g.Map{"ok": false, "rttMs": 0, "reason": "未配置三方地址"})
		return
	}
	client := &http.Client{Timeout: 4 * time.Second}
	t0 := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		response.Ok(r, g.Map{"ok": false, "rttMs": 0, "reason": "探测地址无效"})
		return
	}
	resp, err := client.Do(req)
	dt := time.Since(t0).Milliseconds()
	if err != nil {
		response.Ok(r, g.Map{"ok": false, "rttMs": dt, "reason": "三方不可达"})
		return
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
	resp.Body.Close()
	response.Ok(r, g.Map{"ok": true, "rttMs": dt, "status": resp.StatusCode})
}
