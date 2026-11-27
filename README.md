# 卫通会议 · 云端源码

1. **[部署](./docs/部署.md)** — 编译、落盘、反代、升级  
2. [本地开发](./docs/本地开发.md) — 本机 `go run` / `pnpm dev`  
3. [目录结构](./docs/目录结构.md)  
4. [数据库结构](./docs/数据库结构.md)  
5. [账号清单](./docs/账号清单.md)  

契约（改接口必动）：[`contracts/`](./contracts/)。  
`AGENTS.md` 仅作仓内应用发现标志。

## 中卫通公网会议

网页在 `frontend/`，账号和会议业务后端在 `backend/`，转录和录制助手在 `assistant/`。音视频通过独立部署的中卫通媒体服务接入。

- [公网适配变更记录](./docs/中卫通公网会议适配变更记录.md)
- [可导入 ApiPost 的接口集合](./contracts/中卫通公网会议_Apipost接口集合.json) · [OpenAPI](./contracts/api.openapi.yaml)
- [阿里云构建和部署](./deploy/aliyun/README.md)
