// 消费侧武装接收槽（`armRkReceiver`）的行为判据。
//
// 背景（实测 2026-10-12）：边端一路视频黑屏 14 分钟，每 12 秒订一次、每次都是
// `404 no stream is available on path 'conference/cam1'` —— 网关认得那条槽，但槽里没流，
// 因为船端 RK 的接收进程没人叫起来。三方叫起它的口子是 §10.1 `prepare{role:"consumer"}`，
// 我方此前从未调用过。这三条用例钉的就是"叫了之后怎么等、等多久、什么时候该收手"。
package meeting

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/service/thirdparty"
)

func TestArmRkReceiverWaitsPollsAndGivesUp(t *testing.T) {
	const readyAfter = 2 // 前两次说"还在起"，第三次说就绪

	for name, tc := range map[string]struct {
		// 桩的应答脚本：按命中次序返回
		replies  func(hit int) (status int, body string)
		budget   time.Duration
		want     bool
		wantHits int // 0 = 不校验次数
		minHits  int // 至少命中几次
	}{
		"轮询到就绪就停": {
			replies: func(hit int) (int, string) {
				if hit <= readyAfter {
					return http.StatusOK, `{"receiverReady":false,"receiverReason":"ingest_warmup"}`
				}
				return http.StatusOK, `{"receiverReady":true}`
			},
			budget:   3 * time.Second,
			want:     true,
			wantHits: readyAfter + 1,
		},
		"三方明确拒绝(404)就立刻收手，不空烧预算": {
			replies: func(int) (int, string) {
				return http.StatusNotFound, `{"ok":false,"reason":"rtsp_describe_404"}`
			},
			budget:   3 * time.Second,
			want:     false,
			wantHits: 1, // 判据自证：写成"继续轮"的话这里会远大于 1
		},
		"一直没就绪就按预算收手": {
			replies: func(int) (int, string) {
				return http.StatusOK, `{"receiverReady":false,"receiverReason":"waiting_media"}`
			},
			budget:  600 * time.Millisecond,
			want:    false,
			minHits: 2, // 判据自证：一次就回说明根本没在轮询
		},
	} {
		t.Run(name, func(t *testing.T) {
			var hits int64
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := int(atomic.AddInt64(&hits, 1))
				status, body := tc.replies(n)
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				_, _ = w.Write([]byte(body))
			}))
			defer srv.Close()
			t.Setenv("THIRDPARTY_CONFERENCE_BASEURL", srv.URL)

			c := New(nil, nil, nil, thirdparty.New(), nil, nil)
			got := c.armRkReceiver(context.Background(), "ptok", "pub_9", tc.budget)
			n := int(atomic.LoadInt64(&hits))

			if got != tc.want {
				t.Fatalf("armRkReceiver = %v，期望 %v（命中 %d 次）", got, tc.want, n)
			}
			if tc.wantHits != 0 && n != tc.wantHits {
				t.Fatalf("prepare 命中 %d 次，期望 %d 次", n, tc.wantHits)
			}
			if tc.minHits != 0 && n < tc.minHits {
				t.Fatalf("prepare 只命中 %d 次，少于 %d 次 —— 轮询没在跑", n, tc.minHits)
			}
		})
	}
}

// 三处武装动作的边界用源码扫描钉住：**browser_whip 侧不调，rk_browser_roi 侧必须调，消费侧必须调**。
//
// 为什么这几句要专门守：它们是同一个三方端点上**几条相反**的决定，且都写在同一个 package 里
// （browser_whip 那条来自 2026-09-25 实测 `rtsp_describe_404`，消费侧那条来自 2026-10-12 实测空槽，
// 船端发布侧那条来自三方的发布时序"先武装槽、再接轨道"）。下一次"统一一下逻辑"很容易把其中一条
// 合并掉 —— 而合并掉的代价要再到现场黑屏一次才看得见。
//
// 2026-11-05 重锚：发布侧原先写的是"一律不调"，那是在来源恒为 browser_whip 时成立的结论。
// 来源按端别分档后，船端浏览器那一路（rk_browser_roi）**必须**在创建发布时武装接收槽，
// 判据从"不调"改成"只在 rk_browser_roi 分支调一次"；browser_whip 那侧不调的结论不变。
//
// 下限断言（函数体必须真扫到）是防扫描器静默失效给出假"0 命中"，与 `errs/usermsg_scan_test.go` 同一手法。
func TestPrepareRoleBoundaryPerSide(t *testing.T) {
	whip := controllerFuncBody(t, "Whip")
	whep := controllerFuncBody(t, "StreamWhep")
	create := controllerFuncBody(t, "CreatePublication")

	// 只认**真实调用形式**（`c.armRkReceiver(` / `adapter.PreparePublication(`）：
	// 两侧的注释里都会提到对方的名字，扫裸函数名会把注释当代码。
	if strings.Contains(whip, "adapter.PreparePublication(") || strings.Contains(whip, "c.armRkReceiver(") {
		t.Fatal("转发 offer 那一侧出现了武装动作 —— 实测 prepare 对 browser_whip 回 404 rtsp_describe_404，那边不该调")
	}

	// 发布侧：来源必须由那一处判据给出（别在同一行里又写死一个词），
	// 且武装只在 rk_browser_roi 分支里、只调一次。
	if !strings.Contains(create, "publicationSourceType(") {
		t.Fatal("创建发布不再按端别/媒体类型推来源 —— 又写死成一种来源了")
	}
	// 申报值必须走常量：写回裸字面量的话，下次改词只改得到一处，两边就分叉了。
	if strings.Contains(create, `"`+consts.SourceTypeRkBrowserRoi+`"`) {
		t.Fatal("创建发布里出现了 sourceType 的裸字面量 —— 来源词只许从 consts 取")
	}
	gate := "if sourceType == consts.SourceTypeRkBrowserRoi {"
	gateAt := strings.Index(create, gate)
	armAt := strings.Index(create, "c.armRkReceiver(")
	if gateAt < 0 {
		t.Fatal("发布侧武装没有按 rk_browser_roi 门控 —— browser_whip 那一路会被白叫一次 404")
	}
	if n := strings.Count(create, "c.armRkReceiver("); n != 1 {
		t.Fatalf("发布侧武装调用点数 = %d，期望 1（只在 rk_browser_roi 分支）", n)
	}
	if armAt < gateAt {
		t.Fatal("发布侧武装跑到了门控外面 —— 那等于对 browser_whip 也调 prepare")
	}

	if !strings.Contains(whep, "c.armRkReceiver(") {
		t.Fatal("消费(WHEP)侧不再武装接收槽 —— 上游说'槽里没流'时我方就只剩一句 502，拿不出三方的原因")
	}
	// 只许在"槽空"那一条分支叫一次：订阅前无条件叫会给每条正常订阅白加一次失败往返
	// （实测三方对 browser_whip 回 404 publication_not_found）。
	if n := strings.Count(whep, "c.armRkReceiver("); n != 1 {
		t.Fatalf("消费侧武装调用点数 = %d，期望 1（只在空槽分支），多了就是给正常订阅加开销或在这里循环", n)
	}
}

// controllerFuncBody 取 `func (c *Controller) <name>(` 到该函数结束的那一段。
// 取不到就直接 fail —— 静默取空会让上面的判据变成"什么都没扫到所以全绿"。
func controllerFuncBody(t *testing.T, name string) string {
	t.Helper()
	src, err := os.ReadFile("meeting.go")
	if err != nil {
		t.Fatalf("读 meeting.go 失败，判据无法成立：%v", err)
	}
	sig := fmt.Sprintf("func (c *Controller) %s(", name)
	start := strings.Index(string(src), sig)
	if start < 0 {
		t.Fatalf("扫不到 %s —— 函数被改名了，这条边界判据已经失效", sig)
	}
	rest := string(src)[start:]
	end := strings.Index(rest, "\n}")
	if end <= 0 {
		t.Fatalf("%s 的函数体扫不出来", sig)
	}
	body := rest[:end]
	if len(body) < 200 {
		t.Fatalf("%s 函数体只扫到 %d 字节，扫描器判据已塌", sig, len(body))
	}
	return body
}
