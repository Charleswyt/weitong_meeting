# 卫通会议前后端 HTTP / WebSocket 契约

版本日期：2026-09-28
消费者：`cloud/backend/`、`cloud/frontend/`

本文件定义**我们自己**前后端之间的规约，按本域业务语义设计。
**三方平台是 backend 的实现细节**：三方字段命名、令牌（participantToken 等）、签发 URL、
错误码一律不出后端适配层，前端零感知。三方能力变化只应引起本契约的*增量*，不应引起*镜像*。

## 1. 统一响应格式

单对象：
```jsonc
{ "code": 200, "msg": "操作成功", "data": { /* T */ } }
```

分页：
```jsonc
{ "code": 200, "msg": "查询成功", "rows": [ /* T[] */ ], "total": 150 }
```
**`rows` 与 `total` 恒在**：空集也要回 `"rows": []、"total": 0`。
出口 `response.OkWithRows` 因此**不走 `omitempty`** —— 一旦让 0 消失，前端拿 `undefined`
去渲染分页就是空白（2026-09-29 实测 `?status=running` 命中 0 条时就是这样）。

失败：
```jsonc
{ "code": 500, "msg": "具体错误信息", "reason": "not_in_meeting" }
```
`reason` 可选，是**给前端的分支信号**不是给用户看的文案。**分两个口径数，别看错了以为冲突**（E2 澄清 2026-10-10）：
- **普通 JSON 信封**：目前只有一个值 `not_in_meeting` —— 本端已不在这场会里（刚离会 / 被另一台设备顶号 / 会已散），
  前端收到它表示"静默收尾、离开会中页"，**不得弹报错**（第 1 项，见 6.4.33 ①）。
- **媒体代理端点（`response.FailStream`）**：由 HTTP 状态码**一处导出**，共 8 值，见本节末的映射表。
  两边都是机器值、都不是文案；差别只在"谁规定它"——前者由业务分支点名，后者由状态码推导。

鉴权失败：`code: 401`。前端拦截器一律按 `code !== 200` 判错并弹 `msg`。

**`msg` 只装我方自己写的、用户可操作的中文。** 三方原始错误体、SQL/驱动报错、GoFrame 校验英文
一律不进 `msg` —— 后端出口是 `response.FailSystem(op, err)`（细节只写服务端日志，`msg` 固定
「系统异常」）与 `response.FailValidate(err)`（参数校验失败，`code: 400`，`msg` 固定「请求参数不合法」）。

**`msg` 里不得出现实现词。** 前端只认这一个后端，`msg` 会被原样弹给用户，所以其中不得出现
「三方 / 上游 / 板卡 / 船端 / 岸端 / 本地网关」这类描述**我方如何实现**的词；改成用户能行动的
说法（例：`board_recording_requires_local_gateway` → 「云端录制需在会议设备侧发起，本页面无法开启」）。
被去掉的原始原因一律 `glog` 进服务端日志，不丢诊断信息。同理，前端界面文案与代码里也不出现这些词。

**需要前端分支时读 `reason`，不读 `msg`。** 错误信封可带一个可选的机器码字段：

```json
{ "code": 500, "msg": "请先加入会议", "reason": "not_in_meeting" }
```

`reason` 只放**我方定义**的稳定枚举值，`msg` 只给人看；前端 `ApiError.reason` 消费它。
已定义值：`not_in_meeting` —— 服务端已经没有这个会话（会议已结束、房间被回收、后端重启），
前端的动作是**清会话态并离开会中页**，不是弹一句报错。新增取值必须同时改本表与前端分支，
**不得让前端退回比对中文文案**。

媒体代理端点（`response.FailStream`）例外在"消费方是播放器、必须回真非 2xx"，**不在 `reason` 的语义**：
它的 `reason` 同样必须是机器值，由状态码**一处导出**（调用点不传第二份字符串）。
导出名按 HTTP 语义取通用词，因为这三条端点（订阅 / 录制资源 / 头像）共用它 —— 404 在头像那里不是"流没了"：

| HTTP | `reason` | 会中页订阅链路该怎么动 |
| --- | --- | --- |
| 401 | `not_in_meeting` | 正常收尾：清会话态、离开会中页，不弹错 |
| 404 | `not_found` | **终态**：这条流已经没了 —— 不重试、不挂红字，等下一轮 state 把它摘掉 |
| 410 | `gone` | **终态**：会已散 —— 同上，且整页停止重订 |
| 503 | `warming` | 中间态：1.5 秒短间隔重试，不进 10 秒冷却 |
| 502 | `upstream_unreachable` | 上游接不通：进冷却 + 一句可行动提示 |
| 501 | `no_channel` | 这路本来就没有该通道：**正常分支**，换通路继续，不算失败 |
| 400 | `bad_request` | 我方自己请求拼错了 —— 记日志，重试无意义 |
| 其他 | `system_error` | 兜底一句「系统异常」 |

〔2026-09-30 更正〕`FailStream` 此前把 `reason` 填成了 `msg` 本身（人话占了机器字段的位置），
直接后果就是前端只能 `msg.includes('还在准备中')` 这样猜文案 —— 违了本节第 52 行那句"不得"。
现已按上表出一处映射改定。视频腿走的是托管播放器，**它连状态码都不回吐**，
所以那一侧的终态判定改读**已轮询到的 state**（这条流还在不在本轮名单 / 会还在不在 running），
同样不许解析文本（`utils/streamFailure.ts`，判据表可 Node 直跑）。

### 1.1 超时上限与日志分级〔新增〕

**任何用户可感知的请求，超时上限 10 秒，不允许更久。**

- 前端 `src/utils/request.ts` 的 axios `timeout = 10000`。
- 后端在请求路径上发起的出站调用同样 ≤10s。
- 后端**等外部数据最多 8s**（留出回话与网络往返的余量），到点必须给出明确答复，
  不能让客户端先超时。
- 慢端点（实测 ~78s 的全租户聚合）**不得出现在请求路径上**：请求侧只读进程缓存，
  刷新在后台单飞做。首页缓存缺失时直接降级只出本地数据；录制索引缺失时回
  `503 + 「录制列表正在同步，请稍后重试」`，**绝不返回空列表假装没有数据**。

〔第 35 项收口：全量核对，不只看一处〕

| 环节 | 值 | 依据 |
| --- | --- | --- |
| 前端 axios | 10s | `request.ts timeout: 10000` |
| 后端出站（三方 API/媒体代理） | 10s | `thirdparty/adapter.go httpClient Timeout` |
| 浏览器 ICE 收集 | 2s / 2s | 发布 `ICE_GATHER_LIMIT_MS`、订阅 `waitIceComplete` —— 本轮核对确认**已有上限**，不需要改（这里记的是核对结果，不是改动） |
| WS 写截止 | 5s | `websocket/hub.go SetWriteDeadline` |
| **服务端读超时** | **10s（本轮新增）** | GoFrame 默认 `ReadTimeout=60s`（`ghttp_server_config.go`），是用户可感知的白等窗口，超出上限 → `server.readTimeout: "10s"` |

服务端读超时不是"配了就算"，用**半截请求体**实测：只发 header + 一部分 body（`Content-Length: 500`）然后不发。
配之前 12 秒的观察窗内连接一直挂着（对得上默认 60 秒）；配之后第 **10 秒整**服务端主动断开并回包
（探针 `backend/temp/slowbody.mjs`）。写侧刻意不设上限：媒体代理与 WS 是长连接流，一刀切 10 秒会把回放与
订阅在半路掐断 —— 改后浏览器首页/会议页照常工作（实测首页正常渲染、无"系统异常/请求失败"）。

**日志分级按"谁能处理"划分，不按"谁出错"划分。**

| 级别 | 场景 | 例 |
|---|---|---|
| `Error` | 我方代码/依赖故障，需要人看 | 未识别的入会失败、录制压制落库失败 |
| `Warning` | 外部系统没配合，但已按设计降级 | 后台刷新失败暂用上一份、三方返回可重试中间态 |
| `Info` | 幂等命中、正常业务的边界态 | 上游已无该录制，按删除成功处理 |

用户界面上**不出现任何技术细节**：厂商 reason、HTTP 状态码、字段名、内部 id、堆栈一律只进日志；
`msg` 只写用户下一步能做什么的中文。

## 2. 时间戳

所有时间字段一律 ISO-8601 带时区偏移，例：
```
"startTime": "2026-09-08T09:00:00+08:00"
```
前端**固定按业务时区（`Asia/Shanghai`）渲染**，不按浏览器系统时区：会议是船岸业务时区里的事件，
客户端系统时区是 UTC 时把 09:30 的会显示成 01:30 属于错误显示，不是"本地化"。
渲染入口只有 `src/utils/time.ts`（`formatDateTime` / `businessClock` / `businessDayKey`），
页面里不许再出现裸 `getHours()` / `toLocaleString()`。
线格式仍带显式偏移 —— 绝对时刻不依赖任何一端的系统时区；将来若要"按用户时区"显示，
由服务端下发业务时区字段，不改本条线格式。

服务端侧同样不跟宿主机走：进程时区由 `server.timezone` 钉死，达梦容器跑东八区
（表里有 `DEFAULT CURRENT_TIMESTAMP`）。三方的 `startAt` 是 **Unix 秒**，只按时刻换算、不做墙钟加减。

预约表单的"时区"下拉语义 = 墙钟时间所配的显式 UTC 偏移，提交带偏移的 ISO 串，不做静默丢弃。

## 3. 分页请求

```
GET /api/v1/<resource>/list?pageNum=1&pageSize=10&orderByColumn=startTime&isAsc=desc
```
`orderByColumn` 只允许白名单列（后端 switch 校验，防注入）。

## 4. 字段命名

- 数据库列：`snake_case`；Go：`PascalCase`；JSON / TS：`camelCase`
- 布尔偏好用 `boolean`（新字段不再用 0|1；存量 `faceEnhancement` 等下轮统一）
- 命名按本域语义（`micOn/cameraOn/hostId/streams`），**不照抄三方词形**

## 5. 认证

### 5.1 前端 ↔ 我方后端

- `GET /api/v1/auth/sm2-public-key` → 线格式见 `api.openapi.yaml` `GET /auth/sm2-public-key`
  （**md 曾写 5 字段，实际 8 字段**：另有 `curve`/`ciphertextEncoding`/`expiresInSeconds`，以 yaml 为准）
- `POST /api/v1/auth/login`：SM2 信封（前端 sm-crypto C1C3C2 加密
  `{username, password, challenge, issuedAtMs, nonce}`；密文去 C1 前导 `04`、小写 hex）。
  后端私钥解密→口令比对。落库形态自 2026-09-29 起是 **PBKDF2-HMAC-SHA256 + 每用户随机盐**
  （`internal/password`，串形 `pbkdf2-sha256$迭代$盐$摘要`，10 万次 / 87 字节，列宽 128 够用）；
  不带该前缀的历史值仍按明文比，且**登录成功后就地换成哈希**，所以"种库→跑哈希"两步之间不会把人锁在门外
  （批量补跑：`go run . hash-passwords`，幂等）。此处旧版本先写"BCrypt 校验"、后写"明文比对属待办"，
  两条都已过期，以本节为准。challenge 一次性（5 分钟 TTL）；
  信封校验失败回 `409 {code, msg, reason}`，`reason` 取值域固定为四条：
  `key_mismatch` / `challenge_invalid_or_used`（这两条**可重试** → 前端重取公钥**重试一次**，
  见前端 `SM2_RETRY_REASONS`）、`crypto_failed`（密文本身坏，不重试）、
  `envelope_incomplete`（信封是好的、里面没装账号或口令 → 不重试，`msg` 必须说"请填写完整的账号和密码"，
  不能笼统说"凭证失效"，否则用户会去刷新页面而不是补口令）。
  〔2026-09-29 修的形态缺陷〕这条 409 原先用 `WriteStatus(409)` + `WriteJsonExit`，
  gf 会把状态短语 `Conflict` 拼在 JSON 前面 → 响应体不是合法 JSON，且 `reason` 整个丢掉，
  后果是**前端那条重试路径从来没生效过**、用户只看到一句「系统异常」。
  现收进 `response.FailStatus(status,msg,reason)`（内部先 `ClearBuffer()`）——
  **凡"要回真非 2xx 状态码、但消费方是前端代码"的出口都必须走它**，不要在控制器里手拼。
  登录成功后"该账号的会议链路是否已打通"经 `linkSynced/linkReason` 如实回传。
  〔变更〕旧字段名 `thirdPartySynced/thirdPartyReason` 作废：字段名本身就把"实现对端的是外部系统"
  这件事告诉了前端，违反"前端只认后端"。同理 `linkReason` **只允许我方本域中文**
  （口令不对 / 连不通 / 未同步三类），外部系统的原始报文只进服务端日志。
- 其余请求：`Authorization: Bearer <jwt>`；JWT claims `userId/username/accountType`。
- `POST /api/v1/auth/auto-login`〔2026-10-08 新增，**临时方案**〕：**公开端点**（不校验 Bearer），无需口令即换一个
  固定用户的令牌，返回体与 `/login` **同形状** `{token, user, linkSynced, linkReason}` —— 前端拿到的是同一条 JWT，
  所以 WS 一次性票、`?token=` 媒体资产、以及后端那条按 userId 缓存的会议链路令牌全部照旧复用。
  身份来源是**一条链、没有并列真源**：`AUTH_AUTOLOGIN_USERNAME`（环境变量）> `auth.autoLogin.username`
  （配置文件，镜像内置默认 `wangqiang`）；取值必须是《账号清单》(`docs/账号清单.md`) 里的登录名，
  且**边云两端不得填同一个账号** —— 同账号会让日程过滤、录制目录 `hxt/{登录账号}/{时刻}/{会议编号}/`
  那一段、以及按用户缓存的那条会话混成一坨。
  **不做前端构建期注入**：bundle 由 `pnpm build` 烘死，容器运行时的环境变量改不动它，
  所以"此刻是不是免登录、免的是谁"只有后端知道，前端只问结果。
  开关关闭 / 配置的账号在系统内不存在或被禁用 → `403 {code, msg, reason}`，
  `reason` 取 `auto_login_disabled` 或 `auto_login_user_unavailable`。
  **这里故意不用 401**：401 会命中前端拦截器自己的登出分支（清令牌→跳登录页），在这个模式下就成了
  "探测一次就把自己踢出去"的回路；`/login` 那条路只留给真正的登录态失效。
- **票参兜底**：浏览器原生加载器（`<video>`/`<img>`/hls.js 的 fetch）带不了请求头，只有**只读**端点
  接受 `?token=<jwt>`：会中媒体代理、录制回放资产、头像字节（§6.4 / §6.5 / §6.9）。
  后端按**固定路径形状 + 固定尾段**精确匹配放行，写操作与列表/详情一律不在其列；票参值仍是本人 JWT，
  **不由后端拼进任何 VO 字段**（避免令牌被写进 JSON、历史与 Referer）。
- **鉴权失败的写法按"谁来读这份响应"分两种**（2026-09-29 实测后补的口径）：
  会被**交给解码器**的路径 —— `…/playlist.m3u8`、`…/hls/*`、会中帧流 —— 回**真 401**；
  其余一律仍是 `HTTP 200 + {code:401,msg}` 信封。理由是前者若走信封，hls.js 会把
  「未登录」那 31 字节 JSON 当媒体数据喂进解复用器，用户端只剩一句与真因无关的解析错误；
  而 `…/download` **不走真状态码** —— 前端那段"先试 JSON 再落 blob"的取词逻辑要靠信封拿到 `msg`，
  改成真 401 就退化成一句「下载失败」（第 7 项：可读的话仍由后端写）。
- **WebSocket 鉴权**：浏览器 WS 不能带请求头 →
  `POST /api/v1/meetings/ws-ticket` `{}`（Bearer）→ 线格式见 `api.openapi.yaml` `POST /meetings/ws-ticket`（短时一次性）；
  连接 `GET /ws/v1/meeting?meetingId=<id>&ticket=<ticket>`。
  三方的参会令牌由后端在此映射持有，**永不出现在前端**。

### 5.2 我方后端 ↔ 三方（实现注记，非前端契约）

后端以管理员身份对三方 SM2 登录、以用户映射账号 join 取得参会令牌，登记
`(userId, meetingId) → 参会令牌`；对三方的 heartbeat/focus/board 调用均由后端代发。
详见 `platform/contracts/edge-to-cloud/EXTERNAL_HTTPS_CONFERENCE_API.md`。

## 6. 端点契约

### 6.1 `/api/v1/auth`

> 端点清单（线格式明细见 `api.openapi.yaml`，本节只列路径与业务语义）：
- `GET /sm2-public-key`
- `POST /login`
- `POST /auto-login`
- `POST /sms/send`〔2026-11-20〕公开：`{mobile, purpose:login|reset}` → `{cooldownSeconds, provider, debugCode?}`。
  手机号必须已绑在 `sys_user.MOBILE`；未绑回业务拒绝。默认 `auth.sms.provider=console`（验证码进服务端日志，
  且 `debugCode` 回前端便于联调）；换成 `smsbao` 等后正式下发短信、`debugCode` 不下发。
- `POST /sms/login`〔2026-11-20〕公开：`{mobile, code}` → 与 `/login` **同形状** `{token,user,linkSynced,linkReason?}`。
- `POST /sms/reset-password`〔2026-11-20〕公开：`{mobile, code}` + 与 `/login` 同形的 SM2 信封字段（信封内 `password` 为新口令）；
  成功无 data，只回成功文案。
- `POST /email/send`〔2026-11-20〕公开：`{email, purpose:login|reset}` → `{cooldownSeconds, provider, debugCode?}`。
  `purpose=login`：未注册也可发码（首登自助注册）；`purpose=reset`：邮箱须已有账号。
  发件走 `auth.email`；`provider=console` 时验证码进日志并回 `debugCode`。
- `POST /email/login`〔2026-11-20〕公开：`{email, code, displayName?, registerAs?}` → 与 `/login` **同形状**。
  验证码通过且邮箱未注册时**自动建号**（USERNAME=邮箱、无三方口令 → 常为 `linkSynced=false`）；
  `registerAs=temp` 建 `temp_user`（临时用户，须带显示名，面试场景）；否则 `meeting_participant`（普通用户）。
  已注册则直接签发（不改类型）。
- `POST /logout`
- `GET /me`
- `POST /ws-ticket 不在本组 —— 实际注册在 meetings 组下：/api/v1/meetings/ws-ticket（cmd.go:107 /api/v1 → :118 Group("/meetings") → :122 POST /ws-ticket；前端 meeting.ts:231 打的也是这条）。本表此行是历史误列，路径以 §5.1 为准`

**`/auto-login` 的前端消费口径**〔2026-10-08〕：路由守卫在**没有令牌时先试它一次**（共享一条在途 Promise，
本轮失败就不再重试 —— 否则每次导航都打后端一回）；成功就继续去**原目标路由**（不是硬跳 `/`），失败落 `/login`。
免登录成立时前端把这一态记在 `localStorage.autoLogin`，据此**隐藏「退出登录」**（一个点了立刻被登回来的按钮
就是死按钮），并在令牌到期回 401 时**静默重签一次、原请求只重放一次**（板卡放一夜不能变成死页）；
重签仍失败才清真令牌回登录页。
`auth.autoLogin.enabled` 改回 `false` 即恢复现有登录流程 —— 登录页、`/login` 路由与 SM2 信封链路一行未动，
整条改动可回退，这是"暂时取消登录页"的兑现方式。

**`/logout` 的对外语义**：一律回 `200 登出成功`，**不因外部会议链路不可达而失败** ——
结束三方侧那次登录是后台动作（限时 5 秒，失败只进服务端日志），
链路的抖动不该变成一个用户看得见的报错弹窗（第 7 项口径）。

**UserVo**：`{id, username, displayName, avatar?, accountType, accountTypeName, positionCode?, positionName?}`
〔变更〕删除 `thirdPartyAccount` —— 前端只认这一个后端，把"账号被映射到外部系统"这个实现事实
交给前端就是泄漏实现细节（第 10 项）；它此前也只用于展示，前端无任何消费方。
（`avatar` 由本地文件路径改为**我方头像端点路径**
`/api/v1/users/<id>/avatar`，字节在达梦里、不在磁盘上，见 §6.9。）

### 6.2 `/api/v1/users`

〔变更〕`sys_contact` 已废弃删除，人员主数据统一由 `sys_user` 承载；通讯录页随之移除。

> 端点清单（线格式明细见 `api.openapi.yaml`，本节只列路径与业务语义）：
- `GET /users`

```ts
// UserBriefVo：id 即邀请 participantIds 的取值域（sys_user.id）
{ id: number; name: string; positionCode: string; positionName: string; avatar?: string }
```
〔变更〕删除 `account`（原为外部系统账号名）：前端邀请只用 `id`，该字段无消费方，留着就是把实现细节交给前端。

头像写入仍走 `/api/v1/users/me/avatar`（POST/DELETE）；〔变更〕**读取**新增
`GET /api/v1/users/{id}/avatar`（回图片字节，见 §6.9）。`UserBriefVo.avatar` 与 `UserVo.avatar` 同形。

### 6.3 `/api/v1/meetings`

**`meetingId` 是我方会话键，对前端不透明**：本系统预约出来的会用它自己的主键；只在三方建的会
（手机/板卡发起、本库无预约单）由后端分配一个 `1e15` 起的键，**不是** `meeting_appointment.id`。
前端只把它当路径参数与 WS query 原样回传，不要判正负、不要拿去和列表项的 `id` 比。
这类外部会议的日程字段（主题、状态、开始时刻、时长、成员、流）全部实时来自三方 `/:id/state`，
库里没有的字段（`localStatus`、`creatorId`、受邀名单）返回空，前端按空值渲染，不要当缺陷补。

> 端点清单（线格式明细见 `api.openapi.yaml`，本节只列路径与业务语义）：
- `GET /list`
- `GET /today / /stats / /:id`
- `POST /schedule`
- `POST /quick-start`
- `POST /:id/start / /:id/stop`
- `POST /join`
- `POST /leave`
- `POST /:id/end`
- `POST /:id/cancel`
| ~~DELETE~~ | `/:id`〔**已撤除 2026-09-29**〕 | 第 6 项：会议可以取消、不能删除，本系统不再提供删除预约单。路由、`controller.Delete`、`service.Delete`、`MeetingDeleteReq/Res` 全部移除（调用会 404）。`meeting_deleted` 压制表**仍然读** —— 历史上删过的会要一直压住，否则它们会在日程里复活；不再有写入方 |
- `PUT /:id`
- `GET /:id/state`
- `POST /:id/focus`
- `POST /:id/publications`
| POST / DELETE | `/:id/publications/:pubId/whip` | WHIP offer 转发（POST，`application/sdp`）/ 拆流（DELETE）。**只有一种情况会改 offer**：转发地址是船内 TCP-only 媒体网关（路径 `/__ship_local_media/{id}/whip`）时，去掉 offer 里的 TWCC 反馈行与两个 TWCC `extmap`（照三方 `localTcpWhipOffer`：TCP 队头阻塞后 Chrome 的 TWCC 估算器会塌到 ~30 kbps，把 delta 帧饿在关键帧后面；NACK/PLI、RTCP 报告与媒体 PTS 一律保留）。云端地址不匹配该路径，offer 原样转发。**两个入口都按"这条发布归谁"校验**：`pubId` 必须属于调用者，否则按"发布不存在/已结束"回（不给可区分存在性的错误词）。会议级成员资格挡不住同场别人 —— 多个边端 + 多个云端参加同一场会时，那等于 B 能往 A 的流里推 SDP、或把 A 的流拆掉。详见 `../docs/adr/0088-WHIP发布没有归属校验同场成员可互相推流与拆流.md` |
- `POST /:id/publications/:pubId/stop`
- `POST /:id/publications/:pubId/roi-hint〔新增〕`
- `POST /:id/media-state`
- `POST /:id/telemetry〔新增〕`
- `POST /:id/streams/:streamId/whep`
- `DELETE /:id/streams/:streamId/whep〔新增〕`
- `POST /:id/recording/start / :id/recording/stop`
`board_recording_requires_local_gateway` → 本接口以 500 + 中文原因如实回传；前端据此提示"岸端无法开启板卡录制"，
并引导用本地录制，不得静默成功 |

**TelemetryItem**（WS `telemetry` 帧与 `POST /:id/telemetry` **共用这一个形状**，别各写一遍）：
```ts
{
  publicationId: string              // 归哪一路发布。逐路各一条：摄像头与屏幕共享是两个独立发布，都要报
  sourceVideoBitrateKbps: number     // 发布端自己 getStats 实测的编码码率（SI kbit/s）
  sourceFps: number                  // outbound-rtp 的 framesPerSecond；量不到给 0
  associatedAudioBitrateKbps: number // 该人独立音频路的实测上行；没有给 0
}
```
这一组字段名是**原样透传给三方的载荷**，必须照它的解析器（`backend/internal/service/thirdparty/types.go`
的 `VideoSourceTelemetry` 已记这条约定）—— 属"三方字段名不外溢"的**例外**，因为它不是我域 VO、
后端不改写它就转发。两条过滤在后端 `session.Registry.UpdateSourceTelemetry` **一处**生效
（空 `publicationId`、`sourceVideoBitrateKbps <= 0` 整条丢），REST 与 WS 共用。
**发 0 比缺数更坏**：上游分不清"实测到 0"与"没测到"。三方的新鲜门是 4 秒 ——
外部契约 `platform/contracts/edge-to-cloud/EXTERNAL_HTTPS_CONFERENCE_API.md` §9「参会状态与保活」里
`videoSourceTelemetry` 那一条写的是"仅在**有活跃发布流且 ≤4 秒新鲜**时携带"。
后端取用时同样按 4 秒过期摘除（`session.sourceTelemetryTTL`），过期样本宁可不带 ——
带一份旧的等于让远端算出一个看起来很合理的倍率。
**引用三方一律用符号名不用行号**：那两份副本由 G11 按哈希锁着，三方一改版本号行号就全漂。

**MeetingVo**（本域会议记录）：
```ts
{
  id: number                    // 我方会话键，见 6.3 开头：外部会议不是数据库主键
  title: string
  meetingNo: string             // 三方会议号，唯一入会号；**未同步到三方时为空串**（2026-10-10 起本域不再生成本地会议号）
  startTime: string; startedAt: string   // startedAt **不是 `string|null`**：未开始给空串 `""`（代码 `StartedAt string`，无指针无 omitempty）
  durationMinutes: number
  status: string                // 字典 meeting_status
  managed: boolean              // false=只在三方存在的会（手机/板卡发起）：不可改/取消/提前开始，前端据此隐藏按钮
  localStatus: string           // 字典 local_sync_status（本系统与上游的同步态，前端仅用于"同步失败"提示）
  cloudRecord: boolean
  muteOnJoin: boolean           // 预约时设定的入会初始态，会中只读（上游无改约接口）
  cameraOffOnJoin: boolean
  allowWaiting: boolean         // 第 10 项：允许成员在主持人入会前等待（门禁在我方后端，不外传三方）
  hostName: string
  isHost: boolean               // 第 6 项：这场会的主持人是不是当前登录用户。前端据此显示"修改/取消"，
                                // 后端在 `PUT /:id` 与 `POST /:id/cancel` 里**独立校验同一件事** —— 隐藏按钮不是权限控制
  creatorId: number; creatorName: string; creatorPositionName: string
  // 后两个**恒出现**（`meeting.go:310-311` 无 omitempty），取不到是空串而非缺键；此前标 `?` 是文档口径错（DERIVATION §4-B3）
  createdAt: string
}
```
〔变更〕删除 `edgeUrl/cloudUrl/hostThirdPartyAccount` 外漏——入口链接与上游账号是后端细节。
**`thirdPartyMeetingId` 是个例外，它仍在 `MeetingVo` 里发**（`meeting.go:294`，装配在 `:1594-1598`/`:1626`）：
前端回放入口拿它当查询键与门禁（`AllMeetingsView.vue:287`/`:295`），删了入口全断 —— 本行此前写"已删除"与代码不符，
2026-10-10 按实测更正（DERIVATION §4-A1）。它的定位是**内部查询键**，不是给用户看的外链；要收口的是展示与日志外泄，不是这个字段本身。
〔2026-09-29〕进一步删除 `joinH5Url`：**入会链接由前端用 `location.origin` 拼**
（形状见 `frontend/src/utils/joinFlow.ts` 的 `preJoinPathByNumber`，即 `{当前站点}/meeting/pre/no/{会议号}`）。
理由：前后端各自容器化，浏览器访问前端的对外地址（宿主 IP、映射端口、协议）只有浏览器自己知道，
后端既拿不到也不该写死——配置里那份固定地址曾与真实访问地址分叉。
会议号仍由后端给（`meetingNo`），链接只是它的前端拼法，不是第二份事实。

**〔2026-10-10 口径〕对外只有一个会议号：三方号。** 本域曾另生成本地 6 位号并在展示时兜底，
结果是"入会失败但仍落了一行本地预约"时页面会显示这个三方不认的号，用户拿它入会必然得到
「会议不存在或尚未开始」—— 看不出来是没同步，只像是系统坏了。所以：`MEETING_NUMBER` 列停止生成、
只留读老数据；展示与解析一律用 `THIRD_PARTY_MEETING_NUMBER`；`meetingNo` 为空即代表"这场会还没同步"，
前端在这一栏显示「尚未同步」，入会会被明确拦下（文案「这场会还没准备好，暂时无法入会」，前后端同一句）。

**MeetingStateVo**：
```ts
{
  meetingId: number
  status: string                // scheduled/starting/running/ended/...
  startedAt: string             // 同 MeetingVo：**恒出现**，未开始是空串而不是 null（`meeting_state.go:59`）
  serverTime: number            // 毫秒，前端校时
  clockDriftMs: number          // 上游 `serverClockUncertaintyMs` 原样带过来；**可为小数**（船端网关实测 84.3505…），别按整数解析
  hostId: string                // 唯一主持人来源；participants[].isHost 只由它推导（上游成员级 isHost 仅在 hostId 为空时兜底），
                                // 避免两侧做 OR 时同时出现多个"主持人"。上游在主持人离会后自动移交，本域如实转述
  participantCount: number
  cloudRecord: boolean          // 〔A3 补列 2026-10-10〕此前本节漏写：代码 `meeting_state.go:64` 一直发、前端 `meeting.ts:86` 一直在读
  recording: {active: boolean, state: string}   // 本域抽象：state=idle/starting/recording/stopping/error 由后端归并上游多态
  participants: Array<{
    id: string; name: string; isHost: boolean
    nodeType: 'edge' | 'cloud'  // 本域枚举（对应主数据 endpointType，字典 master 见 shared）
                                // 三方没报侧别时后端不返回空：按本实例 deployment.side 兜底，该项默认 edge，
                                // 所以"取不到是哪端"的参会者一律显示边端（2026-09-29 口径）
    cameraOn: boolean; micOn: boolean; sharing: boolean
    // 〔语义收紧〕cameraOn/micOn = 该成员当前**有已就绪且带可播端点的真实发布**，
    // 不再是上游回传的客户端自报意图位。理由：实测只发意图不走 WHIP 发布时，
    // 意图位为 true 而其他端既无画面也无声音，成员面板会显示"摄像头已开"的假状态。
    // 因此前端可直接据此渲染 🎤/ 徽标，无需也不应再自行推断。sharing 仍为自报位。
    recording: boolean
    avatar?: string             // 〔A4 补列 2026-10-10〕`meeting_state.go:18`，**带 omitempty**：该成员没头像就不带这个键
                                // （与 invited[].avatar 同形）。前端 `meeting.ts:45` 读它，取不到走占位图（`avatarImage.ts:20`）
  }>
  invited: Array<{              // 受邀名单（源自本域 meeting_participant，上游不提供）
    userId: number              // sys_user.id
    name: string
    avatar?: string             // sys_user.avatar 的 API 路径；该用户没传过头像就不带这个字段
    joined: boolean             // 与 participants 比对得出的入会态
    participantId: string       // 已入会时为对应 participant.id；未入会为 ""（Go 侧无 null）
  }>                            // 成员面板「等候入场」= invited 中 joined=false；上游只上报已入会者，
                                // 未受邀者自行入会仍出现在 participants，不进等候入场
  streams: Array<{              // 本域"流描述"，寻址全部指向我方后端
    id: string                  // 后端签发的流号（对前端稳定，不等于三方 publicationId）
    ownerId: string             // 发布者 participantId；前端据此排除自己的发布（否则会订阅到自己，出现常黑窗格）
    ownerName: string
    kind: 'camera' | 'screen' | 'audio'
    video: boolean; audio: boolean
    width: number; height: number; fps: number
    sourceBitrateKbps: number   // 该路**发布方的编码码率**（kbps）。〔B2 更正 2026-10-10〕类型是 `number` 不是 `number|null`：
                                // 代码 `meeting_state.go:45` 是 `int`，**取不到就是 0**，后端从不给 null。
                                // "取不到必须显示 —、不得用未压缩基线顶替"（第 26 项）这条判据照旧，但它的触发条件是 **0**，
                                // 前端已这么实现（`compression.ts:33` `kbps>0 ? … : '—'`），不存在"永不触发的分支"。
                                // 曾考虑把字段改成 `*int + omitempty` 以保留 null 语义 —— **裁定不做**：现口径自洽，
                                // 为一处文档笔误去改线格式并承担线上风险不值。
    compressionKind: 'none' | 'edgeRoi' | 'cloudSoftwareRoi' | 'unknown'
                                      // 我方自己的语义枚举（三方的 sourceType/cloudSoftwareRoi
                                      // 不外溢到契约）：这一路到底经过哪一道二次压缩。
                                      // 'none' 时前端不报压缩倍率，照三方写「直传（无 ROI 二次压缩）」那句的语义 ——
                                      // **但界面文字里不许出现「二次压缩」「ROI」**（`check:copy` 判为技术名词，
                                      // 2026-10-13 实测拦下过），上桌的是「直传（没有额外压缩）」。
                                      // 且 'none' 的含义是**这一路没有"压缩前/压缩后"这组量**，不是"数还没取到"：
                                      // 界面该把三格合成一句说清楚，缺数组才写「统计中」（见下方三项口径）。
    compressionRatio?: number         // 〔新增 2026-10-13〕三方在该路发布记录里**直接上报**的压缩倍率
                                      // （`transportMetrics.compressionRatio`）。它是倍率的**第三级取数**：
                                      // 本端两个数（编码码率、实传速率）凑不出倍率时才用它 —— 口径照三方
                                      // `compressionText`（其 `ratio = source/rate`，任一非正就退回这个上报值），
                                      // 不是我方发明的兜底。报不报倍率仍以 `compressionKind` 为准。
                                      // 带 omitempty ⇒ 缺键或 0 都是"三方没给"，前端写「统计中」，不得拿派生值冒充。
                                      // 保留小数原样传：取整会把 2.31 倍说成 2 倍。
    compressionEstimated?: boolean    // 上面那个倍率是三方**估算**而非实测（`compressionEstimate`）⇒ 界面要标「估算」
    active: boolean
    videoCodec: string          // 〔A5 补列 2026-10-10〕`meeting_state.go:51`（`h264`/`hevc`，**无 omitempty → 恒出现**），
                                // 前端 `meeting.ts:73` 读它决定是否直连解码。ADR-0079 早就定了这条语义，只是没回填到本字段表
    videoChannel?: 'direct' | 'lanWhep'
                                // 〔新增〕这一路的**视频腿**走哪条通道，前端按这个机器值选播放器，不去猜错误文案。
                                // 判据一处（`service/meeting_state.go` 的 `VideoLegChannel`）：有直连地址 → `direct`；
                                // 只有船端局域网那条 WHEP 通道**且本实例 `deployment.side=edge`** → `lanWhep`；两条都不满足 → 不给。
                                // **带 omitempty，所以"接不通"是缺键而不是空串**（前端按缺键处理，别期待 `""`）：
                                // 典型是云端实例收到只给了船内网通道的那一路，那条腿岸端浏览器 ICE 永不可达，与其签一个
                                // 注定黑格的地址不如没有这一档。`lanWhep` 这一路的视频**不走 GET 端点**，
                                // 走 `POST /:id/streams/:streamId/whep`（offer 里带 `m=video`）；
                                // 前端 `InMeetingView.vue` 把这条腿收到的 MediaStream 直接绑到该格的 `<video>`，不经画布
    endpoints: {
      video?: string            // /api/v1/meetings/{id}/media/{streamId}/video（会话头鉴权）
                                // 〔收紧〕**只在 `videoChannel=direct` 时签发**，不再"这条发布有任一视频通道就给"。
                                // 可核对的原因：`lanWhep` 那一路的 GET 通路本来就给不出东西（它是 WHEP，要 POST + SDP），
                                // 挂着这个地址等于让前端每 ~1.5 秒去取一个注定 503 的端点，表现就是"这路画面一直没准备好"
                                // 一路挂到散会 —— 那正是本节开头 503/502 分开报所要消灭的假象
      audio?: string            // 同上 /audio
    }
  }>
}
```

#### 中卫通公网会议的视频传输

同一账号可为摄像头和共享屏幕分别设置原始转发或阿里云 H.264 压缩。三种云端策略为 `source_frames`、`bandwidth_first` 和 `optimized`。Web 通过创建发布和发布设置 PUT 传递选择，接收端依据 `streams[].revision` 重连媒体。码率单位为 kbps。端点、字段和可直接发出的请求见 [网页 OpenAPI](./api.openapi.yaml) 和 [Apipost 第 06 组](./中卫通公网会议_Apipost接口集合.json)。

### 6.3.1 统计条那几格的取数口径

界面上这些数（会中悬浮统计条、侧栏会议信息卡、传输状态抽屉）**全部由前端从播放器实测回调派生**，
后端只给 `sourceBitrateKbps` / `compressionKind` / `compressionRatio` 三个真值。算法各只有一处实现：
`frontend/src/utils/compression.ts`（压缩三项）与 `frontend/src/utils/mediaClock.ts`（帧延迟），
**不许有第二份**（第 26 项的教训：两处各算就会各说一套，侧栏与会中页就会互相矛盾）。

| 界面项 | 取数 | 没有值时写什么 |
|---|---|---|
| 原始速率 | `sourceBitrateKbps`（发布方自己实测的编码码率） | 没给 ⇒ `统计中`；`compressionKind=none` ⇒ **这一格不出现** |
| 压缩比 | 原始 ÷ 压缩后；两个数凑不出时退回 `compressionRatio`。**前缀「压缩 / 估算」适用于任何来源的倍率**（三方会议页 `compressionText` 就是这么写的），不是只有退回分支才标 | 同上；kind 未知且原始不高于实传 ⇒ `直传`；上报倍率 ≤1 ⇒ `统计中`（三方看板 `formatCompressionEffect` 对 `ratio <= 1` 直接不出） |
| 节省带宽 | **百分比**，不是速率差值：`clamp((1 − 压缩后 ÷ 原始) × 100, 0, 100)`，两位小数，前缀「节省 / 估算节省」。三方**会议页没有这个量**（`节省` 在 `tp-meeting.js` 里 0 命中），口径取自三方流媒体看板 `app.js` 的 `compressionFieldsFrom` / `formatCompressionEffect`。只有上报倍率、没有两个速率时按 `1 − 1 ÷ 倍率` 反推（纯代数，不引入新信息）—— 看板优先用服务端的 `bandwidthSavingPercent`，但**那个字段不在会议链路的 `transportMetrics` 里**（它属看板 `/api/frontend/lanes/{id}` 家族），所以这条链路上反推是唯一诚实路径 | 只在确认存在压缩收益时才算，否则 `统计中`；**倒挂不许被 clamp 压成 `0.00%`** —— "省了 0%" 是假数 |
| 压缩后速率 | 这一路的**出站**速率（不是"本机收到的"）。分母量在哪条腿只由 `compression.ts` 的 `pickTransmittedKbps` 一处决定：**我自己发布的那一路**取 `ingressBitrateKbps`（三方在该路发布记录里测到的出站码率，与分子同一条腿；后端由 `UpstreamBitrateKbps()` 从 `transportMetrics.upstreamVideoBitrateKbps` 接出）；**远端那一路**取本机接收速率（直连腿取播放器 `onTraffic`，局域网通道取 `getStats` 的 `bytesReceived` 增量） | 它没起来之前**不做除法**（拿 0 当分母只会得出一个假的无穷大）。本端那一路 `ingressBitrateKbps` 为 0 时写 `统计中`，**绝不回落到本机接收速率** —— 那是另一条腿的数 |
| 相对帧延迟 | **以本次播放收到的第一个有效帧为基准的漂移量** = `(本地单调钟差) − (源时间差)`，带符号 | 基准还没立 ⇒ `统计中`；本端那一格 ⇒ `—`（发送侧没有"本地播放时刻"可比） |
| 播放音画差 | 这一路画面的播放时刻 − 同一个人独立音频路的播放时刻，两个都取自本端。**两个口径分开取、必须同口径才相减**：优先两轨都有 `estimatedPlayoutTimestamp`（真在出声），否则两轨都有同步源的轨道交付时刻（前缀 `≈`）；一方一个口径就直接不报 —— 差值里混着两个口径各自的偏差，看着是个合理毫秒数其实什么都不是。两条轨的样本还都要新鲜（≤2.5 s），一条死了半分钟也不许拿旧值相减。**画面与声音两条腿都必须是浏览器 PC**：声音那条腿的 WHEP 取序见 §6.2 那行（先 `audioWhepUrl`，边端再退船内 `_audio` 车道）；退到直连流就没有 PC，这一格结构上出不来 | 直连腿根本没有 PC ⇒ `—`（结构性量不到，不是"还没到"）；画面或声音任一条腿落在直连流上 ⇒ `—`；这一路没有独立音频路 ⇒ `—`（**判据在全部流里找纯音频发布**，不能拿只装视频瓦片的列表去找，见 ADR-0087）；同口径的样本没齐或已过期 ⇒ `统计中` |

〔界面分工〕这些量只出现在两处，各管一边，别混：**播放窗口上的悬浮栏**说的是**那一格**（自己那一格或某位远端）那一路的数；**传输状态抽屉**说的是**本端发送侧**——我发了什么、发得怎么样（摄像头上行/目标码率/实际帧率/发布规格/麦克风上行/推流状态）。本端编码器的「目标码率」只进抽屉，不摆在别人的瓦片上：目标码率是**编码器目标**，上行是**网线上真实字节**（含传输开销与重传），两者不是同一个量，摆在一格会让人拿本端目标去对别人的流。

五条不许改回去的口径：

1. **相对帧延迟不是"播放时刻 − 采集时刻"**。那个绝对量要采集端墙钟，而它只存在于直连拉流的容器帧头里；
   船端局域网那条腿（`videoChannel=lanWhep`）不经我方容器，拿不到。用首帧当基准把绝对偏移减掉，
   两条腿才能共用同一个口径 —— 三方在同一条腿上做的也是同一件事，其栏内说明原文：
   「以本次播放首个有效帧为固定基准；正值表示延迟增加，负值表示追赶，不代表绝对单向延迟」。
   所以**负值是合法读数**（表示在追赶），不许再加一道 `> 0` 的守卫把它吞掉 ——
   此前正是那道守卫让这个字段在两条腿上都永远显示 `—`。
2. **换腿或换源钟必须重立基准**（anchor key = 源钟标识 + 口径）。拿旧腿的起点量新腿，
   报出来的是两条腿之差，不是任何一路的延迟；这与"摘腿时出过帧的证据必须跟着走"是同一条规矩。
3. **「没有这组量」与「数还没到」必须分开说**：`compressionKind=none` 的那一路没有额外压缩环节，
   因此根本不存在"压缩前"这个数 —— 界面把三格合成一句「直传（没有额外压缩）」；
   只有"还没取到"才写 `统计中`。两者都糊成 `—` 会让人以为页面坏了。
   界面文字里不许出现「二次压缩」「ROI」这类实现名词（`check:copy` 拦得住，2026-10-13 实测命中过三次）。
4. **速率换算一律 SI（÷1000），且全仓只有 `utils/compression.ts` 的 `rateText` 一处**。三方四处证据一致
   （引用一律用符号名 + 副本哈希前 16 位，行号随三方改版漂移）：看板 `app.js` 的 `formatKbpsAsMbps` = `/1000`、
   `formatTrafficMegabytes` = `/1000000`、会议页 `tp-meeting.js`（哈希 `9f519d23a7358482`）的 `samplePeerRates`
   采样公式 `kbps = Δbytes*8/Δms`（即 SI kbit/s）、`formatTransportRate` = `/1000`。
   此前下行侧（`InMeetingView` 的 `focusKbps`、`whepPlayer` 的 onRate、`MemberPanel` 的 `mbpsText`）用 `/1024`、
   上行侧 `useWhipPublish` 用 `/1000`，而**压缩比正是拿这两个数相除** ⇒ 系统性偏大 2.4%；
   显示层再 `/1024` 一次，1000 kbps 就成了 `0.98 Mbps`、74 kbps 成了 `0.07 Mbps`（2026-11-04 实测确有这么低的轨）。
   显示单位**按量级切换**（三方 `formatTransportRate`：`>=1000` 出 Mbps，否则 kbps）；
   宫格与成员面板那种紧凑写法（`↑1.25Mbps`，原型 `15/16_meeting_top*.png`）走 `rateTextCompact`，
   **只去空格、不重算**。
5. **分母量在哪条腿由 `pickTransmittedKbps` 一处定，而两条腿「报不报倍率」不同**。三方自己就是分两套做的：
   它本端那一路（`ownRows`）的分母是 `upstreamVideoBitrateKbps`（与分子同在发布侧一条腿上），
   远端那一路（`remoteRows`）才传裸的本机接收速率。我方此前对**本端**也拿本机接收速率当分母 ——
   两个不同测量点相除，倍率没有任何意义。分两处说清：
   - **本端发布那一路（`basis='ingress'`）**：分子是自己 `getStats` 的编码码率，分母是 `ingressBitrateKbps`。
     两个数虽然都在发布侧，但**这一格不给倍率、也不给节省百分比**，只给两个实测速率。判据是实测：
     2026-11-05 云边对拍 30 s × 2 s，比值中位 1.39、**最小 0.74（倒挂）**、最大 1.84；1 s 粒度同一秒内
     能得出 0% 与 43% 两个"节省"（证据 `../evidence/2026-11-05-同侧分母配对-云边对拍.md`）。
     三方上报的 `compressionRatio` **也不能拿来替代** —— 实测它就是同一对瞬时量的商（读 A 204÷221=0.92 对上
     上报值 0.92；读 B 215÷94=2.29 对上 2.28），换个来源只会再报一次同一份抖动。
     一个会摆到 0.74 的比值不是压缩比：压缩不会把出站量变得比编码输出还大。
   - **远端那一路（`basis='egress'`）**：分子是对方上报的编码码率，分母是本机接收速率。两个数在两条腿上，
     差值里**含网络损耗与重传**，tooltip 必须照实说。三方看板能避开这点是因为它比的是**同一侧的字节总量**
     （`formatTrafficSavingEffect` 取 `trafficSavingBytes`，缺失才用 `referenceTrafficBytes − 实际视频字节`，
     真源都在云端 API），而会议链路上没有那个真源。
   `basis` 是 `CompressionInput` 里的**必填**字段（漏了编译不过），**不进任何算术**，但决定这一格是否给倍率。

6. **本端那条 RK 接收路（`videoChannel=lanWhep`）不采三方的 `null` 约定**。三方在那条腿上，当浏览器拿不到
   本机遥测时会回 `null`（`rkReceiverDeviceId || bundle.useRkReceiver ? null : …`），语义是"这台浏览器根本没有
   这条腿的字节可量"——是"测不到所以不猜"。而我方这条腿由 `whepPlayer.ts` 在浏览器 PC 上真收，
   `streamStats[].bytes` 是**真测**；照抄那条 `null` 等于把真数据扔掉。这是有意的偏离，不是遗漏。

7. **`rk_browser_roi` 的发布侧编码偏好是硬条件，缺了就这一路不发**。三方 `preferH264ForSender(pc, sender,
   sourceType === "rk_browser_roi")` 的第三参为真时是 required —— 拿不到 H.264 直接不发布
   （`tp-meeting.js`，副本哈希 `9f519d23a7358482`）。我方照办：确知没有 H.264 时关闭这条连接、把刚建出的
   发布停掉，并给用户一句能行动的话；**不静默降级**，因为船内那条接收槽只吃浏览器 H.264，降级结果是
   "看着发出去了、对端永远黑格"。唯一例外是**能力表拿不到**（`RTCRtpSender.getCapabilities` 为空）：
   那是"不可判"，照默认协商继续发 —— 拒绝必须是"确知没有"，不能是"我没查到"。

〔口径出处，别写错〕「原始速率 / 压缩比 / 节省带宽」这三项**只有三方的船端 legacy 会议页有**
（`tp-meeting.js`，云、边两侧同一份字节，哈希 `9f519d23a7358482`）。三方的**云端会议页**是另一套实现
（`ocean-vue`，`tp-ocean-workspace-core.cloud.js`，哈希 `28488e9dc2718e20`）：云端 `/meeting` 已退役只做跳转，
`ocean-meeting.html` 只显示一块**聚合**带宽（`session.cloudVideoBitrateKbps` 求和 → Mbps + `ingestTotalBytes`
→ 累计上行 MB），**没有**这三项；而船端那份同源代码在 `zwt-meeting-mode=ship-local` 时连那块聚合面板都跳过。
所以：我方在云端页面显示这三项属**我方自研**，不许写成"照三方云端"；分母口径的基准是船端的 legacy 页。
探测记录与可复跑探针见 `../evidence/2026-11-05-三方云边客户端探测.md` 与 `../scratch/probe-vendor-clients.mjs`。

〔未收口〕两处展示点的三项**顺序不同**：悬浮统计条是 原始速率/压缩比/节省带宽，侧栏信息卡是
原始速率/节省带宽/压缩比。两边各有依据 —— 前者有 09-29 的实跑读数
（`../docs/审查-20260927-全量对比与边界测试.md` 里「第 2 项 悬浮统计条=主画面那一路」那一行），
后者代码注释自称"顺序照原型"；而仓内 `docs/image/需求/1790059433869.png` **实际是个 UTF-8 文本文件**
（内容是围栏应用的），取不到原型图。本轮只改数值不改排版 —— 要统一顺序先取 Calicat 画布证据，
别凭一边的注释推翻另一边的实跑记录。

> 为什么从"分辨率×帧率×YUV420"换成编码码率、为什么音画差从"没有真源"改判为漏接：
> 处置记录在 [ADR-0007 统计条的本端四项](../docs/adr/0007-统计条的本端四项-+-平台失败文案不外泄.md)。

### 6.3.2 「采集时间」的真源与"只认同一帧"的匹配判据

局域网那条视频腿（`videoChannel=lanWhep`）不经我方容器，帧头里没有采集端墙钟，所以这个量另有真源：
`GET /api/v1/meetings/{id}/streams/{streamId}/frame-times` —— 我方后端代理船端网关的本机端点
`/api/local/frame-times?lane=N`。**只在 `deployment.side=edge` 且这条发布确实分到接收槽
（`rkReceiverLaneId ∈ [1,32]`）时可用**，否则 404；直连腿不需要它，采集时刻就在它的帧头里。

- **直连腿帧头的 `timestamp` 单位是微秒，不是容器时基的 tick。** 托管播放器在交给回调之前已经换算过
  （`pts * 1e6 / session.timebase`），所以换采集时刻只能 `baseUnixNs/1e6 + timestamp/1000`。
  曾经这里又除了一次时基（按 90 kHz 解释），等于把媒体时间放大 11.11 倍：采集时刻被算到未来十几分钟，
  相对帧延迟读成 `-807601 ms`。算术可自证 —— 漂移 = −10.11 × 会话存活秒数，反推 79.9 s 与日志吻合。
- **房间级状态缓存不能跨用户复用。** 三方在 `publications[]` 的每条订阅地址里嵌一张**绑定参会者**的票据
  （解出来含 `pid`/`pub`/`path`/`actions`），而地址是"谁拉的状态"就绑谁。所以 `MeetingRoom` 记状态必须连
  "用谁的令牌拉的"一起记，订阅路径只认本人那份（`StateFor(userId)`）；拿别人缓存里的地址去订，三方回
  `401 authentication error`。与 WHEP 会话表按用户分键是同一条道理。
- **`401` 不是终态。** 实测音频腿的 401 全部落在**发布号刚翻新**的窗口（票据当场新签、绑定正确、
  有效期还剩约 12 小时），属瞬时竞争而非"这路已经没了" —— 判成终态会一次竞争就把这条腿永久放弃且不再
  回落另一条通路，表现是声音间歇性消失而界面一句不说。只有 `404`/`410` 才是终态。
- 音频两条通路（WHEP 与直连压缩流）**各自都要试**，不是只有"这路没有该通道"(501) 才回落。
  船端形态下音频发布的 `rkReceiverPath` 与 `rkReceiverAudioWhepUrl` 实测恒空，所以边端音频只有云端
  `audioWhepUrl` 一条路 —— 不要为它造"按部署侧分通道"的抽象，没有可分的东西。
- 这条代理路径**必须带 `/api` 前缀**且调用要标 `silent`：dev 的 vite 与生产 nginx 只转发 `/api`，
  写成 `/v1/...` 会被前端路由吃掉、回 200 + index.html，拦截器见响应体没有 `code` 就每 2 秒弹一条「请求失败」
  —— HTTP 是 200、类型检查无错、后端日志零记录，只有用户看得见。判据在 `frontend/scripts/check-endpoint-paths.mjs`。
- 响应**包在我方信封里、`data` 原样透传上游字节**：表里每帧的采集时刻是 Unix **纳秒**、源钟标识是
  64 位整数，两者都超出 JSON number 的安全整数范围 —— 一旦在 Go 侧过一遍 struct/float 就会被静默
  改掉末几位。这条由 `internal/response/raw_envelope_test.go` 钉着（字面量必须逐字节出现在响应里）。
  为什么要包信封：裸透传上游的 `{ok:true,…}` 会被 `request.ts` 拦截器按 `code!==200` 判成"系统异常"弹窗。
- 前端**只认"就是这一帧"**：拿接收方同步源（`getSynchronizationSources()`）的 `rtpTimestamp` 与表里的 `rtpTimestamp`
  逐值相等（容 1 tick）才采信。**不许改成"最近邻 + 若干容差"** —— 那张表是稠密的
  （现场 256 帧覆盖 10.28 秒、帧间隔约 40ms），任何 rtp 都能命中"某个"帧，于是会报出一个
  错了近一秒却看起来完全合理的采集时刻。对不上就回 0，界面留「统计中」。
- 差值按**有符号 32 位**解释，否则表跨过回绕点时会漏掉本该相邻的两帧。
- `sourceClockSynchronized=false`（2026-10-13 现场实测值）⇒ 源钟未与服务器对齐，所以**绝对**帧延迟
  本来就不可信，这一路只报相对漂移；`sourceClockId ≠ audioSourceClockId` ⇒ 两条轨不同时钟域，
  「源音画差」算不出（三方也是这么显示的：`-- · 时钟域不同`）。
- 轮询只跟主画面那一路，间隔 2 秒：换一格就换一条 lane，继续轮询旧的等于查别人的槽。
- 上游回 404（槽里没流）时**不打扰用户**：那一格留「统计中」，原因只进服务端日志。
  它是可选的诊断信息，把三方网关的一次正常 404 变成弹窗，等于用可选信息打扰正在开会的人。

### 6.3.3 订阅失败的一句人话要分"从没起来过"与"真的断了"

`POST /streams/{id}/whep` 在"网关认得这条槽、但槽里没流"时回 **502**，`msg` 是给用户看的那一句。
同一个上游回答对应两件不同的事实，**必须说两句**：

| 这一路 | `msg` |
|---|---|
| 该用户在这条腿上从没收到过媒体 | 这路画面一直没准备好 / 这路声音一直没准备好 |
| 确实从有画面掉下来 | 这一路画面中断了，正在自动重连 |

- 判据是 `room.whep` 里**有没有这位用户这条腿的成功记录**（只在 SDP 协商成功后写入），
  不是发布状态：`publishing` 既可能是"从没 ready"也可能是"ready 后回落"，实测两者都存在。
- **不许承诺"退出后重新进入会议"**：该动作能否恢复未按现行结论重测，且对"从没起来过"的路，
  说"已中断"是断言了一次根本没发生的中断。依据见 `docs/adr/0094-be-rk-receiver-slot.md`。
- 感官词（画面/声音）由腿的**机器值** `video|audio` 派生，不由显示词派生。
- 已知边界：这条判据是进程内存态，**后端重启会重置**为"从没起来过"。

### 6.4 `/api/v1/meetings/{id}/media/{streamId}/{video|audio}`〔新增〕

> **编号 §6.4.x 的正文不在这份文件里。** 它们是逐轮处置记录（"哪天哪一轮为什么改成这样"），
> 2026-10-10 三层化时原文搬入 `../docs/adr/`，本文件每处只留一行指针；索引见 `../docs/adr/README.md`。
> 分界是**内容性质**不是有没有日期：`§6.5.1` 也带日期尾注，但它定的是 `LocalRecording` 的稳定形状，
> 所以留在规格里。判据：换一个功能还会不会引用它 —— 会，就是规格；不会，就是决策记录。

媒体流代理：GET 流式响应（H.264 Annex-B over HTTP 或 WHEP 转发，实现由后端定），
鉴权 = 我方 JWT（`?token=` 查询参数兜底，供 `<video>`/fetch 无法带头场景，短时有效）。
后端按 `(user, meeting)` 映射到的上游参会令牌注入上游请求；上游不可达时以 HTTP 错误结束，
前端显示"无法接收该流 + 重试"。
〔变更〕**取流即表达关注**：本端点在解析地址前先向上游上报"这一端要收这路发布"（实测没人关注的流会被
饿着——下行 ~70kbps、首字节 700ms+；关注后 ~176kbps、1ms）。前端那次 fire-and-forget 的关注上报与本请求
是并发的，所以不能等它落地；关注上报失败只记日志，不阻断取流。
〔变更〕**"还没准备好"与"坏了"要分开报**：这路发布在我方可见状态里找不到、没有可用直连地址、
或上游回"流尚未就绪"（含 425 一类）时，统一回 `503 + 这路媒体还在准备中，请稍后重试`；
只有真正的上游故障才回 502。理由：① 503/425 是会自己变好的中间态，前端据此走 ~1.5s 的短间隔重试，
而不是 10s 冷却加一句红色"起播失败"（实测表现就是用户报的"拉不到对端音视频"）；
② 上游的状态词（`direct_video_not_ready` 等）不外溢到响应文案，诊断线索只进服务端日志。
〔变更〕**但"会议已经不在了"不是中间态**：订阅时实时回源三方拉会议状态，若上游回
`404 / meeting_not_found`（现网日志实测 2026-09-28 14:45，同刻 heartbeat 已判该用户不在会中），
本端点回 **`410 + 这场会议已经结束，媒体不再可用`**。此前它回 503「还在准备中」，
而 503 的语义是"会自己变好"，前端据此每 ~1.5s 重试一个已经不存在的会议 —— 用户看到的就是反复"起播失败"。
前端把 `404/410` 判为终态（不重试、不挂红字，等下一轮 state 摘掉死流），所以这个状态码是契约而不是文案。
判据用 HTTP 状态，不比对提示文案；两类判据的互斥性有单测守着
（`backend/internal/controller/meeting/meeting_stream_test.go`）。

〔变更〕视频**只走直连流**：没有 `directVideoUrl` 时不再回退到板卡接收通道——那是 WHEP 通道（要 POST + SDP），
用 GET 拉注定 4xx，只会把"这路没有直连流"报成起播失败。音频侧同理：先走 `/:id/streams/:streamId/whep`，
该端点明确回 `501`（有 WHEP 通道但本路径不协商）时前端才退回直连播放器；
`/whep` 里"这路发布还没进我的状态"也改成 `503`（旧版回 404 会让前端把这路当成已结束的流摘掉瓦片）。
〔澄清，本条定的是 **GET 通路的形状**，不是说这路视频没有第二条腿〕边端形态下视频腿就是那条局域网 WHEP：
由 `streams[].videoChannel=lanWhep` 点名、由 `POST /:id/streams/:streamId/whep`（offer 带 `m=video`）协商，
**GET 端点在这种形态下不签发该路视频地址**（收紧理由见 §6.3 `endpoints.video` 那格）。

*ADR-0001 「未开始」不等于「已结束」：发布时机与文案口径 → [决策记录](../docs/adr/0001-「未开始」不等于「已结束」发布时机与文案口径.md)*
*ADR-0002 野会收口：会议压制表 + 会话键来源标记 → [决策记录](../docs/adr/0002-野会收口会议压制表-+-会话键来源标记.md)*
*ADR-0004 入会只有一个入口：预检页（第 41 项） → [决策记录](../docs/adr/0004-入会只有一个入口预检页第-41-项.md)*
*ADR-0005 收尾清理不打扰用户，报错不带技术细节（第 42 项，对齐 §1.1） → [决策记录](../docs/adr/0005-收尾清理不打扰用户报错不带技术细节第-42-项对齐-第1节.md)*
*ADR-0006 设备按钮必须有可感知反馈（第 43 项） → [决策记录](../docs/adr/0006-设备按钮必须有可感知反馈第-43-项.md)*
*ADR-0007 统计条的本端四项 + 平台失败文案不外泄 → [决策记录](../docs/adr/0007-统计条的本端四项-+-平台失败文案不外泄.md)*
*ADR-0008 两人两端的名单互见实测 + 非主持人停会的文案 → [决策记录](../docs/adr/0008-两人两端的名单互见实测-+-非主持人停会的文案.md)*
*ADR-0009 订阅回源把会议ID当成了会议号 —— 第 2/37 项的共同根因 → [决策记录](../docs/adr/0009-订阅回源把会议ID当成了会议号-——-第-237-项的共.md)*
*ADR-0010 预约里的「入会时静音 / 入会时关闭摄像头」曾被预检页无条件盖掉 → [决策记录](../docs/adr/0010-预约里的「入会时静音-入会时关闭摄像头」曾被预检页无条件.md)*
*ADR-0011 同一路媒体在上游有多个别名，只有 `ready` 那个打得开 → [决策记录](../docs/adr/0011-同一路媒体在上游有多个别名只有-ready-那个打得开.md)*
*ADR-0012 换排列会把画布换掉：播放器必须跟着重建 → [决策记录](../docs/adr/0012-换排列会把画布换掉播放器必须跟着重建.md)*
*ADR-0013 成员栏：自拍格不是第二块解码画布；文案口径以原型为准 → [决策记录](../docs/adr/0013-成员栏自拍格不是第二块解码画布；文案口径以原型为准.md)*
*ADR-0014 设备状态卡的唯一真源是"采得到"，不是"枚举得到" → [决策记录](../docs/adr/0014-设备状态卡的唯一真源是采得到不是枚举得到.md)*
*ADR-0015 宫格「邀请成员加入」格：照原型改文案，但不照抄没有真源的数字 → [决策记录](../docs/adr/0015-宫格「邀请成员加入」格照原型改文案但不照抄没有真源的数字.md)*
*ADR-0016 顶部排列的骨架：一条**恒为一行**的缩略条 + 一块吃掉余高的主画面 → [决策记录](../docs/adr/0016-顶部排列的骨架一条恒为一行的缩略条-+-一块吃掉余高的主.md)*
*ADR-0017 缩略条与宫格**不是同一套字段口径**：徽标、速率写法、分辨率帧率各有出处 → [决策记录](../docs/adr/0017-缩略条与宫格不是同一套字段口径徽标速率写法分辨率帧率各有.md)*
*ADR-0018 「所有会议」两档的行内按钮：按原型 11/12 逐档实测 → [决策记录](../docs/adr/0018-「所有会议」两档的行内按钮按原型-1112-逐档实测.md)*
*ADR-0020 第 10 项的边界画在哪：厂商词一律不出服务端，开放协议名留在契约里 → [决策记录](../docs/adr/0020-第-10-项的边界画在哪厂商词一律不出服务端开放协议名留.md)*
*ADR-0021 完成度复测：五条用一次浏览器/一次 grep 就能定口径的项 → [决策记录](../docs/adr/0021-完成度复测五条用一次浏览器一次-grep-就能定口径的项.md)*
*ADR-0019 两处"页面上说了但没做对"：预览成功后旧报错没清、统计条收起后仍画在工具条上 → [决策记录](../docs/adr/0019-两处页面上说了但没做对预览成功后旧报错没清统计条收起后仍.md)*
*ADR-0022 预约弹窗按原型收口：删掉受邀成员区与术语提示 → [决策记录](../docs/adr/0022-预约弹窗按原型收口删掉受邀成员区与术语提示.md)*
*ADR-0023 `?token=` 票参从"整段会议前缀"收到"一种只读形状" → [决策记录](../docs/adr/0023-token=-票参从整段会议前缀收到一种只读形状.md)*
*ADR-0024 第 15 项「只糊背景」的定量证据，与两处无界 await → [决策记录](../docs/adr/0024-第-15-项「只糊背景」的定量证据与两处无界-await.md)*
*ADR-0025 第 18 项「按钮图标尽量和原型一致」：逐枚比对 + 一枚"根本不存在的图标" → [决策记录](../docs/adr/0025-第-18-项「按钮图标尽量和原型一致」逐枚比对-+-一枚.md)*
*ADR-0026 完成度审计第三轮：第 18/34/35 项按"全量取数"重跑，炸出四处上屏技术细节 → [决策记录](../docs/adr/0026-完成度审计第三轮第-183435-项按全量取数重跑炸出四.md)*
*ADR-0027 第 18 项的第二半：应用外壳原来用**彩色 emoji 当图标**，全量换成线条图标 → [决策记录](../docs/adr/0027-第-18-项的第二半应用外壳原来用彩色-emoji-当图.md)*
*ADR-0028 "零行即系统异常"这一族：`Scan` 查不到就返回 `sql.ErrNoRows`，把业务分支变成死代码 → [决策记录](../docs/adr/0028-零行即系统异常这一族Scan-查不到就返回-sql.Er.md)*
*ADR-0029 第 31 项「关闭摄像头时头像应在播放器中间」：上一轮标了完成，实测**没落地** → [决策记录](../docs/adr/0029-第-31-项「关闭摄像头时头像应在播放器中间」上一轮标了.md)*
*ADR-0030 设置页一次跑通第 9/20/34 项，并纠我探针的一次误判 → [决策记录](../docs/adr/0030-设置页一次跑通第-92034-项并纠我探针的一次误判.md)*
*ADR-0031 第 5 项「持续检测 5 秒」原来只做在设置页，预检页仍是 5 轮即完 → [决策记录](../docs/adr/0031-第-5-项「持续检测-5-秒」原来只做在设置页预检页仍是.md)*
*ADR-0032 第 1/5/6/7/10 项的后端口径：收尾静默、参会历史、主持人门禁、msg 归译、等候室 → [决策记录](../docs/adr/0032-第-156710-项的后端口径收尾静默参会历史主持人门禁.md)*
*ADR-0033 回放页的窗口排列：**定案为 1/4/9 宫格 + 分页**，不跟会中页那套形态走 → [决策记录](../docs/adr/0033-回放页的窗口排列定案为-149-宫格-+-分页不跟会中页.md)*
*ADR-0034 设置页改为"逐项自动保存"，保存位置显示成实际写入路径 → [决策记录](../docs/adr/0034-设置页改为逐项自动保存保存位置显示成实际写入路径.md)*
*ADR-0035 本地口令改为哈希落库；预入会页去掉网络检测、设备块改成"只作用本场会" → [决策记录](../docs/adr/0035-本地口令改为哈希落库；预入会页去掉网络检测设备块改成只作.md)*
*ADR-0036 扬声器试听点了没声音：根因是 MediaStream 源的 `autoplay` 根本不触发 → [决策记录](../docs/adr/0036-扬声器试听点了没声音根因是-MediaStream-源的.md)*
*ADR-0037 自动保存的反馈改成一次性提示，页头不留常驻状态条 → [决策记录](../docs/adr/0037-自动保存的反馈改成一次性提示页头不留常驻状态条.md)*
*ADR-0038 三方实测值带一位小数，我方按 int 收 → 心跳与 /state 解析全线失败 → [决策记录](../docs/adr/0038-三方实测值带一位小数我方按-int-收-→-心跳与-st.md)*
*ADR-0039 本地宫格按「人 × 通路」归组：退会再入不再多开一格 → [决策记录](../docs/adr/0039-本地宫格按「人-×-通路」归组退会再入不再多开一格.md)*
*ADR-0040 授权目录的写权限**不随句柄持久化**：授过权也可能一直写不进去 → [决策记录](../docs/adr/0040-授权目录的写权限不随句柄持久化授过权也可能一直写不进去.md)*
*ADR-0041 `hxt` 第三段用**登录账号**，不用中文姓名 → [决策记录](../docs/adr/0041-hxt-第三段用登录账号不用中文姓名.md)*
*ADR-0042 「全部文件」漏了本机录制 + 真实录制的回放读数 → [决策记录](../docs/adr/0042-「全部文件」漏了本机录制-+-真实录制的回放读数.md)*
*ADR-0043 进度条拖动会漏监听器 → 拖坏一次之后"划过就 seek" → [决策记录](../docs/adr/0043-进度条拖动会漏监听器-→-拖坏一次之后划过就-seek.md)*
*ADR-0044 统计条 tooltip 里的实现名词全部去掉 → [决策记录](../docs/adr/0044-统计条-tooltip-里的实现名词全部去掉.md)*
*ADR-0045 停止/离开会议后列表看不到这条录制：登记排在写盘后面 → [决策记录](../docs/adr/0045-停止离开会议后列表看不到这条录制登记排在写盘后面.md)*
*ADR-0046 录制列表切栏竞态：上一栏迟到的响应把当前栏盖掉 → [决策记录](../docs/adr/0046-录制列表切栏竞态上一栏迟到的响应把当前栏盖掉.md)*
*ADR-0047 合成这条链上的三个死路 + t=0 被判成"还没开录" → [决策记录](../docs/adr/0047-合成这条链上的三个死路-+-t=0-被判成还没开录.md)*
*ADR-0048 合成片的落点定稿：走浏览器下载目录，与录制保存位置无关 → [决策记录](../docs/adr/0048-合成片的落点定稿走浏览器下载目录与录制保存位置无关.md)*
*ADR-0049 第 25/28/30/31/32/33/34/35 项一次性实测回看 + 第 38 项又清掉三处 → [决策记录](../docs/adr/0049-第-2528303132333435-项一次性实测回看.md)*
*ADR-0050 合成不再要求"整场别切走"：切走=自动暂停，回来接着放 → [决策记录](../docs/adr/0050-合成不再要求整场别切走切走=自动暂停回来接着放.md)*
*ADR-0051 盘上一轮清点：授权目录真写过文件、`.crdownload` 不是我方截断、第 24 项这次没验成 → [决策记录](../docs/adr/0051-盘上一轮清点授权目录真写过文件.crdownload-不.md)*
*ADR-0052 第 7/38 项全量静态复审：只剩一处展示层改写（已修），并记下一条 `reason` 语义混用的具名缺口 → [决策记录](../docs/adr/0052-第-738-项全量静态复审只剩一处展示层改写已修并记下一.md)*
*ADR-0053 宫格合成产物改出 **mp4**（第 16 项原话要的那个格式，本机浏览器原生就能封） → [决策记录](../docs/adr/0053-宫格合成产物改出-mp4第-16-项原话要的那个格式本机.md)*
*ADR-0054 第 7 项判据层欠债还清：`reason` 改成状态码导出的机器值，前端不再猜中文文案 → [决策记录](../docs/adr/0054-第-7-项判据层欠债还清reason-改成状态码导出的机.md)*
*ADR-0055 合成导出改为**离线合成**，回放页排列改为**按列数** → [决策记录](../docs/adr/0055-合成导出改为离线合成回放页排列改为按列数.md)*
*ADR-0056 第 34 项「点了没声音」查出第二半：快速会议弹窗的试听**从不传输出设备** → [决策记录](../docs/adr/0056-第-34-项「点了没声音」查出第二半快速会议弹窗的试听从.md)*
*ADR-0057 「前端从不退订 WHEP」这条债的判据查过了：**先别补调用**，原来的前提是条没验的假设 → [决策记录](../docs/adr/0057-「前端从不退订-WHEP」这条债的判据查过了先别补调用原.md)*
*ADR-0058 第 38 项复查：先前那句"全域 0 命中"是**口径太窄造成的假阴性**，本轮补扫抓到 4 处并已修 → [决策记录](../docs/adr/0058-第-38-项复查先前那句全域-0-命中是口径太窄造成的假.md)*
*ADR-0059 第 24 项「登录失败没提示」端到端补齐：**两条失败分支都实测到弹提示** → [决策记录](../docs/adr/0059-第-24-项「登录失败没提示」端到端补齐两条失败分支都实.md)*
*ADR-0060 第 38 项的判据从此可执行：`pnpm run check:copy` → [决策记录](../docs/adr/0060-第-38-项的判据从此可执行pnpm-run-check.md)*
*ADR-0061 第 20 项的另一半也上了门禁：`pnpm run check:tokens` —— 悬空的 CSS 变量 → [决策记录](../docs/adr/0061-第-20-项的另一半也上了门禁pnpm-run-chec.md)*
*ADR-0062 第 7 项又抓到一处**按错误文本判分支**：`isSelfAbort` 已换成结构判据 → [决策记录](../docs/adr/0062-第-7-项又抓到一处按错误文本判分支isSelfAbor.md)*
*ADR-0063 记一笔已定性的债：后端取词层**自己也在用文本匹配**，本轮判定不改，但写下触发条件 → [决策记录](../docs/adr/0063-记一笔已定性的债后端取词层自己也在用文本匹配本轮判定不改.md)*
*ADR-0064 对"别人后来大改过的那批文件"做了一次回归核对；顺带修了一个**静默坏掉的取证夹具** → [决策记录](../docs/adr/0064-对别人后来大改过的那批文件做了一次回归核对；顺带修了一个.md)*
*ADR-0065 第 7 项的**显示层**也进了门禁：后端 `msg` 只能原样上桌，拼接与插值都算改写 → [决策记录](../docs/adr/0065-第-7-项的显示层也进了门禁后端-msg-只能原样上桌拼.md)*
*ADR-0066 第 7/38 项的**后端侧**也上了门：`errs/usermsg_scan_test.go` → [决策记录](../docs/adr/0066-第-738-项的后端侧也上了门errsusermsgsc.md)*
*ADR-0067 「各项说明一行内」这条**不要做成静态门禁**：量过了，字面量长度不是渲染长度 → [决策记录](../docs/adr/0067-「各项说明一行内」这条不要做成静态门禁量过了字面量长度不.md)*
*ADR-0068 本地录制方案复审：九条已复核缺陷、增量落库与启动自愈、登录态不按标签 → [决策记录](../docs/adr/0068-本地录制方案复审九条已复核缺陷增量落库与启动自愈登录态不.md)*
*ADR-0003 三方发布拒绝的真实响应（逆向记录） → [决策记录](../docs/adr/0003-三方发布拒绝的真实响应逆向记录.md)*
### 6.5 `/api/v1/recordings`〔补写 2026-10-10 —— 此前整组无 HTTP 小节，见 DERIVATION §4-A7/F1〕

注册处 `backend/internal/cmd/cmd.go:147-152`，六条路由**全部在册并运行**。
此前本节只存在 §6.5.1（浏览器本地清单），controller 注释里反复引用的"契约 §6.5"一直指向一个不存在的节号 —— 本节补上它。
**形状真源是 `api.openapi.yaml`**（`RecordingVo` / `PlaybackData` 及其子型），下面的表只写语义与判据，不重抄字段清单（避免又长出第二份）。

> 端点清单（线格式明细见 `api.openapi.yaml`，本节只列路径与业务语义）：
- `GET /list`
- `GET /:meetingId/playback`
- `GET /:recordingId/download`
- `DELETE /:recordingId`
- `GET /:recordingId/playlist.m3u8`
- `GET /:recordingId/hls/*path`

`playbackUrl` / `downloadUrl` 都是**我方代理路径**，不是三方地址；三方地址不外溢。
`meetingNo` 是**三方会议号** —— 本域只有这一个入会号，没有"本地会议号"这种东西。它取自三方录像目录的
分组摘要（`groups[].meeting.meetingNumber`），在我方摊平分组时保留到每一行上，所以同一场会的各路带的是
同一个号。三方点名的历史孤立录像（`meeting` 为 null、`key` 为 `legacy:<recordingId>`）摘不到会，只能是空串：
界面按「原会议已查不到」如实显示，**不许拿会话键或别的键冒充**。
本地录制（`recordingType=local`）的字节只在录制者那台浏览器里，后端从未知晓 —— 那套形状见 §6.5.1，两者不要混用（`dataMissing` 就属于那边，见 §6.5.1 与 DERIVATION §4-C2）。

### 6.5.1 本地录制清单的形状（浏览器侧真源，不是 HTTP 契约）

本节 2026-09-29 那轮反馈（第 14–17 项）定形，此后随实现更新；标题里不带轮次标记（门禁 G4 不许现行规格留日期小节）。

本地录制的文件与清单都只在**录制者这台浏览器**里（IndexedDB 库 `conference-local`：
`handles` 目录句柄 / `recordings` 清单 / `blobs` 分片），后端从未知晓它们存在，
所以这一节定的是**前端内部契约** —— 回放、下载、宫格合成、清单展示都只认这个形状。
它刻意与三方 `playback` 的形状同构（见 `platform/contracts/edge-to-cloud/EXTERNAL_HTTPS_CONFERENCE_API.md` §12），
这样本地与云端两条来源能共用同一个回看引擎。

```ts
LocalRecording {
  id; title; meetingNo; fileName
  startedAt: number          // 本机 epoch 毫秒；展示按业务时区格式化，不外泄 ISO 串
  durationSec; sizeBytes; mime
  schema?: 1 | 2             // 1=旧的单条混合流产物；2=分轨道分片。读侧必须两条都认
  tracks?: RecordedTrack[]   // schema=2 才有
  dirPath?: string | null    // 授权目录内的相对层级；**没真的写出来就是 null**
  dirHandle?: boolean        // false = 产物只在浏览器里，界面必须这么说，不许假装落盘
  partial?: boolean          // 有路提前中断 / 存在缺口
}
RecordedTrack {              // 一路 = 一个 (参会者 × 通路) 的一次连续录制
  recordingId                // 同一个人中途退会再入 = **新的一条路**，不往旧路里续（第 17 项）
  ownerId; ownerName; kind: 'camera'|'screen'|'audio'; mediaLabel
  hasVideo; hasAudio
  startOffsetSec             // 相对整场 t0（录制会话开始的 epoch）
  endOffsetSec: number|null  // null = 会话结束时仍在录：没有实测终值就不写终值
  closedAtMs: number|null; closeReason: string
  mime; fileName
  segments: TrackSegment[]   // { seq, offsetSec, durationSec, sizeBytes, blobKey, mime }
}
```

四条硬口径（都是"不许造行"这条根规范在录制上的具体化）：

1. **分片是真分片**：每 2 秒一个 timeslice 落一条 `segments[]`，崩溃/刷新只丢最后一片；
   清单与分片同事务写，读侧遇到"清单有、blob 没了"要按缺口处理而不是当 0 秒。
2. **缺口是事实**：某路没在录的那段时间**不产生任何 segment**，回放按 `offsetSec` 找不到片就显示
   「尚未开始 / 此时段录制中断 / 此路录制已结束」。**不得**用重复末帧、静音段或补 0 时长把它填平 ——
   这也是画布取帧走 `captureStream(0)` 手动出帧（没画到东西就不出帧）的原因。
3. **`dirPath` / `dirHandle` 不许美化**：浏览器只能在用户授权目录内建
   `hxt/{登录账号}/{yyyyMMddHHmmss}/{会议编号}/` 这一层（第二段是账号不是姓名，见 6.4.42）；
   不支持 File System Access 的浏览器
   回退到下载目录，此时 `dirHandle=false` 且界面如实说明"没有写进那个层级"。
   云端录制的存储路径不归我们（第 13 项），所以清单里**没有**任何指向三方盘的路径字段。
4. **`schema` 只增不改**：老的单条混合流产物还在用户浏览器里，读侧必须继续能播；
   加字段往 `schema=2` 的形状里加，不要原地改语义。
5. **存储按会话、视图按「人 × 通路」**（第 17 项的口径，见 6.4.40）：上面那句"再入会 = 新的一条路"
   说的是**清单存储**；回放与宫格合成消费的是 `groupTracksByLane()` 归组后的视图行，
   一个 (ownerId × kind) 一行。归组只改视图，**不改清单**，也不把两次会话的原始文件拼成一份
   —— 两次 MediaRecorder 各有自己的容器头，拼起来就是坏文件。

### 6.6 `/api/v1/chat`

- `GET /messages?meetingId=&afterId=&limit=` → 线格式见 `api.openapi.yaml` `GET /chat/messages`
- `POST /messages` `{meetingId, text, clientMessageId}` → 线格式见 `api.openapi.yaml` `POST /chat/messages`

参会令牌由后端从 `(user, meeting)` 映射取；用户未入会 → `code:409, msg:"请先加入会议"`。
**ChatMessageVo**：`{id, text, senderName, senderEndpointType: 'edge'|'cloud', sentAt}`（ISO-8601）。
〔A8 更正 2026-10-10〕本行原先写 `senderNodeType`，那是**WebSocket 推送帧**上的名字
（`websocket/hub.go:404`）；REST 两路的线上键名是 `senderEndpointType`（`api/v1/chat.go:31`）。
两个词分属两条通道，不是同一个字段改了名 —— 前端 `api/chat.ts:7` 的 REST 类型也照本行抄错了，接线时由生成类型替换。
另注两条 REST 侧的形状细节（都在 `api.openapi.yaml` 里声明）：`GET` 的 data **直接是数组**（装饰体那个
`{messages:[…]}` 壳从未在线上出现过）；`POST` 的回显 `id` 恒为 0（自增主键不回查），**不许拿它当这条消息的标识**。

### 6.7 `/api/v1/settings/`

**字段清单不在这里重抄** —— 那正是本轮要治的东西：这一节原先列了一遍偏好字段，
结果后端加了 `recordingFps` 之后这里就成了第二份"看起来对但其实少一个键"的口径。
形状真源是 `api.openapi.yaml` 的 `PreferenceVo`（18 键），前端类型接线后由它生成。
本节只留 schema 装不下的语义：

- **线上路径带尾斜杠**：`/api/v1/settings/`（`cmd.go:161` 把 `/settings` 与 `/` 拼出来的），
  少一个斜杠就是另一条路由。
- **PUT 是全量覆盖**，请求体就是那个扁平对象（不包 `preferences` 壳）。所以前端**不许只 PUT 改动的那几项** ——
  少带一个键等于把那一项清零。成功回 `OkWithMessage`，**没有 data 键**。
- **行不存在时 GET 返回全默认值且不落库**（惰性），首次 PUT 才 upsert。
  这条不是可优化项：`GetPreferences` 里注释写着，"没写过偏好"是正常首访，
  若顺着 `Scan` 零行的 err 分支走，用户第一次打开设置页就会撞「系统异常」。
- **`recordingFps` 的 0 = 未设置**，前端 `canvasFpsFor` 兜到 15 —— 与 `sourceBitrateKbps` 用 0 表"取不到"是同一套编码。
  它此前只存在于前端类型与设置页下拉框、后端根本没有这一列（GET 从不返回、PUT 当未知键丢弃），
  2026-10-10 才补成 `user_settings.RECORDING_FPS` 真列；
  契约↔运行时的键集对账由 `backend/tests/regression/verify-contract-settings.mjs` 盯着，别再让它单边长。
- **`faceEnhancement`/`cloudRecordDefault` 是 0/1 整数不是 bool**（列是 TINYINT），
  而 `mirrorVideo`/`bgBlur`/`autoGain`/`noiseSuppression` 是 bool —— 同一张表里两种风格，改的时候别顺手统一。
- **`videoMaxFps` 与 `recordingFps` 是两件事**：前者是采集约束的 ideal 上限，后者是本地录制的画布帧率。
- **背景虚化只有 `vbMode` 一个生效真源**（`off|blur`，`custom` 本期按 `off`）：`bgBlur` 是旧开关的兼容镜像，
  读取时 `bgBlur && vbMode==='off'` 迁移为 `blur`，保存时写回 `bgBlur = (vbMode==='blur')`。
  两个真源曾导致"设置页显示关、采集仍在虚化"。
- **`GET /api/v1/settings/capabilities`**（新增）返回 `{faceEnhancement:{supported,message}}`。
  它不塞进 `PreferenceVo`：那 18 键是 PUT 的全量请求体，加只读键会把全量覆盖弄坏。
  `message` 由后端产出、前端照实渲染；判据是 `deployment.side == "cloud"`，
  理由与原文见外部契约 §10.3 末的云边对拍。

### 6.8 `/api/v1/dicts/{type}`

不变。

### 6.9 `/api/v1/users/me`〔变更：头像不再落文件盘，改存达梦〕

> 端点清单（线格式明细见 `api.openapi.yaml`，本节只列路径与业务语义）：
- `POST /avatar`
- `DELETE /avatar`
- `PUT /display-name`
- `GET /api/v1/users/{id}/avatar`

- 鉴权：默认 `Authorization: Bearer`；因为是 `<img src>`，该路径**只按固定形状**
  `/api/v1/users/<纯数字 id>/avatar` + `GET` 接受 `?token=` 票参（§5.1）。
  同前缀下的 `POST/DELETE /users/me/avatar`、`GET /users` 列表**不**因票参可达。
- 未登录/票参失效仍走全局响应格式（HTTP 200 + `{"code":401,"msg":"未登录"}`，既有 `response.Unauthorized`
  的形状，本轮不改）—— 对 `<img>` 而言就是"解码失败"，前端按现有的 `@error` 回落到名字首字母即可。
- 前端把 VO 里的 `avatar` 原样当 `src` 用时**需要自己补票参**（录制回放资产已有的做法，会中 `mediaUrl()` 同款）；
  后端不把 `?token=` 拼进任何响应字段。
- 〔删除〕静态直出 `GET /uploads/avatars/<file>` 与其目录配置一并撤掉：字节已在库里，磁盘上不再有头像。
  **不提供 SVG**（可携带脚本，静态/内联直出等同存储型 XSS）；`Content-Type` 恒由服务端按文件头判定。
- 显示名是"别人看到的我"：会中成员栏、参会者名单、聊天署名、受邀名单全部读同一个 `display_name`，
  改了之后其他端在**下一次状态同步**时看到新值（本端立即更新）。登录账号名（`username`）不可改，只有显示名可改。
- 头像真源唯一在 `sys_user.avatar_data` + `sys_user.avatar_type`；`sys_user.avatar` 降为**派生列**
  （有头像时等于 `/api/v1/users/<id>/avatar`，无头像为 NULL），只为让列表类查询不必触碰 BLOB。
  `GET /api/v1/auth/me`、登录响应、`UserBriefVo` 与 WS `participants[].avatar` 均透出同一派生路径，前端全站消费同一字段。
- 换头像后最多 5 分钟才在别的会话里可见（`max-age=300`），本人本页立即更新。
- 前端上传前用 canvas 等比缩到 256×256 再传（宿机带宽有限），服务端仍独立校验大小与类型。

### 6.10 `/api/v1/net-probe`〔新增〕

设置页「网络检测」的真实测量端点。只测**到本系统后端的这一段链路**，不宣称代表卫星链路端到端质量。

> 端点清单（线格式明细见 `api.openapi.yaml`，本节只列路径与业务语义）：
- `GET /down?kb=1024`
- `POST /up`

- 两个端点都在 `/api/v1` 的 JWT 组内 —— 未鉴权的带宽探测端点等于给自己装了个放大器。
- `kb` 缺省 1024、上限 8192，超限按上限截断而非报错。
- 延迟与抖动复用既有 `probeNetwork`（多次真实往返，取中位数与标准差），不新增端点。
- **丢包率无源**：fetch 层测不出丢包，设置页该格显示「抖动」，不放一个假装能测出来的百分比。

*ADR-0069 录制卡片的下载形状 + 应用级合成任务 + 存储配额 → [决策记录](../docs/adr/0069-录制卡片的下载形状-+-应用级合成任务-+-存储配额.md)*
*ADR-0070 一处新的文档-代码分叉登记：`localRecorder.ts` 的目录层级注释还是旧顺序 → [决策记录](../docs/adr/0070-一处新的文档-代码分叉登记localRecorder.t.md)*
*ADR-0071 一条本地录制被两个编码器写坏：写入侧守卫 + 读取侧拒绝交文件 → [决策记录](../docs/adr/0071-一条本地录制被两个编码器写坏写入侧守卫-+-读取侧拒绝交.md)*
*ADR-0072 取证工具自己有两处错：`validate-mp4.mjs` 的 esds 长度与"影音双轨"假设 → [决策记录](../docs/adr/0072-取证工具自己有两处错validate-mp4.mjs-的.md)*
*ADR-0073 录制可见性与归属：本地按登录账号过滤，云端由上游令牌强制 → [决策记录](../docs/adr/0073-录制可见性与归属本地按登录账号过滤云端由上游令牌强制.md)*
*ADR-0074 云端录制合成已接通：一条发布 = 一个远端 faststart MP4 → [决策记录](../docs/adr/0074-云端录制合成已接通一条发布-=-一个远端-faststa.md)*
*ADR-0075 本机录制的画质档位：只管码率与录制帧率，**不碰采集约束** → [决策记录](../docs/adr/0075-本机录制的画质档位只管码率与录制帧率不碰采集约束.md)*
*ADR-0076 "时长"只有一个算法；半截件判据的分母只能是被勾选路的时间轴 → [决策记录](../docs/adr/0076-时长只有一个算法；半截件判据的分母只能是被勾选路的时间轴.md)*
*ADR-0077 云端合成在容器边界被自己饿死：入料改惰性开料 + 停摆按前进量判活 → [决策记录](../docs/adr/0077-云端合成在容器边界被自己饿死入料改惰性开料-+-停摆按前.md)*
*ADR-0078 三档接线：回放页 DOM 与导出件同吃 `composeLayout` → [决策记录](../docs/adr/0078-三档接线回放页-DOM-与导出件同吃-composeLa.md)*
*ADR-0079 直连视频的取流编码按路判定：`streams[].videoCodec` → [决策记录](../docs/adr/0079-直连视频的取流编码按路判定streams.videoCo.md)*
*ADR-0080 ADR-0079 真机验通：边端那一格出画面了 → [决策记录](../docs/adr/0080-真机验通边端那一格出画面了.md)*
*ADR-0081 录制列表的分页单位从"路"改成"场"：`total` 现在是场次数 → [决策记录](../docs/adr/0081-录制列表的分页单位从路改成场total-现在是场次数.md)*
*ADR-0082 回放页：勾选成为唯一控制面 + 布局档位分两组 → [决策记录](../docs/adr/0082-回放页勾选成为唯一控制面-+-布局档位分两组.md)*
*ADR-0083 本地录制整栏空着：一条路径差一层目录，后面压着四层、修完又自己添了一层 → [决策记录](../docs/adr/0083-本地录制整栏空着一条路径差一层目录后面压着四层修完又自己.md)*
*ADR-0084 发版前复验：3 秒重试轮绕过防重入位（真机未复现，记为潜在风险）+ 「本端发布异常」只认画面腿 → [决策记录](../docs/adr/0084-发版前复验重试轮并发未复现发布异常徽章只认画面腿两条.md)*
*ADR-0085 边端应用被跨源 iframe 内嵌：只有目录选择器被拒（改借顶层小窗，选好照常落盘）；事前判据只拦有依据的两条 → [决策记录](../docs/adr/0085-边端应用被跨源iframe内嵌只有目录选择器被拒写盘正常.md)*
*ADR-0086 统计条在局域网通道上整条消失（`lanWhep` 那条腿从不写 `streamStats`）+ 帧延迟换成首帧基准、音画差"没有真源"改判为漏接 → [决策记录](../docs/adr/0086-统计条在局域网通道上整条消失帧延迟换成首帧基准.md)*
*ADR-0087 同侧分母不给倍率（实测会倒挂、抖动 ±30%，连三方上报的倍率都是同一个瞬时量的商）+ 三方云边是两个客户端（三项只在船端 legacy 页，云端只有聚合带宽）→ [决策记录](../docs/adr/0087-同侧分母不给倍率-+-三方云边是两个客户端.md)*
## 7. WebSocket `/ws/v1/meeting?meetingId=&ticket=`

信封 `{type, data}`。事件（服务端→客户端）：

| type | data | 时机 |
|---|---|---|
| `participants` | `{participants, invited}` —— 与 `MeetingStateVo` 同形；`invited[].joined` 随入会变化重算 | 变更 |
| `meeting` | `MeetingStateVo`（同 `GET /:id/state` 的 data，字段一个不多一个不少） | 变更；**〔新增〕这场会的后端会话全部被判定失效时补发一次终态**：上游最后一次给过 `ended/cancelled/failed` 就用那个词，一次都没拿到过就按 `ended`。前端收到 `status` 为终态词即应清掉 sessionStorage 里的 meetingId 退出会中页——浏览器关标签页不会调 `/leave`，没有这次广播前端就永远不知道自己已经被踢出 |
| `streams` | `MeetingStateVo.streams` | 变更 |
| `time` | `{serverTime, clockDriftMs}` | 每秒 |
| `chat` | `ChatMessageVo` | 新消息 |
| `speaking` | `{participantId, speaking}` | 客户端上报转发（仅同会议其他连接） |

客户端→服务端（仅这五类）：`media` `{cameraOn, micOn, sharing}`、`telemetry` `{items:[TelemetryItem]}`、
`chat` `{text, clientMessageId}`、`speaking` `{participantId, speaking}`、`leave`。
`TelemetryItem` 的形状与两条过滤规则见 6.3 的 `POST /:id/telemetry` —— **两条通道共用一个形状**。
WS 这条是冗余、正确性以 REST 为准，理由与 `media` 同（WS 未连上时静默丢弃）。
〔此前分叉〕本行原写"仅这四类"，而 `websocket/hub.go` 早就有第五个 `case "telemetry"` —— 契约漏登记，
不是代码多长了一类。

〔参会令牌续期归后端〕上游的 heartbeat 同时是状态拉取与令牌续期，**按会话逐个发**，从 `/meetings/join`
成功那一刻起由后端负责。前端 WS 断开**不会**导致该成员被上游判 `participant_not_joined` 踢出；
`media` 事件只更新意图位，不承担保活职责。

〔删除〕`camera_strategy/share_strategy/record_toggle` 幽灵类型；策略与录制改走 6.3 的 REST。

## 8. 未接入清单（页面标注"暂未接入"，禁止假数据顶替）

先澄清一个易混点：成员面板的**「等候入场」不是等候室**——它是"受邀但未入会"的名册分组，
数据源是本域 `meeting_participant` × 在线 `participants` 比对，**本域可实现**（见 6.3 `invited`）。
真正的等候室**已于 2026-09-29 按第 10 项在本域实现**（见 6.4.33）：三方没有准入接口，
但"要不要把这个端真的放进三方"是我方后端的决定，所以门禁做在这一侧。

- 会议锁定、主持人强制禁言 —— 上游无能力，未接入前不做控件
- 预约弹窗的「受邀成员」选择区：本轮按需求冻结（不接入、不演示），入会准入不受邀请名单约束
- 邀请通道之「微信」「企业微信」—— 本系统无任何第三方发送通道；弹窗内**只复制链接并如实标注暂未接入**，
  不得放一个假装能发送的按钮。「邮件」走 `mailto:`、「短信」走 `sms:`、「二维码」前端本地生成
- 聊天输入区的 @提及 / 附件上传 / 语音条 —— 上游与本地均无对应能力，未接入前不显示入口
- **背景虚化 / 虚拟背景 —— 〔2026-10-09 主动屏蔽〕**功能不完善（人像分割与降级未站住），暂时下线。
  开关只有 `frontend/src/utils/virtualBackground.ts` 的 `BG_BLUR_AVAILABLE` 一处，恢复改回 `true` 即可。
  **三处一起关，不许只藏控件**：预检页的「虚拟背景」整块、设置页的「背景虚化」行、以及采集链路里
  `useMediaSettings` 的 `wantBlur`。最后那处是重点 —— 只藏 UI 的话，之前把虚化打开过的人会
  **继续被虚化，却没有地方看到或关掉**，那比"功能没有"更糟。已保存的偏好不清除（恢复后照旧生效）。
- 快捷键 —— **2026-11-17 用户定为不做（wontfix）**，不是"待做"。画布上没有这块设计，
  唯一依据是已删除的 HTML 原型（6 条固定键、且无"自定义"），代码里从未有过键盘绑定。
  取证见 `../evidence/2026-11-17-交付目录改名与旧仓核对.md`。真要做属新增需求：先改画布，再从零加组件。
- 人脸 ROI 提示 —— 边端 RK 通道专属，岸端浏览器暂不接
