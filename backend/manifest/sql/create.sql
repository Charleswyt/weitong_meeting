-- =============================================================================
-- 视频会议系统 —— 达梦 DM8 建表 + 种子数据
--
-- 执行前提：先以 SYSDBA 跑 `bootstrap.sql` 建 CONFERENCE 用户/模式；再以 CONFERENCE
-- 用户跑本脚本。步骤与踩过的坑见同目录 README.md。
--
-- 本单元约定（**与其他单元不同**，别当"忘了加"去补）：
--   1. **不建外键**（`FOREIGN KEY`）。跨表关系靠应用层维护；删预约须同事务删参会人。
--   2. **不建唯一约束**（`UNIQUE`）。PK 除外。用户名/会议号/预约-联系人组合的唯一性
--      由 service 层校验；一旦加"新建用户"入口必须补查重，否则同名会静默命中错误用户。
--   3. **不建二级索引**（`CREATE INDEX`）。PK 支撑的隐式索引保留。数据量小 + 边端资源紧，
--      字典靠 `gcache` 缓存而不是 DB 索引。这与 `edge/fence/backend/manifest/sql/0002_create_indexes.sql`
--      的做法相反。
--   4. **每张表每一列都有 `COMMENT ON`**。GoFrame 的 `gf gen dao` 读 DB 注释写进 entity 的 GoDoc，
--      所以注释要在 DDL 里落，不要事后在 Go 里手工补。
--   5. 本脚本为**开发期全量重建**：前导 `DROP TABLE IF EXISTS`，跑失败人工介入。
--      DM8 支持 `DROP ... IF EXISTS`，但**不支持** `CREATE TABLE IF NOT EXISTS`。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. 幂等前导（按引用倒序删；无 FK 所以顺序也不敏感，但这样更清晰）
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS recording_deleted;
DROP TABLE IF EXISTS meeting_participant;
DROP TABLE IF EXISTS meeting_appointment;
DROP TABLE IF EXISTS sys_contact;
DROP TABLE IF EXISTS user_settings;
DROP TABLE IF EXISTS sys_user;
DROP TABLE IF EXISTS sys_dept;
DROP TABLE IF EXISTS sys_dict_data;
DROP TABLE IF EXISTS sys_dict_type;

-- -----------------------------------------------------------------------------
-- 1. sys_dict_type —— 字典类型表
-- -----------------------------------------------------------------------------
CREATE TABLE sys_dict_type (
    dict_type   VARCHAR(64)  NOT NULL PRIMARY KEY,
    dict_name   VARCHAR(64)  NOT NULL,
    status      TINYINT      DEFAULT 1,
    remark      VARCHAR(256) DEFAULT NULL,
    created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    deleted_at  TIMESTAMP    DEFAULT NULL
);
COMMENT ON TABLE  sys_dict_type             IS '字典类型表：所有受管枚举的目录，一行一个枚举类别';
COMMENT ON COLUMN sys_dict_type.dict_type   IS '枚举类别编码（如 position/meeting_status），全仓唯一由应用层保证；业务表以此+dict_value 定位';
COMMENT ON COLUMN sys_dict_type.dict_name   IS '类别显示名';
COMMENT ON COLUMN sys_dict_type.status      IS '1 启用 0 停用；停用只隐藏取值不删数据';
COMMENT ON COLUMN sys_dict_type.remark      IS '归属与取值域真源出处';
COMMENT ON COLUMN sys_dict_type.created_at  IS '创建时间，GoFrame 自动维护';
COMMENT ON COLUMN sys_dict_type.updated_at  IS '更新时间，GoFrame 自动维护';
COMMENT ON COLUMN sys_dict_type.deleted_at  IS '软删除时间戳，非空即视为删除';

-- -----------------------------------------------------------------------------
-- 2. sys_dict_data —— 字典数据表
-- -----------------------------------------------------------------------------
CREATE TABLE sys_dict_data (
    id          BIGINT IDENTITY(1,1) PRIMARY KEY,
    dict_type   VARCHAR(64)  NOT NULL,
    dict_value  VARCHAR(64)  NOT NULL,
    dict_label  VARCHAR(64)  NOT NULL,
    sort        INT          DEFAULT 0,
    status      TINYINT      DEFAULT 1,
    tag_type    VARCHAR(16)  DEFAULT NULL,
    remark      VARCHAR(256) DEFAULT NULL,
    created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    deleted_at  TIMESTAMP    DEFAULT NULL
);
COMMENT ON TABLE  sys_dict_data             IS '字典数据表：用 dict_type 判别的全部枚举取值';
COMMENT ON COLUMN sys_dict_data.id          IS '自增主键';
COMMENT ON COLUMN sys_dict_data.dict_type   IS '所属枚举类别（逻辑引用 sys_dict_type.dict_type，无 DB 外键）';
COMMENT ON COLUMN sys_dict_data.dict_value  IS '落库的规范值，业务表存这一列；(dict_type,dict_value) 组合唯一由应用层保证';
COMMENT ON COLUMN sys_dict_data.dict_label  IS '给人看的展示名';
COMMENT ON COLUMN sys_dict_data.sort        IS '下拉与展示顺序';
COMMENT ON COLUMN sys_dict_data.status      IS '1 可见 0 隐藏（隐藏不等于删除，历史数据仍能反查 label）';
COMMENT ON COLUMN sys_dict_data.tag_type    IS '前端 el-tag 语义色 success/info/warning/danger，替代组件里硬写的 switch';
COMMENT ON COLUMN sys_dict_data.remark      IS '取值域真源出处或特殊说明';
COMMENT ON COLUMN sys_dict_data.created_at  IS '创建时间，GoFrame 自动维护';
COMMENT ON COLUMN sys_dict_data.updated_at  IS '更新时间，GoFrame 自动维护';
COMMENT ON COLUMN sys_dict_data.deleted_at  IS '软删除时间戳';

-- -----------------------------------------------------------------------------
-- 3. sys_dept —— 组织机构
-- -----------------------------------------------------------------------------
CREATE TABLE sys_dept (
    id          BIGINT IDENTITY(1,1) PRIMARY KEY,
    name        VARCHAR(64)  NOT NULL,
    sort        INT          DEFAULT 0,
    status      TINYINT      DEFAULT 1,
    created_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    deleted_at  TIMESTAMP    DEFAULT NULL
);
COMMENT ON TABLE  sys_dept             IS '组织机构（岸端中心 / 技术保障部 / 船端）';
COMMENT ON COLUMN sys_dept.id          IS '自增主键';
COMMENT ON COLUMN sys_dept.name        IS '部门名称；不同船可能同名，故不加唯一约束';
COMMENT ON COLUMN sys_dept.sort        IS '展示顺序';
COMMENT ON COLUMN sys_dept.status      IS '1 正常 0 停用';
COMMENT ON COLUMN sys_dept.created_at  IS '创建时间';
COMMENT ON COLUMN sys_dept.updated_at  IS '更新时间';
COMMENT ON COLUMN sys_dept.deleted_at  IS '软删除时间戳';

-- -----------------------------------------------------------------------------
-- 4. sys_user —— 本地登录用户
-- -----------------------------------------------------------------------------
CREATE TABLE sys_user (
    id                    BIGINT IDENTITY(1,1) PRIMARY KEY,
    username              VARCHAR(64)  NOT NULL,
    password              VARCHAR(128) NOT NULL,
    display_name          VARCHAR(64)  NOT NULL,
    avatar                VARCHAR(256) DEFAULT NULL,
    avatar_data           BLOB         DEFAULT NULL,
    avatar_type           VARCHAR(20)  DEFAULT NULL,
    third_party_account   VARCHAR(64)  NOT NULL,
    third_party_password  VARCHAR(128) NOT NULL,
    account_type          VARCHAR(32)  DEFAULT 'meeting_participant',
    position_code         VARCHAR(64)  DEFAULT NULL,
    status                TINYINT      DEFAULT 1,
    created_at            TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at            TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    deleted_at            TIMESTAMP    DEFAULT NULL
);
COMMENT ON TABLE  sys_user                          IS '本地登录用户；权限只由 account_type 决定，与三方 1:1';
COMMENT ON COLUMN sys_user.id                       IS '自增主键';
COMMENT ON COLUMN sys_user.username                 IS '登录名；唯一性在应用层校验，无 DB 约束（本单元约定）。一旦加"新建用户"入口必须补查重';
COMMENT ON COLUMN sys_user.password                 IS '本地口令，当前明文过渡，SM2 适配层接入后改哈希';
COMMENT ON COLUMN sys_user.display_name             IS '入会与界面展示名，唯一真源（user_settings 不再存 displayName）';
COMMENT ON COLUMN sys_user.avatar                   IS '头像 API 路径 /api/v1/users/{id}/avatar（派生值，字节在 AVATAR_DATA、类型在 AVATAR_TYPE）；无头像为 NULL';
COMMENT ON COLUMN sys_user.avatar_data              IS '头像二进制字节（PNG/JPEG/WebP），自 2026-09-28 起这里是头像唯一真源，不再落本地文件盘';
COMMENT ON COLUMN sys_user.avatar_type              IS '头像 MIME 类型（image/png、image/jpeg、image/webp），由服务端按文件头判定，不取客户端声明';
COMMENT ON COLUMN sys_user.third_party_account      IS '映射到三方平台的账号名';
COMMENT ON COLUMN sys_user.third_party_password     IS '三方口令，当前明文存储为已知待办（凭据只走 .env 的例外：这里按用户一行、需要后台可查）';
COMMENT ON COLUMN sys_user.account_type             IS '字典 account_type：meeting_participant/device_admin/super_admin；登录时用三方 AuthResult.AccountType 回写';
COMMENT ON COLUMN sys_user.position_code            IS '字典 position；人员主数据，当前在本仓字典表是有主的权宜，定义权待 cloud/device-registry 建成后上收';
COMMENT ON COLUMN sys_user.status                   IS '1 启用 0 禁用';
COMMENT ON COLUMN sys_user.created_at               IS '创建时间';
COMMENT ON COLUMN sys_user.updated_at               IS '更新时间';
COMMENT ON COLUMN sys_user.deleted_at               IS '软删除时间戳';

-- -----------------------------------------------------------------------------
-- 5. user_settings —— 用户偏好（原 sys_user.preferences JSON 摊平而来）
-- -----------------------------------------------------------------------------
CREATE TABLE user_settings (
    user_id                    BIGINT       NOT NULL PRIMARY KEY,
    camera_device_id           VARCHAR(128) DEFAULT '',
    microphone_device_id       VARCHAR(128) DEFAULT '',
    speaker_device_id          VARCHAR(128) DEFAULT '',
    video_resolution           VARCHAR(16)  DEFAULT '1080p',
    video_max_fps              INT          DEFAULT 20,
    video_target_bitrate_kbps  INT          DEFAULT 0,
    vb_mode                    VARCHAR(16)  DEFAULT 'off',
    vb_custom_image_url        VARCHAR(256) DEFAULT '',
    face_enhancement           TINYINT      DEFAULT 0,
    cloud_record_default       TINYINT      DEFAULT 1,
    recording_quality          VARCHAR(16)  DEFAULT 'high',
    mirror_video               TINYINT      DEFAULT 1,
    bg_blur                    TINYINT      DEFAULT 0,
    mic_volume                 INT          DEFAULT 80,
    auto_gain                  TINYINT      DEFAULT 1,
    noise_suppression          TINYINT      DEFAULT 1,
    recording_save_dir         VARCHAR(256) DEFAULT '',
    created_at                 TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at                 TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE  user_settings                              IS '用户偏好，一用户一行（1:1）；原先 sys_user.preferences 的 JSON 摊平而来';
COMMENT ON COLUMN user_settings.user_id                      IS '主键即外键语义，逻辑引用 sys_user.id；无 DB 外键；行不存在时后端返回全默认值且不落库（惰性）';
COMMENT ON COLUMN user_settings.camera_device_id             IS '浏览器 MediaStreamTrack.deviceId，128 而非 64 因为 Chrome 值较长；换机器即失效故仅作偏好';
COMMENT ON COLUMN user_settings.microphone_device_id         IS '同上，麦克风 deviceId';
COMMENT ON COLUMN user_settings.speaker_device_id            IS '同上，扬声器 deviceId';
COMMENT ON COLUMN user_settings.video_resolution             IS '字典 video_resolution：480p/720p/1080p，作为采集约束的 ideal 值';
COMMENT ON COLUMN user_settings.video_max_fps                IS '最大帧率，作为采集约束的 ideal 值';
COMMENT ON COLUMN user_settings.video_target_bitrate_kbps    IS '0=自适应；其余为上限 Kbps，UI 偏好';
COMMENT ON COLUMN user_settings.vb_mode                      IS '字典 vb_mode：off/blur/custom';
COMMENT ON COLUMN user_settings.vb_custom_image_url          IS '自定义背景图 URL，vb_mode=custom 时生效';
COMMENT ON COLUMN user_settings.face_enhancement             IS '浏览器端美颜开关：1 开 0 关';
COMMENT ON COLUMN user_settings.cloud_record_default         IS '预约弹窗初始值，不覆盖用户当场改动：1 默认开 0 默认关';
COMMENT ON COLUMN user_settings.recording_quality            IS '字典 recording_quality：high/medium/low';
COMMENT ON COLUMN user_settings.mirror_video                 IS '视频镜像开关：1 开 0 关，前端 CSS transform 应用';
COMMENT ON COLUMN user_settings.bg_blur                      IS '背景虚化开关：1 开 0 关；vb_mode 非 off 时以 vb_mode 为准';
COMMENT ON COLUMN user_settings.mic_volume                   IS '麦克风音量 0-100，前端 GainNode 应用';
COMMENT ON COLUMN user_settings.auto_gain                    IS '自动增益：映射 getUserMedia autoGainControl';
COMMENT ON COLUMN user_settings.noise_suppression            IS '降噪：映射 getUserMedia noiseSuppression';
COMMENT ON COLUMN user_settings.recording_save_dir           IS '本地录制保存目录的显示名；真实目录句柄存客户端 IndexedDB，本列仅回显';
COMMENT ON COLUMN user_settings.created_at                   IS '创建时间';
COMMENT ON COLUMN user_settings.updated_at                   IS '更新时间。本表无 deleted_at：随 sys_user 软删，读时以 sys_user 状态过滤';

-- -----------------------------------------------------------------------------
-- 6. meeting_appointment —— 会议预约单
-- -----------------------------------------------------------------------------
CREATE TABLE meeting_appointment (
    id                        BIGINT IDENTITY(1,1) PRIMARY KEY,
    title                     VARCHAR(256) NOT NULL,
    meeting_number            VARCHAR(12)  DEFAULT NULL,
    third_party_meeting_id    VARCHAR(64)  DEFAULT NULL,
    third_party_meeting_number VARCHAR(12) DEFAULT NULL,
    started_at                TIMESTAMP    DEFAULT NULL,
    creator_id                BIGINT       NOT NULL,
    host_third_party_account  VARCHAR(64)  NOT NULL,
    start_time                TIMESTAMP    NOT NULL,
    duration_minutes          INT          NOT NULL,
    cloud_record              TINYINT      DEFAULT 1,
    mute_on_join              TINYINT      DEFAULT 0,
    camera_off_on_join        TINYINT      DEFAULT 0,
    allow_waiting             TINYINT      DEFAULT 0,
    launch_kind               VARCHAR(16)  DEFAULT '',
    local_status              VARCHAR(16)  DEFAULT 'pending',
    status                    VARCHAR(16)  DEFAULT 'scheduled',
    created_at                TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    updated_at                TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
    deleted_at                TIMESTAMP    DEFAULT NULL
);
COMMENT ON TABLE  meeting_appointment                            IS '会议预约单，本系统的控制面记录；真源仍在三方平台';
COMMENT ON COLUMN meeting_appointment.id                         IS '自增主键';
COMMENT ON COLUMN meeting_appointment.title                      IS '会议主题';
COMMENT ON COLUMN meeting_appointment.meeting_number             IS '会议号，crypto/rand 6 位；无唯一约束故允许极小概率重复，前端以 id 为准';
COMMENT ON COLUMN meeting_appointment.third_party_meeting_id     IS '三方返回的会议 id，回填即代表同步成功';
COMMENT ON COLUMN meeting_appointment.third_party_meeting_number IS '三方生成的 8 位会议号，入会/订阅以它为准（本系统 meeting_number 仅本地展示与查询）';
COMMENT ON COLUMN meeting_appointment.started_at                 IS '三方实测开会时刻（state.startedAtUnixMs 回填），会中时长以它为起点';
COMMENT ON COLUMN meeting_appointment.creator_id                 IS '预约人，逻辑引用 sys_user.id';
COMMENT ON COLUMN meeting_appointment.host_third_party_account   IS '主持人三方账号，登录用户映射的 third_party_account 自动填入';
COMMENT ON COLUMN meeting_appointment.start_time                 IS '开始时间';
COMMENT ON COLUMN meeting_appointment.duration_minutes           IS '时长（分钟）';
COMMENT ON COLUMN meeting_appointment.cloud_record               IS '本次预约的选择，与 user_settings.cloud_record_default 是"实值 vs 默认值"的关系';
COMMENT ON COLUMN meeting_appointment.local_status               IS '字典 local_sync_status：pending/synced/failed，本系统与三方的同步态';
COMMENT ON COLUMN meeting_appointment.status                     IS '字典 meeting_status：scheduled/starting/running/ended/failed/cancelled';
COMMENT ON COLUMN meeting_appointment.created_at                 IS '创建时间';
COMMENT ON COLUMN meeting_appointment.updated_at                 IS '更新时间';
COMMENT ON COLUMN meeting_appointment.deleted_at                 IS '软删除时间戳';

-- -----------------------------------------------------------------------------
-- 8. meeting_participant —— 预约与参会人关联（多对多桥表）
-- -----------------------------------------------------------------------------
CREATE TABLE meeting_participant (
    id              BIGINT IDENTITY(1,1) PRIMARY KEY,
    appointment_id  BIGINT    NOT NULL,
    user_id         BIGINT    NOT NULL,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at      TIMESTAMP DEFAULT NULL
);
COMMENT ON TABLE  meeting_participant                IS '预约与参会人的关联（多对多桥表）';
COMMENT ON COLUMN meeting_participant.id             IS '自增主键';
COMMENT ON COLUMN meeting_participant.appointment_id IS '逻辑引用 meeting_appointment.id；删预约须同事务删本表（无级联外键）';
COMMENT ON COLUMN meeting_participant.user_id        IS '逻辑引用 sys_user.id';
COMMENT ON COLUMN meeting_participant.created_at     IS '创建时间';
COMMENT ON COLUMN meeting_participant.updated_at     IS '更新时间';
COMMENT ON COLUMN meeting_participant.deleted_at     IS '软删除时间戳。(appointment_id, user_id) 组合唯一性由应用层保证';

-- -----------------------------------------------------------------------------
-- 9. recording_deleted —— 录制压制表（本侧的账，不落三方语义）
--    列名刻意**不叫** deleted_at：达梦侧走 GoFrame gdb，`deleted_at` 会被识别为逻辑删除列，
--    于是 SELECT 自动加 `WHERE DELETED_AT IS NULL`、DELETE 自动变 UPDATE —— 与本表语义正好相反
--    （有行 = 压制，不是"这行已删"）。实测踩过：14 条压制行插进去了但列表读不到。
-- -----------------------------------------------------------------------------
CREATE TABLE recording_deleted (
    recording_id    VARCHAR(128) NOT NULL PRIMARY KEY,
    meeting_id      VARCHAR(64)  DEFAULT NULL,
    suppressed_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE  recording_deleted                IS '录制压制表：用户在本页面删过的 recordingId 在此留一行，/recordings/list 与 playback 出口据此剔条目。三方 recordings[] 有删不掉的孤儿行（其 meetingId 上游已无会议、整场 DELETE 回 409 meeting_not_found、状态又不是 media_deleted 所以过不了列表过滤 —— 实测那条报 ready/198KB），只靠上游清理做不到"删了就不再出现"，故本表是我方自己的账，不改上游语义、不向上游造行';
COMMENT ON COLUMN recording_deleted.recording_id   IS '三方 recordings[].recordingId 原样（实测 rec_pub_meeting_…_participant_…_pub_… 达 88 字符，故 128 不是 64）；有行即压制，主键天然去重（本单元不建 UNIQUE 约束的约定对 PK 除外）';
COMMENT ON COLUMN recording_deleted.meeting_id     IS '该录制所属三方会议 id，仅作排查线索：删除是整场粒度，同场其它 recordingId 也各写一行；读列表只按 recording_id 判定，不靠它反查会议是否还在';
COMMENT ON COLUMN recording_deleted.suppressed_at  IS '本侧登记压制的时刻（不是三方的删除时刻，孤儿行三方从未删成）。刻意不叫 deleted_at：那会被 GoFrame gdb 当逻辑删除列，查询会自动加 WHERE DELETED_AT IS NULL 把压制行全滤掉。恢复某条 = 物理删这一行，当前无恢复入口';

-- -----------------------------------------------------------------------------
-- 10. meeting_deleted —— 会议压制表（本侧的账）
--     删一场会要先在三方侧把它停掉（见 MeetingService.Delete），但**停了它仍留在三方列表里**，
--     只是状态变 ended（实测 84312157/63358347…：本地删除后三方照旧报 ended、照样上日程），
--     所以"删了就不再出现"这一条只能靠本表登记，不能指望上游清理。
--     主键取三方 meetingId 而不是会议号：meetingId 才是"那一场会"的标识，日程合并也是按它对齐的；
--     会议号是给人拨号用的，只留作排查线索。
--     列名同样刻意**不叫** deleted_at（逻辑删除列陷阱，见第 9 节说明）。
-- -----------------------------------------------------------------------------
CREATE TABLE meeting_deleted (
    meeting_id      VARCHAR(64) NOT NULL PRIMARY KEY,
    meeting_number  VARCHAR(32) DEFAULT NULL,
    appointment_id  BIGINT      DEFAULT NULL,
    suppressed_at   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE  meeting_deleted               IS '会议压制表：本侧删过的会（按三方 meetingId）在此留一行，日程合并时据此剔掉上游仍报着的那一场。三方没有"删除会议"这个动作，取消/停止只会把它变成 ended 留在列表里（实测 17 条已删预约中 16 条至今仍可见，含 92323537 报 scheduled），所以这张表是我方自己的账，不改上游语义、也不向上游造行';
COMMENT ON COLUMN meeting_deleted.meeting_id    IS '三方 meetings[].meetingId 原样（实测 meeting_1790527565_0xx8arRt 27 字符）；有行即压制，主键天然去重';
COMMENT ON COLUMN meeting_deleted.meeting_number IS '该场的三方会议号，仅作排查线索：读列表不按号判定（号是拨号用的，不保证一场一号）';
COMMENT ON COLUMN meeting_deleted.appointment_id IS '本侧被删除的预约单 id，仅作排查线索（预约单是软删，行还在 meeting_appointment 里可回查）';
COMMENT ON COLUMN meeting_deleted.suppressed_at  IS '本侧登记压制的时刻。刻意不叫 deleted_at：那会被 GoFrame gdb 当逻辑删除列，查询会自动加 WHERE DELETED_AT IS NULL 把压制行全滤掉。恢复某条 = 物理删这一行，当前无恢复入口';

-- =============================================================================
-- 字典与业务种子数据
-- =============================================================================
-- sys_dict_type（8 类）
INSERT INTO sys_dict_type (dict_type, dict_name, status, remark) VALUES
  ('account_type',          '三方账号类型',   1, '取值域真源：shared/contracts/edge-to-cloud/EXTERNAL_HTTPS_CONFERENCE_API_20260907.md 权限节'),
  ('position',              '职位',           1, '人员主数据；当前在本仓字典表是有主的权宜，定义权待 cloud/device-registry 建成后上收'),
  ('meeting_status',        '会议运行状态',   1, '取值域真源：shared/contracts/edge-to-cloud/EXTERNAL_HTTPS_CONFERENCE_API_20260907.md'),
  ('local_sync_status',     '本地同步状态',   1, '本单元自有；描述与三方的同步态'),
  ('recording_quality',     '录制质量',       1, '本单元自有的 UI 偏好；三方不感知'),
  ('video_resolution',      '视频分辨率',     1, '本单元自有的 UI 偏好；作为浏览器 MediaStream 采集约束的 ideal 值'),
  ('vb_mode',               '虚拟背景模式',   1, '本单元自有的 UI 偏好；浏览器端处理');

-- sys_dict_data (32 行)
INSERT INTO sys_dict_data (dict_type, dict_value, dict_label, sort, tag_type, remark) VALUES
  ('account_type', 'meeting_participant', '普通用户',   1, 'info',    '普通注册用户'),
  ('account_type', 'device_admin',        '设备管理员', 2, 'primary', '本账号设备范围内的会议管理'),
  ('account_type', 'super_admin',         '超级管理员', 3, 'danger',  '全部设备的会议管理'),
  ('account_type', 'temp_user',           '临时用户',   4, 'warning', '面试等场景临时注册');

INSERT INTO sys_dict_data (dict_type, dict_value, dict_label, sort, remark) VALUES
  ('position', 'captain',          '船长',       1, '船端'),
  ('position', 'chief_officer',    '大副',       2, '船端'),
  ('position', 'shore_dispatcher', '岸端调度员', 3, '岸端调度中心'),
  ('position', 'shore_duty',       '岸端值班员', 4, '岸端调度中心'),
  ('position', 'comms_engineer',   '通信工程师', 5, '技术保障部'),
  ('position', 'tech_supervisor',  '技术主管',   6, '技术保障部'),
  ('position', 'dispatch_director','调度主任',   7, '岸端调度中心'),
  ('position', 'tech_engineer',    '技术工程师', 8, '技术保障部');

INSERT INTO sys_dict_data (dict_type, dict_value, dict_label, sort, tag_type) VALUES
  ('meeting_status', 'scheduled', '待开始',   1, 'info'),
  ('meeting_status', 'starting',  '启动中',   2, 'warning'),
  ('meeting_status', 'running',   '进行中',   3, 'success'),
  ('meeting_status', 'ended',     '已结束',   4, 'info'),
  ('meeting_status', 'failed',    '启动失败', 5, 'danger'),
  ('meeting_status', 'cancelled', '已取消',   6, 'info');

INSERT INTO sys_dict_data (dict_type, dict_value, dict_label, sort, tag_type) VALUES
  ('local_sync_status', 'pending', '待同步',   1, 'warning'),
  ('local_sync_status', 'synced',  '已同步',   2, 'success'),
  ('local_sync_status', 'failed',  '同步失败', 3, 'danger');

INSERT INTO sys_dict_data (dict_type, dict_value, dict_label, sort) VALUES
  ('recording_quality', 'high',   '高', 1),
  ('recording_quality', 'medium', '中', 2),
  ('recording_quality', 'low',    '低', 3);

INSERT INTO sys_dict_data (dict_type, dict_value, dict_label, sort) VALUES
  ('video_resolution', '480p',  '标清 480p',    1),
  ('video_resolution', '720p',  '高清 720p',    2),
  ('video_resolution', '1080p', '全高清 1080p', 3);

INSERT INTO sys_dict_data (dict_type, dict_value, dict_label, sort) VALUES
  ('vb_mode', 'off',    '关闭',       1),
  ('vb_mode', 'blur',   '背景虚化',   2),
  ('vb_mode', 'custom', '自定义图片', 3);

-- sys_dept
INSERT INTO sys_dept (name, sort) VALUES ('岸端调度中心', 1);
INSERT INTO sys_dept (name, sort) VALUES ('技术保障部',   2);
INSERT INTO sys_dept (name, sort) VALUES ('远洋8号',      3);

-- sys_user（6 行；与三方 6 个管理员账号一一对应，见 docs/三方系统管理员账号.md；
-- 原 sys_contact 里的纯联系人（王强/赵海/陈芳）已并入本表，成为无独立登录用途的参会人账号。
-- third_party_password 本文件只留空占位，真实口令由 gitignore 的 seed-credentials.sql 注入。）
INSERT INTO sys_user (username, password, display_name, third_party_account, third_party_password, account_type, position_code)
VALUES ('admin',     '', '系统管理员', 'rk3588bj',      '', 'super_admin',         'tech_supervisor');
INSERT INTO sys_user (username, password, display_name, third_party_account, third_party_password, account_type, position_code)
VALUES ('zhangming', '',   '张明',      'rk3588zwtship', '', 'device_admin',        'dispatch_director');
INSERT INTO sys_user (username, password, display_name, third_party_account, third_party_password, account_type, position_code)
VALUES ('liwei',     '',   '李伟',      'rk3588bj2',     '', 'meeting_participant', 'tech_engineer');
INSERT INTO sys_user (username, password, display_name, third_party_account, third_party_password, account_type, position_code)
VALUES ('wangqiang', '',   '王强',      'rk3588gzst',    '', 'meeting_participant', 'shore_duty');
INSERT INTO sys_user (username, password, display_name, third_party_account, third_party_password, account_type, position_code)
VALUES ('zhaohai',   '',   '赵海',      'rk3588bj3',     '', 'meeting_participant', 'chief_officer');
INSERT INTO sys_user (username, password, display_name, third_party_account, third_party_password, account_type, position_code)
VALUES ('chenfang',  '',   '陈芳',      'rk3588bj4',     '', 'meeting_participant', 'captain');

-- user_settings（3 行；摊开原 sys_user.preferences JSON；设备 id 均为 ''）
INSERT INTO user_settings (user_id, video_resolution, video_max_fps, video_target_bitrate_kbps, vb_mode, face_enhancement, cloud_record_default, recording_quality)
VALUES (1, '1080p', 30, 0, 'off',  0, 1, 'high');
INSERT INTO user_settings (user_id, video_resolution, video_max_fps, video_target_bitrate_kbps, vb_mode, face_enhancement, cloud_record_default, recording_quality)
VALUES (2, '1080p', 30, 0, 'off',  0, 1, 'high');
INSERT INTO user_settings (user_id, video_resolution, video_max_fps, video_target_bitrate_kbps, vb_mode, face_enhancement, cloud_record_default, recording_quality)
VALUES (3, '720p',  15, 300, 'blur', 1, 1, 'medium');

-- sys_contact 已废弃删除：人员主数据统一由 sys_user 承载（见上）。
