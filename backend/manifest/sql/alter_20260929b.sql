-- -----------------------------------------------------------------------------
-- alter_20260929b.sql —— 给 meeting_attendance 补唯一约束（表与 allow_waiting 列在 a 段已落）
--
-- 为什么不是 CREATE INDEX：create.sql 第 3 条约定本 schema **不建二级索引**
-- （数据量小 + 边端资源紧，只保留 PK/UNIQUE 支撑的隐式索引）。所以这里用唯一约束
-- 表达"一个 (三方 meetingId, 用户) 只能有一行" —— 它是正确性要求（重复入会走
-- 更新而不是插第二行），不是查询加速；顺带得到一个隐式索引，符合约定。
-- -----------------------------------------------------------------------------

ALTER TABLE meeting_attendance ADD CONSTRAINT uk_meeting_attendance UNIQUE (meeting_id, user_id);
