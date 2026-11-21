package thirdparty

import "strings"

// 录制条目的粒度是**一路发布**，不是一场会议：同一场会里每个参会者的摄像头、麦克风、
// 屏幕共享各自成一条。实测（2026-09-28）当前账号可见的 174/174 条 title 都是四段
// "会议名 · 参会者 · 通路类型 · 设备名"，通路类型取值只有 摄像头 / 麦克风 / 屏幕共享。
//
// 这段解析必须留在适配层：它是三方拼接串的格式知识，不能让前端去拆字符串
// （见 contracts/api-contract.md §1 与 AGENTS.md「前端只知后端」）。
const laneTitleSep = " · "

// LabelOfKind 把通路类型换给用户看的两个汉字。三方在这里给的是**设备型号**
// （实测 "USB Camera (30c9:0041)"、"本机麦克风 (适用于数字麦克风的英特尔® 智音技术)"），
// 那是技术细节，不进界面（契约 §1.1）。
func LabelOfKind(kind string) string {
	switch kind {
	case "camera":
		return "画面"
	case "audio":
		return "声音"
	case "screen":
		return "共享屏幕"
	}
	return "录制"
}

// LaneOf 把三方 title 换成本域语义：参会者、通路类型、给用户看的标签。
// 认不出来就返回空类型 + "录制"，不猜 —— 猜出来的类型会把用户引到错误的播放器上。
func LaneOf(title string) (participant string, kind string, label string) {
	segments := strings.Split(title, laneTitleSep)
	if len(segments) < 3 {
		return "", "", LabelOfKind("")
	}
	who := strings.TrimSpace(segments[1])
	switch strings.TrimSpace(segments[2]) {
	case "摄像头":
		return who, "camera", LabelOfKind("camera")
	case "麦克风":
		return who, "audio", LabelOfKind("audio")
	case "屏幕共享":
		return who, "screen", LabelOfKind("screen")
	}
	return who, "", LabelOfKind("")
}

// MeetingTitleOf 取 title 的会议名段；分组摘要里有会议标题时优先用摘要（那是结构字段，不是拼串）。
func MeetingTitleOf(title string) string {
	if idx := strings.Index(title, laneTitleSep); idx > 0 {
		return title[:idx]
	}
	return title
}
