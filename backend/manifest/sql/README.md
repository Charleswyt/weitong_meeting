# conference 建库脚本

边端库是 **SQLite**：一个应用一个 `.db` 文件，本应用的就是 `data/conference.db`
（`data/` 已 gitignore，备份/替换/回滚就是拷一个文件）。定案见 `platform/TECH_STACK.md`「边端」表的「数据库」行
（2026-09-29：**边端不用达梦**）。

所以此前那份"与 `edge/fence` 共用一个 DM8 容器（`127.0.0.1:5236`）、本应用用独立 schema `CONFERENCE`"
的形态**已经退役** —— 达梦里 schema 名 = 用户名那套前提在本单元不再存在。达梦脚本全部转为历史档案，
见下面「达梦时期的历史档案」。

## 脚本执行顺序

新库有三步，顺序**不可颠倒**（第一步的口令列是空占位）：

```bash
go run . migrate -script=manifest/sql/sqlite_create.sql      # 10 张表 + 字典与业务种子
go run . migrate -script=manifest/sql/seed-credentials.sql   # 灌真实口令（该文件 gitignore，绝不入库）
go run . hash-passwords                                      # 把本地口令换成 PBKDF2 哈希（幂等）
```

1. **`sqlite_create.sql` 是唯一入口脚本**，2026-09-29 起新库跑完它就是完整的：10 张表 + 字典与业务种子，
   16 条语句。它用 `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE` + **显式主键**，所以
   **可重复执行、不毁数据、也不会把字典行插两遍**。
   达梦时代"create.sql 停在它写就的那天、之后新增的表/列只在 `alter_*.sql` 里，所以新库得按日期顺序
   把 `alter_*.sql` 全跑一遍"那个负担**已经没了** —— 别再照那个流程走。
2. **跑完第一步必须紧接着跑 `seed-credentials.sql`**：`sqlite_create.sql` 里 `sys_user.PASSWORD` 与
   `THIRD_PARTY_PASSWORD` 都是**空串占位**（文件里不含任何口令），不灌就**谁都登不进去**。
   该文件现在**同时**含三方口令与本地口令两类 `UPDATE`，12 条。
3. **第三步 `hash-passwords` 不是可选收尾**：`seed-credentials.sql` 灌进去的是明文（SQL 里没法算
   PBKDF2），跑完这一步库里才全是 `pbkdf2-sha256$迭代$盐$摘要`。没跑也不会锁门 ——
   `internal/password.Verify` 兼容明文并在**登录成功后就地升级**，但"能登录"不等于"已脱敏"。
   命令幂等：带前缀的行跳过，**空串行跳过**（空串是"还没配口令"的占位，哈希它等于开一个空口令后门）。
   只动 `PASSWORD` 一列：`THIRD_PARTY_PASSWORD` 要原样发给三方换令牌，哈希过一次就废了。
4. **`database.default.debug: true` 会把执行的 SQL 连参数一起打进日志** —— 跑 `seed-credentials.sql` 时
   把输出重定向到文件，**别贴进任何记录、终端历史、提交信息或本文档**。
   `hash-passwords` 的日志里是哈希（不是明文），但仍属凭据材料，同样不外传。
5. 连接串只从 `manifest/config/config.yaml` 的 `database.default.link` 读，**没有 `-dsn` 口**：
   命令行传 dsn 会被 shell history 与进程列表留下来，而那份配置文件本来就是连接串的真源。

**回读要看，别只看"没报错"**：表数查 `sqlite_master`，列查 `PRAGMA table_info('<表>')`
（都走 `go run . migrate -query=...`）。达梦的 `USER_TAB_COLUMNS` / `USER_TAB_COMMENTS`
在这里**没有对应物**，别照着老路找。

**切分器的一条坑（不是达梦专属，今天还在）**：`internal/cmd/migrate.go` 的 `splitStatements` 按分号切，
**并给英文双引号做配对，配对状态还跨行**。行首整行 `--` 注释会被跳过（引号不参与配对），
但**列定义后面的行尾注释**里的英文双引号是会被喂进切分器的 —— 同一行**落单**的一个 `"`
会把后续分号吞掉，紧跟的语句被切成坏 SQL，报出来的是语法错误，看着像 SQL 写坏了。
**注释里要引用词语就用中文引号**；`sqlite_create.sql` 现有的 12 个 ASCII 双引号都是成对出现的，别破坏这个不变量。

## 驱动与连接串

`github.com/gogf/gf/contrib/drivers/sqlite/v2 v2.10.3`，底层是 `github.com/glebarez/go-sqlite`
（`modernc.org/sqlite` 的纯 Go 移植）→ **不需要 CGO**。

这条重要，不是洁癖：上 RK3588 板卡的镜像必须 `--platform linux/arm64`，**一旦有 CGO 就交叉编译不了**。
达梦驱动已从 `go.mod` 彻底摘除（`go mod tidy` 后只剩 sqlite contrib 和它自己的间接依赖）。

```
sqlite::@file(data/conference.db)?journal_mode=WAL&busy_timeout=5000
```

gf 的 sqlite contrib 认这个形状，`?k=v` 会被**逐项**转成 DSN 上的 `_pragma=k(v)`；
相对路径按进程工作目录（后端仓根）解析。
**SQLite 没有用户/口令概念**，所以这份配置里从此**不再有连接凭据**，口令只在 `sys_user` 表里按用户一行。

WAL + busy_timeout **不是可选**：SQLite 是**单写者**，会中 cron（`ReconcileStaleRunning`，每分钟全表扫
`meeting_appointment`）与 HTTP 请求会并发写，不开这两项就撞 `SQLITE_BUSY`。

## 三条硬约定（最容易复发的坑）

1. **表名小写、列名大写。** 10 个 DAO 的列常量与 entity 的 `orm:` 标签**全是大写字符串**，
   gf 会给标识符加反引号，而 **SQLite 里带引号的标识符大小写敏感** → 列名必须与那些常量**逐字符**对上，
   否则全线 `no such column`。种子 `INSERT` 用小写列名可以（非引号标识符大小写不敏感）。
   新表/新列先抄 DAO 常量，别自己定大小写风格。
2. **绝不给时间列写 `DEFAULT CURRENT_TIMESTAMP`。** SQLite 的该默认值**恒为 UTC**
   （达梦容器当年被特意设成东八区，所以 DM 版照抄是"对的"），照过来**不报错**，
   只会让时间戳**静默差 8 小时**。去掉是安全的，因为**没有任何一列真吃 DB 默认值**：
   - `CREATED_AT` / `UPDATED_AT` / `DELETED_AT` —— 由 gdb 按列名自动维护；
   - `SUPPRESSED_AT` / `FIRST_JOINED_AT` / `LAST_JOINED_AT` —— 由代码显式 `gtime.Now()`
     （`meeting_schedule.go:279`、`recording.go:313`、`meeting_attendance.go:43-44`）；
   - `STARTED_AT` / `START_TIME` —— 来自三方实测值与用户预约输入，本就不该有默认。

   进程时区仍由 `server.timezone` 钉死（`internal/cmd/config.go`），不跟宿机时区走。
3. **SQLite 的 DDL 语法跟 DM/Oracle 不是一回事。**
   - **不支持** `ALTER TABLE ... ADD CONSTRAINT UNIQUE` —— 唯一约束一律 `CREATE UNIQUE INDEX`
     （见 `uk_meeting_attendance`，DM 版那句 `ADD CONSTRAINT` 就是这么换掉的）；
   - 自增主键必须写 `INTEGER PRIMARY KEY AUTOINCREMENT` —— 写 `BIGINT` 就**退化成普通整数列**
     （DM 的 `BIGINT IDENTITY(1,1) PRIMARY KEY` 直译过来是错的）；非自增主键
     （`dict_type` / `recording_id` / `meeting_id` / `user_settings.user_id`）保持原样；
   - `ADD COLUMN` 一条只能一列，**不吃** `ADD ( ... )` 括号形式。

## 建表约定（与其他单元不同）

本单元**不建**：
- 外键（`FOREIGN KEY`）—— 跨表全是逻辑引用，列注释里写明"无外键"；
- 唯一约束（`UNIQUE`）—— 除 PK 外全部去掉；
- 二级索引（`CREATE INDEX`）—— 除 PK 支撑的隐式索引外。

与围栏**旧达梦版**的建索引脚本（4 索引 + 2 unique）**做法相反**（该脚本已随 fence 2026-10-11 无库化删除）。理由：
- 数据量为个位数行（种子）到千级（会议/参会人）；
- 边端设备资源紧，索引维护成本不划算；
- 唯一性由应用层校验（`auth.Login` 用 `Where(username).Scan()` 只取首行；
  一旦加用户管理入口，service 层**必须**补查重，否则重名会静默命中错误用户）。

**唯一的例外**是 `meeting_attendance` 的 `(MEETING_ID, USER_ID)`：重复入会必须走更新而不是插第二行，
那是**正确性要求**不是查询加速，所以它落成 `CREATE UNIQUE INDEX IF NOT EXISTS uk_meeting_attendance`
（隐式索引是顺带的，不违反上面的约定）。

## 列注释的真源变了

**SQLite 没有 `COMMENT ON`**（解析器接受但丢弃），库里存不住注释。达梦时代
"用独立成句的 `COMMENT ON TABLE` / `COMMENT ON COLUMN`、每张表每一列补一条、`gf gen dao` 会读它写进
entity 的 GoDoc"那一整套，现在**都不成立**。

注释的真源是 `manifest/sql/sqlite_create.sql` 的**行内 `--`**，entity 的 GoDoc 按它**手工维护**。

**别顺手跑 `gf gen dao`** —— 障碍换了但结论没换：达梦时代跑不了它是因为 `-l` 的解析器切不开含 `@` 的口令，
这个理由随换库消失了；但换库**没让 regen 变安全**：① 它读不到列注释（见上），regen 出来的三层 GoDoc 是空的，
会把现有注释全冲掉；② 它按表生成 `internal/dao/<table>.go`，与本仓手写的单文件 `dao.go` 里的
`var SysUser = ...` **重复声明**，直接编译失败。所以新表仍按 `recording_deleted` / `meeting_deleted`
现有形状**手写**三层，差异只在包名/表名/列名/列注释四处。细则见仓库根 `AGENTS.md`。

## 要加字段怎么做

1. 改 `manifest/sql/sqlite_create.sql`（新库要长这样），列名写**大写**；
2. 对现网库跑**单列** `ALTER TABLE`：
   `go run . migrate -query="ALTER TABLE x ADD COLUMN Y VARCHAR(32) DEFAULT ''"`；
3. 同步 DAO 列常量与 `entity/`、`do/`、`internal/dao/internal/` 三层，注释从 `sqlite_create.sql` 抄；
4. `PRAGMA table_info('x')` 回读证明列在。

## 达梦时期的历史档案（绝不能再执行）

`bootstrap.sql` / `create.sql` / `alter_20260924.sql` / `alter_20260928.sql` / `alter_20260928b.sql` /
`alter_20260929.sql` / `alter_20260929b.sql` **保留只为说明"这一列当初为什么这么定"**，
**不要再对 SQLite 执行**：

- `bootstrap.sql` 以 SYSDBA 建用户 + 模式 + `GRANT RESOURCE` —— SQLite 无用户无模式，整段无意义；
- `alter_20260924.sql` 的 `ADD ( 多列 )` 与 `alter_20260929b.sql` 的 `ADD CONSTRAINT UNIQUE`
  都是 DM/Oracle 语法，SQLite 解析不了；
- `create.sql` 每张表前导 `DROP TABLE IF EXISTS`（DM 不支持 `CREATE TABLE IF NOT EXISTS`，只能先删后建），
  **拿它"顺手重建"会把现网数据清掉**，而且它停在达梦时期，**缺** `meeting_attendance` 整张表与
  `meeting_appointment.ALLOW_WAITING` 一列（那两处只在 `alter_20260929*.sql` 里）；
- `create.sql` 把 6 个本地口令**明文写进了版本库**，那是已登记待处置的债 ——
  `sqlite_create.sql` 一个口令都不含，别把那个形态带回来。

一并退役、**别在现在的代码里找它们的影子**的达梦专属经验：`docker exec disql` 连库（现在连库工具只有
`go run . migrate`）、disql 按**第一个 `@`** 把含 `@` 的口令切坏、`gf gen dao -l` 报
`invalid link configuration` 并把整串连口令打到终端、DM8 报 `Error -2007 第 N 列["]附近出现错误`、
容器 TZ 设东八区、`5236` 端口与 `CONFERENCE` schema。
其中"link 串里两个 `@` 可疑、顺手改成离散字段并 commit"这条**已经是历史**：
换库后 link 里根本没有凭据可切，也没什么可改回去的。

## 存量数据没搬（已知缺口，如实记着）

**没有做达梦 → SQLite 的数据迁移。** 开发机的 `data/conference.db` 是**从种子重建**起来的，
达梦库里的存量行（历史会议、参会记录、录制）**一行都没搬过来**。
现在库里内容 = `sqlite_create.sql` 的种子 + 之后回归测试新造的行。
要真搬得单独写导出/导入并按表逐行核对 —— **别把"表结构齐了、回归全绿"当成"数据也齐了"**。

## 已实测的验证结果（2026-09-29）

- `sqlite_create.sql` **16 条语句 0 失败**；`seed-credentials.sql` **12 条 0 失败**。
- `go build ./...` 通过；服务启动期那条

  ```sql
  SELECT `ID`,... FROM `meeting_appointment`
  WHERE (`STATUS` IN ('running','starting')) AND `DELETED_AT` IS NULL LIMIT 200
  ```

  在 SQLite 上正常执行 —— 证明**大写列名 + 小写表名 + 逻辑删除过滤**三者都对上了。
- 端到端回归 `verify-0929-round2.mjs` **20/20 通过** + `verify-lobby-release.mjs` **6/6 通过**
  （2026-09-29 14:43），覆盖 SM2 登录、`InsertAndGetId`（拿到 id 1/2/3，证明
  `INTEGER PRIMARY KEY AUTOINCREMENT` 语义正确）、预约改取消权限、等候室门禁、软删、参会历史与列表。
- 跑回归的两个环境坑照旧记着：`%TEMP%\creds.tsv` 要用本应用树内的 `scratch/restore-creds.mjs`（若有）写回；
  `sm-crypto` 只装在 `cloud/frontend/node_modules`，脚本应在 `cloud/frontend/scratch/` 里跑、
  跑完删掉副本 —— **别往 backend 加 `node_modules`**。

## 旧文档里的两处错数（已纠正）

`create.sql` 的注释自述 `sys_dict_type` 是「8 类」、`sys_dict_data` 是「32 行」，**实际是 7 类 / 29 行**
（按 3+8+6+3+3+3+3 逐行数出来的一致结论）。
**以 `sqlite_create.sql` 的 29 行为准**；历史档案里那两行注释留着当事故记录，别抄它的口径。
