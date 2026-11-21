-- =============================================================================
-- 视频会议系统 —— 达梦建库前置（一次性，DBA 动作）
--
-- 与电子围栏共用同一达梦实例（本机 fence-dm8 容器 / 端口 5236），本应用用独立
-- schema `CONFERENCE`。这一段不在 `create.sql` 的能力范围内：它建的是"用户 + 模式 + 建表权限"，
-- 必须先以 SYSDBA 执行完，再切到 CONFERENCE 用户跑 `create.sql` 建表。
--
-- 写法对齐 edge/fence 已验证的引导流程（见 fence 的 manifest/sql/README.md）：
--   * 没有 `CONNECT` 角色 —— 达梦的 DBA_ROLES 里根本没有它，那是 Oracle 的习惯；
--   * 不用 `GRANT a, b TO x` 的逗号多角色写法 —— 达梦不接受，逐条 GRANT。
-- 达梦里 schema 名 = 用户名；`CREATE SCHEMA ... AUTHORIZATION` 把它显式建为该用户的默认模式。
-- =============================================================================

-- 口令由环境注入，不写进仓库（对齐 edge/fence 的做法）。达梦要求：长度 ≥9，含大小写字母、数字、特殊字符。
CREATE USER "CONFERENCE" IDENTIFIED BY "<由环境注入，不写进仓库>";
CREATE SCHEMA "CONFERENCE" AUTHORIZATION "CONFERENCE";
GRANT RESOURCE TO "CONFERENCE";

-- 用户/模式若已存在，上面两条会报"已存在"，跳过即可（幂等由执行者判断，达梦不支持 IF NOT EXISTS）。
