package session

import (
	"testing"
	"time"

	"cloud-conference-backend/internal/service/thirdparty"
)

// 「原始速率 / 压缩比 / 节省带宽」三个数的**唯一真源**就是这份上报：订阅端算不出压缩前的编码码率，
// 只能读服务端把它转发成的该路 transportMetrics.sourceVideoBitrateKbps（契约 §6.3.1）。
// 所以这里钉三条不变量：
//  1. **发 0 比缺数更坏** —— 上游分不清"实测到 0"与"没测到"，所以 <=0 与空 publicationId 必须整条丢掉；
//  2. **逐路各一条** —— 摄像头与屏幕共享是两个独立发布，只报摄像头会让"看别人共享屏幕"那一格永远统计中；
//  3. **过期样本宁可不带** —— 三方只认 4 秒内的新鲜度（外部契约 :941-942），
//     带一份旧的等于让远端算出一个看起来很合理的倍率。
func TestSourceTelemetryFiltersAndExpires(t *testing.T) {
	rg := NewRegistry()
	rg.Join(1, "88744106", "meeting_x", &Session{UserId: 7})

	if !rg.UpdateSourceTelemetry(1, 7, []thirdparty.VideoSourceTelemetry{
		{PublicationId: "pub_cam", SourceVideoBitrateKbps: 1072.4, SourceFps: 25},
		{PublicationId: "pub_screen", SourceVideoBitrateKbps: 611, SourceFps: 15},
		{PublicationId: "", SourceVideoBitrateKbps: 900},        // 没有归属，丢掉
		{PublicationId: "pub_zero", SourceVideoBitrateKbps: 0},  // 实测到 0 与没测到在上游无法区分，丢掉
		{PublicationId: "pub_neg", SourceVideoBitrateKbps: -12}, // 同上
	}) {
		t.Fatal("会话在会中，UpdateSourceTelemetry 不该报失败")
	}

	media, ok := rg.NextMediaState(1, 7)
	if !ok {
		t.Fatal("NextMediaState 应当取到该会话的媒体状态")
	}
	if len(media.VideoSourceTelemetry) != 2 {
		t.Fatalf("只该留下 2 条有效样本（摄像头 + 屏幕共享各一条），实得 %d 条：%+v",
			len(media.VideoSourceTelemetry), media.VideoSourceTelemetry)
	}
	got := map[string]float64{}
	for _, it := range media.VideoSourceTelemetry {
		got[it.PublicationId] = it.SourceVideoBitrateKbps
	}
	if got["pub_cam"] != 1072.4 || got["pub_screen"] != 611 {
		t.Errorf("两路样本没原样带出（后端不该改写要透传给三方的值）：%+v", got)
	}

	// 过期即摘：把采样时刻推到 4 秒门外，样本必须整段消失（MediaState 上是 omitempty ⇒ 键都不出现），
	// 而不是带一份旧值让远端算出一个看起来很合理的倍率。
	room, _ := rg.Room(1)
	room.mu.Lock()
	room.Sessions[7].sourceTelemetryAt = time.Now().Add(-sourceTelemetryTTL - time.Second)
	room.mu.Unlock()

	media, _ = rg.NextMediaState(1, 7)
	if len(media.VideoSourceTelemetry) != 0 {
		t.Errorf("过期样本仍被带出：%+v", media.VideoSourceTelemetry)
	}
}

// 这一轮全被滤掉时不许留下上一轮的旧样本：那一轮的码率描述的是**当时**的编码器状态，
// 而三方会把它当"发布端此刻的编码码率"转发给所有订阅者。
func TestSourceTelemetryAllFilteredClearsPrevious(t *testing.T) {
	rg := NewRegistry()
	rg.Join(1, "88744106", "meeting_x", &Session{UserId: 7})
	rg.UpdateSourceTelemetry(1, 7, []thirdparty.VideoSourceTelemetry{
		{PublicationId: "pub_cam", SourceVideoBitrateKbps: 800},
	})
	rg.UpdateSourceTelemetry(1, 7, []thirdparty.VideoSourceTelemetry{
		{PublicationId: "pub_cam", SourceVideoBitrateKbps: 0},
	})

	media, ok := rg.NextMediaState(1, 7)
	if !ok {
		t.Fatal("NextMediaState 应当取到该会话的媒体状态")
	}
	if len(media.VideoSourceTelemetry) != 0 {
		t.Errorf("这一轮没测到，却带出了上一轮的 800kbps：%+v", media.VideoSourceTelemetry)
	}
}

// 不在会中（没有该会议的房间 / 没有该用户的会话）必须报失败，让 REST 出口能回「请先加入会议」，
// 而不是静默写进一个不存在的会话。
func TestSourceTelemetryRequiresSession(t *testing.T) {
	rg := NewRegistry()
	if rg.UpdateSourceTelemetry(1, 7, []thirdparty.VideoSourceTelemetry{
		{PublicationId: "pub_cam", SourceVideoBitrateKbps: 800},
	}) {
		t.Error("没有房间时不该报成功")
	}

	rg.Join(1, "88744106", "meeting_x", &Session{UserId: 7})
	if rg.UpdateSourceTelemetry(1, 8, []thirdparty.VideoSourceTelemetry{
		{PublicationId: "pub_cam", SourceVideoBitrateKbps: 800},
	}) {
		t.Error("用户 8 不在这场会里，不该报成功")
	}
	if _, ok := rg.NextMediaState(1, 8); ok {
		t.Error("用户 8 不在这场会里，NextMediaState 不该取到状态")
	}
}
