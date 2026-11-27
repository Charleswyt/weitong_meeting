# 中卫通公网会议的阿里云部署

公网入口为 `/zwt-meeting/`。云端工作台通过新标签页打开此地址。用户在卫通会议的 Vue 页面登录，Go 服务管理账号、会议、聊天、WebSocket 和邀请。中卫通媒体服务负责房间、参会令牌及 WebRTC。

| 组件 | 运行位置 |
| --- | --- |
| 原版 Vue 构建产物 | `/opt/weitong-meeting/current/www/zwt-meeting/` |
| 原版 Go 后端 | `weitong-meeting.service`，回环端口 19896 |
| 账号与会议 SQLite 数据库 | `/var/lib/weitong-meeting/data/conference.db` |
| 生效配置 | `/etc/weitong-meeting/backend/manifest/config/` |
| 中卫通媒体控制 | `sinosat-meeting.service`，回环端口 19894 |
| 公网路由 | `/etc/nginx/snippets/sinosat-meeting.conf` |

## 登录与入会

邮箱验证码有效期为 5 分钟，重新获取间隔为 60 秒。校验通过后由原项目创建或识别用户。已有会议账号可使用 SM2 密码登录。当前配置的邮件供应商为 SMTP。短信配置为 console，公网 Nginx 对短信端点返回 503。开通真实短信后需同步调整供应商和公网路由。

独立服务用稳定的用户 ID 与媒体服务交换会话。交换凭据保存在 `/etc/weitong-meeting/media-token`，仅在本机回环链路使用。持邀请号的已登录用户可以预检房间，预检响应包含标题、创建时间和容量。主持权跟随建会者的账号来源和用户 ID。工作台持有的业务密码和令牌无需传给会议网页。

## 构建和发布

在 `frontend/` 使用 Node 24、pnpm 12 和仓库的锁文件构建前端。

```sh
pnpm install --frozen-lockfile
pnpm exec vue-tsc
pnpm exec vite build --base=/zwt-meeting/
```

公网版本 `20261126-adaptive-912d78286ac6` 对应会议源码 `48cb8fb`。该版本使用项目默认的 source map 配置生成 `dist/`，打发布包时排除 `*.map`。验收时使用原发布工作区共享的 `node_modules`，复现了全部 71 个前端文件的 SHA256。独立安装同一锁文件时，分块文件名可能变化，发布时应一起交付同次构建的首页和静态资源。

Go 后端使用 `backend/go.mod` 对应的版本编译。部署时以发布目录和 `current` 软链接切换二进制和网页，数据库独立持久化。

将现场提供的 `config.yaml` 和 `smtp.local.yaml` 放到源码的 `backend/manifest/config/`。原项目运行时读取 `config.yaml`。本次部署将后者中的邮件设置合并进生效配置，并为新实例生成专用 JWT 签名密钥、SM2 私钥和媒体交换凭据。更新时保留已生效的密钥和数据库。首次建库包含业务表及基础字典，正式用户通过邮箱注册。

原项目接口定义位于 `contracts/api.openapi.yaml`。在当前站点调用时以 `/zwt-meeting` 为服务前缀。现有中卫通媒体接口仍使用 `/zwt-meeting/api/v1/rooms` 和 `/zwt-meeting/api/v1/session`。

## 会议助手

`weitong-assistant.service` 在回环地址 19917 提供服务。程序位于 `/opt/weitong-assistant/current`，Python 运行时使用 `/usr/bin/python3.10`。将 `assistant/requirements.txt` 中的依赖安装至 `/opt/weitong-assistant-runtime/python`，按照 `assistant/models.lock.json` 下载并核对模型至同一运行时的 `models` 目录。FFmpeg 需要 RTSP、Matroska、libx264、AAC、drawtext 和 DejaVu Sans 字体。

现场配置为 `/etc/weitong-assistant/config.json`，由 root 和会议服务组读取。配置项 `authUrl` 指向会议账号服务的 `/api/v1/auth/me`，`presenceUrl` 指向本机媒体服务的 `/internal/weitong/activity`。`bridge` 为现有媒体桥接凭据。`meetings` 指向会议业务 SQLite，`data` 指向独立状态目录，`models` 指向校验后的模型目录。`rtspPort`、`mediaUser`、`mediaPassword` 复用本机媒体网关配置。`key` 是初装时用系统随机源生成并以 Base64 编码的 32 字节密钥，升级应保留。备份与恢复需要会议数据库、助手数据库、归档回执和独立保管的该密钥。

`weitong-recording-archive.timer` 调用独立归档服务。`/etc/weitong-assistant/archive.json` 的 `clientDirectory` 指向现有 OSS 归档客户端所在目录，`archiveConfig` 指向既有归档配置。上传范围为 `weitong-meeting/recordings/v1/<会议内部ID>/<轨道文件ID>.enc`。归档服务设置私有 ACL，核对本地和 OSS 字节数、CRC64，回执记录 SHA-256。会议网页通过会议助手鉴权导出；对象存储凭据由归档服务持有。

发布前在阿里云使用 `/usr/local/sbin/weitong-meeting-release-guard acquire`，切换与健康检查结束后执行 `release`。安装这条命令的源码为 `deploy/aliyun/roi/release_guard.py`。ROI 导航绑定 `data-weitong-presence`，使用同目录的 `meeting-activity.js`。公网用户指南包含操作入口、权限和验收范围。[会议助手与在会运维](../../docs/中卫通公网会议助手与在会运维.md)
