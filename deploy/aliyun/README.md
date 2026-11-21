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

使用 Node 24、pnpm 12 和仓库的锁文件构建前端。执行 `pnpm install --frozen-lockfile`、`pnpm exec vue-tsc` 和 `pnpm exec vite build --base=/zwt-meeting/ --sourcemap=false`。Go 后端使用 go.mod 对应的 Go 版本编译。部署时以发布目录和 `current` 软链接切换二进制和网页，数据库独立持久化。

将现场提供的 `config.yaml` 和 `smtp.local.yaml` 放到源码的 `backend/manifest/config/`。原项目运行时读取 `config.yaml`。本次部署将后者中的邮件设置合并进生效配置，并为新实例生成专用 JWT 签名密钥、SM2 私钥和媒体交换凭据。更新时保留已生效的密钥和数据库。首次建库包含业务表及基础字典，正式用户通过邮箱注册。

原项目接口定义位于 `contracts/api.openapi.yaml`。在当前站点调用时以 `/zwt-meeting` 为服务前缀。现有中卫通媒体接口仍使用 `/zwt-meeting/api/v1/rooms` 和 `/zwt-meeting/api/v1/session`。
