-- -----------------------------------------------------------------------------
-- alter_20260929.sql —— 既有 CONFERENCE schema 的增量迁移（新库直接跑 create.sql，无需本文件）
-- 以 CONFERENCE 用户执行：`go run . migrate -script=manifest/sql/alter_20260929.sql`
-- 达梦不支持 CREATE TABLE IF NOT EXISTS，重复跑会报"对象已存在"，那不是失败。
--
-- 这一段落两件本轮需求要的事实：
--
-- 1) meeting_attendance（第 5 项：加入过的会议要出现在会议列表里）
--    这是**我方自己的事实**：三方只认参会令牌，不会替我们记"这台岸端浏览器进过哪场会"，
--    而它的 `meetings[]` 是全租户列表、没法按"我参加过"筛（实测见单元 AGENTS.md）。
--    所以这一行必须落库，且只在真的入会成功时写 —— 不从"受邀名单"推断成"参加过"，
--    那是两种不同的事实。历史数据**不回填**：库里没有任何可靠证据能证明谁进过哪场会，
--    凭推断造行就是把不一致变成看不见的债。因此该表从本迁移之后开始累积。
--
-- 2) meeting_appointment.allow_waiting（第 10 项：允许成员在主持人入会前等待）
--    三方没有等候室能力（新版接口文档 20260928 里 scheduleMeeting 的字段只有
--    title/startAt/durationMinutes/hostUsername/cloudRecord/recordingMode/rkRecord/
--    sources/targetDevices；grep lobby/admit/等候 零命中），但"要不要让这个端真的加入三方"
--    这个决定权在我方后端手里 —— 门禁做在我们这一侧，不需要上游支持也能成立。
--    列只存"这场会开不开这道门"，等待队列本身是运行时状态，不落库。
-- -----------------------------------------------------------------------------

CREATE TABLE meeting_attendance (
    id               BIGINT IDENTITY(1,1) PRIMARY KEY,
    meeting_id       VARCHAR(64) NOT NULL,
    meeting_number   VARCHAR(32)  DEFAULT NULL,
    appointment_id   BIGINT       DEFAULT NULL,
    user_id          BIGINT      NOT NULL,
    first_joined_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_joined_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    join_count       INTEGER     DEFAULT 1,
    CONSTRAINT uk_meeting_attendance UNIQUE (meeting_id, user_id)
);
COMMENT ON TABLE  meeting_attendance                IS '参会历史：这个账号真的进过哪场会（第 5 项）。一行 = 一个(三方 meetingId, 用户)组合，重复入会只把 last_joined_at 与 join_count 往前推。它是"加入过的会议仍要出现在会议列表"的唯一真源 —— 三方列表按主持人过滤看不见别人主持的会，受邀名单又不等于实际参加过';
COMMENT ON COLUMN meeting_attendance.id             IS '自增主键';
COMMENT ON COLUMN meeting_attendance.meeting_id     IS '三方 meetings[].meetingId 原样，一场会的稳定身份（会议号是拨号用的，不保证一场一号）；入会响应里没有它就不写这行';
COMMENT ON COLUMN meeting_attendance.meeting_number IS '该场的三方会议号，供日程按号对齐本地预约单（与 meeting_deleted 同一口径）';
COMMENT ON COLUMN meeting_attendance.appointment_id IS '本库预约单 id，可空：手机/板卡在三方直接发起的会本库没有预约单，只有会话键';
COMMENT ON COLUMN meeting_attendance.user_id        IS '逻辑引用 sys_user.id（无级联外键）';
COMMENT ON COLUMN meeting_attendance.first_joined_at IS '本账号第一次成功入会的时刻';
COMMENT ON COLUMN meeting_attendance.last_joined_at  IS '本账号最近一次成功入会的时刻，日程排序与"最近加入"展示用它';
COMMENT ON COLUMN meeting_attendance.join_count      IS '成功入会次数（含中途退会再入）。刻意不叫 deleted_at 之类：那会被 GoFrame gdb 当逻辑删除列，查询自动加 WHERE 把行滤掉';

ALTER TABLE meeting_appointment ADD allow_waiting TINYINT DEFAULT 0;
COMMENT ON COLUMN meeting_appointment.allow_waiting IS '1=允许成员在主持人入会前等待（第 10 项）。门禁在我方后端：主持人尚未在场时，这个端不真的调用三方 join，入会响应回 waiting=true，由前端停在"等待主持人"页轮询。三方无等候室能力，所以这个开关不外传、也不承诺上游行为';
