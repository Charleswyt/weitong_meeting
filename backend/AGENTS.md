# cloud/backend —— 卫通会议云端后端

**栈**：Go + GoFrame v2.10.3 + SQLite（无 CGO）。模块名：`cloud-conference-backend`。

默认 `deployment.side=cloud`。契约真源：`../contracts/`。三方：`../../platform/contracts/edge-to-cloud/`。

## 配置

`manifest/config/config.yaml`（gitignore；从 `config.yaml.example` 复制）。
同机多实例对拍时把 `server.address` 改为 `:18082`。

## 本地 / 镜像

见 [`../AGENTS.md`](../AGENTS.md)。镜像配方在 `../Dockerfile`。
