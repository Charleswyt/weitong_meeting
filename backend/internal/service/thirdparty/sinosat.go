package thirdparty

import (
	"cloud-conference-backend/internal/model"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
)

// sinosatRoomByParticipant 把参会令牌映到 roomId。
// 公网会议族的 leave/end/streams/messages 路径都带 roomId，而调用方原先只持有参会令牌
// （Ocean 族路径不带会议号）。Join 成功时写入，Leave/End 时删掉。
var sinosatRoomByParticipant sync.Map // participantToken -> roomId

func (a *Adapter) IsSinosatV1(ctx context.Context) bool {
	u := a.getBaseURL(ctx)
	return strings.Contains(u, "/zwt-meeting/")
}

func (a *Adapter) bindSinosatRoom(participantToken, roomId string) {
	if participantToken == "" || roomId == "" {
		return
	}
	sinosatRoomByParticipant.Store(participantToken, roomId)
}

func (a *Adapter) unbindSinosatRoom(participantToken string) {
	if participantToken == "" {
		return
	}
	sinosatRoomByParticipant.Delete(participantToken)
}

func (a *Adapter) sinosatRoomOf(participantToken string) (string, error) {
	v, ok := sinosatRoomByParticipant.Load(participantToken)
	if !ok {
		return "", fmt.Errorf("公网会议：找不到该参会令牌对应的房间，请重新入会")
	}
	roomId, _ := v.(string)
	if roomId == "" {
		return "", fmt.Errorf("公网会议：房间号为空，请重新入会")
	}
	return roomId, nil
}

// sinosatAuth 公网会议族：账号令牌与参会令牌都走 Bearer（没有 X-Conference-Token）。
func (a *Adapter) sinosatAuthMode(auth int) int {
	if auth == authParticipant {
		return authBearer
	}
	return auth
}

func (a *Adapter) loginSinosat(ctx context.Context, account, password string) (*AuthResult, error) {
	data, err := a.doRequest(ctx, http.MethodPost, "/session", map[string]string{
		"username": account,
		"password": password,
	}, "", authNone)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Token     string `json:"token"`
		Username  string `json:"username"`
		ExpiresIn int64  `json:"expiresIn"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("unmarshal sinosat login: %w", err)
	}
	if raw.Token == "" {
		return nil, fmt.Errorf("公网会议登录未返回令牌")
	}
	return &AuthResult{
		OK:       true,
		Token:    raw.Token,
		Username: raw.Username,
		// 公网会议不回 accountType；下游只展示用，给个稳定占位。
		AccountType: "meeting_participant",
		ExpiresAt:   raw.ExpiresIn,
	}, nil
}

func (a *Adapter) logoutSinosat(ctx context.Context, token string) error {
	_, err := a.doRequest(ctx, http.MethodDelete, "/session", nil, token, authBearer)
	return err
}

func (a *Adapter) createRoomSinosat(ctx context.Context, token, title string) (*ThirdMeeting, error) {
	body := map[string]string{}
	if strings.TrimSpace(title) != "" {
		body["title"] = strings.TrimSpace(title)
	}
	data, err := a.doRequest(ctx, http.MethodPost, "/rooms", body, token, authBearer)
	if err != nil {
		return nil, err
	}
	var raw struct {
		RoomId       string  `json:"roomId"`
		Title        string  `json:"title"`
		CreatedAt    float64 `json:"createdAt"`
		RoomCapacity int     `json:"roomCapacity"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("unmarshal sinosat room: %w", err)
	}
	if raw.RoomId == "" {
		return nil, fmt.Errorf("公网会议创建未返回房间号")
	}
	return &ThirdMeeting{
		MeetingId:     raw.RoomId,
		MeetingNumber: raw.RoomId,
		Title:         raw.Title,
		Status:        "running",
		StartAt:       int64(raw.CreatedAt),
		CloudRecord:   false,
	}, nil
}

func (a *Adapter) listRoomsSinosat(ctx context.Context, token string) (*MeetingPage, error) {
	data, err := a.doRequest(ctx, http.MethodGet, "/rooms", nil, token, authBearer)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Rooms []struct {
			RoomId       string  `json:"roomId"`
			Title        string  `json:"title"`
			CreatedAt    float64 `json:"createdAt"`
			RoomCapacity int     `json:"roomCapacity"`
		} `json:"rooms"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("unmarshal sinosat rooms: %w", err)
	}
	page := &MeetingPage{OK: true}
	for _, r := range raw.Rooms {
		page.Meetings = append(page.Meetings, ThirdMeeting{
			MeetingId:     r.RoomId,
			MeetingNumber: r.RoomId,
			Title:         r.Title,
			Status:        "running",
			StartAt:       int64(r.CreatedAt),
		})
	}
	page.Pagination.Meetings.Total = len(page.Meetings)
	page.Pagination.Meetings.Limit = len(page.Meetings)
	return page, nil
}

func (a *Adapter) joinSinosat(ctx context.Context, token string, req *JoinReq) (*JoinResult, error) {
	roomId := strings.TrimSpace(req.MeetingNumber)
	if roomId == "" {
		return nil, fmt.Errorf("公网会议入会缺少房间号")
	}
	body := map[string]string{}
	if dn := strings.TrimSpace(req.DisplayName); dn != "" {
		body["displayName"] = dn
	}
	data, err := a.doRequest(ctx, http.MethodPost, "/rooms/"+roomId+"/join", body, token, authBearer)
	if err != nil {
		return nil, err
	}
	var raw struct {
		RoomId           string  `json:"roomId"`
		Title            string  `json:"title"`
		CreatedAt        float64 `json:"createdAt"`
		RoomCapacity     int     `json:"roomCapacity"`
		ParticipantId    string  `json:"participantId"`
		ParticipantToken string  `json:"participantToken"`
		Host             bool    `json:"host"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("unmarshal sinosat join: %w", err)
	}
	if raw.ParticipantToken == "" {
		return nil, fmt.Errorf("公网会议入会未返回参会令牌")
	}
	a.bindSinosatRoom(raw.ParticipantToken, raw.RoomId)
	hostPid := ""
	if raw.Host {
		hostPid = raw.ParticipantId
	}
	return &JoinResult{
		ParticipantId:    raw.ParticipantId,
		ParticipantToken: raw.ParticipantToken,
		Meeting: MeetingInfo{
			Title:             raw.Title,
			MeetingNumber:     raw.RoomId,
			MeetingId:         raw.RoomId,
			Status:            "running",
			StartAt:           int64(raw.CreatedAt),
			HostParticipantId: hostPid,
			ParticipantCount:  1,
		},
		State: &MeetingState{
			Status: "running",
			Participants: []ParticipantState{{
				ParticipantId: raw.ParticipantId,
				DisplayName:   req.DisplayName,
				IsHost:        raw.Host,
				Status:        "joined",
			}},
		},
	}, nil
}

func (a *Adapter) leaveSinosat(ctx context.Context, participantToken string) error {
	roomId, err := a.sinosatRoomOf(participantToken)
	if err != nil {
		return err
	}
	_, err = a.doRequest(ctx, http.MethodPost, "/rooms/"+roomId+"/leave", map[string]interface{}{}, participantToken, authBearer)
	a.unbindSinosatRoom(participantToken)
	return err
}

func (a *Adapter) endSinosat(ctx context.Context, participantToken string) error {
	roomId, err := a.sinosatRoomOf(participantToken)
	if err != nil {
		return err
	}
	_, err = a.doRequest(ctx, http.MethodPost, "/rooms/"+roomId+"/end", map[string]interface{}{}, participantToken, authBearer)
	a.unbindSinosatRoom(participantToken)
	return err
}

// stopSinosat 对应管理面「结束会议」：公网会议没有 management stop，
// GET /rooms 只列未结束房——不在列表即已结束；仍在列表则 join→end。
func (a *Adapter) stopSinosat(ctx context.Context, bearerToken, meetingId string) error {
	meetingId = strings.TrimSpace(meetingId)
	if meetingId == "" {
		return fmt.Errorf("公网会议结束缺少房间号")
	}
	page, err := a.listRoomsSinosat(ctx, bearerToken)
	if err != nil {
		return err
	}
	found := false
	for _, m := range page.Meetings {
		if m.MeetingId == meetingId || m.MeetingNumber == meetingId {
			found = true
			break
		}
	}
	if !found {
		return nil
	}
	jr, err := a.joinSinosat(ctx, bearerToken, &JoinReq{MeetingNumber: meetingId})
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "not_found") || strings.Contains(msg, "404") ||
			strings.Contains(msg, "ended") || strings.Contains(msg, "closed") {
			return nil
		}
		return err
	}
	return a.endSinosat(ctx, jr.ParticipantToken)
}

func (a *Adapter) getRoomSinosat(ctx context.Context, participantToken, roomId string) (*MeetingResponse, error) {
	if roomId == "" {
		var err error
		roomId, err = a.sinosatRoomOf(participantToken)
		if err != nil {
			return nil, err
		}
	} else {
		// 刷新路径带着 ExternalNo；同时回填映射，避免进程重启后 leave 找不到房。
		a.bindSinosatRoom(participantToken, roomId)
	}
	data, err := a.doRequest(ctx, http.MethodGet, "/rooms/"+roomId, nil, participantToken, authBearer)
	if err != nil {
		return nil, err
	}
	return mapSinosatRoomSnapshot(a.getBaseURL(ctx), roomId, data)
}

// Reporting observations shares the room snapshot round trip with the normal heartbeat.
func (a *Adapter) reportSinosatTelemetry(ctx context.Context, token string, media *MediaState) (*MeetingResponse, error) {
	room, err := a.sinosatRoomOf(token)
	if err != nil {
		return nil, err
	}
	data, err := a.doRequest(ctx, http.MethodPost, "/rooms/"+room+"/telemetry",
		map[string]interface{}{"items": media.VideoSourceTelemetry}, token, authBearer)
	if err != nil {
		return nil, err
	}
	return mapSinosatRoomSnapshot(a.getBaseURL(ctx), room, data)
}

// mapSinosatRoomSnapshot 把公网会议房间快照洗成我方 MeetingResponse / Publication 形状，
// 避免 Ocean 字段名外溢到控制层。
func mapSinosatRoomSnapshot(baseURL, roomId string, data []byte) (*MeetingResponse, error) {
	var raw struct {
		RoomId       string  `json:"roomId"`
		Title        string  `json:"title"`
		CreatedAt    float64 `json:"createdAt"`
		RoomCapacity int     `json:"roomCapacity"`
		Host         bool    `json:"host"`
		Self         string  `json:"self"`
		Participants []struct {
			ID          string `json:"id"`
			DisplayName string `json:"displayName"`
			Host        bool   `json:"host"`
		} `json:"participants"`
		Streams []struct {
			ID            string `json:"id"`
			ParticipantID string `json:"participantId"`
			Kind          string `json:"kind"`
			Label         string `json:"label"`
			Status        string `json:"status"`
			Revision      int    `json:"revision"`
			Settings      struct {
				Mode             string `json:"mode"`
				Codec            string `json:"codec"`
				EncodingStrategy string `json:"encodingStrategy"`
				Resolution       string `json:"resolution"`
				Fps              int    `json:"fps"`
				VideoKbps        int    `json:"videoKbps"`
			} `json:"settings"`
			Metrics struct {
				VideoStats       *model.VideoStats `json:"videoStats"`
				OutputCodecs     []string          `json:"outputCodecs"`
				SourceKbps       *float64          `json:"sourceKbps"`
				OutputKbps       *float64          `json:"outputKbps"`
				CompressionRatio *float64          `json:"compressionRatio"`
			} `json:"metrics"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("unmarshal sinosat room snapshot: %w", err)
	}
	if raw.RoomId == "" {
		raw.RoomId = roomId
	}
	base := strings.TrimRight(baseURL, "/")
	hostPid := ""
	parts := make([]ParticipantState, 0, len(raw.Participants))
	for _, p := range raw.Participants {
		if p.Host {
			hostPid = p.ID
		}
		parts = append(parts, ParticipantState{
			ParticipantId: p.ID,
			DisplayName:   p.DisplayName,
			IsHost:        p.Host,
			Status:        "joined",
		})
	}
	pubs := make([]Publication, 0, len(raw.Streams))
	for _, s := range raw.Streams {
		mediaKind := s.Kind
		if s.Kind == "microphone" {
			mediaKind = "audio"
		}
		pub := Publication{
			PublicationId: s.ID,
			ParticipantId: s.ParticipantID,
			MediaKind:     mediaKind,
			MediaLabel:    s.Label,
			Status:        mapSinosatStreamStatus(s.Status),
			SourceType:    "browser_whip",
			VideoStats:    s.Metrics.VideoStats,
			TransportMode: s.Settings.Mode, Revision: s.Revision,
		}
		if pub.VideoStats != nil && pub.VideoStats.CloudOutputFps != nil {
			pub.Fps = *pub.VideoStats.CloudOutputFps
		}
		if s.Settings.Mode == "cloud" && s.Kind != "microphone" {
			pub.CloudSoftwareRoi = s.Settings.Codec == "h264"
			pub.EncodingStrategy = s.Settings.EncodingStrategy
			pub.TargetBitrateKbps = s.Settings.VideoKbps
		}
		for _, codec := range s.Metrics.OutputCodecs {
			switch strings.ToLower(codec) {
			case "h264", "h265", "vp8", "vp9", "av1":
				pub.DirectVideoCodec = strings.ToLower(codec)
			}
		}
		if s.Metrics.SourceKbps != nil || s.Metrics.OutputKbps != nil {
			pub.TransportMetrics = &TransportMetrics{}
			if s.Metrics.SourceKbps != nil {
				pub.SourceVideoBitrateKbps = *s.Metrics.SourceKbps
				pub.TransportMetrics.SourceVideoBitrateKbps = *s.Metrics.SourceKbps
			}
			if s.Metrics.OutputKbps != nil {
				pub.TransportMetrics.UpstreamVideoBitrateKbps = *s.Metrics.OutputKbps
			}
			if s.Metrics.CompressionRatio != nil {
				pub.TransportMetrics.CompressionRatio = *s.Metrics.CompressionRatio
			}
		}
		// ready / standby 都给出可协商地址：standby 时仅发布端在房，他端尚未入会；
		// 他端入会后上游会升到 ready，地址不变。
		if s.Status == "ready" || s.Status == "standby" || s.Status == "compressing" {
			whep := fmt.Sprintf("%s/rooms/%s/streams/%s/whep", base, raw.RoomId, s.ID)
			whip := fmt.Sprintf("%s/rooms/%s/streams/%s/whip", base, raw.RoomId, s.ID)
			pub.WhipUrl = whip
			switch s.Kind {
			case "microphone":
				pub.AudioWhepUrl = whep
			default:
				pub.CloudWhepUrl = whep
				if s.Kind == "screen" {
					for _, codec := range s.Metrics.OutputCodecs {
						if strings.EqualFold(codec, "Opus") {
							pub.AudioWhepUrl = whep
							break
						}
					}
				}
			}
		}
		pubs = append(pubs, pub)
	}
	return &MeetingResponse{
		Meeting: MeetingInfo{
			Title:             raw.Title,
			MeetingNumber:     raw.RoomId,
			MeetingId:         raw.RoomId,
			Status:            "running",
			StartAt:           int64(raw.CreatedAt),
			HostParticipantId: hostPid,
			ParticipantCount:  len(parts),
			PublicationCount:  len(pubs),
		},
		Participants: parts,
		Publications: pubs,
	}, nil
}

func mapSinosatStreamStatus(s string) string {
	switch s {
	case "ready":
		return "ready"
	case "waiting", "standby", "compressing":
		return s
	default:
		return s
	}
}

func mapMediaKindToSinosat(mediaKind string) string {
	switch mediaKind {
	case "audio":
		return "microphone"
	case "camera", "screen":
		return mediaKind
	default:
		return mediaKind
	}
}

func (a *Adapter) createPublicationSinosat(ctx context.Context, participantToken string, payload map[string]interface{}) ([]byte, error) {
	roomId, err := a.sinosatRoomOf(participantToken)
	if err != nil {
		return nil, err
	}
	mediaKind, _ := payload["mediaKind"].(string)
	kind := mapMediaKindToSinosat(mediaKind)
	label, _ := payload["mediaLabel"].(string)
	if label == "" {
		switch kind {
		case "camera":
			label = "摄像头"
		case "microphone":
			label = "麦克风"
		case "screen":
			label = "共享屏幕"
		}
	}
	prefs := map[string]interface{}{"mode": "original"}
	if kind != "microphone" {
		if fps, ok := payload["fps"].(int); ok && fps > 0 && fps <= 60 {
			prefs["fps"] = fps
		}
		width, _ := payload["width"].(int)
		height, _ := payload["height"].(int)
		short := min(width, height)
		if short > 0 {
			switch {
			case short <= 360:
				prefs["resolution"] = "360p"
			case short <= 540:
				prefs["resolution"] = "540p"
			case short <= 720:
				prefs["resolution"] = "720p"
			default:
				prefs["resolution"] = "1080p"
			}
		}
		if payload["transportMode"] == "cloud" {
			prefs["mode"] = "cloud"
			if strategy, ok := payload["encodingStrategy"].(string); ok && strategy != "" {
				prefs["encodingStrategy"] = strategy
			}
			if budget, ok := payload["targetBitrateKbps"].(int); ok && budget > 0 {
				prefs["videoKbps"] = budget
			}
		}
	}
	body := map[string]interface{}{"kind": kind, "label": label, "settings": prefs}
	if w, ok := payload["width"].(int); ok && w >= 2 && w <= 8192 && kind != "microphone" {
		if h, ok := payload["height"].(int); ok && h >= 2 && h <= 8192 {
			body["sourceSize"] = []int{w, h}
		}
	}
	data, err := a.doRequest(ctx, http.MethodPost, "/rooms/"+roomId+"/streams", body, participantToken, authBearer)
	if err != nil {
		return nil, err
	}
	var raw struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(data, &raw); err != nil || raw.ID == "" {
		return nil, fmt.Errorf("公网会议登记媒体未返回 id: %w", err)
	}
	base := strings.TrimRight(a.getBaseURL(ctx), "/")
	whipURL := fmt.Sprintf("%s/rooms/%s/streams/%s/whip", base, roomId, raw.ID)
	// 控制层 parsePublication 认顶层 publicationId + whipUrl。
	out, _ := json.Marshal(map[string]string{
		"publicationId": raw.ID,
		"whipUrl":       whipURL,
	})
	return out, nil
}

func (a *Adapter) SetVideoSettings(ctx context.Context, token, pubID string, settings map[string]interface{}) ([]byte, error) {
	roomID, err := a.sinosatRoomOf(token)
	if err != nil {
		return nil, err
	}
	return a.doRequest(ctx, http.MethodPatch, "/rooms/"+roomID+"/streams/"+pubID, settings, token, authBearer)
}

func (a *Adapter) stopPublicationSinosat(ctx context.Context, participantToken, publicationId string) ([]byte, error) {
	roomId, err := a.sinosatRoomOf(participantToken)
	if err != nil {
		return nil, err
	}
	_, err = a.doRequest(ctx, http.MethodDelete,
		"/rooms/"+roomId+"/streams/"+publicationId, nil, participantToken, authBearer)
	return nil, err
}

func (a *Adapter) sendChatSinosat(ctx context.Context, participantToken, text string) error {
	roomId, err := a.sinosatRoomOf(participantToken)
	if err != nil {
		return err
	}
	_, err = a.doRequest(ctx, http.MethodPost, "/rooms/"+roomId+"/messages",
		map[string]string{"text": text}, participantToken, authBearer)
	return err
}

func (a *Adapter) listMessagesSinosat(ctx context.Context, participantToken string, afterId, limit int) ([]ChatMessage, int64, error) {
	roomId, err := a.sinosatRoomOf(participantToken)
	if err != nil {
		return nil, 0, err
	}
	path := fmt.Sprintf("/rooms/%s/messages?after=%d", roomId, afterId)
	data, err := a.doRequest(ctx, http.MethodGet, path, nil, participantToken, authBearer)
	if err != nil {
		return nil, 0, err
	}
	var raw struct {
		Messages []struct {
			ID            int64   `json:"id"`
			ParticipantID string  `json:"participantId"`
			DisplayName   string  `json:"displayName"`
			Text          string  `json:"text"`
			SentAt        float64 `json:"sentAt"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, 0, fmt.Errorf("unmarshal sinosat messages: %w", err)
	}
	out := make([]ChatMessage, 0, len(raw.Messages))
	var latest int64
	for _, m := range raw.Messages {
		out = append(out, ChatMessage{
			Id:         m.ID,
			Text:       m.Text,
			SenderName: m.DisplayName,
			SentAt:     int64(m.SentAt),
			SentAtMs:   int64(m.SentAt * 1000),
		})
		if m.ID > latest {
			latest = m.ID
		}
	}
	_ = limit
	return out, latest, nil
}
