package observability

import (
	"fmt"
	"net/http"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
)

type routeMetric struct {
	count       uint64
	errorCount  uint64
	durationMs  uint64
}

// Collector 零外部依赖的轻量指标采集器，输出 Prometheus 0.0.4 文本格式。
type Collector struct {
	startedAt time.Time
	totalReq  atomic.Uint64
	totalErr  atomic.Uint64

	mu     sync.RWMutex
	routes map[string]*routeMetric

	roomStatsFn func() (rooms, sessions int)
	wsCountFn   func() int
}

var Default = &Collector{
	startedAt: time.Now(),
	routes:    make(map[string]*routeMetric),
}

// BindRuntime 绑定会议房间/会话/WebSocket 实时计数器。
func (c *Collector) BindRuntime(roomStats func() (int, int), wsCount func() int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.roomStatsFn = roomStats
	c.wsCountFn = wsCount
}

// RecordHTTP 记录一次 HTTP 请求的耗时与状态码。
func (c *Collector) RecordHTTP(method, path string, status int, dur time.Duration) {
	c.totalReq.Add(1)
	isErr := status >= 500
	if isErr {
		c.totalErr.Add(1)
	}
	normPath := normalizePath(path)
	key := method + " " + normPath
	ms := uint64(dur.Milliseconds())

	c.mu.Lock()
	m, ok := c.routes[key]
	if !ok {
		// 防止恶意扫描无穷路径导致内存膨胀
		if len(c.routes) >= 256 {
			key = method + " /*other*"
			m = c.routes[key]
		}
		if m == nil {
			m = &routeMetric{}
			c.routes[key] = m
		}
	}
	m.count++
	if isErr {
		m.errorCount++
	}
	m.durationMs += ms
	c.mu.Unlock()
}

// normalizePath 将路径中的纯数字段或长随机段归并为 :id，避免指标基数爆炸。
func normalizePath(p string) string {
	if p == "" {
		return "/"
	}
	parts := strings.Split(p, "/")
	for i, seg := range parts {
		if seg == "" {
			continue
		}
		allDigit := true
		for _, r := range seg {
			if r < '0' || r > '9' {
				allDigit = false
				break
			}
		}
		if allDigit || len(seg) >= 20 {
			parts[i] = ":id"
		}
	}
	return strings.Join(parts, "/")
}

// HealthHandler 存活探针（GET /healthz）。
func HealthHandler(r *ghttp.Request) {
	rooms, sessions := 0, 0
	wsClients := 0
	Default.mu.RLock()
	rf := Default.roomStatsFn
	wf := Default.wsCountFn
	Default.mu.RUnlock()
	if rf != nil {
		rooms, sessions = rf()
	}
	if wf != nil {
		wsClients = wf()
	}
	r.Response.WriteJson(g.Map{
		"status":         "ok",
		"uptimeSeconds":  int64(time.Since(Default.startedAt).Seconds()),
		"activeRooms":    rooms,
		"activeSessions": sessions,
		"wsClients":      wsClients,
		"goroutines":     runtime.NumGoroutine(),
		"httpRequests":   Default.totalReq.Load(),
		"http5xxErrors":  Default.totalErr.Load(),
	})
}

// ReadyHandler 就绪探针（GET /readyz），校验数据库连接是否可用。
func ReadyHandler(r *ghttp.Request) {
	if _, err := g.DB().GetValue(r.Context(), "SELECT 1"); err != nil {
		r.Response.WriteStatus(http.StatusServiceUnavailable)
		r.Response.WriteJson(g.Map{
			"status": "not_ready",
			"db":     "error",
		})
		return
	}
	r.Response.WriteJson(g.Map{
		"status": "ready",
		"db":     "ok",
	})
}

// MetricsHandler Prometheus 指标采集出口（GET /metrics）。
func MetricsHandler(r *ghttp.Request) {
	rooms, sessions := 0, 0
	wsClients := 0
	Default.mu.RLock()
	rf := Default.roomStatsFn
	wf := Default.wsCountFn
	keys := make([]string, 0, len(Default.routes))
	snap := make(map[string]routeMetric, len(Default.routes))
	for k, v := range Default.routes {
		keys = append(keys, k)
		snap[k] = *v
	}
	Default.mu.RUnlock()
	if rf != nil {
		rooms, sessions = rf()
	}
	if wf != nil {
		wsClients = wf()
	}
	sort.Strings(keys)

	var sb strings.Builder
	sb.WriteString("# HELP process_uptime_seconds Process uptime in seconds.\n")
	sb.WriteString("# TYPE process_uptime_seconds gauge\n")
	fmt.Fprintf(&sb, "process_uptime_seconds %.2f\n", time.Since(Default.startedAt).Seconds())

	sb.WriteString("# HELP go_goroutines Number of goroutines currently running.\n")
	sb.WriteString("# TYPE go_goroutines gauge\n")
	fmt.Fprintf(&sb, "go_goroutines %d\n", runtime.NumGoroutine())

	sb.WriteString("# HELP conference_active_rooms Active meeting rooms in memory.\n")
	sb.WriteString("# TYPE conference_active_rooms gauge\n")
	fmt.Fprintf(&sb, "conference_active_rooms %d\n", rooms)

	sb.WriteString("# HELP conference_active_sessions Active participant sessions in memory.\n")
	sb.WriteString("# TYPE conference_active_sessions gauge\n")
	fmt.Fprintf(&sb, "conference_active_sessions %d\n", sessions)

	sb.WriteString("# HELP conference_ws_clients Active meeting WebSocket connections.\n")
	sb.WriteString("# TYPE conference_ws_clients gauge\n")
	fmt.Fprintf(&sb, "conference_ws_clients %d\n", wsClients)

	sb.WriteString("# HELP http_requests_total Total HTTP requests handled.\n")
	sb.WriteString("# TYPE http_requests_total counter\n")
	fmt.Fprintf(&sb, "http_requests_total %d\n", Default.totalReq.Load())

	sb.WriteString("# HELP http_5xx_errors_total Total HTTP 5xx responses.\n")
	sb.WriteString("# TYPE http_5xx_errors_total counter\n")
	fmt.Fprintf(&sb, "http_5xx_errors_total %d\n", Default.totalErr.Load())

	sb.WriteString("# HELP http_route_requests_total HTTP requests by method and normalized path.\n")
	sb.WriteString("# TYPE http_route_requests_total counter\n")
	for _, k := range keys {
		method, path, _ := strings.Cut(k, " ")
		m := snap[k]
		fmt.Fprintf(&sb, "http_route_requests_total{method=%q,path=%q} %d\n", method, path, m.count)
	}

	sb.WriteString("# HELP http_route_duration_ms_sum Total HTTP request duration in ms by route.\n")
	sb.WriteString("# TYPE http_route_duration_ms_sum counter\n")
	for _, k := range keys {
		method, path, _ := strings.Cut(k, " ")
		m := snap[k]
		fmt.Fprintf(&sb, "http_route_duration_ms_sum{method=%q,path=%q} %d\n", method, path, m.durationMs)
	}

	r.Response.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	r.Response.Write(sb.String())
}
