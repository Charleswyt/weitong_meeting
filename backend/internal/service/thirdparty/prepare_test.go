// §10.1 `prepare` 的适配层形状测试。
//
// 为什么单独钉这一条：消费侧武装接收槽（`role=consumer`）是"让船端 RK 把云端流灌进那条局域网槽"
// 的唯一入口（实测 2026-10-12：不调它，槽永远是空的，WHEP 每 12 秒回一次 404）。
// 而三方表达"没起来"有**两种**写法 —— 还在起是 200 + `receiverReason`，起不来是 404 + §17 的
// `reason`（实测过 `rtsp_describe_404`）。如果非 2xx 被当成纯 error 丢掉，日志里就只剩
// 一句"订阅失败"，下一轮排查还是只能猜是谁的锅。所以这条测试钉的不是"能不能调通"，
// 而是**两种原因都必须活着回到调用方**。
package thirdparty

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPreparePublicationReturnsBodyAndErrorTogether(t *testing.T) {
	type captured struct {
		method string
		path   string
		token  string
		body   map[string]interface{}
	}
	var got captured

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.method = r.Method
		got.path = r.URL.Path
		got.token = r.Header.Get("X-Conference-Token")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &got.body)
		// 三种回答按发布号分派（把 query 拼进 publicationId 会连路径一起弄脏）。
		switch {
		case strings.HasSuffix(r.URL.Path, "/pub-starting/prepare"):
			// 还在起：200 + receiverReady:false
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"receiverReady":false,"receiverReason":"ingest_warmup:1"}`))
		case strings.HasSuffix(r.URL.Path, "/pub-ready/prepare"):
			// consumerAttached 刻意留 false：就绪判据一旦被人写成看它，本例当场红。
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"receiverReady":true,"consumerAttached":false}`))
		default:
			// 起不来：404 + §17 错误体
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"ok":false,"reason":"rtsp_describe_404"}`))
		}
	}))
	defer srv.Close()
	t.Setenv("THIRDPARTY_CONFERENCE_BASEURL", srv.URL)

	a := New()
	ctx := context.Background()

	t.Run("请求形状：路径/方法/令牌/体里的 role 与 publicationId", func(t *testing.T) {
		_, _ = a.PreparePublication(ctx, "ptok", "pub_9", PrepareRoleConsumer)
		if got.method != http.MethodPost || got.path != "/api/conference/publications/pub_9/prepare" {
			t.Fatalf("打到的是 %s %s，期望 POST /api/conference/publications/pub_9/prepare", got.method, got.path)
		}
		if got.token != "ptok" {
			t.Fatalf("prepare 必须带参会令牌（X-Conference-Token），实际 %q", got.token)
		}
		if got.body["role"] != "consumer" || got.body["publicationId"] != "pub_9" {
			t.Fatalf("请求体不对：%v —— role 与 publicationId 是三方定位这条 lane 的依据", got.body)
		}
	})

	t.Run("还在起：200 + receiverReason 要能读出来", func(t *testing.T) {
		res, err := a.PreparePublication(ctx, "ptok", "pub-starting", PrepareRoleConsumer)
		if err != nil {
			t.Fatalf("200 不该回 error：%v", err)
		}
		if res == nil || res.ReceiverReady {
			t.Fatalf("receiverReady=false 被读成了就绪：%+v", res)
		}
		if res.WhyNotReady() != "ingest_warmup:1" {
			t.Fatalf("原因丢了：%q", res.WhyNotReady())
		}
	})

	t.Run("起不来：404 必须同时回原因和错误", func(t *testing.T) {
		res, err := a.PreparePublication(ctx, "ptok", "pub-denied", PrepareRoleConsumer)
		if err == nil {
			t.Fatal("404 被吞成了成功 —— 调用方就分不出'没起来'和'起不来'")
		}
		if res == nil {
			t.Fatal("404 把响应体丢了 —— rtsp_describe_404 是唯一能定责的线索")
		}
		if res.ReceiverReady {
			t.Fatal("404 不该被读成就绪")
		}
		if res.WhyNotReady() != "rtsp_describe_404" {
			t.Fatalf("§17 的 reason 没接住，实际 %q", res.WhyNotReady())
		}
	})

	t.Run("就绪：只认 receiverReady", func(t *testing.T) {
		res, err := a.PreparePublication(ctx, "ptok", "pub-ready", PrepareRoleConsumer)
		if err != nil || res == nil || !res.ReceiverReady {
			t.Fatalf("就绪被判成没就绪：res=%+v err=%v", res, err)
		}
		if res.WhyNotReady() != "" {
			t.Fatalf("已就绪还硬凑一个原因：%q", res.WhyNotReady())
		}
	})
}

// WhyNotReady 的归并顺序也要钉住：两种写法同时出现时以 `receiverReason` 为准
// （它才是 §10.1 的字段，`reason` 只是 §17 错误体的兜底）。
// 判据自证：把顺序写反的实现在第二例上必红；把"就绪"也回原因的写法在第一例上必红。
func TestWhyNotReadyPrefersReceiverReason(t *testing.T) {
	for name, tc := range map[string]struct {
		in   PrepareResult
		want string
	}{
		"就绪时不许硬凑原因":                {PrepareResult{ReceiverReady: true, ReceiverReason: "stale"}, ""},
		"两种都在时以 receiverReason 为准": {PrepareResult{ReceiverReason: "ingest_warmup:2", Reason: "rtsp_describe_404"}, "ingest_warmup:2"},
		"只有 §17 错误体时兜到 reason":     {PrepareResult{Reason: "rtsp_describe_404"}, "rtsp_describe_404"},
		"两边都空就是空串":                 {PrepareResult{}, ""},
	} {
		if got := tc.in.WhyNotReady(); got != tc.want {
			t.Fatalf("%s: WhyNotReady() = %q，期望 %q", name, got, tc.want)
		}
	}
}
