-- =============================================================================
-- 视频会议单元 · SQLite 建表 + 种子数据（边端目标形态，2026-09-29 起为唯一入口脚本）
--
-- 为什么换：shared/TECH_STACK.md 第 12 行已定案「边端不用达梦，一应用一个 .db 文件」，
--   宿机（RK3588 板卡）上不装也不打算装 DM8。本仓此前连开发机的 DM8 容器属存量待迁移。
-- 驱动：github.com/gogf/gf/contrib/drivers/sqlite/v2 v2.10.3 —— 实测其底层是
--   github.com/glebarez/go-sqlite（modernc.org/sqlite 的纯 Go 移植），**不需要 CGO**，
--   所以 `--platform linux/arm64` 的镜像照常交叉编译（这条是上板卡的硬约束）。
--
-- 与 DM8 版 create.sql 的六处刻意差异（不是漏翻，改之前先读这段）：
--  1. 表名小写、**列名大写**。DAO 的列常量与 entity 的 orm 标签全是大写字符串
--     （internal/dao/internal/*.go），而 gf 会给标识符加反引号；SQLite 里**带引号的
--     标识符大小写敏感**，所以列名必须与那些常量逐字符相同，否则全线 no such column。
--     种子 INSERT 用小写列名 —— SQLite 的**非引号**标识符大小写不敏感，照样落对列。
--  2. `BIGINT IDENTITY(1,1) PRIMARY KEY` → `INTEGER PRIMARY KEY AUTOINCREMENT`。
--     SQLite 只认 `INTEGER` 这一种写法做自增，写 BIGINT 就退化成普通整数列。
--     非自增主键（dict_type / recording_id / meeting_id / user_settings.user_id）不动。
--  3. **不写 DEFAULT CURRENT_TIMESTAMP** —— 这是本次迁移最容易静默踩的坑：
--     SQLite 的 CURRENT_TIMESTAMP **恒为 UTC**，而达梦容器被特意跑在东八区。
--     照抄默认值不会报错，只会让 created_at/updated_at/suppressed_at 全线差 8 小时。
--     去掉它是安全的，因为没有任何一列真的吃 DB 默认值：
--       · CREATED_AT / UPDATED_AT / DELETED_AT —— GoFrame gdb 按列名自动维护，写入即带上；
--       · SUPPRESSED_AT / FIRST_JOINED_AT / LAST_JOINED_AT —— 代码显式 gtime.Now()
--         （meeting_schedule.go:279、recording.go:313、meeting_attendance.go:43-44）；
--       · STARTED_AT / START_TIME —— 来自三方实测值与用户预约输入，本就不该有默认。
--     进程时区仍由 server.timezone 钉死（internal/cmd/config.go 的 gtime.SetTimeZone）。
--  4. 注释：SQLite 没有 `COMMENT ON`（解析器接受但丢弃）。所以**列注释的真源从库内
--     移到本文件的行内 `--`**。副作用：`gf gen dao` 读不到 DB 列注释了 —— 本仓本来就
--     跑不了它（见 AGENTS.md），entity 的 GoDoc 按本文件手维护。
--  5. 唯一约束：沿用本单元「不建二级索引、不建 UNIQUE（PK 除外）」的约定。
--     只有 meeting_attendance 的 (meeting_id,user_id) 有唯一性要求 —— 达梦那版用
--     `ALTER TABLE ADD CONSTRAINT` （alter_20260929b.sql），SQLite **不支持**该语法，
--     等价改成下面的 `CREATE UNIQUE INDEX`。
--  6. 幂等：DM 版每表前导 `DROP TABLE IF EXISTS`（因为它不支持 CREATE IF NOT EXISTS）。
--     SQLite 两条都支持，这里用 `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE` +
--     **显式主键**，所以重复执行不会毁数据、也不会把字典行插两遍。
--     显式给 sys_user 1..6 还有一个硬理由：user_settings 的种子按 user_id 1/2/3 写，
--     DM 版那三行是"恰好"落在 1/2/3 上的（IDENTITY 顺序凑出来的），不该再靠运气。
--
-- 口令：**本文件不含任何口令**。sys_user.password 与 third_party_password 都留空占位，
--   真实值只由 gitignore 的 `seed-credentials.sql` 注入（该文件绝不入库）。
--   旧 DM 版 create.sql 把 6 个本地口令明文写进了版本库，那是已登记待处置的债
--   （见 docs 与提交历史），新脚本不延续那个形态。
--
-- 跑法（连接串只从 manifest/config/config.yaml 读，没有 -dsn 口，口令不进命令行）：
--   go run . migrate -script=manifest/sql/sqlite_create.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- sys_dict_type 枚举类别
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sys_dict_type (
  DICT_TYPE  VARCHAR(64) NOT NULL PRIMARY KEY, -- 枚举类别编码（position/meeting_status…）；全仓唯一由应用层保证
  DICT_NAME  VARCHAR(64) NOT NULL,             -- 类别显示名
  STATUS     TINYINT     DEFAULT 1,            -- 1 启用 0 停用；停用只隐藏取值不删数据
  REMARK     VARCHAR(256),                     -- 归属与取值域真源出处
  CREATED_AT TIMESTAMP,                        -- 由 gdb 自动维护（不给 DB 默认值，见头部第 3 条）
  UPDATED_AT TIMESTAMP,                        -- 同上
  DELETED_AT TIMESTAMP                         -- 软删除时间戳，非空即视为删除
);

-- -----------------------------------------------------------------------------
-- sys_dict_data 枚举取值
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sys_dict_data (
  ID         INTEGER PRIMARY KEY AUTOINCREMENT, -- 自增主键
  DICT_TYPE  VARCHAR(64) NOT NULL,              -- 所属类别（逻辑引用 sys_dict_type.DICT_TYPE，无外键）
  DICT_VALUE VARCHAR(64) NOT NULL,              -- 落库的规范值，业务表存这一列；组合唯一由应用层保证
  DICT_LABEL VARCHAR(64) NOT NULL,              -- 给人看的展示名
  SORT       INT      DEFAULT 0,                -- 下拉与展示顺序
  STATUS     TINYINT  DEFAULT 1,                -- 1 可见 0 隐藏（隐藏不等于删除，历史数据仍能反查 label）
  TAG_TYPE   VARCHAR(16),                       -- 前端标签语义色 success/info/warning/danger，替代组件里硬写的 switch
  REMARK     VARCHAR(256),                      -- 取值域真源出处或特殊说明
  CREATED_AT TIMESTAMP,                         -- gdb 自动维护
  UPDATED_AT TIMESTAMP,                         -- gdb 自动维护
  DELETED_AT TIMESTAMP                          -- 软删除时间戳
);

-- -----------------------------------------------------------------------------
-- sys_dept 部门
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sys_dept (
  ID         INTEGER PRIMARY KEY AUTOINCREMENT, -- 自增主键
  NAME       VARCHAR(64) NOT NULL,              -- 部门名称；不同船可能同名，故不加唯一约束
  SORT       INT      DEFAULT 0,                -- 展示顺序
  STATUS     TINYINT  DEFAULT 1,                -- 1 正常 0 停用
  CREATED_AT TIMESTAMP,                         -- gdb 自动维护
  UPDATED_AT TIMESTAMP,                         -- gdb 自动维护
  DELETED_AT TIMESTAMP                          -- 软删除时间戳
);

-- -----------------------------------------------------------------------------
-- sys_user 账号（本单元的人员主数据；原 sys_contact 已并入本表）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sys_user (
  ID                    INTEGER PRIMARY KEY AUTOINCREMENT, -- 自增主键
  USERNAME              VARCHAR(64)  NOT NULL,             -- 登录名；唯一性在应用层校验（本单元约定），一旦加"新建用户"入口必须补查重
  PASSWORD              VARCHAR(128) NOT NULL,             -- 本地口令，当前明文过渡；种子只留空位，真值见 gitignore 的 seed-credentials.sql
  DISPLAY_NAME          VARCHAR(64)  NOT NULL,             -- 入会与界面展示名，唯一真源（user_settings 不再存 displayName）
  AVATAR                VARCHAR(256),                      -- 头像 API 路径（派生值，字节在 AVATAR_DATA、类型在 AVATAR_TYPE）
  THIRD_PARTY_ACCOUNT   VARCHAR(64)  NOT NULL,             -- 映射到三方平台的账号名
  THIRD_PARTY_PASSWORD  VARCHAR(128) NOT NULL,             -- 三方口令：按用户一行、需后台可查，故不入配置文件；种子留空位
  ACCOUNT_TYPE          VARCHAR(32)  DEFAULT 'meeting_participant', -- 字典 account_type
  POSITION_CODE         VARCHAR(64),                       -- 字典 position；人员主数据，定义权待 cloud/device-registry 上收
  STATUS                TINYINT      DEFAULT 1,            -- 1 启用 0 禁用
  MOBILE                VARCHAR(20),                       -- 绑定手机号（11 位国内号）；空=未绑，短信登录/找回靠这一列
  EMAIL                 VARCHAR(128),                      -- 绑定邮箱；空=未绑，邮箱验证码登录靠这一列
  CREATED_AT            TIMESTAMP,                         -- gdb 自动维护
  UPDATED_AT            TIMESTAMP,                         -- gdb 自动维护
  DELETED_AT            TIMESTAMP,                         -- 软删除时间戳
  AVATAR_DATA           BLOB,                              -- 头像二进制（PNG/JPEG/WebP），自 2026-09-28 起是头像唯一真源，不落本地文件盘
  AVATAR_TYPE           VARCHAR(20)                        -- 头像 MIME，由服务端按文件头判定，不取客户端声明
);
-- 手机号唯一（空串不算）：同一号不能绑两个人
CREATE UNIQUE INDEX IF NOT EXISTS uk_sys_user_mobile
  ON sys_user(MOBILE) WHERE MOBILE IS NOT NULL AND MOBILE != '';
-- 邮箱唯一（空串不算）：同一邮箱不能绑两个人
CREATE UNIQUE INDEX IF NOT EXISTS uk_sys_user_email
  ON sys_user(EMAIL) WHERE EMAIL IS NOT NULL AND EMAIL != '';

-- -----------------------------------------------------------------------------
-- user_settings 用户偏好（摊开原 sys_user.preferences JSON）
-- 本表无 DELETED_AT：随 sys_user 软删，读时以 sys_user 状态过滤。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_settings (
  USER_ID                    BIGINT NOT NULL PRIMARY KEY,  -- 主键即外键语义，逻辑引用 sys_user.id；行不存在时后端返回全默认值且不落库（惰性）
  CAMERA_DEVICE_ID           VARCHAR(128) DEFAULT '',      -- MediaStreamTrack.deviceId，128 而非 64 因为 Chrome 的值较长；换机器即失效
  MICROPHONE_DEVICE_ID       VARCHAR(128) DEFAULT '',      -- 同上，麦克风
  SPEAKER_DEVICE_ID          VARCHAR(128) DEFAULT '',      -- 同上，扬声器
  VIDEO_RESOLUTION           VARCHAR(16)  DEFAULT '1080p', -- 字典 video_resolution，作为采集约束的 ideal 值
  VIDEO_MAX_FPS              INT          DEFAULT 20,      -- 最大帧率 ideal 值
  VIDEO_TARGET_BITRATE_KBPS  INT          DEFAULT 0,       -- 0=自适应；其余为上限 Kbps，UI 偏好
  VB_MODE                    VARCHAR(16)  DEFAULT 'off',   -- 字典 vb_mode：off/blur/custom
  VB_CUSTOM_IMAGE_URL        VARCHAR(256) DEFAULT '',      -- 自定义背景图 URL，vb_mode=custom 时生效
  FACE_ENHANCEMENT           TINYINT      DEFAULT 0,       -- 浏览器端美颜开关
  CLOUD_RECORD_DEFAULT       TINYINT      DEFAULT 1,       -- 预约弹窗初始值，不覆盖用户当场改动
  RECORDING_QUALITY          VARCHAR(16)  DEFAULT 'high',  -- 字典 recording_quality
  RECORDING_FPS              INT          DEFAULT 30,      -- 本地录制画布帧率（25/30/60/120）；喂 trackRecorder 的 frameRate
  MIRROR_VIDEO               TINYINT      DEFAULT 1,       -- 视频镜像，前端 CSS transform 应用
  BG_BLUR                    TINYINT      DEFAULT 0,       -- 背景虚化；vb_mode 非 off 时以 vb_mode 为准
  MIC_VOLUME                 INT          DEFAULT 80,      -- 麦克风音量 0-100，前端 GainNode 应用
  AUTO_GAIN                  TINYINT      DEFAULT 1,       -- 映射 getUserMedia autoGainControl
  NOISE_SUPPRESSION          TINYINT      DEFAULT 1,       -- 映射 getUserMedia noiseSuppression
  RECORDING_SAVE_DIR         VARCHAR(256) DEFAULT '',      -- 本地录制保存目录的显示名；真实目录句柄在客户端 IndexedDB，本列仅回显
  CREATED_AT                 TIMESTAMP,                    -- gdb 自动维护
  UPDATED_AT                 TIMESTAMP                     -- gdb 自动维护
);

-- -----------------------------------------------------------------------------
-- meeting_appointment 预约单
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_appointment (
  ID                          INTEGER PRIMARY KEY AUTOINCREMENT, -- 自增主键；会话键依赖它是递增小整数（internal/session/registry.go）
  TITLE                       VARCHAR(256) NOT NULL,             -- 会议主题
  MEETING_NUMBER              VARCHAR(12),                       -- 〔历史列，不再生成〕曾是本地 6 位会议号；2026-10-10 起对外唯一入会号只认 THIRD_PARTY_MEETING_NUMBER，本列只留着读老数据
  THIRD_PARTY_MEETING_ID      VARCHAR(64),                       -- 三方返回的会议 id，回填即代表同步成功
  THIRD_PARTY_MEETING_NUMBER  VARCHAR(12),                       -- 三方 8 位会议号，入会/订阅以它为准
  STARTED_AT                  TIMESTAMP,                         -- 三方实测开会时刻（state.startedAtUnixMs 回填），会中时长以它为起点
  CREATOR_ID                  BIGINT NOT NULL,                   -- 预约人，逻辑引用 sys_user.id
  HOST_THIRD_PARTY_ACCOUNT    VARCHAR(64) NOT NULL,              -- 主持人三方账号，由登录用户映射自动填入
  START_TIME                  TIMESTAMP NOT NULL,                -- 预约开始时间
  DURATION_MINUTES            INT NOT NULL,                      -- 时长（分钟）
  CLOUD_RECORD                TINYINT DEFAULT 1,                 -- 本次预约的选择，与 user_settings.CLOUD_RECORD_DEFAULT 是"实值 vs 默认值"
  MUTE_ON_JOIN                TINYINT DEFAULT 0,                 -- 预约时设定的入会初始静音
  CAMERA_OFF_ON_JOIN          TINYINT DEFAULT 0,                 -- 预约时设定的入会初始关摄像头
  ALLOW_WAITING               TINYINT DEFAULT 0,                 -- 第 10 项：1=允许成员在主持人入会前等待。门禁在我方后端，等待队列是运行时状态不落库
  LAUNCH_KIND                 VARCHAR(16) DEFAULT '',            -- quick/scheduled/share/voice；空则列表侧按预约/快速推断
  LOCAL_STATUS                VARCHAR(16) DEFAULT 'pending',     -- 字典 local_sync_status：本系统与三方的同步态
  STATUS                      VARCHAR(16) DEFAULT 'scheduled',   -- 字典 meeting_status：scheduled/starting/running/ended/failed/cancelled
  CREATED_AT                  TIMESTAMP,                         -- gdb 自动维护
  UPDATED_AT                  TIMESTAMP,                         -- gdb 自动维护
  DELETED_AT                  TIMESTAMP                          -- 软删除时间戳（第 6 项：可取消不可删除，这一列是"取消/撤销日程"不是物理删）
);

-- -----------------------------------------------------------------------------
-- meeting_participant 受邀名单
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_participant (
  ID             INTEGER PRIMARY KEY AUTOINCREMENT, -- 自增主键
  APPOINTMENT_ID BIGINT NOT NULL,                   -- 逻辑引用 meeting_appointment.id；删预约须同事务删本表（无级联外键）
  USER_ID        BIGINT NOT NULL,                   -- 逻辑引用 sys_user.id
  CREATED_AT     TIMESTAMP,                         -- gdb 自动维护
  UPDATED_AT     TIMESTAMP,                         -- gdb 自动维护
  DELETED_AT     TIMESTAMP                          -- 软删除时间戳。(APPOINTMENT_ID,USER_ID) 组合唯一性由应用层保证
);

-- -----------------------------------------------------------------------------
-- recording_deleted 录制压制表（我方自己的账，不改上游语义、不向上游造行）
-- 列刻意不叫 deleted_at：那会被 gdb 当逻辑删除列，查询自动加 WHERE 把压制行全滤掉。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recording_deleted (
  RECORDING_ID    VARCHAR(128) NOT NULL PRIMARY KEY, -- 三方 recordings[].recordingId 原样（实测达 88 字符，故 128 不是 64）；有行即压制
  MEETING_ID      VARCHAR(64),                       -- 该录制所属三方会议 id，仅作排查线索；读列表只按 recording_id 判定
  SUPPRESSED_AT   TIMESTAMP                          -- 本侧登记压制的时刻（不是三方的删除时刻，孤儿行三方从未删成）；代码显式写
);

-- -----------------------------------------------------------------------------
-- meeting_deleted 会议压制表（三方没有"删除会议"这个动作，取消/停止只会变 ended 留在列表里）
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_deleted (
  MEETING_ID      VARCHAR(64) NOT NULL PRIMARY KEY, -- 三方 meetings[].meetingId 原样
  MEETING_NUMBER  VARCHAR(32),                      -- 该场的三方会议号，仅作排查线索（号是拨号用的，不保证一场一号）
  APPOINTMENT_ID  BIGINT,                           -- 本侧被取消的预约单 id，仅作线索（预约单是软删，行还在）
  SUPPRESSED_AT   TIMESTAMP                         -- 本侧登记压制的时刻；代码显式写
);

-- -----------------------------------------------------------------------------
-- meeting_attendance 参会历史（第 5 项「加入过的会也要在列表」的唯一真源）
-- 三方列表按主持人过滤看不见别人主持的会，受邀名单又不等于实际参加过。
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meeting_attendance (
  ID              INTEGER PRIMARY KEY AUTOINCREMENT, -- 自增主键
  MEETING_ID      VARCHAR(64) NOT NULL,              -- 三方 meetingId，一场会的稳定身份
  MEETING_NUMBER  VARCHAR(32),                       -- 该场三方会议号，供日程按号对齐本地预约单
  APPOINTMENT_ID  BIGINT,                            -- 本库预约单 id，可空：三方直接发起的会本库没有预约单
  USER_ID         BIGINT NOT NULL,                   -- 逻辑引用 sys_user.id（无级联外键）
  FIRST_JOINED_AT TIMESTAMP,                         -- 第一次成功入会时刻；代码显式写
  LAST_JOINED_AT  TIMESTAMP,                         -- 最近一次成功入会时刻，日程排序与"最近加入"用它
  JOIN_COUNT      INTEGER DEFAULT 1                  -- 成功入会次数（含中途退会再入）
);

-- (meeting_id,user_id) 唯一：重复入会只把 LAST_JOINED_AT 与 JOIN_COUNT 往前推。
-- 达梦那版是 ALTER TABLE ADD CONSTRAINT（alter_20260929b.sql），SQLite 不支持该语法，等价写作唯一索引。
CREATE UNIQUE INDEX IF NOT EXISTS uk_meeting_attendance ON meeting_attendance (MEETING_ID, USER_ID);

-- =============================================================================
-- 种子数据
-- 全部 INSERT OR IGNORE + 显式主键，所以本文件可重复执行。
-- 口令列一律留空串：真实口令只由 gitignore 的 seed-credentials.sql 注入。
-- =============================================================================

-- sys_dict_type（7 类）
INSERT OR IGNORE INTO sys_dict_type (DICT_TYPE, DICT_NAME, STATUS, REMARK) VALUES
  ('account_type',      '三方账号类型', 1, '取值域真源：shared/contracts/edge-to-cloud/EXTERNAL_HTTPS_CONFERENCE_API_20260907.md 权限节'),
  ('position',          '职位',         1, '人员主数据；当前在本仓字典表是有主的权宜，定义权待 cloud/device-registry 建成后上收'),
  ('meeting_status',    '会议运行状态', 1, '取值域真源：shared/contracts/edge-to-cloud/EXTERNAL_HTTPS_CONFERENCE_API_20260907.md'),
  ('local_sync_status', '本地同步状态', 1, '本单元自有；描述与三方的同步态'),
  ('recording_quality', '录制质量',     1, '本单元自有的 UI 偏好；三方不感知'),
  ('video_resolution',  '视频分辨率',   1, '本单元自有的 UI 偏好；作为浏览器 MediaStream 采集约束的 ideal 值'),
  ('vb_mode',           '虚拟背景模式', 1, '本单元自有的 UI 偏好；浏览器端处理');

-- sys_dict_data（显式 ID 1..29，保证可重复执行且不插重）
-- 旧 DM 版 create.sql 那句注释写着「32 行」、字典类别写着「8 类」，都是数错的：
-- 实际按 3+8+6+3+3+3+3 = 29 行、7 类。这里以逐行数出来的数为准，不延续错口径。
INSERT OR IGNORE INTO sys_dict_data (ID, DICT_TYPE, DICT_VALUE, DICT_LABEL, SORT, TAG_TYPE, REMARK) VALUES
  (1,  'account_type',      'meeting_participant', '普通用户',     1, 'info',    '普通注册用户'),
  (2,  'account_type',      'device_admin',        '设备管理员',   2, 'primary', '本账号设备范围内的会议管理'),
  (3,  'account_type',      'super_admin',         '超级管理员',   3, 'danger',  '全部设备的会议管理'),
  (30, 'account_type',      'temp_user',           '临时用户',     4, 'warning', '面试等场景临时注册'),
  (4,  'position',          'captain',             '船长',         1, NULL,      '船端'),
  (5,  'position',          'chief_officer',       '大副',         2, NULL,      '船端'),
  (6,  'position',          'shore_dispatcher',    '岸端调度员',   3, NULL,      '岸端调度中心'),
  (7,  'position',          'shore_duty',          '岸端值班员',   4, NULL,      '岸端调度中心'),
  (8,  'position',          'comms_engineer',      '通信工程师',   5, NULL,      '技术保障部'),
  (9,  'position',          'tech_supervisor',     '技术主管',     6, NULL,      '技术保障部'),
  (10, 'position',          'dispatch_director',   '调度主任',     7, NULL,      '岸端调度中心'),
  (11, 'position',          'tech_engineer',       '技术工程师',   8, NULL,      '技术保障部'),
  (12, 'meeting_status',    'scheduled',           '待开始',       1, 'info',    NULL),
  (13, 'meeting_status',    'starting',            '启动中',       2, 'warning', NULL),
  (14, 'meeting_status',    'running',             '进行中',       3, 'success', NULL),
  (15, 'meeting_status',    'ended',               '已结束',       4, 'info',    NULL),
  (16, 'meeting_status',    'failed',              '启动失败',     5, 'danger',  NULL),
  (17, 'meeting_status',    'cancelled',           '已取消',       6, 'info',    NULL),
  (18, 'local_sync_status', 'pending',             '待同步',       1, 'warning', NULL),
  (19, 'local_sync_status', 'synced',              '已同步',       2, 'success', NULL),
  (20, 'local_sync_status', 'failed',              '同步失败',     3, 'danger',  NULL),
  (21, 'recording_quality', 'high',                '高',           1, NULL,      NULL),
  (22, 'recording_quality', 'medium',              '中',           2, NULL,      NULL),
  (23, 'recording_quality', 'low',                 '低',           3, NULL,      NULL),
  (24, 'video_resolution',  '480p',                '标清 480p',    1, NULL,      NULL),
  (25, 'video_resolution',  '720p',                '高清 720p',    2, NULL,      NULL),
  (26, 'video_resolution',  '1080p',               '全高清 1080p', 3, NULL,      NULL),
  (27, 'vb_mode',           'off',                 '关闭',         1, NULL,      NULL),
  (28, 'vb_mode',           'blur',                '背景虚化',     2, NULL,      NULL),
  (29, 'vb_mode',           'custom',              '自定义图片',   3, NULL,      NULL);

-- sys_dept（3 行）
INSERT OR IGNORE INTO sys_dept (ID, NAME, SORT) VALUES
  (1, '岸端调度中心', 1),
  (2, '技术保障部',   2),
  (3, '远洋8号',      3);

-- sys_user（6 行；与三方 6 个账号一一对应，见 docs/三方系统管理员账号.md）
-- 显式 ID 1..6：下面 user_settings 的种子按 user_id 1/2/3 写，对应关系必须钉死，
-- 不能再像 DM 版那样靠 IDENTITY 恰好从 1 连续分配。
-- PASSWORD / THIRD_PARTY_PASSWORD 留空串，真值由 gitignore 的 seed-credentials.sql 注入。
INSERT OR IGNORE INTO sys_user
  (ID, USERNAME, PASSWORD, DISPLAY_NAME, THIRD_PARTY_ACCOUNT, THIRD_PARTY_PASSWORD, ACCOUNT_TYPE, POSITION_CODE)
VALUES
  (1, 'admin',     '', '系统管理员', 'rk3588bj',      '', 'super_admin',         'tech_supervisor'),
  (2, 'zhangming', '', '张明',      'rk3588zwtship', '', 'device_admin',        'dispatch_director'),
  (3, 'liwei',     '', '李伟',      'rk3588bj2',     '', 'meeting_participant', 'tech_engineer'),
  (4, 'wangqiang', '', '王强',      'rk3588gzst',    '', 'meeting_participant', 'shore_duty'),
  (5, 'zhaohai',   '', '赵海',      'rk3588bj3',     '', 'meeting_participant', 'chief_officer'),
  (6, 'chenfang',  '', '陈芳',      'rk3588bj4',     '', 'meeting_participant', 'captain');

-- user_settings（3 行；设备 id 均为默认空串）
INSERT OR IGNORE INTO user_settings
  (USER_ID, VIDEO_RESOLUTION, VIDEO_MAX_FPS, VIDEO_TARGET_BITRATE_KBPS, VB_MODE, FACE_ENHANCEMENT, CLOUD_RECORD_DEFAULT, RECORDING_QUALITY)
VALUES
  (1, '1080p', 30, 0, 'off',  0, 1, 'high'),
  (2, '1080p', 30, 0, 'off',  0, 1, 'high'),
  (3, '720p',  15, 300, 'blur', 1, 1, 'medium');
