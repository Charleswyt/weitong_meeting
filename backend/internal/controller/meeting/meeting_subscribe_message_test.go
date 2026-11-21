package meeting

import (
	"strings"
	"testing"

	"cloud-conference-backend/internal/consts"

	"github.com/gogf/gf/v2/errors/gerror"
)

// 媒体订阅失败时，上游原始错误（带地址、协议名、运行时串）不能进弹窗 —— 只进日志（第 10/34 项）。
func TestSubscribeUserMessageKeepsInternalsOutOfCopy(t *testing.T) {
	raw := gerror.New(`http request POST /api/frontend/conference-media/whep: Post "https://10.0.0.8/whep": context deadline exceeded`)
	got := subscribeUserMessage(raw, consts.WhepKindVideo, true)
	for _, leak := range []string{"whep", "10.0.0.8", "conference-media", "context deadline", "http request"} {
		if strings.Contains(strings.ToLower(got), strings.ToLower(leak)) {
			t.Fatalf("文案泄漏了 %q：%s", leak, got)
		}
	}
	if !strings.Contains(got, "没有回应") {
		t.Fatalf("超时应说成媒体服务没回应，实际：%s", got)
	}
	for _, c := range []struct{ raw, want string }{
		{"status 401 participant_not_joined", "请先加入会议"},
		{"status 410 meeting_ended", "会议已结束"},
		{"status 404 meeting_not_found", "会议已结束"},
		{"connection refused", "没有回应"},
		{"some odd refusal", "没能订阅成功"},
	} {
		if got := subscribeUserMessage(gerror.New(c.raw), consts.WhepKindVideo, false); !strings.Contains(got, c.want) {
			t.Fatalf("raw=%q 期望含 %q，实际：%s", c.raw, c.want, got)
		}
	}
}

// 船端那条局域网槽"认得但里面没流"时，弹窗不许把上游英文原文或槽名贴给用户。
//
// 更正（实测 2026-10-12）：这条此前叫 `NamesTheRejoinAction`，钉的是"文案必须给出
// 退出后重新进入会议这个动作"，理由是"转发进程随参会者退出而收，重进就能恢复"。
// 那个前提已被本轮日志推翻（槽是这条发布自己的接收槽，404 = 里面没流 = 船端 RK 的接收进程
// 没起，与对端退没退无关）。所以这里**不再钉那句动作**，只钉"不外泄技术细节"这条下限。
func TestSubscribeUserMessageOnEmptyReceiverSlot(t *testing.T) {
	raw := gerror.New(`sdp endpoint returned 404: {"status":"error","error":"no stream is available on path 'conference/cam1'"}`)
	got := subscribeUserMessage(raw, consts.WhepKindVideo, true)
	for _, leak := range []string{"no stream", "conference/cam1", "path", "404"} {
		if strings.Contains(strings.ToLower(got), strings.ToLower(leak)) {
			t.Fatalf("文案泄漏了 %q：%s", leak, got)
		}
	}
	// 判据自证：上面那圈不许是空转 —— 拿上游原文过同一圈，必须命中（否则样本没带上游词，
	// 那圈判据在什么都漏的文案上也会照样绿）。
	tripped := false
	for _, leak := range []string{"no stream", "conference/cam1", "path", "404"} {
		if strings.Contains(strings.ToLower(raw.Error()), strings.ToLower(leak)) {
			tripped = true
		}
	}
	if !tripped {
		t.Fatal("自证样本没带上游原文，上面那圈泄漏判据等于没跑")
	}
}

// 「槽里没流」分两件不同的事，界面必须说两句不同的话。
//
// 实测依据（2026-10-13 两场会，四套实例各自回源的逐次快照，四份独立日志一致）：
//
//	会 90 的 `pub…343` 在 1833 次快照里 ready **0 次**（17:55:45→18:44:21 一次都没起来），
//	同场的 `pub…332` 却曾 ready、17:57:24–29 起永久回落 publishing。
//	会 91 的 `pub…353/360/370` 同样 0/135。
//
// 两句都被翻成「这一路画面已中断，请退出后重新进入会议」，于是对前者**断言了一次根本没发生过的
// 中断**，还给出一个代码自己标着未重测的动作（`meeting.go` 里那句 ⚠️）。
//
// 判据用"这位用户在这条腿上是否真的建起过会话"，不用发布状态：用户没见过画面时，
// 对他说"断了"就是撒谎 —— 而"曾经有过"只有他本人经历过才算数。
func TestSubscribeFailureDistinguishesNeverStartedFromDropped(t *testing.T) {
	emptySlot := gerror.New(`sdp endpoint returned 404: {"status":"error","error":"no stream is available on path 'conference/cam1'"}`)

	never := subscribeUserMessage(emptySlot, consts.WhepKindVideo, false)
	if !strings.Contains(never, "一直没准备好") {
		t.Fatalf("从未起来过的路应说「一直没准备好」，实际：%s", never)
	}
	for _, lie := range []string{"已中断", "退出", "重新进入"} {
		if strings.Contains(never, lie) {
			t.Fatalf("从未起来过的路不许说 %q（断言了一次没发生过的中断）：%s", lie, never)
		}
	}

	dropped := subscribeUserMessage(emptySlot, consts.WhepKindVideo, true)
	if !strings.Contains(dropped, "中断") {
		t.Fatalf("真从画面上掉下来的路要说「中断」，实际：%s", dropped)
	}

	// 音频腿不许共用"画面"那句（P3）。
	for _, leg := range []string{consts.WhepKindVideo, consts.WhepKindAudio} {
		for _, ever := range []bool{false, true} {
			got := subscribeUserMessage(emptySlot, leg, ever)
			if (leg == consts.WhepKindAudio) == strings.Contains(got, "画面") {
				t.Fatalf("腿=%s ever=%v 的文案用错了感官词：%s", leg, ever, got)
			}
		}
	}

	// 其余成因不受这个开关影响：超时/未入会跟"曾否有过画面"无关，两处各说各的。
	for _, raw := range []string{"context deadline exceeded", "status 401 participant_not_joined"} {
		if a, b := subscribeUserMessage(gerror.New(raw), consts.WhepKindVideo, false), subscribeUserMessage(gerror.New(raw), consts.WhepKindVideo, true); a != b {
			t.Fatalf("raw=%q 的文案不该随 everHadMedia 变：%q vs %q", raw, a, b)
		}
	}
}
