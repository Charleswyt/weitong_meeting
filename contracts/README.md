# cloud 前后端契约

本目录是**云端应用**前后端的唯一契约真源。后端与前端都读这里，不引用 `edge/`。

| 文件 | 用途 |
|---|---|
| `api.openapi.yaml` | 线格式；`frontend` 用 `pnpm run gen:types` 生成类型 |
| `api-contract.md` | 语义口径、错误码、状态机 |
| `DERIVATION.md` | 与实现对不齐时的推导登记 |

跨单元三方字段仍在 `../../platform/contracts/`。
