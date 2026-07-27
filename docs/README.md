# Mate Agent 第三版 · 文稿总目录（收敛版）

> 适用目录：`~/Documents/Mate Agent/`
>
> 本页是第三版 Mate Agent / Mate 智伴 的**唯一总体文档**。
> 2026-07-27 收敛：`docs/superpowers/` 下逐版累积的过程稿（各功能的规格 / 实施计划 / 阶段报告）已删除，
> 只保留**本页总览 + 4 份确定件**。历史过程稿可从 Git 历史中找回，不再在工作区常驻。

---

## 1. 定位

第三版是基于 Orkas 基座开发的 Mate Agent / Mate 智伴 品牌版。核心方向：

- 保留 Orkas Conversation / Agent Runtime 作为底层事实源。
- 引入 P3394 的 Wake、KSTAR、Experience 治理闭环，并把 KSTAR 核心迁移到独立的 Meta Skill Engine（MCP 进程）。
- 对外品牌切换为 Mate Agent，中文名 Mate 智伴。
- 指挥官后端可切换（Orkas Core Agent / Hermes CLI），云模型授权复用现有 `auth` 体系。

---

## 2. 已交付与在建能力（总览）

| 能力 | 当前状态 | 关键代码位置 | 权威文档 |
|---|---|---|---|
| 品牌独立化（Mate Agent / 智伴） | 已完成 | 全仓品牌串、`resources/`、`package.json` | 见 Git 历史过程稿 |
| 指挥官后端 + 模型配置切换 | 已完成 | `features/local_agents/backends/hermes.ts`、`features/config.ts` | 见 Git 历史过程稿 |
| 多 Agent 协作 / 共享上下文 | 已完成（POC 收口） | `features/group_chat/{bus,collaboration,visibility,router}.ts` | 交接文档 §2–§3 |
| 工作流上下文（workflow context） | 已完成 | `features/group_chat/collaboration.ts` | 交接文档 §3.3 |
| P3394 协议层（Wake / Protocol） | 记录型已交付，控制器型在建 | `features/p3394/{protocol,wake-service,wake-controller}.ts` | 交接文档 §4.1、§10 |
| KSTAR 学习闭环 | 单核心迁移已落地，工具契约对齐在建 | `features/p3394/kstar-*.ts`、`packages/nseap-meta-skill-engine/` | 设计文档 + 一致性审计 |
| Agent 活动面板 / 协作抽屉 | 已交付（UI） | `renderer/modules/conversation-info.js`、`conversation.js` | 见 Git 历史过程稿 |
| 报销智能体 / TaskAgent 接入 | 未开始（Sprint 2 承诺范围待共同确认） | `features/local_agents/`、`features/agents.ts` | 交接文档 §4.3–§4.4 |

> 说明：迁移到"控制器型协议"、KSTAR 工具契约对齐、报销 / TaskAgent 接入均属 **Sprint 2 在建 / 待确认**，
> 最终承诺范围由 PO、Tech Lead 与本助手在核验后共同确认。

---

## 3. 当前能力边界（Evidence 基线）

以 [周末增量能力基线 Evidence](./superpowers/reports/2026-07-27-weekend-increment-capability-baseline-evidence.md) 为准，分三层：

- **A 层 — 已进 main**：治理归属已收敛，回归测试全量重跑通过。此层是当前可信基线。
- **B 层 — 分支未推送**：`codex/meta-skill-engine-single-core`（Meta Skill Engine 单核心）尚未推送 / 集成，
  是当前最大差距（Evidence 中标记为 R-07），需 Tech Lead 推送并集成。
- **C 层 — 未跟踪 / stash**：未纳入基线计数，不作为交付依据。

具体文件数、增删行、测试计数、复现命令，一律以 Evidence 原文为准，本页不复述以免与源失同步。

---

## 4. 确定件索引（唯一权威来源）

以下 4 份为本轮保留的确定件，均为中文，互不重复：

1. [Meta Skill Engine 单一 KSTAR 核心迁移设计](./superpowers/specs/2026-07-26-meta-skill-engine-single-core-design.md)
   — 引擎为何独立、迁移契约、快照信封 / 生成 CAS、批次计划、12 点删除门。
2. [KSTAR 论文架构与当前实现一致性审计](./superpowers/reports/2026-07-26-kstar-paper-implementation-consistency-audit.md)
   — 结论"部分一致（C 级）"、P0–P1 差距、六知识分量映射、落地顺序。
3. [P3394 CogSeed Sprint 2 技术交接文档](./superpowers/reports/2026-07-27-p3394-handover.md)
   — 总体架构、四人任务方向、已完成重大变更、阻塞依赖、验证命令。
4. [周末增量能力基线 Evidence（Sprint 2 输入）](./superpowers/reports/2026-07-27-weekend-increment-capability-baseline-evidence.md)
   — 三层能力边界、三方签字表、复现命令附录。

仓库级依据另见 [`../README.md`](../README.md)（产品概述）与 [`../CLAUDE.md`](../CLAUDE.md)（设计约束与工作规则）。

---

## 5. 核心原则与约束（速记）

1. Orkas 是基座，不是对外品牌；Mate Agent 是对外品牌，Mate 智伴是中文名。
2. P3394 负责治理闭环：Wake Gate、KSTAR、ExperienceCandidate。
3. 单一 dispatch 路径 `features/group_chat/bus.ts::enqueue`；单一 CLI spawn 路径 `features/local_agents/runner.ts`；单一 MCP spawn 路径 `features/connectors/mcp-client.ts`。
4. `#core-agent` 仅动态导入；主进程不开 HTTP server / 端口 / 本地鉴权；渲染层只走 `window.orkas.{invoke,stream}`。
5. 用户数据只落在 `<uid>/cloud/`（可同步）与 `<uid>/local/`（本机）。
6. 新增 npm 依赖需先讨论（如 `yaml@^2.6.1` 属引擎迁移的待批准依赖）。
7. KSTAR durable deliverable 必须带 `kstar: required` + `kstar_expectation`。

---

## 6. 验证命令

```bash
# 全量测试（脚本自管 sqlite ABI 切换）
npm test

# P3394 聚焦
npm run test:js -- test/main/features/p3394 test/main/features/group_chat \
  test/static test/renderer/conversation-info.test.ts

# Meta Skill Engine
npm run engine:build && npm run engine:test && npm run engine:check

# 类型检查
npm run typecheck
```

---

## 7. 收敛说明

- 本次删除 `docs/superpowers/` 下 24 份过程稿（10 份 plans、11 份 specs、3 份阶段 reports）。
  这些是 superpowers-zh 工作流"设计先于编码"按功能逐版产出的规格 / 计划 / 报告，功能落地后即为过程副产物。
- 保留 4 份确定件（见 §4）+ 本页总览。全部为中文。
- 删除仅作用于工作区常驻文稿，Git 历史完整保留，需要旧稿可从历史检出。

---

## 8. 备注

`docs/` 顶层还有若干独立工作文档（`P3394_Team2_RouteB_*`、`Mate Agent 开发实施说明.*`、
`companion-repro-demo-runbook.md`、`research/`），不属于本次 `docs/superpowers/` 收敛范围，保持原样。
后续如需扩展新功能，应优先更新本页索引，再补对应确定件，避免文稿再次分散。
