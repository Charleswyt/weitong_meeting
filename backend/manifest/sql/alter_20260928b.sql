-- -----------------------------------------------------------------------------
-- alter_20260928b.sql —— 既有 CONFERENCE schema 的增量迁移（新库直接跑 create.sql，无需本文件）
-- 以 CONFERENCE 用户执行：`go run . migrate -script=manifest/sql/alter_20260928b.sql`
-- 达梦**不支持** CREATE TABLE IF NOT EXISTS，重复跑会报"对象已存在"，那不是失败。
-- 表定义与列注释与 create.sql 第 10 节保持一致（gf gen dao 读的是 DB 注释，不是本文件）。
--
-- 为什么要这张表：删一场会前我们已先在平台侧停掉它（MeetingService.Delete），但实测停完
-- 三方仍把这场会留在会议列表里、只是状态变 ended；17 条已软删的预约里 16 条至今仍出现在
-- 近期会议（其中 92323537 甚至仍报 scheduled、还能被拨号入会）。三方没有"删除会议"这个动作，
-- 所以"删了就不再出现"只能由本侧记账。
--
-- 回填只从**已有事实**推导：把 meeting_appointment 里已经软删的行按原样登记，
-- 一条也不凭推断新建。
-- -----------------------------------------------------------------------------

CREATE TABLE meeting_deleted (
    meeting_id      VARCHAR(64) NOT NULL PRIMARY KEY,
    meeting_number  VARCHAR(32) DEFAULT NULL,
    appointment_id  BIGINT      DEFAULT NULL,
    suppressed_at   TIMESTAMP   DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE  meeting_deleted                IS '会议压制表：本侧删过的会（按三方 meetingId）在此留一行，日程合并时据此剔掉上游仍报着的那一场。三方没有"删除会议"这个动作，取消/停止只会把它变成 ended 留在列表里（实测 17 条已删预约中 16 条至今仍可见，含 92323537 报 scheduled），所以这张表是我方自己的账，不改上游语义、也不向上游造行';
COMMENT ON COLUMN meeting_deleted.meeting_id     IS '三方 meetings[].meetingId 原样（实测 meeting_1790527565_0xx8arRt 27 字符）；有行即压制，主键天然去重';
COMMENT ON COLUMN meeting_deleted.meeting_number IS '该场的三方会议号，仅作排查线索：读列表不按号判定（号是拨号用的，不保证一场一号）';
COMMENT ON COLUMN meeting_deleted.appointment_id IS '本侧被删除的预约单 id，仅作排查线索（预约单是软删，行还在 meeting_appointment 里可回查）';
COMMENT ON COLUMN meeting_deleted.suppressed_at  IS '本侧登记压制的时刻。刻意不叫 deleted_at：那会被 GoFrame gdb 当逻辑删除列，查询会自动加 WHERE DELETED_AT IS NULL 把压制行全滤掉。恢复某条 = 物理删这一行，当前无恢复入口';

INSERT INTO meeting_deleted (meeting_id, meeting_number, appointment_id)
SELECT THIRD_PARTY_MEETING_ID, THIRD_PARTY_MEETING_NUMBER, ID
  FROM meeting_appointment
 WHERE DELETED_AT IS NOT NULL AND THIRD_PARTY_MEETING_ID IS NOT NULL;
