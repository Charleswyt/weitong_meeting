-- -----------------------------------------------------------------------------
-- alter_20260924.sql —— 既有 CONFERENCE schema 的增量迁移（新库直接跑 create.sql 即可，无需本文件）
-- 以 CONFERENCE 用户执行。达梦不支持 ADD COLUMN IF NOT EXISTS，逐条执行、重复报"列已存在"可跳过。
-- 连库方式见 README.md（容器外 Go 客户端，勿 docker exec disql）。
-- -----------------------------------------------------------------------------

-- meeting_appointment：三方会议号回填 + 实测开会时刻
ALTER TABLE meeting_appointment ADD (
    third_party_meeting_number VARCHAR(12) DEFAULT NULL,
    started_at                 TIMESTAMP   DEFAULT NULL
);
COMMENT ON COLUMN meeting_appointment.third_party_meeting_number IS '三方生成的 8 位会议号，入会/订阅以它为准（本系统 meeting_number 仅本地展示与查询）';
COMMENT ON COLUMN meeting_appointment.started_at                 IS '三方实测开会时刻（state.startedAtUnixMs 回填），会中时长以它为起点';

-- user_settings：会中真实生效的采集/音频/录制偏好
ALTER TABLE user_settings ADD (
    mirror_video       TINYINT      DEFAULT 1,
    bg_blur            TINYINT      DEFAULT 0,
    mic_volume         INT          DEFAULT 80,
    auto_gain          TINYINT      DEFAULT 1,
    noise_suppression  TINYINT      DEFAULT 1,
    recording_save_dir VARCHAR(256) DEFAULT ''
);
COMMENT ON COLUMN user_settings.mirror_video        IS '视频镜像开关：1 开 0 关，前端 CSS transform 应用';
COMMENT ON COLUMN user_settings.bg_blur             IS '背景虚化开关：1 开 0 关；vb_mode 非 off 时以 vb_mode 为准';
COMMENT ON COLUMN user_settings.mic_volume          IS '麦克风音量 0-100，前端 GainNode 应用';
COMMENT ON COLUMN user_settings.auto_gain           IS '自动增益：映射 getUserMedia autoGainControl';
COMMENT ON COLUMN user_settings.noise_suppression   IS '降噪：映射 getUserMedia noiseSuppression';
COMMENT ON COLUMN user_settings.recording_save_dir  IS '本地录制保存目录的显示名；真实目录句柄存客户端 IndexedDB，本列仅回显';

-- meeting_appointment：入会初始媒体偏好（/join 回传，会议页消费）
ALTER TABLE meeting_appointment ADD (
    mute_on_join       TINYINT DEFAULT 0,
    camera_off_on_join TINYINT DEFAULT 0
);
COMMENT ON COLUMN meeting_appointment.mute_on_join       IS '预约人入会时默认静音，/join 回传由会议页消费';
COMMENT ON COLUMN meeting_appointment.camera_off_on_join IS '预约人入会时默认关闭摄像头，/join 回传由会议页消费';
