# DERIVATION —— api.openapi.yaml 的派生账（逐字段来源 + 不一致清单）

**〔派生件，非真源〕** 本文件与 `api.openapi.yaml` 都是 2026-10-10 由**人工逐字段对照**产出的**待核对草稿**：
以 backend **运行时出口**（controller 里 `response.Ok*/OkWithRows/OkWithData` 的实返回值 + `api/v1` 与 `internal/model` 的实际 VO struct）为形状真源，
交叉 `api-contract.md` §6（文档口径）与 `frontend/src/api/*.ts`（前端口径）。
〔2026-10-10 状态更新〕yaml 已能解析（此前它**根本解析不了**，见 §4 引言），`src/types/api.gen.ts` 由它生成并带 `source-sha256`，门禁 **G5** 已落地挡"改了不重生成/手改生成物"。
§4-A7 的 `/recordings` HTTP 小节已补进 §6.5，§4 的 23 条分叉已全部裁定。
**但它仍不是可以直接引用的"契约真源"**：覆盖面 35 条，`/users` 列表、`/settings`、`/dicts`、`/net-probe`、
HLS 两条与 WebSocket 帧形状还没进来（见 §6 末）。`reason` 取值域**已扫成枚举**（见 §6 末的收口条）。
**在 §6 末那批补完之前，前端接线只能按已覆盖的 35 条走。**

生成方式不是"工具自动导出"，因为运行时形状**不在** `api/v1/*Res` 装饰体里（它们自称 swagger 装饰、运行时不消费，backend/AGENTS.md「待补」也确认与实际 handler 不一致）；
若用 gf 的 swagger 导出，导出的会是一套**从未在线上出现过**的形状。所以形状逐端点回 handler 数实返回，行号见每字段。

**行号基准**：backend/ 下文件相对 `cloud/backend/`；文档行号指 `contracts/api-contract.md`（行号随改随移，**不作判据**，定位请按章节号）；前端行号指 `cloud/frontend/src/`。

---

## 0. 覆盖度

**端点（§6 现行规格声明的路由）**：本 yaml 现覆盖 **35 条**（第二批见 §6；〔2026-10-10〕从 18 条补上来）。下面列的是**第一批**那 18 条。
覆盖到的：
`POST /auth/login`、`POST /auth/auto-login`、`GET /auth/me`、`POST /auth/logout`、
`PUT /users/me/display-name`、`POST /users/me/avatar`、`DELETE /users/me/avatar`、`GET /users/{id}/avatar`、
`GET /meetings/list`、`GET /meetings/{id}`、`POST /meetings/schedule`、`POST /meetings/{id}/cancel`、`GET /meetings/{id}/state`、
`GET /meetings/{id}/media/{streamId}/{kind}`、
`GET /recordings/list`、`GET /recordings/{meetingId}/playback`、`GET /recordings/{recordingId}/download`、`DELETE /recordings/{recordingId}`。

**VO**：覆盖 `UserVo`、`LoginData`、`MeetingVo`、`MeetingStateVo`（含 `ParticipantVo`/`InvitedVo`/`StreamVo`/`StreamEndpointsVo`/`RecordingStateVo`）、`RecordingVo`、`PlaybackData`（含 `PlaybackMeeting`/`PlaybackTimeline`/`PlaybackStream`）、`AvatarData`/`DisplayNameData`、`DeleteRecordingData`。请求体覆盖 `LoginReq`/`ScheduleReq`/`DisplayNameReq`/两组分页查询参。

**未覆盖**见 §3。宁可小而全对：`/meetings/join|leave|quick-start|end|start|stop|focus|precheck|recording/{action}|publications*|streams/{id}/whep*|streams/{id}/frame-times|media-state|ws-ticket`、`/auth/sm2-public-key`、`/users` 列表、`/chat/*`、`/settings/*`、`/dicts/{type}`、`/net-probe/*`、`/recordings/{id}/playlist.m3u8`、`/recordings/{id}/hls/*path` **均未写进 yaml**（但读到的分叉仍记进 §1/§2）。

---

## 1. 逐字段来源表（运行时 ↔ 文档 ↔ 前端 三方可对性）

图例：✅ 三方一致（形状/键名一致）；⚠️ 有分叉，细节进 §2；— 表示该侧无此字段。

### UserVo（auth.go:51-60）
| 字段 | 运行时(Go file:行) | 文档 | 前端 | 对性 |
|---|---|---|---|---|
| id/username/displayName | auth.go:52-54 | §6.1:231 | auth.ts:6-8 | ✅ |
| avatar | auth.go:55（无 omitempty，恒出现） | §6.1:231 标 `avatar?` | auth.ts:9 `avatar?` | ⚠️ B3 |
| accountType/accountTypeName | auth.go:56-57 | §6.1:231 | auth.ts:10-11 | ✅ |
| positionCode/positionName | auth.go:58-59（无 omitempty） | §6.1:231 标 `?` | auth.ts:12-13 `?` | ⚠️ B3 |

### LoginData（handler loginRes→v1.LoginRes，auth.go:16-22 / controller auth.go:97-104）
token(17)/user(18)/linkSynced(20)/linkReason(21, omitempty) — 文档 §6.1:213 与 §5.1:173，前端 auth.ts:16-21 → ✅ 四方一致（唯一分叉是旧字段名 thirdPartySynced 已在 §5.1:168 作废，代码/前端都已用 link*）。

### MeetingVo（api/v1/meeting.go:288-313；装配 meeting.go:1561-1642）
| 字段 | 运行时 | 文档 | 前端 | 对性 |
|---|---|---|---|---|
| id/title/meetingNo | meeting.go:289-291 | §6.3:290-292 | meeting.ts:5-7 | ✅ |
| thirdPartyMeetingId | meeting.go:294（存在且被填充） | §6.3:309 称"已删除" | meeting.ts:8 存在 | ⚠️ **A1** |
| startTime | meeting.go:295 | §6.3:293 | meeting.ts:9 | ✅ |
| startedAt | meeting.go:296（string，非指针） | §6.3:293 `string\|null` | meeting.ts:10 `string` | ⚠️ B1 |
| durationMinutes/status/managed/localStatus | 297-300 | §6.3:294-297 | meeting.ts:11-16 | ✅ |
| cloudRecord/muteOnJoin/cameraOffOnJoin/allowWaiting | 301-304 | §6.3:298-301 | meeting.ts:17-23 | ✅ |
| hostName/isHost/creatorId | 305-309 | §6.3:302-305 | meeting.ts:24-25 | ✅ |
| creatorName/creatorPositionName | 310-311（无 omitempty，恒出现） | §6.3:305 标 `?` | meeting.ts:26-27 `?` | ⚠️ B3 |
| createdAt | 312 | §6.3:306 | meeting.ts:28 | ✅ |

### ScheduleReq（POST /meetings/schedule；PUT /meetings/{id} 同形状；meeting.go:52-62/71-82）
title(54)/startTime(55)/durationMinutes(56)/cloudRecord(57)/muteOnJoin*(58)/cameraOff*(59)/participantIds(61) — 文档 §6.3:266/274 与前端 meeting.ts:111-120 → ✅
**allowWaiting(60)** — 运行时*有*、前端*有*(meeting.ts:118)，文档 §6.3:266 请求体清单**没列** → ⚠️ **A2**
校验：durationMinutes `min:1|max:120`、title `length:1,64`（文档未写数值区间，只写必填）。

### MeetingStateVo（internal/model/meeting_state.go:56-69）
| 字段 | 运行时 | 文档 | 前端 | 对性 |
|---|---|---|---|---|
| meetingId/status/startedAt | 57-59 | §6.3:320-322（startedAt 写 string\|null） | meeting.ts:79-81 | ⚠️ B1 |
| serverTime/clockDriftMs/hostId/participantCount | 60-63 | §6.3:323-327 | meeting.ts:82-85 | ✅ |
| cloudRecord | 64（存在） | §6.3 MeetingStateVo（317-368）**未列** | meeting.ts:86 存在 | ⚠️ **A3** |
| recording | 65 → RecordingStateVo(3-6) | §6.3:328 | meeting.ts:31-34,87 | ✅ |
| participants | 66 → ParticipantVo(8-19) | §6.3:329-340 | meeting.ts:36-46 | 见下 |
| invited | 67 → InvitedVo(22-28) | §6.3:341-348 | meeting.ts:49-56 | ✅ |
| streams | 68 → StreamVo(35-54) | §6.3:349-367 | meeting.ts:58-76 | 见下 |

ParticipantVo：id/name/isHost/nodeType/cameraOn/micOn/sharing/recording ✅（meeting_state.go:9-16 / §6.3:330-339 / meeting.ts:37-44）。
**avatar**（meeting_state.go:18, omitempty）运行时存在、前端存在(meeting.ts:45)，文档 §6.3:329-340 participants **未列** → ⚠️ **A4**。（`Account` 是 `json:"-"`，不外泄，符合 §2/§6.1:232。）

StreamVo：id/ownerId/ownerName/kind/video/audio/width/height/fps/compressionKind/active/endpoints ✅。
- **sourceBitrateKbps**：运行时 `int`（meeting_state.go:45），文档 §6.3:356 写 `number|null` 且要求"取不到显示 —"，前端 `number`（meeting.ts:68）→ ⚠️ **B2**（后端不会给 null，"显示 —"那条分支拿不到触发条件）。
- **videoCodec**：运行时存在（meeting_state.go:51），前端存在（meeting.ts:73），文档 §6.3:349-367 streams **未列** → ⚠️ **A5**。

### RecordingVo / PlaybackData（api/v1/recording.go:48-98）
RecordingVo：recordingId/meetingId/meetingNo/title/participant/status/mediaKind/mediaLabel/recordingType/deletable/startedAt/durationSec/meetingStartedAt/meetingSpanSec/fileSizeBytes/playbackUrl/downloadUrl ✅（recording.go:49-70）。
- **meetingNo**（recording.go:54，无 omitempty → 恒出现）：值取自三方录像目录的**分组摘要** `groups[].meeting.meetingNumber`，在我方摊平分组时保留到每一行（`service/recording.go:79,95-98,139`）。三方的 title 串里没有号，所以摘不到会的历史孤立录像（`meeting` 为 null、`key` 为 `legacy:<id>`）只能是空串，界面按「原会议已查不到」如实显示。Go 字段名 `MeetingNumber` 镜像三方字段名、线格式用我方形状 `meetingNo` —— 与下面 PlaybackMeeting 那条（C1）同例，不是新立的命名。
- **meetingStartedAt/meetingSpanSec**（recording.go:66-67，无 omitempty → 恒出现）：前端标可选（recording.ts:20-21）→ ⚠️ B3。
- **dataMissing?**：前端 recording.ts:26 声明，运行时 RecordingVo **无此字段**（永不发）→ ⚠️ **C2**。
- 注：§6 全篇无 `/recordings` HTTP 小节，RecordingVo 系整体无文档对照（→ §3.0 / F1）。

PlaybackData（RecordingPlaybackRes，recording.go:24-29）：partial/meeting/timeline/streams ✅ 形状。
- PlaybackStream：recordingId/displayName/mediaKind/mediaLabel/hasVideo/hasAudio/playbackUrl/downloadUrl/offsetSeconds/durationSeconds ✅（recording.go:86-97 / meeting.ts:29-45；has* 运行时恒出现，前端标可选 → B3）。
- PlaybackTimeline：startAt/durationSeconds ✅。
- **PlaybackMeeting 键名**（recording.go:75）→ **已裁定并修复（2026-10-10）**：json 键改为 `meetingNo`，Go 字段名不动。依据是全仓惯例 `meetingNo`（后端 4 处、前端 90 处、规格 §6.3 明写"用户可见的唯一入会号"），此处是唯一特例；探针里的 `meetingNumber` 读的是三方接口，与本键无关，不改。

### 头像/显示名（user.go）
UserAvatarRes.avatar（user.go:7）→ ✅（§6.9:555/556 / user.ts:5-6）。UserDisplayNameRes.displayName（user.go:24）→ ✅（§6.9:557 / user.ts:19-21）。

---

## 2. 不一致清单（本次交付的主要价值）

> 只登记，不选边、不调和。每条交回主会话裁定"改文档 / 改代码 / 改前端"。

### A. 文档 ↔ 运行时（api-contract.md 与代码实质不同）
- **A1 MeetingVo.thirdPartyMeetingId** | 文档说"已删除，不外漏"（api-contract.md:309-310）| 代码仍发且被前端消费：字段 meeting.go:294，填充 scheduleToVo meeting.go:1594-1598 / meetingToVo:1626；前端 meeting.ts:8 注释"回放页用它查录制清单"。
- **A2 schedule/PUT 请求体 allowWaiting** | 文档 §6.3:266 请求体清单 `{title,startTime,durationMinutes,cloudRecord,muteOnJoin?,cameraOff?,participantIds?}` 无 allowWaiting | 代码 meeting.go:60 有（且 service 用它决定门禁 meeting.go:216）；前端 meeting.ts:118 有。
- **A3 MeetingStateVo.cloudRecord** | 文档 §6.3:317-368 的 MeetingStateVo 未列 cloudRecord | 代码 meeting_state.go:64 存在；前端 meeting.ts:86 存在。
- **A4 participants[].avatar** | 文档 §6.3:329-340 participants 未列 avatar | 代码 meeting_state.go:18（omitempty）；前端 meeting.ts:45。
- **A5 streams[].videoCodec** | 文档 §6.3:349-367 streams 未列 videoCodec | 代码 meeting_state.go:51（h264|hevc，无 omitempty）；前端 meeting.ts:73。
- **A6 /ws-ticket 路径** | 文档两处各说一套：§5.1:196 写 `POST /api/v1/ws-ticket`、§6.1:217 又把 `/ws-ticket` 列在 `/api/v1/auth` 表下 | 实际路由是 `/api/v1/meetings/ws-ticket`（cmd.go:122，装饰体 meeting.go:253 path:"/meetings/ws-ticket"）；前端也打这条 meeting.ts:230。文档路径与分组**两处都错**（也是 §4-E1 的自相矛盾）。
- **A7 `/recordings` HTTP 端点整组无文档** | §6 无 GET /recordings/list、/{meetingId}/playback、/{recordingId}/download、DELETE、playlist.m3u8、hls/* 的小节（仅 §6.5.1 定浏览器本地清单，非 HTTP；controller 注释反复引用"契约 §6.5"但 §6.5 在现文件里不存在）| 代码 cmd.go:147-154 全部在册并运行。→ 派生时**无文档可对**，字段表只填了 代码↔前端 两栏。
- **A8 ChatMessageVo 键名（chat，未入 yaml）** | 文档 §6.6:527 `senderNodeType: 'edge'|'cloud'` | 代码 chat.go:31 `SenderEndpointType json:"senderEndpointType"`；且文档 §6.6:523 写 GET 返回 `data: ChatMessageVo[]`，装饰体 chat.go:12-14 是 `{messages:[...]}`（待核对，见 D 类）。

### B. 线格式 / 可空性（同一字段文档与代码给的"类型"不同）
- **B1 startedAt = string 还是 null** | 文档 §6.3:293（MeetingVo）、§6.3:323（StateVo）写 `string | null` | 代码 `StartedAt string`（meeting.go:296 / meeting_state.go:59），未开始是 `""` 不是 null；前端也按 string（meeting.ts:10/81）。→ 文档承诺 null，代码永远给 ""。
- **B2 sourceBitrateKbps = number 还是 number|null** | 文档 §6.3:356-357 写 `number | null`，并要求"取不到前端必须显示 —，不得用未压缩基线顶替（第 26 项）" | 代码 `SourceBitrateKbps int`（meeting_state.go:45），取不到是 **0** 不是 null；前端 `number`（meeting.ts:68）。→ "显示 —"那条判据在 null 上触发，而运行时从不给 null，用 0 还是"无数据"未在文档区分（潜在把 0 kbps 当真实码率显示的风险）。**〔2026-10-10 复核撤回后半句：前端用 `kbps>0` 而非判 null，"—"分支实际会触发，见 §4-B2〕**
- **B3 "可选(?)" 字段运行时从不省略** | 文档标可选：UserVo.avatar/positionCode/positionName（§6.1:231）、creatorName/creatorPositionName（§6.3:305）、RecordingVo.meetingStartedAt/meetingSpanSec（无文档，前端 recording.ts:20-21 标可选）、PlaybackStream.hasVideo/hasAudio（前端 recording.ts:39-40 标可选）| 代码这些 json 标签**无 omitempty**（auth.go:55/58/59、meeting.go:310/311、recording.go:62/63、recording.go:88/89）→ 键恒出现，只是值可能是 ""/0/false。OpenAPI 里我按"恒出现"标 required。

### C. 代码 ↔ 前端（两侧直接对不上，非文档问题）
- **C1 PlaybackMeeting 键名分裂 → **已修**（见 §2 首条）。复核补充：代理初稿把这条同时写成 C1 与 C3，且把 E1 说成"两处路径都错"。
  **〔2026-10-10 二次复核，我上一轮"§5.1 那条路径与代码一致"的收窄是错的〕** 直读 `cmd.go:107/118/122` 的分组嵌套：
  `/api/v1` → `Group("/meetings")` → `POST /ws-ticket`，实际全路径是 `/api/v1/meetings/ws-ticket`；
  而 §5.1 写 `POST /api/v1/ws-ticket`（少一级）、§6.1 把它列进 `/auth` 组表（分组错）—— **两处都错，原陈述成立**。
  前端 `meeting.ts:231` 打的也是 `/api/v1/meetings/ws-ticket`。文档两处已改。
- **C2 RecordingVo.dataMissing 前端独有** | 前端 recording.ts:26 声明 `dataMissing?: boolean`（注释"分片字节已被浏览器回收"）| 后端 RecordingVo（recording.go:48-67）**无该字段**，任何出口都不发。→ 需判定是本地清单串进了 HTTP 类型，还是后端漏发。
- **C3 join 响应 hasRecording 声明但运行时恒 false**（join 未入 yaml）| 文档 §6.3:269 与前端 meeting.ts:104 都列 `hasRecording`，装饰体 meeting.go:126 有字段 | handler `Join` 两处返回（meeting.go:394-401 等待态、466-473 入会态）**均未赋值 HasRecording** → 因是 bool 无 omitempty，键恒在且永远 false。前端"有无录制"若据此判定即永久失真。

### D. `api/v1/*Res` 装饰体 ↔ 运行时（我按运行时写 yaml；装饰体是这套形状的"第二份假真源"）
backend/AGENTS.md「待补」原文承认"`api/v1/*Res` 是 swagger 装饰，与实际 handler 返回形状不一致"。逐条：
- **D1 `/auth/me`** | 装饰体 MeRes = `{user: UserVo}`（auth.go:47-49）| handler `response.Ok(r, userVo)`（auth.go:119）→ data 直接是 UserVo，无 `{user}` 壳。文档 §6.1:216 反而与运行时一致（说 data=UserVo）。
- **D2 `/meetings/{id}`** | MeetingDetailRes `{meeting}`（meeting.go:48-50）| handler Detail 返回 meetingToVo 直发（meeting.go:142）/ detailFromUpstream 直发 vo（177）→ data=MeetingVo。
- **D3 `/meetings/schedule` `/quick-start` PUT `/meetings/{id}`** | MeetingScheduleRes/MeetingQuickStartRes/MeetingUpdateRes 均 `{meeting}`（meeting.go:64/95/84）| handler 全 `response.Ok(r, vo)`（230/264/1510）→ data=MeetingVo。
- **D4 `/meetings/today`** | MeetingTodayRes `{list: [...]}`（meeting.go:28-30）| handler Today `response.Ok(r, result)`，result 是 `[]MeetingVo`（107）→ data 直接是数组。
- **D5 `/meetings/{id}/state`** | MeetingStateRes `{state}`（meeting.go:224-226）| handler State `response.Ok(r, vo)`（574）→ data=MeetingStateVo。
（结论：装饰体普遍多包一层 `{单数名}`，运行时没有；**文档 §6 的 data 描述大多与运行时一致、与装饰体不一致**，说明装饰体是最该被生成物替换掉的那一份。）

### E. 规格文档自身矛盾（api-contract.md 内部两处说法不一）
- **E1 `/ws-ticket` 位置**：§5.1:196 说 `POST /api/v1/ws-ticket`，§6.1:217 又把它列进 `/api/v1/auth` 组表（即 `/api/v1/auth/ws-ticket`）——两个都不是代码里的 `/api/v1/meetings/ws-ticket`。
- **E2 `reason` 的取值域基数**：§1:29-31 说"目前只有一个值 `not_in_meeting`"，§1:55-68 的 FailStream 映射表又列出 8 个 reason（not_found/gone/warming/upstream_unreachable/no_channel/bad_request/system_error）。两处都在 §1，读起来像冲突（可解释为"信封一个/流式另算"，但文本没这么切分）。
- **E3 `/list` 数据源**：§6.3:264 说列表"以三方为全集：后端拉三方 `conference-management/state` 的 meetings"，而仓的 AGENTS.md（backend 与根）明确"**本仓已不再调 state**，改走集合端点 `GET /meetings`"。文档口径滞后于实现（schema 不受影响，但属"规格自相矛盾/过期"）。

### F. 结构性缺文档（不算"分叉"，但派生时无处对照）
- **F1** `/recordings` HTTP 六条路由（见 A7）：RecordingVo / PlaybackData 全套无文档 schema，只能以代码为单一来源——一旦接线时前端按自身 interface 生成，会与代码在这一组上悄悄分叉（C1/C2 已是证据）。

---

## 3. 未覆盖清单（端点 / VO + 为什么）

**未写进 yaml 的端点**（都在代码里运行、多数在 §6 有规格）：
- `/auth/sm2-public-key`（cmd.go:111；§6.1:212/§5.1:149；descriptor 由 sm2Svc.Issue 造，非 api/v1 struct，未采）。
- `/meetings` 组：`/today`(cmd.go:120)、`/stats`(121)、`/quick-start`(124)、`/join`(125)、`/precheck`(126)、`/leave`(127)、PUT `/{id}`(129)、`/start`(131)、`/stop`(132)、`/end`(133)、`/focus`(134)、`/recording/{action}`(135)、`/cancel` 已含、`/publications`+`/whip`+`/stop`(138-141)、`/streams/{id}/whep` POST/DELETE(143-144)、`/streams/{id}/frame-times` GET(145)、`/media-state`(146)、`/ws-ticket`(122)。
- `/users` 列表（cmd.go:175；§6.2:243，UserBriefVo）。
- `/chat/messages` GET/POST（§6.6）、`/settings/` GET/PUT（§6.7，PreferenceVo model/settings.go）、`/dicts/{type}`（§6.8，DictItemVo）、`/net-probe/*`（§6.10）、`/recordings/{id}/playlist.m3u8` 与 `/hls/*path`（§6.4/§6.5 语义，二进制改写）。

**未采的 VO/DTO**：MeetingStatsRes、MeetingJoinRes/InitialMediaVo（join 相关，见 C3）、MeetingPrecheckRes、WsTicketRes、PublicationCreateReq/Res、MeetingMediaStateReq、ChatMessageVo、PreferenceVo/SettingsGetReq、DictItemVo。

**为什么没做**：任务给的是最小集 + "宁可小而全对"。以上端点要么含大量三方代理/二进制语义（whep/whip/hls/media 需逐条核对流式契约与 reason 映射），要么 schema 与 §6 有额外分叉需单独裁（join 的 hasRecording=C3、chat 的 senderEndpointType=A8）。逐个派生会拉长核对面、增加误抄风险，留给接线轮次。

---

## 4. 裁定与落地（2026-10-10 主会话，含两轮取证）

> 取证方式：两条并行子代理只做取证、不选边 —— 一条查**前端消费面**（字段有没有人读、读到 0/""/false 会不会变行为），
> 一条查**后端装饰体使用面**（`*Res`/`*Req` 有没有真引用、swagger 到底生不生效）。
> 两条"缺陷陈述"我按老规矩自己复验过：`conference-management/state` 全后端零调用（只剩 `…/meetings` 集合端点）、
> `HasRecording` 在 handler 里确未赋值。
> **其中两条取证结果推翻了本文件此前的猜测**，已就地更正（见 B2、C2）。

| 条 | 裁定 | 依据（取证） | 落地 |
|---|---|---|---|
| **A1** `thirdPartyMeetingId` | **改文档**（文档说"已删除"是假的） | 前端强消费：`AllMeetingsView.vue:287` 拿它当进回放的门禁、`:295` 当路由参数。后端删掉＝回放入口全断 | §6.3 恢复该字段，并写明它是"回放查询的键"，不是可外泄的三方 ID |
| **A2** `allowWaiting` | **改文档**（请求体漏列） | 代码 `meeting.go:60` 有、service `:216` 用它决定门禁；前端 `meeting.ts:118` 有 | §6.3 schedule 请求体补列 |
| **A3** `MeetingStateVo.cloudRecord` | **改文档** | 代码 `meeting_state.go:64`、前端 `:86` | §6.3 StateVo 补列 |
| **A4** `participants[].avatar` | **改文档** | 代码 `meeting_state.go:18`（omitempty）、前端 `meeting.ts:45` 有消费（`avatarImage.ts:20`） | §6.3 participants 补列 |
| **A5** `streams[].videoCodec` | **改文档** | 代码 `meeting_state.go:51`、前端 `:73`；且 ADR-0079 早就定了它的语义，只是没回填到字段表 | §6.3 streams 补列并指向 ADR-0079 |
| **A6/E1** `/ws-ticket` 路径 | **改文档，两处都改** | 实际注册：`cmd.go:107` `/api/v1` → `:118` `Group("/meetings")` → `:122` `POST /ws-ticket` ⇒ `/api/v1/meetings/ws-ticket`；装饰体 `meeting.go:253` 的 `path` 与之**一致**；前端 `meeting.ts:231` 也打这条。**我上一轮把 §5.1 判成"其实一致"是错的，已二次更正**（见 §2-C1） | §5.1 补上 `/meetings` 一级；§6.1 那张 `/auth` 表里这行标注"不在本组" |
| **A7/F1** `/recordings` 六条路由无 HTTP 小节 | **补文档**（新增 §6.3.5 一节） | `cmd.go:147-154` 全部在册并运行；controller 注释反复引用一个不存在的"§6.5" | 新增小节，形状以 yaml/schema 为准，注释里的假 §6.5 指向改为真节号 |
| **A8** `senderEndpointType` | **改文档**（未入 yaml，先记账） | 代码 `chat.go:31` json 键是 `senderEndpointType`；文档写 `senderNodeType` | 待 chat 进 yaml 时一并改，本轮不动 |
| **B1** `startedAt` 是 `string` 不是 `string\|null` | **改文档** | 代码 `StartedAt string`，未开始给 `""`；前端也按 string | §6.3 两处类型改回 `string`，并写"未开始=空串" |
| **B2** `sourceBitrateKbps` 的 null 语义 | **改文档**；**本文件初稿的"判据永不触发"是错的，撤回** | 前端从不判 null：`InMeetingView.vue:1781` → `compression.ts:33` 是 `kbps>0 ? … : '—'`。**0 就是"取不到"的编码**，"—"分支实际会触发 | §6.3 类型改 `number`，判据改"0 显示 —"；`*int + omitempty` 的方案**不做** —— 现口径已自洽，改代码只是为文档的一处笔误去冒线上风险 |
| **B3** 文档/前端标"可选"而运行时恒出现 | **以 schema 为准**：yaml 已按"恒出现"标 `required`，前端手写的 `?` 等接线时由生成类型统一替换，本轮**不为它改前端** | 逐个核对过渲染行为：`avatar`/`positionName`/`creatorName`/`positionCode`/`meetingStartedAt`/`meetingSpanSec` 前端都用 `\|\|`/真值判断，`""`/`0` 与缺键等价，改必填不掩盖缺陷 | 记在 §1 表内；唯一例外见下行 |
| **B3-例外** `hasVideo`/`hasAudio` | **保留前端 `??` 兜底**，契约仍标 required | `cloudReplay.ts:74-75` 用 `??`，注释（`recording.ts:37`）说"字段缺失才退回推断"—— 那是给**浏览器本地清单**造的对象留的，本地那套不经过 HTTP | 契约里 required；前端 `?` 是本地/云端共用形状的代价，接线时再拆两种形状 |
| **C1** `meetingNo` 键名 | **已改代码**（2026-10-10，见本仓 `6e47f04`） | 全仓惯例 `meetingNo`（后端 4 处 / 前端 90 处），此处是唯一特例 | 已落 |
| **C2** `dataMissing` | **改前端**（本文件初稿"需判定是否后端漏发"—— 判定完了：**不是漏发**） | 前端有消费（`RecordingListView.vue:41/42/44/358`），但唯一赋值处是 `:272 dataMissing: !dataFlags[i]`，`dataFlags` 来自 `:221-240 hasLocalData()` 探 IndexedDB/文件句柄 —— **它是浏览器本地派生位，从不经 HTTP** | 从 `api/recording.ts` 的 HTTP interface 摘掉，落到本地清单类型上 |
| **C3** `hasRecording` 恒 false | **删字段**（前后端 + 文档），不补实现 | 前端**零消费**（全 src 只命中 `meeting.ts:104` 的类型声明本身）；后端两处返回均未赋值 → 留着就是一个会误导下一个读者的死字段 | 删 `api/v1/meeting.go:126` 字段与前端类型行；§6.3 改注"有无录制走 `GET /recordings/list`，不在入会响应里" |
| **D1–D5** 装饰体多包一层壳 | **删除这些 `*Res` 响应壳体** | 关键取证：路由全用 `g.GET/g.POST(path, ctrl.Method)` 显式注册、handler 是非标准 `func(r *ghttp.Request)`、**无一处 `group.Bind()`** ⇒ gf 的 OpenAPI 反射根本关联不到这些 struct；`manifest/` 下也没有生成产物。即"对运行时与 swagger 双向皆死" | 删 D 类七个 `{单数名}` 壳；`*Req` 一律保留（35 处 `r.Parse(&req)` 真消费），`AutoLoginReq` 还被 `auth_public_paths_test.go:14` 反射用来对账路由前缀 —— 那是活的 |
| **E2** `reason` 基数 | **不是冲突，是行文没切开** | §1:29-31 讲**信封** reason（目前只 `not_in_meeting`），§1:55-68 讲 `FailStream` 由状态码**一处导出**的 8 值，且 `:55-57` 已说明"例外在消费方不在语义" | 把两句的归属显式标注（"信封 1 值 / 媒体代理按状态码导出"），不改判据 |
| **E3** `/list` 数据源 | **改文档**（文档滞后于实现） | 全后端搜 `conference-management/state` **零命中**，实际调 `…/meetings`（`adapter.go:300`） | §6.3 `/list` 行的端点名改正 |

**接线（前端改读生成类型）本轮仍不做**：等 A7 新增的 `/recordings` 小节与 chat/join 那几条进 yaml、覆盖面补起来之后一次性切，
免得切一半再被 §6 的补记二次打断。G5 已经能挡住"改了 schema 忘重生成"和"手改生成物"两类事。

---

## 5. "规格本身自相矛盾"清单（单独列）

- **E1** `/ws-ticket`：§5.1 少写一级（`/api/v1/ws-ticket`）、§6.1 又把它列进 `/auth` 组表 —— **两处都错**，代码是 `/api/v1/meetings/ws-ticket`（`cmd.go:107/118/122`）。已改文档。（本条曾被我误判成"只有 §6.1 分组错"，更正记录在 §2-C1。）
- **E2** `reason` 基数：§1:29-31"只有一个值" vs §1:55-68 八值映射表。
- **E3** `/meetings/list` 数据源：§6.3:264"调三方 state" vs 仓 AGENTS"已不再调 state"。
- **补充**：§6.1:216 说 `/auth/me` data=UserVo（对），而 §6.9 标题把该端点归到"users/me"叙述里；加上装饰体 D1 的 `{user}` 壳，同一"当前用户"形状在本文件与代码里有三种表述（UserVo 直发 / `{user}` 包 / 归组名不同）。

---

## 6. 第二批派生账（2026-10-10，会议生命周期 / 发布链路 / 聊天）

覆盖面从 18 条补到 **35 条路由 / 34 个 schema**。这一批的形状来自"回 handler 数实返回"，
取证由只读子代理完成、我按 §4 开头那条规矩逐条抽验（子代理的陈述不等于事实）后才写进 yaml。要点按"会咬人"排序：

1. **成功没有 data 键的一族**：`OkWithMessage` 只回 `{code,msg}`（leave / start / stop / end / focus /
   whip DELETE / publications stop）。前端若按 `data` 判成功就会在这些地方炸。
2. **`/publications/:pubId/whip` POST 根本不是 JSON 信封** —— 成功是 `application/sdp` 原文转发三方 answer，
   失败是 `WriteStatus(502, 纯文本)`（`meeting.go:1188,1196-1198`）。判据只能是状态码 + 内容类型。
3. **`media-state` 回 `data: {}`**（空对象、不是缺键；出口 `Ok(r, v1.MeetingMediaStateRes{})`，该 struct 无字段）。
4. **`/today` 与 `GET /chat/messages` 的 data 直接是数组** —— 装饰体里的 `{list}` / `{messages}` 壳
   从未在线上出现过（那批壳已随 §4-D 删除）。
5. **`join` 8 键恒出现**（无一处 omitempty）：等待态 `participantId=""`、真入会态 `waiting=false`，
   所以"键在不在"不能当分支，判有没有进去只看 `waiting`。确认无 `hasRecording`。
6. **`precheck` 只在不可入会时带 `message`**，可入会走 `Ok` → 该键整个缺失（不是空串）。
   前端不许按 `message` 空串判分支。
7. **`recording/{action}` 的取值域由校验标签定**：`v:"required|in:start,stop"`（`api/v1/meeting.go:214`），
   越界在 `r.Parse` 就 400，进不到业务分支。
8. **`/auth/sm2-public-key` 不在 `api/v1` 里**：descriptor 由 `service/auth_sm2.go:56-65,85-94` 现场造，
   按装饰体导出会整个漏掉这一个端点的形状。
9. **A8 落定**：线上键名是 `senderEndpointType`（REST 两路），`senderNodeType` **只存在于 WS 推送**
   （`websocket/hub.go:404`）—— 两个名字分属两条通道，不是同一字段改名。
   而前端 `api/chat.ts:7` 的 REST 类型误写成 `senderNodeType`，且全 src 无一处读 REST 侧该字段。
   裁定：**改前端类型**（接线时由生成类型替换）；本轮只记账不动它，避免半接线状态下的空改。
10. **`POST /chat/messages` 回显 `id:0`**（自增主键不回查）—— 前端不许拿它当这条消息的标识。

**仍未覆盖**（下一批）：`/users` 列表、`/settings` GET/PUT、`/dicts/{type}`、`/net-probe/*`、
`/recordings/{id}/playlist.m3u8` 与 `/hls/*path`（二进制改写与 HLS 语义需单独核）、WS `/ws/v1/meeting` 帧形状。

**〔已收口 2026-10-10〕** `reason` 的取值域此前记为"未逐端点枚举、yaml 里是自由字符串"，现已扫成枚举：
全后端只有 `errs.BizReason(err, R)` **一个注入点**，实参常量只有三个 —— `not_in_meeting`
与 `auto_login.go:31-32` 的 `auto_login_disabled`/`auto_login_user_unavailable`；且多数失败
**根本没有 reason 键**（omitempty），所以信封侧是"三值枚举 + 可选"。
媒体代理侧另算：`streamReason`（`response.go:106-124`）由状态码一处导出，实测 8 值，已写进 `StreamError.reason`。
**E2 那条"看起来冲突"由此有了硬证据**：两套 reason 的产生机制不同（业务点名 vs 状态码推导），不是行文没切开。

## 7. 第三批：WebSocket 帧形状进契约（2026-10-10 收口）

缺口补完 —— **HTTP 42 条路由 + WS 9 类帧**全在契约里了。这一批推翻了我上一轮自己的一个判断：

**我曾在 §4-B3-例外和前端 AGENTS 里写"四个跨通道类型故意没接线，因为接上等于一名覆盖两通道"。
取证后这句话的前提不成立**：`participants`/`invited`/`streams`/`meeting` 四类帧的 payload 与 REST
是**同一个 Go 结构、同一个构造器**（`model/meeting_state.go` + `service/meeting_state.go:25-133`），
字段级零分叉，分叉只在**包装形状**（WS 的 `participants` 帧多一层 `{participants, invited}` 匿名对象、
`streams` 帧根是裸数组）。所以正确的处置是**把包装形状也建成类型**（`WsParticipantsData`/`WsStreamsData`），
而不是让元素类型继续手写。四个类型已接线，`vue-tsc` 零错误 ——
顺带证明它们原先那些 `| string` 放宽是前端自己加的，消费点从来没用过。

### 接线当场暴露的两个真问题

1. **`ChatMessageVo.senderEndpointType` 我上一轮写的 `enum: [edge, cloud]` 是假约束，已撤。**
   REST 侧是**三方原值透传**（`thirdparty/types.go:359` → `service/chat.go:51`），实测值域含
   `ship`/`shore`，代码还容忍 `edge`/`cloud`/`board`，且 `NodeTypeOf` 对不认识的值**只告警不假装认识**
   （`meeting_state.go:210-228`）—— 值域本就是开的。**归一只发生在 WS 那一侧**。
   参会者的 `nodeType` 则确实过了 `NodeTypeOf`（`meeting_state.go:84`），那条枚举是真的、保留。
2. **聊天列表一个类型装两种形状**：`useWebSocket.ts` 的 `messages` 同时装 REST 历史与 WS 推送，
   原先靠 `as ChatEvent` 硬掰 + `senderNodeType?` 标可选把分叉静音。接线后编译器报出来了。
   查清**全仓无人读那个侧别字段**（面板只读 `id/senderName/sentAt/text`）之后，
   处置是如实收成联合 `ChatLine = ChatMessageVo | ChatEvent` 并**删掉断言**，
   不是给某一侧补假字段。

### 另外三条按契约补的守卫

- 信封 `data` 无 omitempty → 服务端**可以**发来 `"data":null`（Go 侧 `Data interface{}` 为 nil）。
  前端原来没有这个分支；现已在 `onmessage` 里加空值丢弃，并核过**后端 7 处构造点今天都不传 nil**，
  所以这是"契约允许、实现未产生"的一种取值，不是补锅。
- 上行 `media` 的四个键是**可空指针**：`UpdateMedia` 收 `*bool`，"没提这项"与"提了但为 false"必须分得开。
  注释里留着历史坑 —— 这里曾直接反序列化三方 `MediaState`（词形 `cameraEnabled`），
  前端发的字段一个都对不上，**媒体意图位恒 false**。
- 上行 `speaking` 全 src **无调用点**（前端本地检测只写 `speakingMap`）。契约如实标"这条上行目前空转"，
  没删后端分支（删它是另一个决定），只记账。

### 仍未收口

- `WsMeetingData` 的零值兜底：撤房补发那一帧只填 `meetingId` 与三个空数组，其余键是零值，
  而契约标全 required —— **前端不许按"键在不在"判有没有数据**。这条只在契约注释里写了，没有门禁盯着。
- WS 无应用层 ping/pong（服务端每秒那次心跳是对三方的，与浏览器无关）；
  断线判定完全依赖 `onclose` + 指数退避，这一点未做端到端验证。
