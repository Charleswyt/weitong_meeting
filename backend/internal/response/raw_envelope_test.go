package response_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
	"github.com/gogf/gf/v2/util/guid"

	"cloud-conference-backend/internal/response"
)

// 帧时刻表代理端点把上游响应原样嵌进我方信封（`json.RawMessage`），因为那里面有
// Unix **纳秒**与 64 位源钟标识 —— 都超出 JSON number 的安全整数范围，过一遍 float 就改掉末几位。
//
// "gf 会不会把 RawMessage 当普通值再编码一遍"是假设，不是事实，这条测试就是把它打掉：
// 字面量必须逐字节出现在响应里，且信封本身要成立（前端拦截器按 `code` 判错，
// 裸透传上游的 `{ok:true}` 会被判成"系统异常"弹窗）。
func TestOkWithDataKeepsRawMessageLiterals(t *testing.T) {
	const nsLiteral = "1791859747932627500"    // Unix 纳秒：> 2^53，float 装不下
	const clockLiteral = "3619134304969597112" // 源钟标识：同样超范围
	raw := `{"ok":true,"sourceClockId":` + clockLiteral +
		`,"frames":[{"rtpTimestamp":1520273504,"sourceEncodeUnixNs":` + nsLiteral + `}]}`

	port, err := freePort()
	if err != nil {
		t.Fatal(err)
	}
	s := g.Server(guid.S())
	s.SetPort(port)
	s.BindHandler("/raw", func(r *ghttp.Request) {
		response.OkWithData(r, json.RawMessage(raw), "ok")
	})
	s.SetDumpRouterMap(false)
	s.SetAccessLogEnabled(false)
	s.Start()
	defer s.Shutdown()

	resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/raw", port)) //nolint:noctx // 测试内一次性请求
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	text := string(body)

	for _, want := range []string{nsLiteral, clockLiteral} {
		if !strings.Contains(text, want) {
			t.Errorf("大整数字面量 %s 没被原样保留（说明中间过了一遍 float）：%s", want, text)
		}
	}
	if strings.Contains(strings.ToLower(text), "e+1") {
		t.Errorf("数字被写成科学计数法：%s", text)
	}
	var env struct {
		Code int `json:"code"`
		Data struct {
			Ok     bool `json:"ok"`
			Frames []struct {
				SourceEncodeUnixNs json.Number `json:"sourceEncodeUnixNs"`
			} `json:"frames"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("响应不是合法 JSON: %v / %s", err, text)
	}
	if env.Code != 200 {
		t.Errorf("code = %d，期望 200（拦截器按它判错）", env.Code)
	}
	if !env.Data.Ok || len(env.Data.Frames) != 1 {
		t.Fatalf("data 形状不对：%s", text)
	}
	if got := env.Data.Frames[0].SourceEncodeUnixNs.String(); got != nsLiteral {
		t.Errorf("解出来的纳秒字面量 = %s，期望 %s", got, nsLiteral)
	}
}
