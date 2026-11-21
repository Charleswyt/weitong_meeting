//go:build edgeprobe

package thirdparty

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// 边端 ROI 实测探针。用 build tag 隔离：默认不编译、不进交付物、不留在产品链路里。
//
//	TP_BASE=https://10.66.216.73:18680 TP_ACCOUNT=chenfang TP_DEVICE=RK3588-BJ4 \
//	  go test -tags edgeprobe ./internal/service/thirdparty -run TestEdgeRoiProbe -v
//
// 输出只回状态码、字段值与地址前缀 —— 口令、participantToken、票据 query 一律不落日志。
func TestEdgeRoiProbe(t *testing.T) {
	base := os.Getenv("TP_BASE")
	account := os.Getenv("TP_ACCOUNT")
	device := os.Getenv("TP_DEVICE")
	if base == "" || account == "" {
		t.Skip("需要 TP_BASE 与 TP_ACCOUNT")
	}
	t.Setenv("THIRDPARTY_CONFERENCE_BASEURL", base)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	a := New()
	password := probePassword(t, account)
	auth, err := a.Login(ctx, account, password)
	if err != nil {
		t.Fatalf("登录失败: %s", describeUpstream(err))
	}
	t.Logf("登录 ok 账号=%s tokenLen=%d", account, len(auth.Token))

	meeting, err := a.QuickStart(ctx, auth.Token, &QuickStartReq{
		Title:           fmt.Sprintf("边端ROI探针 %s", time.Now().Format("1504")),
		DurationMinutes: 6,
		HostUsername:    account,
		CloudRecord:     false,
	})
	if err != nil {
		t.Fatalf("建会失败: %s", describeUpstream(err))
	}
	t.Logf("建会 ok meetingIdLen=%d meetingNumber=%s status=%s", len(meeting.MeetingId), meeting.MeetingNumber, meeting.Status)
	defer func() {
		if err := a.StopMeeting(context.Background(), auth.Token, meeting.MeetingId); err != nil {
			t.Logf("收尾停会失败: %s", describeUpstream(err))
		}
	}()

	endpointType := "ship"
	if !strings.Contains(base, "10.66.") {
		endpointType = "shore"
	}
	joined, err := a.JoinMeeting(ctx, auth.Token, &JoinReq{
		MeetingNumber: meeting.MeetingNumber,
		DisplayName:   "ROI 探针",
		AccountName:   account,
		EndpointType:  endpointType,
		DeviceId:      device,
	})
	if err != nil {
		t.Fatalf("入会失败: %s", describeUpstream(err))
	}
	pt := joined.ParticipantToken
	t.Logf("入会 ok participantId=%s tokenLen=%d endpointType=%s", joined.ParticipantId, len(pt), endpointType)
	defer func() {
		if err := a.LeaveMeeting(context.Background(), pt); err != nil {
			t.Logf("收尾离会失败: %s", describeUpstream(err))
		}
	}()

	for _, sourceType := range []string{"browser_whip", "rk_browser_roi"} {
		t.Run(sourceType, func(t *testing.T) {
			probeOnePublication(ctx, t, a, pt, sourceType, device, meeting.MeetingNumber)
		})
	}
}

func probeOnePublication(ctx context.Context, t *testing.T, a *Adapter, pt, sourceType, device, meetingNumber string) {
	payload := map[string]interface{}{
		"mediaKind":         "camera",
		"sourceType":        sourceType,
		"hasVideo":          true,
		"hasAudio":          false,
		"width":             1280,
		"height":            720,
		"fps":               20,
		"targetBitrateKbps": 600,
		"encodingStrategy":  "source_frames",
		"mediaLabel":        "roi-probe",
	}
	if sourceType == "rk_browser_roi" {
		payload["sourceDeviceId"] = device
	}

	raw, err := a.CreatePublication(ctx, pt, payload)
	if err != nil {
		t.Errorf("建发布被拒: %s", describeUpstream(err))
		return
	}
	var top map[string]interface{}
	if err := json.Unmarshal(raw, &top); err != nil {
		t.Fatalf("发布响应解析不了: %v", err)
	}
	pubId, whip := pickPublicationFields(top)
	t.Logf("建发布 ok publicationId=%s whip形状=%s", pubId, classifyWhip(whip))
	if pubId == "" {
		t.Fatalf("响应里没有 publicationId，键=%s", strings.Join(mapKeys(top), ","))
	}
	defer func() {
		if _, err := a.StopPublication(context.Background(), pt, pubId); err != nil {
			t.Logf("收尾停发布失败: %s", describeUpstream(err))
		}
	}()

	hintBody := func(regions []map[string]float64) map[string]interface{} {
		return map[string]interface{}{
			"detector":          "mediapipe_blazeface_short_range",
			"sequence":          1,
			"sourceTimestampMs": time.Now().UnixMilli(),
			"inferenceMs":       12,
			"regions":           regions,
		}
	}

	_, err = a.PostRoiHint(ctx, pt, pubId, hintBody([]map[string]float64{
		{
			"x":      0.32,
			"y":      0.28,
			"width":  0.30,
			"height": 0.34,
			"score":  0.91,
		},
	}))
	t.Logf("roi-hint 非空框 → %s", upstreamOrOK(err))

	_, err = a.PostRoiHint(ctx, pt, pubId, hintBody(nil))
	t.Logf("roi-hint 空数组 → %s", upstreamOrOK(err))

	if res, err := a.PreparePublication(ctx, pt, pubId, PrepareRolePublisher); err != nil {
		t.Logf("prepare(publisher) → %s", describeUpstream(err))
	} else {
		t.Logf("prepare(publisher) → 2xx ready=%v attached=%v why=%q", res.ReceiverReady, res.ConsumerAttached, res.WhyNotReady())
	}

	// 消费侧武装才决定"槽里有没有流"（实测 2026-10-12：不叫这一步，槽一直空着）。
	if res, err := a.PreparePublication(ctx, pt, pubId, PrepareRoleConsumer); err != nil {
		t.Logf("prepare(consumer) → %s", describeUpstream(err))
	} else {
		t.Logf("prepare(consumer) → 2xx ready=%v attached=%v why=%q", res.ReceiverReady, res.ConsumerAttached, res.WhyNotReady())
	}

	resp, err := a.GetMeetingState(ctx, pt, meetingNumber)
	if err != nil || resp == nil {
		t.Logf("读 /state 失败: %s", describeUpstream(err))
		return
	}
	lane := 0
	for _, p := range resp.Publications {
		if p.PublicationId != pubId {
			continue
		}
		t.Logf("state 回显 sourceType=%s status=%s directVideoCodec=%q directVideoFormat=%q rkDeliveryMode=%s lane=%d path=%s metrics=%v",
			p.SourceType, p.Status, p.DirectVideoCodec, p.DirectVideoFormat, p.RkDeliveryMode, p.RkReceiverLaneId, p.RkReceiverPath, p.TransportMetrics != nil)
		lane = p.RkReceiverLaneId
		break
	}
	if lane == 0 {
		t.Logf("这条发布没有 RK 接收槽（lane=0）")
		return
	}
	tele, teleErr := a.GetLocalTelemetry(ctx, fmt.Sprintf("/api/local/frame-times?lane=%d", lane))
	if teleErr != nil {
		t.Logf("frame-times(lane=%d) → %s", lane, describeUpstream(teleErr))
		return
	}
	// 统计响应里没有凭据，截一段原文只为看清形状。
	t.Logf("frame-times(lane=%d) → 2xx %dB 摘要=%s", lane, len(tele), headOf(tele, 120))
}

func headOf(b []byte, n int) string {
	s := strings.ReplaceAll(string(b), "\n", "")
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

func upstreamOrOK(err error) string {
	if err == nil {
		return "2xx"
	}
	return describeUpstream(err)
}

func describeUpstream(err error) string {
	if err == nil {
		return "2xx"
	}
	var ue *UpstreamError
	if errors.As(err, &ue) {
		body := string(ue.Body)
		if len(body) > 160 {
			body = body[:160] + "…"
		}
		return fmt.Sprintf("HTTP %d %s%s 正文=%q", ue.StatusCode, ue.Method, ue.Path, stripQuery(body))
	}
	return err.Error()
}

// 票据只可能出现在 query 里，去掉 query 与超长正文再打印。
func stripQuery(s string) string {
	if i := strings.IndexAny(s, "?&ticket="); i >= 0 && strings.Contains(s, "ticket") {
		return s[:i]
	}
	return s
}

// 三方按部署 mode 给的 whipUrl 形状不同，票据在 query 里 —— 只报形状分类，不报正文。
func classifyWhip(u string) string {
	if u == "" {
		return "(空)"
	}
	p, _, _ := strings.Cut(u, "?")
	switch {
	case strings.HasPrefix(p, "/__ship_local_media/"):
		return "船端本地媒体面 /__ship_local_media/<id>/whip"
	case strings.HasPrefix(p, "/__ship_cloud_media/"):
		return "船端转云端代理 /__ship_cloud_media/<base64>"
	case strings.HasPrefix(p, "https://"), strings.HasPrefix(p, "http://"):
		return "绝对地址（去 query 后）" + p
	default:
		if len(p) > 70 {
			p = p[:70] + "…"
		}
		return "其它相对路径: " + p
	}
}

func pickPublicationFields(top map[string]interface{}) (string, string) {
	pubId, _ := top["publicationId"].(string)
	whip, _ := top["whipUrl"].(string)
	if nested, ok := top["publication"].(map[string]interface{}); ok {
		if pubId == "" {
			pubId, _ = nested["publicationId"].(string)
		}
		if whip == "" {
			whip, _ = nested["whipUrl"].(string)
		}
	}
	return pubId, whip
}

func mapKeys(m map[string]interface{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// 三方口令从本地 TSV 取（`三方账号<TAB>口令`），不走命令行、不进日志。
func probePassword(t *testing.T, account string) string {
	t.Helper()
	path := os.Getenv("TP_CREDS_FILE")
	if path == "" {
		t.Fatal("需要 TP_CREDS_FILE：每行「三方账号<TAB>口令」的本地凭据文件")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读不到凭据文件 %s: %v", path, err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "\t", 2)
		if len(parts) == 2 && parts[0] == account {
			return parts[1]
		}
	}
	t.Fatalf("凭据文件里没有三方账号 %s", account)
	return ""
}
