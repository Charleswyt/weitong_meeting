package recording

import (
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
	"github.com/gogf/gf/v2/os/glog"

	v1 "cloud-conference-backend/api/v1"
	"cloud-conference-backend/internal/response"
	"cloud-conference-backend/internal/service"
	"cloud-conference-backend/internal/service/thirdparty"
)

type Controller struct {
	recordingSvc *service.RecordingService
	authSvc      *service.AuthService
}

func New(recordingSvc *service.RecordingService, authSvc *service.AuthService) *Controller {
	return &Controller{recordingSvc: recordingSvc, authSvc: authSvc}
}

func (c *Controller) List(r *ghttp.Request) {
	var req v1.RecordingListReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}

	userId := service.GetUserIdFromCtx(r.Context())
	token, err := c.authSvc.GetThirdPartyToken(r.Context(), userId)
	if err != nil {
		response.FailSystem(r, "获取三方令牌失败", err)
		return
	}

	if req.PageNum < 1 {
		req.PageNum = 1
	}
	if req.PageSize < 1 {
		req.PageSize = 20
	}

	recordings, total, err := c.recordingSvc.List(r.Context(), token, req.PageNum, req.PageSize, req.Type, req.Keyword, req.Days)
	if err != nil {
		response.FailSystem(r, "请求处理失败", err)
		return
	}

	rows := make([]v1.RecordingVo, 0, len(recordings))
	for _, rec := range recordings {
		title := rec.MeetingTitle
		if title == "" {
			title = rec.Title
		}
		rows = append(rows, v1.RecordingVo{
			RecordingId:   rec.RecordingId,
			MeetingId:     rec.MeetingId,
			MeetingNumber: rec.MeetingNumber,
			Title:         title,
			Participant:   rec.Participant,
			Status:        rec.Status,
			MediaKind:     rec.MediaKind,
			MediaLabel:    rec.MediaLabel,
			RecordingType: service.RecordingKindOf(rec),
			Deletable:     rec.Access.CanDelete,
			StartedAt:     rec.StartedAtText,
			DurationSec:   rec.DurationSec,
			// 卡片的时间与跨度读这两个，不读"已加载的行"（翻页翻不全时那个数是短的）
			MeetingStartedAt: rec.MeetingStartedAtText,
			MeetingSpanSec:   rec.MeetingSpanSec,
			FileSizeBytes:    rec.FileSizeBytes,
			PlaybackUrl:      proxyPlaybackUrl(rec.RecordingId),
			DownloadUrl:      proxyDownloadUrl(rec.RecordingId),
		})
	}
	response.OkWithRows(r, rows, total)
}

func (c *Controller) Playback(r *ghttp.Request) {
	var req v1.RecordingPlaybackReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}

	userId := service.GetUserIdFromCtx(r.Context())
	token, err := c.authSvc.GetThirdPartyToken(r.Context(), userId)
	if err != nil {
		response.FailSystem(r, "获取三方令牌失败", err)
		return
	}

	data, err := c.recordingSvc.GetPlayback(r.Context(), token, req.MeetingId)
	if err != nil {
		if msg := playbackUserMessage(err); msg != "" {
			// 归译后的 msg 是给用户看的，上游到底回了什么只留在这一条：别让原始错误随归译一起消失，
			// 否则"很多会议都点不开"这种反馈在日志里查不到任何线索。
			glog.Warningf(r.Context(), "回放取数失败 meeting=%s: %v", req.MeetingId, err)
			response.Fail(r, msg)
			return
		}
		response.FailSystem(r, "获取录制回放信息失败", err)
		return
	}

	res := v1.RecordingPlaybackRes{Partial: data.Partial}
	if data.Meeting != nil {
		res.Meeting = &v1.PlaybackMeeting{
			MeetingId:     data.Meeting.MeetingId,
			MeetingNumber: data.Meeting.MeetingNumber,
			Title:         data.Meeting.Title,
			StartedAt:     data.Meeting.StartedAt,
		}
	}
	if data.Timeline != nil {
		res.Timeline = &v1.PlaybackTimeline{
			StartAt:     data.Timeline.StartAt,
			DurationSec: data.Timeline.DurationSec,
		}
	}
	for _, s := range data.Streams {
		res.Streams = append(res.Streams, v1.PlaybackStream{
			RecordingId: s.RecordingId,
			DisplayName: s.DisplayName,
			MediaKind:   s.MediaKind,
			// 通路标签由本域按 kind 派生，不透传上游那个串：上游给的是**发布端的 MediaStream track label**
			// （实测是 88 字符 base64 流 id、"MediaStreamAudioDestinationNode"、"默认值 - 麦克风 (Realtek...)"
			// 这种设备与厂商名），那是技术标识符，按契约 §6.5 的取值域（画面/声音/共享屏幕）不许上桌，
			// 也不许进合成提示里那串路名。列表那侧本来就是 LaneOf 派生的，两条出口同一个口径。
			MediaLabel: thirdparty.LabelOfKind(s.MediaKind),
			// 上游的 hasVideo/hasAudio 原样透传：前端靠它决定这一路要不要静音、进不进宫格。
			HasVideo:    s.HasVideo,
			HasAudio:    s.HasAudio,
			PlaybackUrl: proxyPlaybackUrl(s.RecordingId),
			DownloadUrl: proxyDownloadUrl(s.RecordingId),
			OffsetSec:   s.OffsetSec,
			DurationSec: s.DurationSec,
		})
	}
	response.Ok(r, res)
}

// Download 代理三方归档：三方地址在自签证书主机上，浏览器直连必被拦，
// 且契约 §6.5 明定下载必须经本端（见 contracts/api-contract.md）。
func (c *Controller) Download(r *ghttp.Request) {
	var req v1.RecordingDownloadReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}

	userId := service.GetUserIdFromCtx(r.Context())
	token, err := c.authSvc.GetThirdPartyToken(r.Context(), userId)
	if err != nil {
		response.FailSystem(r, "获取三方令牌失败", err)
		return
	}

	body, header, err := c.recordingSvc.Download(r.Context(), token, req.RecordingId)
	if err != nil {
		if msg := downloadUserMessage(err); msg != "" {
			response.Fail(r, msg)
			return
		}
		response.FailSystem(r, "录制下载失败", err)
		return
	}
	defer body.Close()

	if ct := header.Get("Content-Type"); ct != "" {
		r.Response.Header().Set("Content-Type", ct)
	}
	if cd := header.Get("Content-Disposition"); cd != "" {
		r.Response.Header().Set("Content-Disposition", cd)
	}
	if cl := header.Get("Content-Length"); cl != "" {
		r.Response.Header().Set("Content-Length", cl)
	}
	r.Response.Header().Set("Cache-Control", "no-store")
	r.Response.Status = http.StatusOK
	// 错误不许吞（原先这里是 `io.Copy(...) //nolint:errcheck`）：半截文件——尤其 MP4——在播放器里
	// 表现为"能打开但拖不动进度条、也调不了倍速"，比一次明确的下载失败难查得多。
	// 上游给的 Content-Length 仍照传（浏览器据此显示进度并判完整性）：一旦写不满，net/http 会断开连接，
	// 调用方拿到的是失败而不是静默残留的半截文件 —— 这正是要的形态；这里只把真因记进日志。
	if _, err := io.Copy(r.Response.Writer, body); err != nil {
		g.Log().Errorf(r.Context(), "录制下载代理中断 recordingId=%s: %v", req.RecordingId, err)
	}
}

// Delete 撤下这条录制所属**整场会议**的三方录制文件 —— 三方只有整场删除的粒度，
// 弹窗文案必须如实说明，不能让用户以为只删了一条。
func (c *Controller) Delete(r *ghttp.Request) {
	var req v1.RecordingDeleteReq
	if err := r.Parse(&req); err != nil {
		response.FailValidate(r, err)
		return
	}

	userId := service.GetUserIdFromCtx(r.Context())
	token, err := c.authSvc.GetThirdPartyToken(r.Context(), userId)
	if err != nil {
		response.FailSystem(r, "获取三方令牌失败", err)
		return
	}

	_, files, bytes, err := c.recordingSvc.Delete(r.Context(), token, req.RecordingId)
	if errors.Is(err, service.ErrRecordingNotFound) {
		// 幂等：上游已经没有这个东西 = 删除的目标状态已达成。回 200 让前端把行摘掉，
		// 回错误就会出现"点了删除、报了错、行还挂着"。
		// service 侧在回这个错之前已把该 recordingId（及同场其它条）登记进压制表，
		// 所以下一轮 /list 不会从三方 recordings[] 把它重建回来 —— 契约 §6.5。
		response.OkWithData(r, g.Map{"deletedFiles": 0, "deletedBytes": 0}, "该录制已不存在，已从列表清除")
		return
	}
	if errors.Is(err, service.ErrRecordingNotDeletable) {
		// 上游明说这条不归该账号删。这不是故障，也不该伪装成成功：把可执行的下一句给用户。
		response.Fail(r, "这条录制不由当前账号删除，可联系会议主持人或创建者处理")
		return
	}
	if err != nil {
		response.FailSystem(r, "删除录制失败", err)
		return
	}
	response.OkWithData(r, g.Map{"deletedFiles": files, "deletedBytes": bytes}, "已删除该会议的录制文件")
}

// Playlist 代理三方的 HLS 清单，并把里面指向上游的 URI 改写成本端代理路径。
// 不改写的话，播放器会拿相对路径去请求我们自己的源，全部 404（实测就是这样"播放报错"）。
func (c *Controller) Playlist(r *ghttp.Request) {
	recordingId := r.GetRouter("recordingId").String()
	rel := "playlist.m3u8"
	body, _, err := c.openAsset(r, recordingId, rel)
	if err != nil {
		return
	}
	defer body.Close()

	raw, err := io.ReadAll(body)
	if err != nil {
		g.Log().Errorf(r.Context(), "读取录制清单失败: %v", err)
		response.FailStream(r, http.StatusBadGateway, "系统异常")
		return
	}
	out := rewriteHls(string(raw), recordingId)
	r.Response.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
	r.Response.Header().Set("Cache-Control", "no-store")
	r.Response.Status = http.StatusOK
	r.Response.Write(out)
}

// assetRelPat 只允许"录制目录内的相对路径"：不含 scheme、不含 ..、不以 / 开头。
// 主机名恒由配置里的 baseUrl 决定，客户端能影响的只有这个相对路径，
// 且它拼在固定的 /api/frontend/conference-management/recordings/{id}/ 之后 —— 出不了这台三方主机。
var assetRelPat = regexp.MustCompile(`^[A-Za-z0-9._\-/]+$`)

// HlsAsset 代理清单里指向的分片/变体清单。
func (c *Controller) HlsAsset(r *ghttp.Request) {
	recordingId := r.GetRouter("recordingId").String()
	rel := strings.TrimPrefix(r.GetRouter("path").String(), "/")
	if !safeAssetRel(rel) || !safeAssetRel(recordingId) {
		response.FailStream(r, http.StatusBadRequest, "录制资源路径不合法")
		return
	}
	body, header, err := c.openAsset(r, recordingId, rel)
	if err != nil {
		return
	}
	defer body.Close()

	ct := header.Get("Content-Type")
	if ct == "" {
		ct = "application/octet-stream"
	}
	r.Response.Header().Set("Content-Type", ct)
	r.Response.Header().Set("Cache-Control", "no-store")
	r.Response.Status = http.StatusOK
	// 同上：分片写不完要让 hls.js 拿到"这一片失败"，而不是被喂进一段短字节再报与真因无关的解码错。
	if _, err := io.Copy(r.Response.Writer, body); err != nil {
		g.Log().Errorf(r.Context(), "HLS 分片代理中断 recordingId=%s rel=%s: %v", recordingId, rel, err)
	}
}

// openAsset 给播放器取资产用，失败必须回真非 2xx —— 沿用 HTTP 200 + JSON 错误体的话，
// hls.js 会把错误体当分片数据往下喂，报出来的是与真因无关的解析错误。
func (c *Controller) openAsset(r *ghttp.Request, recordingId, rel string) (io.ReadCloser, http.Header, error) {
	if !safeAssetRel(recordingId) || !safeAssetRel(rel) {
		response.FailStream(r, http.StatusBadRequest, "录制资源路径不合法")
		return nil, nil, errHandled
	}
	userId := service.GetUserIdFromCtx(r.Context())
	token, err := c.authSvc.GetThirdPartyToken(r.Context(), userId)
	if err != nil {
		g.Log().Errorf(r.Context(), "获取三方令牌失败: %v", err)
		response.FailStream(r, http.StatusInternalServerError, "系统异常")
		return nil, nil, errHandled
	}
	body, header, err := c.recordingSvc.Asset(r.Context(), token, recordingId, rel)
	if err != nil {
		if msg := downloadUserMessage(err); msg != "" {
			response.FailStream(r, http.StatusNotFound, msg)
		} else {
			g.Log().Errorf(r.Context(), "读取录制资源失败: %v", err)
			response.FailStream(r, http.StatusBadGateway, "系统异常")
		}
		return nil, nil, errHandled
	}
	return body, header, nil
}

// errHandled：响应已经写出，调用方只需 return。
var errHandled = errors.New("handled")

func safeAssetRel(s string) bool {
	if s == "" || len(s) > 200 || strings.HasPrefix(s, "/") {
		return false
	}
	if !assetRelPat.MatchString(s) {
		return false
	}
	for _, seg := range strings.Split(s, "/") {
		if seg == ".." || seg == "." {
			return false
		}
	}
	return true
}

const hlsProxyPrefix = "/api/v1/recordings/"

// ourHlsPath 把清单里的一条 URI 归一成"相对该录制目录的路径"，再拼成本端代理路径。
// 上游既可能给相对名（片段与清单同目录），也可能给带主机的绝对 URL，两种都要能收。
func ourHlsPath(recordingId, uri string) string {
	rel := strings.TrimSpace(uri)
	if i := strings.Index(rel, "://"); i >= 0 {
		rest := rel[i+3:]
		if j := strings.Index(rest, "/"); j >= 0 {
			rel = rest[j+1:]
		}
	}
	if marker := "/recordings/" + recordingId + "/"; strings.Contains(rel, marker) {
		rel = rel[strings.Index(rel, marker)+len(marker):]
	}
	rel = strings.TrimPrefix(rel, "/")
	if q := strings.Index(rel, "?"); q >= 0 {
		rel = rel[:q]
	}
	if !safeAssetRel(rel) {
		return ""
	}
	return hlsProxyPrefix + url.PathEscape(recordingId) + "/hls/" + rel
}

// rewriteHls 逐行改写清单：普通行是片段 URI，#EXT- 行里可能带 URI="..."（密钥/变体）。
func rewriteHls(text, recordingId string) string {
	lines := strings.Split(text, "\n")
	for i, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "#") {
			lines[i] = rewriteExtUri(raw, recordingId)
			continue
		}
		if p := ourHlsPath(recordingId, line); p != "" {
			lines[i] = p
		}
	}
	return strings.Join(lines, "\n")
}

func rewriteExtUri(line, recordingId string) string {
	const key = `URI="`
	var b strings.Builder
	for rest := line; ; {
		i := strings.Index(rest, key)
		if i < 0 {
			b.WriteString(rest)
			break
		}
		b.WriteString(rest[:i+len(key)])
		rest = rest[i+len(key):]
		j := strings.Index(rest, `"`)
		if j < 0 {
			b.WriteString(rest)
			break
		}
		uri := rest[:j]
		if p := ourHlsPath(recordingId, uri); p != "" {
			uri = p
		}
		b.WriteString(uri)
		b.WriteString(rest[j:])
		rest = rest[j:]
	}
	return b.String()
}

// proxyPlaybackUrl / proxyDownloadUrl 把上游原始资产路径换成本端代理路径。
// 契约 §6.5：playbackUrl/downloadUrl 必须是我方路径，三方 URL 不出适配层。
func proxyPlaybackUrl(recordingId string) string {
	return hlsProxyPrefix + url.PathEscape(recordingId) + "/playlist.m3u8"
}

func proxyDownloadUrl(recordingId string) string {
	return hlsProxyPrefix + url.PathEscape(recordingId) + "/download"
}
func playbackUserMessage(err error) string {
	// 结构化判据优先：playback 的失败 body 里带了能分辨"归档中 vs 已回收"的事实字段
	//（契约 §15.1 要求分两句），而它的 reason 本身只有一个笼统的 recording_not_ready。
	// 不先走这一层的话，原始 err.Error() 里的 "not_ready" 会被下面的兜底匹配成"正在归档"。
	var pe *thirdparty.PlaybackError
	if errors.As(err, &pe) {
		switch {
		case strings.Contains(pe.Reason, "storage_unavailable"):
			return "录制文件已在云端删除，无法回放"
		case strings.Contains(pe.Reason, "not_found"):
			return "没有找到这场会议的录制归档"
		case len(pe.UnavailableRecordingIDs) > 0:
			return "这场会议的录制文件已不可用，无法回放"
		case pe.RecordingCount > 0:
			return "录制正在归档，稍后再试"
		default:
			return "这场会议没有产生可播放的录制"
		}
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "media_deleted"), strings.Contains(msg, "storage_unavailable"):
		return "录制文件已在云端删除，无法回放"
	case strings.Contains(msg, "in_progress"), strings.Contains(msg, "running"):
		return "录制仍在进行中，会议结束后才会归档出文件"
	case strings.Contains(msg, "finalizing"), strings.Contains(msg, "pending"):
		return "录制正在归档，稍后再试"
	case strings.Contains(msg, "not_enabled"), strings.Contains(msg, "not_started"):
		return "这场会议没有开启云端录制"
	case strings.Contains(msg, "not_ready"), strings.Contains(msg, "failed"):
		return "这场会议没有可播放的录制"
	case strings.Contains(msg, "not_found"), strings.Contains(msg, "returned 404"):
		return "没有找到这场会议的录制归档"
	}
	return ""
}

func downloadUserMessage(err error) string {
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "media_deleted"), strings.Contains(msg, "storage_unavailable"):
		return "录制文件已在云端删除，无法下载"
	// 409 就是 download 侧的 recording_not_ready，契约口径是"未归档完成 或 文件已回收"两义，
	// 分不出是哪一种就不要在话里替用户承诺"稍后就行"。
	case strings.Contains(msg, "not_ready"), strings.Contains(msg, "returned 409"):
		return "这场会议没有可下载的录制文件"
	case strings.Contains(msg, "returned 404"), strings.Contains(msg, "not_found"):
		return "没有找到这条录制文件"
	}
	return ""
}
