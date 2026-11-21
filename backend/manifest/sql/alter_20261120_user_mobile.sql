-- 存量库补手机号列（幂等：重复执行时若列已存在会失败，由 migrate 调用方按需处理；
-- 进程启动也会 ensure 一次，见 internal/cmd/ensure_schema.go）。
ALTER TABLE sys_user ADD COLUMN MOBILE VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS uk_sys_user_mobile
  ON sys_user(MOBILE) WHERE MOBILE IS NOT NULL AND MOBILE != '';
