package service

import (
	"context"
	"strconv"
	"strings"
	"sync"

	"github.com/gogf/gf/v2/os/glog"
	"github.com/gogf/gf/v2/os/gtime"

	"cloud-conference-backend/internal/consts"
	"cloud-conference-backend/internal/model"
	"cloud-conference-backend/internal/service/thirdparty"
	"cloud-conference-backend/internal/session"
)

// Roster 是本域侧的补充信息（受邀名单 + 账号头像），三方状态里没有。
type Roster struct {
	Invitees []Invitee
	Avatars  map[string]string
}

// BuildMeetingStateVo 把三方全量状态翻译成我方契约的 MeetingStateVo。
// 三方字段/令牌/URL 在此终结，不外泄一个字节（契约第 5.2 节）。
func BuildMeetingStateVo(meetingId int64, resp *thirdparty.MeetingResponse, room *session.MeetingRoom, roster *Roster) *model.MeetingStateVo {
	if resp == nil {
		return nil
	}
	if roster == nil {
		roster = &Roster{}
	}
	vo := &model.MeetingStateVo{
		MeetingId:        meetingId,
		Status:           resp.Meeting.Status,
		ServerTime:       resp.ServerUnixMs,
		ClockDriftMs:     resp.ServerClockUncertaintyMs,
		HostId:           resp.Meeting.HostParticipantId,
		ParticipantCount: resp.Meeting.ParticipantCount,
		CloudRecord:      resp.Meeting.CloudRecord,
		Recording:        aggregateRecording(resp.Meeting),
		Participants:     make([]model.ParticipantVo, 0, len(resp.Participants)),
		Streams:          make([]model.StreamVo, 0, len(resp.Publications)),
	}
	if resp.Meeting.StartedAtMs() > 0 {
		vo.StartedAt = gtime.NewFromTimeStamp(resp.Meeting.StartedAtMs() / 1000).Format("Y-m-d\\TH:i:sP")
	}
	if vo.ParticipantCount == 0 {
		vo.ParticipantCount = len(resp.Participants)
	}

	// 徽标以真实流为准：某成员"看得见/听得到"当且仅当上游 publications 里存在**已就绪且带可播端点**
	// 的发布。cameraEnabled/microphoneEnabled 只是客户端自报意图 —— 实测只发意图不走 WHIP 发布时，
	// 上游名单显示"摄像头已开"，但其他端既无画面也无声音，所以不能拿意图位当状态用。
	realMedia := make(map[string]mediaPresence, len(resp.Publications))
	for _, pub := range resp.Publications {
		if !pubReady(pub) {
			continue
		}
		p := realMedia[pub.ParticipantId]
		// sharing 同样以真实发布为准（意图位会撒谎）；camera 位排除 screen 发布，
		// 否则"只共享不露脸"会被误判成摄像头已开。
		if pub.MediaKind == "screen" {
			p.sharing = p.sharing || pubHasVideo(pub)
		} else {
			p.camera = p.camera || pubHasVideo(pub)
		}
		p.mic = p.mic || pubHasAudio(pub)
		realMedia[pub.ParticipantId] = p
	}

	nameById := make(map[string]string, len(resp.Participants))
	for _, p := range resp.Participants {
		nameById[p.ParticipantId] = p.DisplayName
		// 主持人只认会议级 hostParticipantId 一个来源；它为空（上游未给出）时才退回成员级标记。
		// 原先两者做 OR，一旦上游两侧不一致就会出现多个"主持人"。
		isHost := p.ParticipantId == resp.Meeting.HostParticipantId
		if resp.Meeting.HostParticipantId == "" {
			isHost = p.IsHost
		}
		vo.Participants = append(vo.Participants, model.ParticipantVo{
			Id:        p.ParticipantId,
			Name:      p.DisplayName,
			IsHost:    isHost,
			NodeType:  NodeTypeOf(p.EndpointType),
			CameraOn:  realMedia[p.ParticipantId].camera,
			MicOn:     realMedia[p.ParticipantId].mic,
			Sharing:   realMedia[p.ParticipantId].sharing,
			Recording: p.LocalRecording,
			Account:   p.AccountName,
			Avatar:    roster.Avatars[p.AccountName],
		})
	}
	vo.Invited = MatchInvited(roster.Invitees, vo.Participants)

	aliasByPub := make(map[string]string)
	if room != nil {
		for _, a := range room.Streams {
			aliasByPub[a.PublicationId] = a.StreamId
		}
	}

	for _, pub := range resp.Publications {
		streamId, ok := aliasByPub[pub.PublicationId]
		if !ok {
			continue
		}
		hasVideo := pubHasVideo(pub)
		hasAudio := pubHasAudio(pub)
		videoChannel := VideoLegChannel(pub)
		sv := model.StreamVo{
			Id:                streamId,
			OwnerId:           pub.ParticipantId,
			OwnerName:         nameById[pub.ParticipantId],
			Kind:              pub.MediaKind,
			Video:             hasVideo,
			Audio:             hasAudio,
			Width:             pub.WidthPx(),
			Height:            pub.HeightPx(),
			Fps:               pub.FpsInt(),
			SourceBitrateKbps: pub.SourceBitrateKbps(),
			// 本端那一路的压缩比分母：与上面那个数同在"发布端→分发面"这一条腿上。
			// 三方自己也是这么分的（ownRows 用 upstreamVideoBitrateKbps 做分母，remoteRows 用本机接收值）。
			IngressBitrateKbps: pub.UpstreamBitrateKbps(),
			CompressionKind:    pub.CompressionKind(),
			// 倍率的退路值与"是不是估算"一起给：前端报不报倍率仍以 compressionKind 为准，
			// 这个数只在 kind 说明确实有压缩、而本端两个数凑不出来时才用。
			CompressionRatio:     pub.CompressionRatio(),
			CompressionEstimated: pub.CompressionEstimated(),
			VideoCodec:           pub.VideoCodec(),
			VideoChannel:         videoChannel,
			Active:               pubReady(pub),
		}
		base := "/api/v1/meetings/" + strconv.FormatInt(meetingId, 10) + "/media/" + streamId
		// 视频端点只在**这条 GET 通路真给得出地址**时才挂。边端形态下这一路的视频腿是 WHEP，
		// 挂着 /media/…/video 等于让前端每 1.5 秒去取一个注定 503 的地址 —— 表现就是"这路画面一直没准备好"。
		if videoChannel == consts.VideoChannelDirect {
			sv.Endpoints.Video = base + "/video"
		}
		if hasAudio {
			sv.Endpoints.Audio = base + "/audio"
		}
		vo.Streams = append(vo.Streams, sv)
	}
	return vo
}

// mediaPresence 记录某成员当前是否真有可消费的视频/音频发布。
type mediaPresence struct {
	camera  bool
	mic     bool
	sharing bool
}

// pubReady 判定发布是否已就绪：状态 ready，或已分到板卡接收通道。
// pubReady 按三方文档第 10.2 节的活跃判定：status=ready、hdReady、有 RK 接收槽位，三者其一即活跃。
// 另外**只要上游给了任一可播通道就算活跃**：岸端手机的音频发布实测只有 audioWhepUrl，
// 既没有 status=ready 也没有 hdReady，按原文判会把它判成"没开麦"，成员徽标就撒谎了。
// 但 stopped/failed 是终态——三方停止后仍会把 audioWhepUrl 留在快照里，不先排除终态，
// 刷新页面就会给同一成员挂出多块"死瓦片"（实测 09-27：重载后 admin/test2 各出现 2-3 块）。
func pubReady(pub thirdparty.Publication) bool {
	if pub.Status == "stopped" || pub.Status == "failed" {
		return false
	}
	return pub.Status == "ready" || pub.HdReady || pub.RkReceiverLaneId > 0 ||
		pub.DirectVideoUrl != "" || pub.DirectAudioUrl != "" ||
		pub.AudioWhepUrl != "" || pub.RkReceiverWhepUrl != "" || pub.RkReceiverAudioWhepUrl != "" ||
		pub.CloudWhepUrl != ""
}

// pubHasVideo 只认视频端点。RkReceiverAudioWhepUrl 是音频通道，不能算作视频。
// RK 那条腿的"端点"有两种写法：网关直接给地址，或只给接收槽路径（由消费方拼
// /__ship_lan_whep/{path}/whep）—— 两种都算有视频，否则会出现"通道判据说有、端点判据说没有"。
func pubHasVideo(pub thirdparty.Publication) bool {
	return pub.DirectVideoUrl != "" || pub.RkReceiverWhepUrl != "" || pub.RkReceiverPath != "" || pub.CloudWhepUrl != ""
}

// VideoLegChannel 定这一路的视频腿走哪条通道，前端按这个机器值选播放器，不去猜错误文案。
//
// RK 局域网 WHEP **只在边端实例上签**：那是船端局域网地址，岸端浏览器协商能回 200、ICE 却永远不可达，
// 症状是"这一格永远黑"。边端实例的消费者就在同一条局域网里（现场那台平板/工位机连的就是船内网）。
//
// 门禁照三方船端客户端自己那一条（meeting.js 的 useRkReceiver，两侧文件同哈希）：
// **投递模式 + 接收槽号 + 路径/地址三者齐备**才算有这条腿。
//
// 更正（实测 2026-10-12）：这里此前写的理由是"`conference/cam1` 是网关回填的本机 RK 输入槽名，
// 只看路径会订到别人的槽"—— 那是误判。真相是 `lane=N ↔ path=conference/camN` 逐参会者对应，
// 它就是**这条发布自己的接收槽**；订它回 404 `no stream is available on path` 的意思是
// **槽里没流**（船端 RK 的接收进程没起，见 controller 的 armRkReceiver），不是"订错了地方"。
// 三件套这条判据本身仍然照三方保留：缺 `rkReceiverLaneId` 就是三方还没给这条发布分配槽，
// 签出去只会换出一条永远不亮的瓦片。
func VideoLegChannel(pub thirdparty.Publication) string {
	if pub.CloudWhepUrl != "" {
		return consts.VideoChannelCloudWhep
	}
	if pub.DirectVideoUrl != "" {
		return consts.VideoChannelDirect
	}
	if DeploymentSide == "edge" && pub.RkDeliveryMode == "raw_hevc_forward" && pub.RkReceiverLaneId > 0 &&
		(pub.RkReceiverPath != "" || pub.RkReceiverWhepUrl != "") {
		return consts.VideoChannelLanWhep
	}
	return ""
}

func pubHasAudio(pub thirdparty.Publication) bool {
	return pub.DirectAudioUrl != "" || pub.AudioWhepUrl != "" || pub.RkReceiverAudioWhepUrl != ""
}

func aggregateRecording(m thirdparty.MeetingInfo) model.RecordingStateVo {
	if len(m.BoardRecordings) == 0 {
		if m.CloudRecord {
			return model.RecordingStateVo{Active: false, State: "idle"}
		}
		return model.RecordingStateVo{Active: false, State: "idle"}
	}
	rec := model.RecordingStateVo{}
	for _, b := range m.BoardRecordings {
		switch b.State {
		case "recording", "waiting_media":
			rec.Active = true
			rec.State = "recording"
		case "starting":
			if rec.State == "" {
				rec.State = "starting"
			}
		case "stopped":
			if rec.State == "" {
				rec.State = "stopping"
			}
		case "error", "unconfirmed", "interrupted":
			rec.State = "error"
		}
	}
	if rec.State == "" {
		rec.State = "idle"
	}
	return rec
}

// DeploymentSide 是本实例部署在哪一侧（config 的 deployment.side，由 cmd 启动时写入）。
// 三方没报某个参会者的端点类型时用它兜底。本单元是边端应用，默认 edge。
var DeploymentSide = "edge"

var (
	nodeTypeWarnMu sync.Mutex
	nodeTypeWarned = map[string]bool{}
)

// NodeTypeOf 把三方 endpointType 映射成我方 edge/cloud。全系统只有这一份映射
// （WebSocket 广播以前另写了一份，丢了兜底，导致同一个人的端类型在两处不一致）。
//
// 实测值（2026-09-28 逆向）：ship=船端→edge、shore=岸端→cloud；
// 同时兼容我方侧可能直接报的 edge/cloud/board。
// 取不到侧别（空值）与不认识的值都按本实例 deployment.side 兜底；该项默认 edge，
// 所以「不知道是哪端」的参会者显示边端（2026-09-29 口径）。
// 不认识的值仍然告警：不假装认识它。
func NodeTypeOf(endpointType string) string {
	switch strings.ToLower(strings.TrimSpace(endpointType)) {
	case "ship", "edge", "board":
		return "edge"
	case "shore", "cloud":
		return "cloud"
	case "":
		return DeploymentSide
	}
	warnUnknownNodeType(endpointType)
	return DeploymentSide
}

func warnUnknownNodeType(value string) {
	nodeTypeWarnMu.Lock()
	defer nodeTypeWarnMu.Unlock()
	if nodeTypeWarned[value] {
		return
	}
	nodeTypeWarned[value] = true
	glog.Warningf(context.Background(), "未识别的端类型 %q，按云端展示；请补进 NodeTypeOf 映射表", value)
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	buf := [20]byte{}
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
