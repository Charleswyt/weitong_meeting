package service

// FaceEnhancementSupported 判断当前部署是否把「人脸增强」开放给用户。
//
// **边端与云端都开放**（2026-11-12 用户决定）。不是临时状态、不是"验证中"——
// 这是长期口径，不要再按 deployment.side 分叉回去。
//
// 为什么曾经只有云端开放，以及为什么改回来：
// - 2026-11-02 用探针实测过船端网关：`browser_whip` 与 `rk_browser_roi` 两种声明都被接受，
//   两条路的 roi-hint 都回 2xx（数据见 evidence/2026-11-02-船端ROI实测-第0-1档.md）。
//   那一轮发布没有真推流（lane=0、directVideoCodec 为空），比不出码率变化 ——
//   所以当时按"效果未验证"暂时只在云端开放。
// - 注意判据始终是**效果是否验证过**，不是"这一侧没有通道"：
//   "边端没有 ROI 通道"那个旧说法已被 `preferH264ForSender(pc, sender, sourceType === "rk_browser_roi")`
//   要求 H.264 这一条实测证据推翻（见 ADR-0104）。
// - 2026-11-12 用户决定两侧都做：边端用户同样需要"远端看得更清"，不能因为端到端验证难做
//   就把功能扣着不给。
//
// 语义提醒（改这块前先读）：人脸增强**不是美颜** —— BlazeFace 检测人脸 → 归一化 regions →
// 250ms 上报 roi-hint → 编码器给这块多分码率。本地预览看不到任何变化，只有远端受益。
func FaceEnhancementSupported() bool {
	return true
}

// FaceEnhancementUnsupportedMessage 是给用户看的那句话，不露部署模式与 sourceType。
//
// 当前两侧都支持，正常路径下这句不会上桌；保留它是为了 `capabilities` 的形状稳定
// （`{supported, message}` 两键恒在，前端不必判空）。
func FaceEnhancementUnsupportedMessage() string {
	return "当前部署不支持"
}
