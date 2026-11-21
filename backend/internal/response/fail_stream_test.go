package response_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"testing"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
	"github.com/gogf/gf/v2/util/guid"

	"cloud-conference-backend/internal/response"
)

func freePort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port, nil
}

// 契约 §1 的状态码→reason 表必须真的落到线上信封里，只测映射函数不算数。
func TestFailStreamEnvelope(t *testing.T) {
	port, err := freePort()
	if err != nil {
		t.Fatal(err)
	}
	s := g.Server(guid.S())
	s.SetPort(port)
	s.BindHandler("/stream", func(r *ghttp.Request) {
		response.FailStream(r, 404, "该流已结束")
	})
	s.SetDumpRouterMap(false)
	s.SetAccessLogEnabled(false)
	s.Start()
	defer s.Shutdown()

	url := fmt.Sprintf("http://127.0.0.1:%d/stream", port)
	resp, err := http.Get(url) //nolint:noctx // 测试内一次性请求
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != 404 {
		t.Errorf("HTTP 状态 = %d，期望 404", resp.StatusCode)
	}
	var env struct {
		Code   int    `json:"code"`
		Msg    string `json:"msg"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("响应不是合法 JSON: %v / %s", err, body)
	}
	if env.Code != 404 {
		t.Errorf("code = %d，期望 404", env.Code)
	}
	if env.Reason != "not_found" {
		t.Errorf("reason = %q，期望机器值 not_found（改前这里填的是 msg 本身）", env.Reason)
	}
	// msg 仍是给人看的那句：换掉 reason 不等于改动文案（第 7 项要求前端照实渲染 msg）。
	if env.Msg != "该流已结束" {
		t.Errorf("msg = %q，期望原样保留「该流已结束」", env.Msg)
	}
}
