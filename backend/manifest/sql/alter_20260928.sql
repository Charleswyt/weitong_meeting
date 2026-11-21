-- -----------------------------------------------------------------------------
-- alter_20260928.sql —— 既有 CONFERENCE schema 的增量迁移（新库直接跑 create.sql 即可，无需本文件）
-- 以 CONFERENCE 用户执行。达梦**不支持** CREATE TABLE IF NOT EXISTS，重复跑会报"对象已存在"，
-- 那不是失败 —— 先查 USER_TABLES 再决定要不要建。
-- 连库方式：仓库根 .env 的 CONFERENCE_DB_LINK 换形状 + `go run . migrate -script=... -dsn=...`
-- （容器外 Go 客户端，勿 docker exec disql；link 串直接当 -dsn 用会报"用户名或密码错误"，见 README.md）。
-- 表定义与列注释与 create.sql 第 9 节保持一致（gf gen dao 读的是 DB 注释，不是本文件）。
--
-- 为什么先 DROP 再建：本表是本次改动新增的，10:16 落的第一版把时刻列命名成了 deleted_at，
-- 而 GoFrame gdb 把 `deleted_at` 认作逻辑删除列 —— SELECT 自动加 WHERE DELETED_AT IS NULL、
-- DELETE 自动变 UPDATE，与本表"有行即压制"的语义正好相反（实测：14 条压制行插进去了，列表读不到）。
-- 当时库里这张表只有开发自证写入的行，所以直接重建。
-- 若某个库已经有**真**压制行，别跑 DROP，改这一句保住数据：
--   ALTER TABLE recording_deleted RENAME COLUMN deleted_at TO suppressed_at;
-- -----------------------------------------------------------------------------

DROP TABLE IF EXISTS recording_deleted;

CREATE TABLE recording_deleted (
    recording_id    VARCHAR(128) NOT NULL PRIMARY KEY,
    meeting_id      VARCHAR(64)  DEFAULT NULL,
    suppressed_at   TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE  recording_deleted                IS '录制压制表：用户在本页面删过的 recordingId 在此留一行，/recordings/list 与 playback 出口据此剔条目。三方 recordings[] 有删不掉的孤儿行（其 meetingId 上游已无会议、整场 DELETE 回 409 meeting_not_found、状态又不是 media_deleted 所以过不了列表过滤 —— 实测那条报 ready/198KB），只靠上游清理做不到"删了就不再出现"，故本表是我方自己的账，不改上游语义、不向上游造行';
COMMENT ON COLUMN recording_deleted.recording_id   IS '三方 recordings[].recordingId 原样（实测 rec_pub_meeting_…_participant_…_pub_… 达 88 字符，故 128 不是 64）；有行即压制，主键天然去重（本单元不建 UNIQUE 约束的约定对 PK 除外）';
COMMENT ON COLUMN recording_deleted.meeting_id     IS '该录制所属三方会议 id，仅作排查线索：删除是整场粒度，同场其它 recordingId 也各写一行；读列表只按 recording_id 判定，不靠它反查会议是否还在';
COMMENT ON COLUMN recording_deleted.suppressed_at  IS '本侧登记压制的时刻（不是三方的删除时刻，孤儿行三方从未删成）。刻意不叫 deleted_at：那会被 GoFrame gdb 当逻辑删除列，查询会自动加 WHERE DELETED_AT IS NULL 把压制行全滤掉。恢复某条 = 物理删这一行，当前无恢复入口';
