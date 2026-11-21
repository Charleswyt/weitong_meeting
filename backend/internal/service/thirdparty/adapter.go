package thirdparty

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gogf/gf/v2/frame/g"
)

const (
	authNone = iota
	authBearer
	authParticipant
)

type Adapter struct {
	httpClient   *http.Client
	streamClient *http.Client
}

func New() *Adapter {
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}
	a := &Adapter{
		httpClient: &http.Client{Timeout: 10 * time.Second, Transport: transport},
		// 不带整请求超时的 client：**只给"响应体又大又流式"的请求用**（直播媒体流、录制归档下载、HLS 分片）。
		// `httpClient` 的 10 秒是**含读完 body** 的整请求超时，用它代理 GB 级归档会在 10 秒整被掐断，
		// 而调用方（controller.Download）还在照抄上游的 Content-Length —— 用户拿到的是**静默截断**的文件：
		// MP4 能打开但拖不动进度条、也调不了倍速（"下载后不可用"最难查的一种形态）。
		// 这类请求的兜底是请求 ctx（浏览器断开即取消），不是墙钟。
		streamClient: &http.Client{Transport: transport},
	}
	return a
}

// FetchVendorAsset 取平台托管的静态资产（如三方直连媒体播放器）。
// 按 vendor-assets 规约第 4 条：不复制副本进我们的仓，只引用平台托管的那一份。
//
// 公网会议族 API base 挂在 `/zwt-meeting/api/v1` 下，但静态资产仍挂在同源根 `/assets/`
// （实测 2026-11-21：`…/zwt-meeting/api/v1/assets/zwt-direct-media.js` → 404，
// `https://<host>/assets/zwt-direct-media.js` → 200）。对 `/assets/` 路径只用 origin。
func (a *Adapter) FetchVendorAsset(ctx context.Context, path string) ([]byte, error) {
	base := a.getBaseURL(ctx)
	if strings.HasPrefix(path, "/assets/") {
		base = a.vendorAssetOrigin(ctx)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base, "/")+path, nil)
	if err != nil {
		return nil, fmt.Errorf("create asset request: %w", err)
	}
	resp, err := a.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch asset %s: %w", path, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read asset %s: %w", path, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("asset %s returned %d", path, resp.StatusCode)
	}
	return body, nil
}

// vendorAssetOrigin 静态资产所在 origin（scheme+host），不含 API path。
func (a *Adapter) vendorAssetOrigin(ctx context.Context) string {
	base := a.getBaseURL(ctx)
	u, err := url.Parse(base)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return strings.TrimRight(base, "/")
	}
	return u.Scheme + "://" + u.Host
}

// GetLocalTelemetry 取船端网关的**本机遥测**端点（实测形状：`/api/local/frame-times?lane=N`）。
// 原样回字节、不在我方解析：那响应里每帧的采集时刻是 Unix **纳秒**、源钟标识是 64 位整数，
// 两者都超出 JSON number 的安全整数范围 —— 过一遍 struct 就会被 float 静默改掉末几位。
// 它不需要凭据（实测不带任何头就回数据），但只在船内网可达：我方页面在另一个源上，
// 直连必撞跨源，所以这层代理是必需的而不是图省事。
func (a *Adapter) GetLocalTelemetry(ctx context.Context, path string) ([]byte, error) {
	// 复用的是"无凭据取原始字节"这一条通路（与托管资产同一类），不另写一份 HTTP。
	return a.FetchVendorAsset(ctx, path)
}

func (a *Adapter) getBaseURL(ctx context.Context) string {
	// 环境变量优先：容器部署时换三方地址不必挂自己的 config.yaml。
	// GoFrame v2 的 MustGetEffective 对嵌套键读不到 YAML 值，手动实现 fallback。
	if v := os.Getenv("THIRDPARTY_CONFERENCE_BASEURL"); v != "" {
		return v
	}
	return g.Cfg().MustGet(ctx, "thirdParty.conference.baseUrl", "").String()
}

// resolveTarget 把三方签发的**裸路径**媒体地址补成绝对地址。
// 三方按部署 mode 决定这个字段的形状：云端（`cloud`）发绝对 `https://<host>/conference/browser/...`，
// 船端网关（`ship-local`）发 `/__ship_cloud_media/<base64url(云端绝对地址)>` —— 相对"我方刚调的那个 origin"，
// 三方自己的页面也是按 `location.origin` 拼（mode 由服务端注入两枚 meta 声明，API 层看不见）。
// 原样发出去会在 transport 层得到 unsupported protocol scheme ""（NewRequest 不拦），WHIP/WHEP 全线转发失败。
// **不要改成"解 base64 直连云端"**：网关对 target 有白名单（外部目标实测 403 `media_target_forbidden`），
// 且船端局域网本就未必能公网直连。
func (a *Adapter) resolveTarget(ctx context.Context, targetURL string) string {
	if targetURL == "" || strings.HasPrefix(targetURL, "http") {
		return targetURL
	}
	base := a.getBaseURL(ctx)
	if base == "" {
		return targetURL
	}
	b, err := url.Parse(base)
	if err != nil || b.Scheme == "" {
		return base + targetURL
	}
	ref, err := url.Parse(targetURL)
	if err != nil {
		return base + targetURL
	}
	return b.ResolveReference(ref).String()
}

// UpstreamError 三方非 2xx 的回答：保留状态码与原始 body，让调用方按业务码分句，
// 而不是只拿到一个被拼平的字符串。**Error() 的文本与旧实现逐字相同** —— 各处 UserMessage
// 归译都按 err.Error() 做字符串匹配，改文本会把它们一起改坏。
type UpstreamError struct {
	Method     string
	Path       string
	StatusCode int
	Body       []byte
}

func (e *UpstreamError) Error() string {
	return fmt.Sprintf("third-party API %s %s returned %d: %s", e.Method, e.Path, e.StatusCode, string(e.Body))
}

// doRequest 发起三方请求（走 `httpClient`：整请求 10s 超时，只适合"小而快"的 JSON 端点）。
// 大响应体的资产（录制归档、HLS 分片）与直播流一律走 `streamClient`，见 New() 里的说明。
func (a *Adapter) doRequest(ctx context.Context, method, path string, body interface{}, token string, auth int) ([]byte, error) {
	return a.doRequestClient(ctx, a.httpClient, method, path, body, token, auth)
}

// doRequestClient 允许指定 http client（如慢端点走不受 30s 掐的 slowClient），
// 超时由 client.Timeout + 调用方 ctx 共同兜底。
func (a *Adapter) doRequestClient(ctx context.Context, client *http.Client, method, path string, body interface{}, token string, auth int) ([]byte, error) {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal request body: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	url := a.getBaseURL(ctx) + path
	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	switch auth {
	case authBearer:
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
	case authParticipant:
		if token != "" {
			req.Header.Set("X-Conference-Token", token)
		}
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http request %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &UpstreamError{Method: method, Path: path, StatusCode: resp.StatusCode, Body: respBody}
	}

	return respBody, nil
}

// doRequestDual 管理面端点，会议页实测同时携带 Bearer 与 X-Conference-Token。
func (a *Adapter) doRequestDual(ctx context.Context, method, path string, body interface{}, bearer, participant string) ([]byte, error) {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal request body: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}
	url := a.getBaseURL(ctx) + path
	req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	if participant != "" {
		req.Header.Set("X-Conference-Token", participant)
	}
	resp, err := a.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http request %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &UpstreamError{Method: method, Path: path, StatusCode: resp.StatusCode, Body: respBody}
	}
	return respBody, nil
}

func (a *Adapter) GetSm2PublicKey(ctx context.Context) (*Sm2PublicKey, error) {
	data, err := a.doRequest(ctx, http.MethodGet, "/api/frontend/auth/sm2-public-key", nil, "", authNone)
	if err != nil {
		return nil, err
	}
	var result Sm2PublicKey
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("unmarshal sm2 public key: %w", err)
	}
	return &result, nil
}

func (a *Adapter) Login(ctx context.Context, account, password string) (*AuthResult, error) {
	if a.IsSinosatV1(ctx) {
		return a.loginSinosat(ctx, account, password)
	}
	desc, err := a.GetSm2PublicKey(ctx)
	if err != nil {
		return nil, fmt.Errorf("获取三方 SM2 公钥失败: %w", err)
	}

	nonce := make([]byte, 18)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("生成登录随机数失败: %w", err)
	}

	envelope, err := json.Marshal(map[string]interface{}{
		"username":   account,
		"password":   password,
		"challenge":  desc.Challenge,
		"issuedAtMs": time.Now().UnixMilli(),
		"nonce":      hex.EncodeToString(nonce),
	})
	if err != nil {
		return nil, fmt.Errorf("构造登录信封失败: %w", err)
	}

	ciphertext, err := EncryptSm2Envelope(envelope, desc.PublicKey)
	if err != nil {
		return nil, err
	}

	payload := map[string]string{
		"username":           account,
		"algorithm":          "SM2",
		"keyId":              desc.KeyID,
		"challenge":          desc.Challenge,
		"cipherMode":         "C1C3C2",
		"ciphertextEncoding": "c1c3c2-hex",
		"ciphertext":         ciphertext,
	}
	data, err := a.doRequest(ctx, http.MethodPost, "/api/frontend/auth/login", payload, "", authNone)
	if err != nil {
		return nil, err
	}
	var result AuthResult
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("unmarshal login result: %w", err)
	}
	if result.Token == "" {
		return nil, fmt.Errorf("三方登录未返回令牌")
	}
	return &result, nil
}

// Logout 结束三方侧的登录会话。存在性与语义都是直连平台实测出来的（2026-09-29）：
// 回 `200 {ok:true}`，之后原 Bearer 打 `/auth/me` 得到 `401 {reason:login_required}`
// —— 是真的作废令牌，不是空操作；不带令牌、重复调用也都回 200，
// 所以调用方可以放心做 best-effort。探针与逐条结果见契约文档 20260928 §11。
func (a *Adapter) Logout(ctx context.Context, token string) error {
	if a.IsSinosatV1(ctx) {
		return a.logoutSinosat(ctx, token)
	}
	_, err := a.doRequest(ctx, http.MethodPost, "/api/frontend/auth/logout", nil, token, authBearer)
	return err
}

// MeetingQuery 是 /meetings 集合查询的条件。字段名与取值都是实测可用形状（2026-09-28）。
type MeetingQuery struct {
	Status    []string // scheduled,starting,running,ended,cancelled,failed,deleted
	Owner     string   // "mine" 或留空（all）
	Q         string
	StartFrom int64
	StartTo   int64
	Order     string // asc / desc
	Detail    string // summary / full
	Limit     int
	Offset    int
}

// GetMeetingPage 走三方的服务端分页会议列表：实测 ~100ms，且 status/owner 由服务端按权限过滤。
// 它取代"拉 /state 全租户聚合再自己筛"的旧路子——后者实测含完整媒体详情时要 ~78 秒。
func (a *Adapter) GetMeetingPage(ctx context.Context, token string, q MeetingQuery) (*MeetingPage, error) {
	if a.IsSinosatV1(ctx) {
		return a.listRoomsSinosat(ctx, token)
	}
	vals := url.Values{}
	if len(q.Status) > 0 {
		vals.Set("status", strings.Join(q.Status, ","))
	}
	if q.Owner != "" {
		vals.Set("owner", q.Owner)
	}
	if q.Q != "" {
		vals.Set("q", q.Q)
	}
	if q.StartFrom > 0 {
		vals.Set("startFrom", strconv.FormatInt(q.StartFrom, 10))
	}
	if q.StartTo > 0 {
		vals.Set("startTo", strconv.FormatInt(q.StartTo, 10))
	}
	if q.Order != "" {
		vals.Set("order", q.Order)
	}
	detail := q.Detail
	if detail == "" {
		detail = "summary"
	}
	vals.Set("detail", detail)
	vals.Set("limit", strconv.Itoa(q.Limit))
	vals.Set("offset", strconv.Itoa(q.Offset))

	path := "/api/frontend/conference-management/meetings?" + vals.Encode()
	data, err := a.doRequest(ctx, http.MethodGet, path, nil, token, authBearer)
	if err != nil {
		return nil, err
	}
	var page MeetingPage
	if err := json.Unmarshal(data, &page); err != nil {
		return nil, fmt.Errorf("unmarshal meeting page: %w", err)
	}
	return &page, nil
}

// GetRecordingGroups 走三方的云端录像目录（实测 ~150ms）。
// 它只覆盖**云端**目录：板卡局域网录制与浏览器个人录制在别的位置，这个接口不虚构本地文件列表。
func (a *Adapter) GetRecordingGroups(ctx context.Context, token string, q RecordingGroupQuery) (*RecordingGroupPage, error) {
	if a.IsSinosatV1(ctx) {
		return &RecordingGroupPage{OK: true, Groups: nil}, nil
	}
	vals := url.Values{}
	if q.Q != "" {
		vals.Set("q", q.Q)
	}
	if q.DeviceId != "" {
		vals.Set("deviceId", q.DeviceId)
	}
	if q.MeetingId != "" {
		vals.Set("meetingId", q.MeetingId)
	}
	if q.Status != "" {
		vals.Set("status", q.Status)
	}
	if q.StartFrom > 0 {
		vals.Set("startFrom", strconv.FormatInt(q.StartFrom, 10))
	}
	if q.StartTo > 0 {
		vals.Set("startTo", strconv.FormatInt(q.StartTo, 10))
	}
	if q.Owner != "" {
		vals.Set("owner", q.Owner)
	}
	limit := q.Limit
	if limit < 1 {
		limit = 50
	}
	if limit > 50 {
		limit = 50 // 实测范围 1–50，超了会被判非法参数
	}
	vals.Set("limit", strconv.Itoa(limit))
	vals.Set("offset", strconv.Itoa(q.Offset))

	data, err := a.doRequest(ctx, http.MethodGet,
		"/api/frontend/conference-management/recordings?"+vals.Encode(), nil, token, authBearer)
	if err != nil {
		return nil, err
	}
	var page RecordingGroupPage
	if err := json.Unmarshal(data, &page); err != nil {
		return nil, fmt.Errorf("unmarshal recording groups: %w", err)
	}
	return &page, nil
}

func (a *Adapter) ScheduleMeeting(ctx context.Context, token string, req *ScheduleReq) (*ThirdMeeting, error) {
	// 公网会议族没有预约时刻：上游只建即时房间，本地预约单仍由我方库承载。
	if a.IsSinosatV1(ctx) {
		return a.createRoomSinosat(ctx, token, req.Title)
	}
	data, err := a.doRequest(ctx, http.MethodPost, "/api/frontend/conference-management/meetings", req, token, authBearer)
	if err != nil {
		return nil, err
	}
	var result struct {
		Meeting ThirdMeeting `json:"meeting"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("unmarshal schedule result: %w", err)
	}
	return &result.Meeting, nil
}

func (a *Adapter) QuickStart(ctx context.Context, token string, req *QuickStartReq) (*ThirdMeeting, error) {
	if a.IsSinosatV1(ctx) {
		return a.createRoomSinosat(ctx, token, req.Title)
	}
	data, err := a.doRequest(ctx, http.MethodPost, "/api/frontend/conference-management/meetings/quick-start", req, token, authBearer)
	if err != nil {
		return nil, err
	}
	var result struct {
		Meeting ThirdMeeting `json:"meeting"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("unmarshal quick start result: %w", err)
	}
	return &result.Meeting, nil
}

func (a *Adapter) StartMeeting(ctx context.Context, token, meetingId string) error {
	if a.IsSinosatV1(ctx) {
		// 公网会议创建即开会，无独立 start。
		return nil
	}
	_, err := a.doRequest(ctx, http.MethodPost,
		fmt.Sprintf("/api/frontend/conference-management/meetings/%s/start", meetingId), nil, token, authBearer)
	return err
}

func (a *Adapter) StopMeeting(ctx context.Context, token, meetingId string) error {
	if a.IsSinosatV1(ctx) {
		// 管理面无 stop：GET /rooms 只列未结束房。已不在列表 = 平台侧已结束。
		// 仍在列表则短暂 join 拿参会令牌再 /end（主持人 Bearer 可入会）。
		return a.stopSinosat(ctx, token, meetingId)
	}
	_, err := a.doRequest(ctx, http.MethodPost,
		fmt.Sprintf("/api/frontend/conference-management/meetings/%s/stop", meetingId), nil, token, authBearer)
	return err
}

func (a *Adapter) StartBoardRecording(ctx context.Context, bearer, participantToken, meetingId string) error {
	if a.IsSinosatV1(ctx) {
		return fmt.Errorf("公网会议暂不支持云端板卡录制，请使用本地录制")
	}
	_, err := a.doRequestDual(ctx, http.MethodPost,
		fmt.Sprintf("/api/frontend/conference-management/meetings/%s/start-board-recording", meetingId),
		map[string]interface{}{}, bearer, participantToken)
	return err
}

func (a *Adapter) StopBoardRecording(ctx context.Context, bearer, participantToken, meetingId string) error {
	if a.IsSinosatV1(ctx) {
		return fmt.Errorf("公网会议暂不支持云端板卡录制")
	}
	_, err := a.doRequestDual(ctx, http.MethodPost,
		fmt.Sprintf("/api/frontend/conference-management/meetings/%s/stop-board-recording", meetingId),
		map[string]interface{}{}, bearer, participantToken)
	return err
}

func (a *Adapter) JoinMeeting(ctx context.Context, token string, req *JoinReq) (*JoinResult, error) {
	if a.IsSinosatV1(ctx) {
		return a.joinSinosat(ctx, token, req)
	}
	data, err := a.doRequest(ctx, http.MethodPost, "/api/conference/meetings/join", req, token, authBearer)
	if err != nil {
		return nil, err
	}
	var raw struct {
		ParticipantId    string             `json:"participantId"`
		ParticipantToken string             `json:"participantToken"`
		ServerUnixMs     int64              `json:"serverUnixMs"`
		MeetingUrl       string             `json:"meetingUrl"`
		Meeting          MeetingInfo        `json:"meeting"`
		Participants     []ParticipantState `json:"participants"`
		Publications     []Publication      `json:"publications"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("unmarshal join result: %w", err)
	}
	state := &MeetingState{
		Participants: raw.Participants,
		Status:       raw.Meeting.Status,
		ServerTime:   raw.ServerUnixMs,
	}
	return &JoinResult{
		ParticipantId:    raw.ParticipantId,
		ParticipantToken: raw.ParticipantToken,
		ServerUnixMs:     raw.ServerUnixMs,
		MeetingUrl:       raw.MeetingUrl,
		Meeting:          raw.Meeting,
		State:            state,
	}, nil
}

func (a *Adapter) LeaveMeeting(ctx context.Context, participantToken string) error {
	if a.IsSinosatV1(ctx) {
		return a.leaveSinosat(ctx, participantToken)
	}
	_, err := a.doRequest(ctx, http.MethodPost, "/api/conference/meetings/leave",
		map[string]interface{}{}, participantToken, authParticipant)
	return err
}

func (a *Adapter) EndMeetingAsHost(ctx context.Context, participantToken string) error {
	if a.IsSinosatV1(ctx) {
		return a.endSinosat(ctx, participantToken)
	}
	_, err := a.doRequest(ctx, http.MethodPost, "/api/conference/meetings/end",
		map[string]interface{}{}, participantToken, authParticipant)
	return err
}

func (a *Adapter) FocusPublication(ctx context.Context, participantToken, publicationId string) error {
	if a.IsSinosatV1(ctx) {
		// 公网会议无 focus 口；压缩切换走 PATCH streams，此处当作无操作。
		return nil
	}
	path := fmt.Sprintf("/api/conference/publications/%s/focus", publicationId)
	_, err := a.doRequest(ctx, http.MethodPost, path, map[string]interface{}{}, participantToken, authParticipant)
	return err
}

// PreparePublication 按 §10.1 要一条发布的通道。`role=consumer` 是**消费侧**的武装动作：
// 三方据此起"这条发布专属的 RK 接收进程"，把云端流灌进 `rkReceiverPath` 那条局域网槽。
//
// 为什么非 2xx 也要把响应体解出来：三方"起不来"是 404 + `reason`（实测 `rtsp_describe_404`），
// "还没起来"是 200 + `receiverReady:false` + `receiverReason` —— 两句都是"这条 lane 归谁管"的
// 唯一线索。直接把它当 error 丢掉，就只剩一句"订阅失败"，下一轮还是只能猜。
// 所以这里**同时**回解析结果和原始 error：调用方拿结果决定要不要继续等，拿 error 记日志。
func (a *Adapter) PreparePublication(ctx context.Context, participantToken, publicationId, role string) (*PrepareResult, error) {
	if a.IsSinosatV1(ctx) {
		return &PrepareResult{ReceiverReady: true}, nil
	}
	path := fmt.Sprintf("/api/conference/publications/%s/prepare", publicationId)
	data, err := a.doRequest(ctx, http.MethodPost, path, map[string]interface{}{
		"role":          role,
		"publicationId": publicationId,
	}, participantToken, authParticipant)
	if err != nil {
		var up *UpstreamError
		if errors.As(err, &up) && len(up.Body) > 0 {
			var res PrepareResult
			if json.Unmarshal(up.Body, &res) == nil {
				return &res, err
			}
		}
		return nil, err
	}
	var res PrepareResult
	if err := json.Unmarshal(data, &res); err != nil {
		return nil, fmt.Errorf("unmarshal prepare result: %w", err)
	}
	return &res, nil
}

// GetMeetingByNumber 入会前按会议号查这场会（三方文档第 8 节：join 前无需参会令牌，管理员 Bearer 即可）。
// 外部会议没有本地预约单，详情就靠它，不必先把人拉进会。
func (a *Adapter) GetMeetingByNumber(ctx context.Context, bearerToken, meetingNumber string) (*MeetingInfo, error) {
	if a.IsSinosatV1(ctx) {
		// 入会前无匿名详情口；权威「是否仍在跑」看 GET /rooms（只列未结束）。
		// 以前一律伪造 running，导致 Reconcile 永远回写不了终态、首页僵尸「进行中」。
		page, err := a.listRoomsSinosat(ctx, bearerToken)
		if err != nil {
			return nil, err
		}
		for _, m := range page.Meetings {
			if m.MeetingNumber == meetingNumber || m.MeetingId == meetingNumber {
				return &MeetingInfo{
					Title:         m.Title,
					MeetingNumber: m.MeetingNumber,
					MeetingId:     m.MeetingId,
					Status:        m.Status,
					StartAt:       m.StartAt,
					CloudRecord:   m.CloudRecord,
					HostUsername:  m.HostUsername,
				}, nil
			}
		}
		return nil, fmt.Errorf("meeting_not_found")
	}
	path := fmt.Sprintf("/api/conference/meetings/%s", meetingNumber)
	data, err := a.doRequest(ctx, http.MethodGet, path, nil, bearerToken, authBearer)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Meeting MeetingInfo `json:"meeting"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("unmarshal meeting: %w", err)
	}
	return &raw.Meeting, nil
}

func (a *Adapter) GetMeetingState(ctx context.Context, participantToken, meetingNumber string) (*MeetingResponse, error) {
	if a.IsSinosatV1(ctx) {
		return a.getRoomSinosat(ctx, participantToken, meetingNumber)
	}
	path := fmt.Sprintf("/api/conference/meetings/%s/state", meetingNumber)
	data, err := a.doRequest(ctx, http.MethodGet, path, nil, participantToken, authParticipant)
	if err != nil {
		return nil, err
	}
	var result MeetingResponse
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("unmarshal meeting state: %w", err)
	}
	return &result, nil
}

// Heartbeat 提交媒体状态并返回全量状态（三方 heartbeat 即状态拉取，见三方文档第 9 节）。
func (a *Adapter) Heartbeat(ctx context.Context, participantToken string, media *MediaState) (*MeetingResponse, error) {
	if a.IsSinosatV1(ctx) {
		// 公网会议无 heartbeat；房间快照即状态。media 上报留给浏览器 getStats。
		_ = media
		return a.getRoomSinosat(ctx, participantToken, "")
	}
	data, err := a.doRequest(ctx, http.MethodPost, "/api/conference/meetings/heartbeat",
		map[string]interface{}{"mediaState": media}, participantToken, authParticipant)
	if err != nil {
		return nil, err
	}
	var result MeetingResponse
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("unmarshal heartbeat state: %w", err)
	}
	return &result, nil
}

// CreatePublication 按三方第 10.1 节登记一次发布，响应含 publicationId 与预授权 whipUrl。
func (a *Adapter) CreatePublication(ctx context.Context, participantToken string, payload map[string]interface{}) ([]byte, error) {
	if a.IsSinosatV1(ctx) {
		return a.createPublicationSinosat(ctx, participantToken, payload)
	}
	return a.doRequest(ctx, http.MethodPost, "/api/conference/publications", payload, participantToken, authParticipant)
}

// PostRoiHint 把浏览器检测到的人脸框转给三方编码器（外部契约 §10.3）。
// 空 regions = 清除；这条只影响编码器取舍，失败不会拆掉已建立的发布。
func (a *Adapter) PostRoiHint(ctx context.Context, participantToken, publicationId string, payload map[string]interface{}) ([]byte, error) {
	if a.IsSinosatV1(ctx) {
		return []byte(`{"ok":true}`), nil
	}
	return a.doRequest(ctx, http.MethodPost, "/api/conference/publications/"+publicationId+"/roi-hint", payload, participantToken, authParticipant)
}

// StopPublication 结束发布。graceSeconds 给对端收尾时间。
func (a *Adapter) StopPublication(ctx context.Context, participantToken, publicationId string) ([]byte, error) {
	if a.IsSinosatV1(ctx) {
		return a.stopPublicationSinosat(ctx, participantToken, publicationId)
	}
	path := fmt.Sprintf("/api/conference/publications/%s/stop", publicationId)
	return a.doRequest(ctx, http.MethodPost, path, map[string]interface{}{"graceSeconds": 0.8}, participantToken, authParticipant)
}

// LoggableTarget 只留 origin + path，把 query 摘掉：query 里那个 ticket 是三方签发的一次性预授权凭据，
// 整条进日志等于把凭据原文落到盘上（09-26 那批 whip delete 日志就是全文带的）。
// 排查要的是"打到了哪个网关的哪条路径"，这两样一个都不少。
func LoggableTarget(targetURL string) string {
	if i := strings.IndexByte(targetURL, '?'); i >= 0 {
		return targetURL[:i] + "?<ticket 已隐去>"
	}
	return targetURL
}

// PostSdp 把浏览器的 SDP offer 原样转发到三方签发的 WHIP/WHEP 地址。
// Ocean 族 URL 预授权，不带鉴权头；公网会议族（sinosat）必须带 Bearer 参会令牌。
// 返回 answer（SDP 文本）与会话 URI（Location 头，用于 DELETE 拆流）。
func (a *Adapter) PostSdp(ctx context.Context, targetURL, offer string) (string, string, error) {
	return a.PostSdpAuth(ctx, targetURL, offer, "")
}

// PostSdpAuth 同 PostSdp，额外可带 Bearer（公网会议 WHIP/WHEP 必需）。
func (a *Adapter) PostSdpAuth(ctx context.Context, targetURL, offer, bearer string) (string, string, error) {
	targetURL = a.resolveTarget(ctx, targetURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, strings.NewReader(offer))
	if err != nil {
		return "", "", fmt.Errorf("create sdp request: %w", err)
	}
	req.Header.Set("Content-Type", "application/sdp")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := a.httpClient.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("sdp post %s: %w", LoggableTarget(targetURL), err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", fmt.Errorf("read sdp answer: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", fmt.Errorf("sdp endpoint returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	// 三方可以按 RFC 7231 回相对 Location（实测 WHIP 会话 URI 就是 `/conference/...`），
	// 必须按 offer URL 解析成绝对地址——否则 DeleteSession 拿到裸路径直接报
	// unsupported protocol scheme ""，WHIP 会话永远拆不掉。
	location := resp.Header.Get("Location")
	if location != "" && !strings.HasPrefix(location, "http") {
		if base, perr := url.Parse(targetURL); perr == nil {
			if ref, rerr := url.Parse(location); rerr == nil {
				location = base.ResolveReference(ref).String()
			}
		}
	}
	return string(body), location, nil
}

// DeleteSession 对 WHIP/WHEP 会话 URI 发 DELETE，真正拆掉这条实时连接。
func (a *Adapter) DeleteSession(ctx context.Context, sessionURL string) error {
	return a.DeleteSessionAuth(ctx, sessionURL, "")
}

// DeleteSessionAuth 同 DeleteSession，公网会议连接释放需 Bearer。
func (a *Adapter) DeleteSessionAuth(ctx context.Context, sessionURL, bearer string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, sessionURL, nil)
	if err != nil {
		return fmt.Errorf("create session delete: %w", err)
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	resp, err := a.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("session delete %s: %w", LoggableTarget(sessionURL), err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	// 会话已经不在了也算拆成功：浏览器先关 PC 时三方会自行回收 WHIP 会话，
	// 随后我们的 DELETE 会收到 404/405/410（实测 09-27 全是 405）——那是既成事实，不是失败。
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusMethodNotAllowed || resp.StatusCode == http.StatusGone {
		return nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("session delete returned %d", resp.StatusCode)
	}
	return nil
}

func (a *Adapter) SendChatMessage(ctx context.Context, participantToken, text, clientMsgId string) error {
	if a.IsSinosatV1(ctx) {
		_ = clientMsgId
		return a.sendChatSinosat(ctx, participantToken, text)
	}
	payload := map[string]string{
		"text":            text,
		"clientMessageId": clientMsgId,
	}
	_, err := a.doRequest(ctx, http.MethodPost, "/api/conference/meetings/messages", payload, participantToken, authParticipant)
	return err
}

func (a *Adapter) ListMessages(ctx context.Context, participantToken string, afterId, limit int) ([]ChatMessage, int64, error) {
	if a.IsSinosatV1(ctx) {
		return a.listMessagesSinosat(ctx, participantToken, afterId, limit)
	}
	path := fmt.Sprintf("/api/conference/meetings/messages?afterId=%d&limit=%d", afterId, limit)
	data, err := a.doRequest(ctx, http.MethodGet, path, nil, participantToken, authParticipant)
	if err != nil {
		return nil, 0, err
	}
	var result ChatListResult
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, 0, fmt.Errorf("unmarshal messages: %w", err)
	}
	return result.Messages, result.LastMessageId, nil
}

// PlaybackError 三方 playback 端点的结构化失败回答。
//
// 它的 reason 只有笼统一个 recording_not_ready（契约 §15.1 要求"归档中 vs 已回收分两句"），
// 真正能分辨的是同一份 body 里的两组事实：
//   - UnavailableRecordingIDs 非空：曾登记过录制、现已不可用（云侧回收）
//   - RecordingCount == 0：这场会从没产出过录制
//
// 所以归译看这两个字段，而不是猜 reason。
type PlaybackError struct {
	StatusCode              int
	Reason                  string
	UnavailableRecordingIDs []string
	RecordingCount          int
}

func (e *PlaybackError) Error() string {
	return fmt.Sprintf("third-party playback failed: %d %s (unavailable=%d, recordings=%d)",
		e.StatusCode, e.Reason, len(e.UnavailableRecordingIDs), e.RecordingCount)
}

func (a *Adapter) GetPlayback(ctx context.Context, token, meetingId string) (*PlaybackData, error) {
	path := fmt.Sprintf("/api/frontend/conference-management/meetings/%s/playback", meetingId)
	data, err := a.doRequest(ctx, http.MethodGet, path, nil, token, authBearer)
	if err != nil {
		if pe := playbackFailure(err); pe != nil {
			return nil, pe
		}
		return nil, err
	}
	var result PlaybackData
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("unmarshal playback data: %w", err)
	}
	return &result, nil
}

// playbackFailure 把 playback 的非 2xx 回答解析成带事实字段的结构；解析不出 reason 就返回 nil，
// 让调用方退回原来的文本错误。失败的 body 里连会议对象一起返回（实测），所以 recordingCount 直接可取。
func playbackFailure(err error) *PlaybackError {
	var ue *UpstreamError
	if !errors.As(err, &ue) {
		return nil
	}
	var body struct {
		Reason                  string   `json:"reason"`
		UnavailableRecordingIDs []string `json:"unavailableRecordingIds"`
		Meeting                 *struct {
			RecordingCount int `json:"recordingCount"`
		} `json:"meeting"`
	}
	if json.Unmarshal(ue.Body, &body) != nil || body.Reason == "" {
		return nil
	}
	pe := &PlaybackError{StatusCode: ue.StatusCode, Reason: body.Reason, UnavailableRecordingIDs: body.UnavailableRecordingIDs}
	if body.Meeting != nil {
		pe.RecordingCount = body.Meeting.RecordingCount
	}
	return pe
}

// DownloadRecording 以管理员 Bearer 代理三方归档下载，返回未关闭的响应体（调用方负责 Close）。
func (a *Adapter) DownloadRecording(ctx context.Context, token, recordingId string) (io.ReadCloser, http.Header, error) {
	return a.GetRecordingAsset(ctx, token, recordingId, "download")
}

// GetRecordingAsset 取某条录制目录下的一个资产（playlist.m3u8 / 分片 / download）。
// rel 由调用方校验过（不许出现 .. 与绝对路径），三方那个 recordings/{id}/ 目录就是它的根。
func (a *Adapter) GetRecordingAsset(ctx context.Context, token, recordingId, rel string) (io.ReadCloser, http.Header, error) {
	url := a.getBaseURL(ctx) + fmt.Sprintf("/api/frontend/conference-management/recordings/%s/%s", recordingId, rel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	// 走 streamClient（无整请求超时）：归档与 HLS 分片可能几百 MB~GB，用 10 秒的 httpClient 会被拦腰截断。
	resp, err := a.streamClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("http request recording asset: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, nil, fmt.Errorf("recording asset %s returned %d: %s", rel, resp.StatusCode, string(body))
	}
	return resp.Body, resp.Header, nil
}

// DeleteMeetingRecordings 撤下一场会议在三方侧的录制文件。
// 三方只有这一个删录制的口子（没有 DELETE /recordings/{id}），粒度是整场会议，
// 所以调用方必须把它当"整场删除"告知用户，不能假装能单删一条。
func (a *Adapter) DeleteMeetingRecordings(ctx context.Context, token, meetingId string) (files int, bytes int64, err error) {
	path := fmt.Sprintf("/api/frontend/conference-management/meetings/%s", meetingId)
	data, err := a.doRequest(ctx, http.MethodDelete, path, nil, token, authBearer)
	if err != nil {
		return 0, 0, err
	}
	var result struct {
		DeletedFileCount int   `json:"deletedFileCount"`
		DeletedBytes     int64 `json:"deletedBytes"`
	}
	if len(data) > 0 {
		if err := json.Unmarshal(data, &result); err != nil {
			return 0, 0, fmt.Errorf("unmarshal delete result: %w", err)
		}
	}
	return result.DeletedFileCount, result.DeletedBytes, nil
}

// 媒体投放 Accept 头（值即三方直连流的容器协商头，见三方文档第 10.2 节）。
// 一条直连流只有"发布端实际编的那个编码"这一条腿可取：取错时上游不会回"编码不对"，
// 而是回 425 direct_video_not_ready，而这个"未就绪"永远不会变就绪。
const (
	AcceptZha1H264 = "application/vnd.zwt.zha1+h264"
	AcceptZha1Hevc = "application/vnd.zwt.zha1+hevc"
	AcceptZaa1Aac  = "application/vnd.zwt.zaa1+aac"
	AcceptSdp      = "application/sdp"
)

// AcceptForVideoCodec 把本域编码枚举（h264|hevc）换成三方的投放协商头。
// 认不出来的编码回 h264，与 Publication.VideoCodec 的默认保持一致，不要在这里另起一套判断。
func AcceptForVideoCodec(codec string) string {
	if codec == "hevc" {
		return AcceptZha1Hevc
	}
	return AcceptZha1H264
}

// OpenStream 以参会令牌打开一条已签发的媒体投放地址，返回流式响应体（调用方 Close）。
// 这是"消费服务端签发的接收地址"，不是自建媒体链路。
func (a *Adapter) OpenStream(ctx context.Context, participantToken, targetURL, accept string) (io.ReadCloser, http.Header, error) {
	target := a.resolveTarget(ctx, targetURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, nil, fmt.Errorf("create stream request: %w", err)
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("X-Conference-Token", participantToken)

	resp, err := a.streamClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("open stream: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, nil, fmt.Errorf("stream returned %d: %s", resp.StatusCode, string(body))
	}
	return resp.Body, resp.Header, nil
}

func (a *Adapter) GetMe(ctx context.Context, token string) (map[string]interface{}, error) {
	data, err := a.doRequest(ctx, http.MethodGet, "/api/frontend/auth/me", nil, token, authBearer)
	if err != nil {
		return nil, err
	}
	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, fmt.Errorf("unmarshal me: %w", err)
	}
	return result, nil
}
