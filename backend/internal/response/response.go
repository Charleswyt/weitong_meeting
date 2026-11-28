package response

import (
	"cloud-conference-backend/internal/errs"

	"github.com/gogf/gf/v2/frame/g"
	"github.com/gogf/gf/v2/net/ghttp"
)

type R struct {
	Code   int         `json:"code"`
	Msg    string      `json:"msg"`
	Reason string      `json:"reason,omitempty"`
	Data   interface{} `json:"data,omitempty"`
	Rows   interface{} `json:"rows,omitempty"`
	Total  int         `json:"total,omitempty"`
}

func Ok(r *ghttp.Request, data interface{}) {
	r.Response.WriteJsonExit(R{Code: 200, Msg: "操作成功", Data: data})
}

func OkWithMessage(r *ghttp.Request, msg string) {
	r.Response.WriteJsonExit(R{Code: 200, Msg: msg})
}

// OkWithData 成功但带警示（例如"本地已建、三方同步失败"），data 仍可用。
func OkWithData(r *ghttp.Request, data interface{}, msg string) {
	r.Response.WriteJsonExit(R{Code: 200, Msg: msg, Data: data})
}

// OkWithRows 分页出口。刻意不走 R 的 omitempty：`total: 0` 与 `rows: null` 必须照样出现，
// 否则前端拿到 undefined 去渲染分页就是空白（契约 §2 承诺分页响应恒含 rows/total）。
func OkWithRows(r *ghttp.Request, rows interface{}, total int) {
	if rows == nil {
		rows = []interface{}{}
	}
	r.Response.WriteJsonExit(g.Map{"code": 200, "msg": "查询成功", "rows": rows, "total": total})
}

func Fail(r *ghttp.Request, msg string) {
	r.Response.WriteJsonExit(R{Code: 500, Msg: msg})
}

// FailNotInMeeting 本端已经不在这场会里了（刚离会、被另一台设备顶号、会已散）。
// 带 reason=not_in_meeting：对前端这是一个"收尾信号"而不是故障，入会后立刻离会
// 那些还在途中的收尾请求走的正是这里，不该弹一句报错（第 1 项）。
func FailNotInMeeting(r *ghttp.Request, msg string) {
	r.Response.WriteJsonExit(R{Code: 500, Msg: msg, Reason: "not_in_meeting"})
}

// FailSystem 内部异常的统一出口：三方原始错误体、SQL 报错、Go 运行时错误只进服务端日志，
// 弹窗一律「系统异常」。那些字符串对用户不可操作，还会把三方路径、字段名和内部 id 漏到界面上。
// 例外：service 层用 errs.Bizf 标过的业务拒绝（如「仅待开始的会议可取消」）按原文透出。
func FailSystem(r *ghttp.Request, op string, err error) {
	msg := "系统异常"
	reason := ""
	if biz := errs.BizMessage(err); biz != "" {
		// 业务拒绝是用户操作撞上了规则，不是我方坏了：按 Warning 记，别把 Error 淹在噪音里。
		msg = biz
		reason = errs.BizReasonOf(err)
		g.Log().Warningf(r.Context(), "%s 业务拒绝: %s", op, biz)
	} else {
		g.Log().Errorf(r.Context(), "%s: %v", op, err)
	}
	r.Response.WriteJsonExit(R{Code: 500, Msg: msg, Reason: reason})
}

// FailValidate 参数校验失败：这是用户自己改得对的地方，给可操作的中文，
// 但不外泄 GoFrame 的英文原文（如 "The durationMinutes value `0` must be equal or greater than 1"）。
func FailValidate(r *ghttp.Request, err error) {
	// 用户填错不是系统故障：Warning 级，英文原文只留在这里。
	g.Log().Warningf(r.Context(), "参数校验失败: %v", err)
	r.Response.WriteJsonExit(R{Code: 400, Msg: "请求参数不合法"})
}

// FailStatus 需要**真非 2xx 状态码**、但消费方仍是前端 axios 代码时的出口。
// 必须先 ClearBuffer：gf 的 WriteStatus 会把状态短语（如 "Conflict"）写进响应体，
// 之后再拼 JSON 就得到 `Conflict{"code":409,...}` —— 整段不是合法 JSON，
// 前端解析不出 code，只能落到「系统异常」那条兜底分支，本可重试的失败也重不了
// （SM2 challenge 过期那条路就是这么废掉的，第 7 项口径要求"给用户的话由后端产出"）。
func FailStatus(r *ghttp.Request, status int, msg string, reason string) {
	r.Response.ClearBuffer()
	r.Response.Status = status
	r.Response.WriteJsonExit(R{Code: status, Msg: msg, Reason: reason})
}

// FailStream 给流式端点（媒体代理）用：必须回真正的非 2xx 状态码。
// 消费方是三方播放器，它只看 HTTP 状态判定"这是不是一条流"，
// 若沿用 HTTP 200 + JSON 错误体，它会把错误体当媒体流读下去，
// 最终报出与真因无关的守卫错误（实测 direct_audio_transcode_guard_failed）。
// reason 字段是播放器会读的键，用来把真因带回前端。
func FailStream(r *ghttp.Request, status int, msg string) {
	r.Response.ClearBuffer()
	r.Response.Status = status
	r.Response.WriteJsonExit(g.Map{
		"code":   status,
		"msg":    msg,
		"reason": streamReason(status),
	})
}

// FailStreamReason 与 FailStream 相同，但 reason 由调用方给出更细的机器值（HTTP 状态不足以区分时）。
func FailStreamReason(r *ghttp.Request, status int, msg, reason string) {
	r.Response.ClearBuffer()
	r.Response.Status = status
	r.Response.WriteJsonExit(g.Map{"code": status, "msg": msg, "reason": reason})
}

// streamReason 把媒体/资源代理端点的 HTTP 状态码换成机器可读的 reason（契约 §1 的映射表）。
// 取名按 HTTP 语义而不是"流"：订阅、录制资源、头像三条端点共用这个出口，404 在头像那里不是"流没了"。
// 前端要分支就读它 —— 之前这里填的是 msg 本身，逼得前端拿中文文案做匹配。
func streamReason(status int) string {
	switch status {
	case 401:
		return "not_in_meeting"
	case 403:
		return "forbidden"
	case 404:
		return "not_found"
	case 410:
		return "gone"
	case 503:
		return "warming"
	case 502:
		return "upstream_unreachable"
	case 501:
		return "no_channel"
	case 400:
		return "bad_request"
	}
	return "system_error"
}

func Unauthorized(r *ghttp.Request, msg string) {
	r.Response.WriteJsonExit(R{Code: 401, Msg: msg})
}
