# cloud/frontend —— 卫通会议云端前端

**栈**：Vue 3.5 + Vite 8 + TS 6 + Element Plus 2.14（pnpm 12、Node 24）。
版本真源：`../../platform/TECH_STACK.md`（G10）。

## 契约

- 线格式类型从 `src/types/api.gen.ts` 取；改 `../contracts/api.openapi.yaml` 后跑 `pnpm run gen:types`。
- 形状以 OpenAPI 为准，语义以 `../contracts/api-contract.md` 为准。

## 本地

见 [`../AGENTS.md`](../AGENTS.md)。开发口 **5176**，默认代理 **18082**。
