//go:build pubprobe

package thirdparty

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"
)

// 只读探针：登三方、拉一场在开会议的 state，把每条发布的三方侧观测原样打出来。
// 用来判"发布停在 publishing"到底是**没收到帧**还是**收到了帧但三方不认**。
//
//	TP_BASE=<三方地址> TP_ACCOUNT=<三方账号> TP_PASSWORD=<口令> TP_MEETING=<会议号> \
//	  go test -tags pubprobe ./internal/service/thirdparty -run TestPublicationProbe -v
//
// 口令只从环境变量读；输出不含令牌，只含状态、规格与码率。
func TestPublicationProbe(t *testing.T) {
	base, account, password, number := os.Getenv("TP_BASE"), os.Getenv("TP_ACCOUNT"), os.Getenv("TP_PASSWORD"), os.Getenv("TP_MEETING")
	if base == "" || account == "" || password == "" || number == "" {
		t.Skip("需要 TP_BASE / TP_ACCOUNT / TP_PASSWORD / TP_MEETING")
	}
	t.Setenv("THIRDPARTY_CONFERENCE_BASEURL", base)

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	a := New()
	auth, err := a.Login(ctx, account, password)
	if err != nil {
		t.Fatalf("登录失败: %v", err)
	}
	t.Logf("登录 ok 账号=%s tokenLen=%d", account, len(auth.Token))

	// 三方 /state 只认三方会议号；先分页列出在开的会，拿到号再查详情。
	page, err := a.GetMeetingPage(ctx, auth.Token, MeetingQuery{Status: []string{"running"}, Detail: "full", Limit: 10})
	if err != nil {
		t.Fatalf("列会议失败: %v", err)
	}
	for _, m := range page.Meetings {
		t.Logf("会议 number=%s meetingId=%s status=%s title=%s", m.MeetingNumber, m.MeetingId, m.Status, m.Title)
		if number != "" && m.MeetingNumber != number {
			continue
		}
		st, err := a.GetMeetingState(ctx, auth.Token, m.MeetingNumber)
		if err != nil {
			t.Logf("  拉 state 失败: %v", err)
			continue
		}
		for _, p := range st.Publications {
			tm := "transportMetrics=nil"
			if p.TransportMetrics != nil {
				b, _ := json.Marshal(p.TransportMetrics)
				tm = string(b)
			}
			t.Logf("  pub=%s kind=%s status=%s hdReady=%v 登记=%vx%v@%.1ffps srcKbps=%.0f %s codec=%q fmt=%q directUrl=%q",
				p.PublicationId, p.MediaKind, p.Status, p.HdReady,
				p.Width, p.Height, p.Fps, p.SourceVideoBitrateKbps, tm,
				p.DirectVideoCodec, p.DirectVideoFormat, urlPrefix(p.DirectVideoUrl))
		}
	}
}

// urlPrefix 只回路径前缀：directVideoUrl 的 query 里带票据，不许进日志。
func urlPrefix(u string) string {
	if len(u) > 48 {
		return u[:48]
	}
	return u
}
