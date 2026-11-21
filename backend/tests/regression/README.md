# 会中控制面回归（HTTP 级验收，不是单元测试）

这两个脚本对着**正在运行的后端**打真实接口，覆盖 2026-09-29 那轮 19 项需求里的
第 **1 / 5 / 6 / 10** 项（离会收尾不报错、加入过的会要出现在列表、会议可取消不可删除且仅主持人可改、
主持人到场前成员进不去）以及第 **9** 项的延迟口径。`go test ./...` 覆盖不到这些，
因为它们要的是"跨账号 + 三方真实会议"的端到端行为。

## 前置

1. 后端 `go run .` 监听 :8082（**库已经是 SQLite** —— `data/conference.db`，`edge-dm8` 容器那套已作废）。
2. `creds.tsv` 里有探针账号：**第 1 列是登录名**（`liwei` / `zhangming`，不是显示名），第 2 列口令。
   口令只从这个文件读，**不要写进脚本、提交信息或任何文档**。
   跑法：`CREDS_FILE="<该路径>" node <脚本>`；不给 `CREDS_FILE` 时脚本退回 `os.tmpdir()/creds.tsv`
   （**别指望 `process.env.TEMP`** —— Git Bash 起的 node 里它常常是空的，那会读到一个不存在的路径）。
3. 这两个脚本打的是 **http**://localhost:8082，**不需要** `NODE_EXTRA_CA_CERTS`（那是历史遗留：
   早先脚本走 https 自签证书时才要）。别为了"照 README 做"去关证书校验。

```bash
cd backend/tests/regression
CREDS_FILE="$TEMP/creds.tsv" node verify-0929-round2.mjs     # 20 项
CREDS_FILE="$TEMP/creds.tsv" node verify-lobby-release.mjs   # 等候室放行 6 项
node verify-contract-settings.mjs                            # 契约↔运行时键集对账，**不需要 creds.tsv**
```

只有在拿不到那台开发机的 CA 时，才在**单次命令**上临时加 `NODE_TLS_REJECT_UNAUTHORIZED=0`。
它会把证书与主机名校验整个关掉（中间人风险），所以**绝不允许**写进源码、`.env`、CI 配置或任何
会被复用到非本机端点的地方 —— 那类端点必须校验证书。

## 2026-09-29 实测到的两个"跑不起来"，先解这两个再怀疑脚本

1. **`%TEMP%\creds.tsv` 会被 Windows 清理掉**（当天就没了），脚本第一行读文件就 `throw`。
   口令不用问人：用本机 gitignore 的凭据种子 / 恢复脚本写回（勿依赖 edge 路径）
   （只打印写了几个登录名、几行有三方对，不回显口令）。
   **列序必须是 4 列** `localUser \t localPass \t tpAccount \t tpPass`：逆向三方的探针吃第 3/4 列，
   而第 4 列的真源是 gitignored 的 `manifest/sql/seed-credentials.sql`（`create.sql` 里那列是空占位）。
   少了那个文件就只会恢复两列 —— 本仓回归照跑，但三方侧探针会判"缺账号对"提前退出。
2. ~~**`sm-crypto` 只装在 `frontend/node_modules`**…把脚本副本放到 `frontend/scratch/` 里跑~~
   —— **已于 2026-09-29 19:12 在脚本里解掉**：两个脚本现在用 `createRequire` 按相对路径
   要求前端仓那份 `sm-crypto`，在本目录直接就能跑，**不要再复制副本**（副本会和原件漂移）。
   留这条划线记录是因为：跨仓不共享依赖这件事本身没变，变的只是"谁来绕开它"。

## 最后一次运行记录

2026-09-29 19:12：**迁到 SQLite 之后第一次重跑，`verify-0929-round2.mjs` 20/20 PASS、
`verify-lobby-release.mjs` 6/6 PASS。** 跑之前先修了脚本本身的两处"根本跑不起来"：
① `import sm from 'sm-crypto'` 在这个目录解析不到（见下一节第 2 条，已改成按路径 `createRequire`，
不再需要复制副本）；② 读凭据用 `process.env.TEMP`（Git Bash 的 node 里是空的）且按 `\n` 切行
（Windows CRLF 会把 `\r` 留在最后一列，三方口令就带着一个看不见的字符去登录）。
所以这一轮 green 是**在 SQLite 上真的跑出来的**，不是沿用上午的记录。

2026-09-29 11:35：加上"登出时结束三方会话"（`AuthService.Logout` + `PeekCachedToken`）之后重跑，
`verify-0929-round2.mjs` **20/20 PASS**、`verify-lobby-release.mjs` **6/6 PASS**，
`go test ./internal/service/thirdparty/ -run TestPeekCachedToken` 也 PASS。
登出那条链路另有端到端取证：登出接口 **2 ms** 返回、后端日志出现
`三方会话已随登出结束`、三方侧同一令牌随后打 `/auth/me` 得 401 —— 见契约 20260928 §11.1。

2026-09-29 11:15：对着含 `cmd.go` 改动的当前树重跑，**20/20 + 6/6 PASS**。

## 会留下什么

脚本会**真的在三方平台建会、入会、结束/取消**，跑完自己收尾（结束会议 + 取消验证用的预约）。

`verify-0929-round2.mjs` 末尾会打印 `IDS {...}`，那是它自己建的验证用会议号，跑完已被清理，留着只为排查。
