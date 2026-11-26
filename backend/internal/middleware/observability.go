package middleware

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
	"time"

	"github.com/gogf/gf/v2/net/ghttp"
	"github.com/gogf/gf/v2/os/glog"

	"cloud-conference-backend/internal/observability"
)

const requestIDHeader = "X-Request-ID"

func newRequestID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "req-" + time.Now().Format("150405.000")
	}
	return hex.EncodeToString(b[:])
}

// Observability 统一注入 X-Request-ID，记录结构化访问日志并上报 HTTP 指标。
func Observability(r *ghttp.Request) {
	reqID := strings.TrimSpace(r.Header.Get(requestIDHeader))
	if reqID == "" || len(reqID) > 64 {
		reqID = newRequestID()
	}
	r.SetCtxVar("requestId", reqID)
	r.Response.Header().Set(requestIDHeader, reqID)

	start := time.Now()
	r.Middleware.Next()
	dur := time.Since(start)
	status := r.Response.Status
	if status == 0 {
		status = 200
	}

	path := r.URL.Path
	// 探针与指标采集不计入业务路由统计
	if path != "/healthz" && path != "/readyz" && path != "/metrics" {
		observability.Default.RecordHTTP(r.Method, path, status, dur)
	}

	if status >= 500 {
		glog.Errorf(r.Context(), "http_req reqId=%s method=%s path=%s status=%d durMs=%d ip=%s",
			reqID, r.Method, path, status, dur.Milliseconds(), r.GetClientIp())
	} else if dur >= time.Second {
		glog.Warningf(r.Context(), "http_slow reqId=%s method=%s path=%s status=%d durMs=%d ip=%s",
			reqID, r.Method, path, status, dur.Milliseconds(), r.GetClientIp())
	}
}
