# 退役用例（不匹配 `scratch/verify-*.ts`，所以全量跑不会带上它们）

放这里不等于删掉：留着是为了让下一个人知道**这条断言曾经管过什么、为什么现在管不着了**，
免得有人把它当"漏跑的用例"重新启用。

| 文件 | 退役日期 | 原因 | 重新启用的条件 |
|---|---|---|---|
| `verify-offline-export.ts` | 2026-10-10 | 被测主体 `src/utils/offlineExport/*` 已于 2026-09-30 整目录删除（离线合成从 `offlineExport/` 重写进 `offlineCompose/`，见契约 ADR-0007x 与 `frontend/AGENTS.md`「合成的两条引擎」） | 只有当真源里重新出现 `offlineExport/` 那一层时才回来 |
| `verify-mp4-roundtrip.ts` | 2026-10-10 | 同上：它测的是 `offlineExport/mp4Muxer.ts` 的 mux→demux 往返，该模块已不存在 | 现行容器判据由 `verify-recording-judgments.ts`（`containerOf`）与 `verify-remux.ts`（`mvhd` 盒子长度）覆盖；MP4 盒级校验走 `scratch/validate-mp4.mjs` + `scratch/scan-mp4-boxes.mjs` 直接量真产物 |
| `analyze-cloud-mp4.{mjs,ts}` | 2026-11-10 | 同上：它 `import { demuxMp4 } from '../src/utils/offlineExport/mp4Demuxer.ts'`，该模块已不存在 | 只有当 `offlineExport/` 那层回来、或 `mp4/remuxFmp4.ts` 长出等价 demux 能力时才改写后启用 |

两份都是在"合一两个检出"（主检出 12 份 + worktree 11 份 `verify-*.ts`，交集为 0）时暴露出来的：
它们在合并后的源码上根本 import 不到目标模块。**判据是"被测主体还在不在"，不是"文件放没放在那儿"。**
