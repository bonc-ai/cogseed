# Mate Agent 第三版 · 文稿总目录（收敛版）

> **2026-08-03 现行开发口径**：`origin/develop` 是唯一功能开发与集成基线，`origin/master` 是稳定发布线，`origin/main` 已彻底停用，不作为开发、集成、发布、历史恢复或代码回迁入口；旧事件只按具体提交审计。认知树、报销管理工作台与集成验收分别在职责隔离的 worktree 中进行。本页 §3–§5 保留 2026-07-27 的阶段证据，不再作为分支操作说明；现行模块边界与验证方式以工作区根目录的 `docs/04-模块协作与隔离契约.md` 和 `docs/02-运行手册.md` 为准。

> 适用目录：`~/Documents/Mate Agent/`
>
> 本页是第三版 Mate Agent / Mate 智伴 的**唯一总体文档**。
> 2026-07-27 收敛：`docs/superpowers/` 下逐版累积的过程稿（各功能的规格 / 实施计划 / 阶段报告）已删除，
> 只保留**本页总览 + 1 份签字 Evidence 基线**；其余确定件的要点已内化进本页 §4.1–§4.3。
> 历史过程稿与已内化的确定件可从 Git 历史中找回，不再在工作区常驻。

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
| 多 Agent 协作 / 共享上下文 | 已完成（POC 收口） | `features/group_chat/{bus,collaboration,visibility,router}.ts` | §4.3 交接要点 |
| 工作流上下文（workflow context） | 已完成 | `features/group_chat/collaboration.ts` | §4.3 交接要点 |
| P3394 协议层（Wake / Protocol） | 记录型已交付，控制器型在建 | `features/p3394/{protocol,wake-service,wake-controller}.ts` | §4.2、§4.3 |
| KSTAR 学习闭环 | 单核心迁移已落地，工具契约对齐在建 | `features/p3394/kstar-*.ts`、`packages/nseap-meta-skill-engine/` | §4.1 迁移设计 + §4.2 一致性审计 |
| Agent 活动面板 / 协作抽屉 | 已交付（UI） | `renderer/modules/conversation-info.js`、`conversation.js` | 见 Git 历史过程稿 |
| 报销智能体 / TaskAgent 接入 | 固定内置管理 Agent 与隔离工作台已完成，正在集成验收 | `features/expense_workbench/`、`ipc/expense_workbench.ts` | 工作区模块协作与隔离契约 |
| 认知树 | 带来源候选、人工确认、复用成长与共享记忆绑定已完成，正在集成验收 | `features/cognition/`、`ipc/cognition.ts` | 工作区模块协作与隔离契约 |

> 说明：迁移到“控制器型协议”和 KSTAR 工具契约对齐仍需按现行代码核验；报销工作台与认知树的状态以上表和当前集成测试为准，不能再沿用 2026-07-27 的“未开始”判断。

---

## 3. 当前能力边界（Evidence 基线）

以下是 [周末增量能力基线 Evidence](./superpowers/reports/2026-07-27-weekend-increment-capability-baseline-evidence.md) 在 **2026-07-27 当日** 的三层记录：

- **A 层 — 当时已进 main**：治理归属已收敛，回归测试全量重跑通过；这只是历史标签，不表示今天仍从 `main` 开发。
- **B 层 — 分支未推送**：`codex/meta-skill-engine-single-core`（Meta Skill Engine 单核心）尚未推送 / 集成，
  是当前最大差距（Evidence 中标记为 R-07），需 Tech Lead 推送并集成。
- **C 层 — 未跟踪 / stash**：未纳入基线计数，不作为交付依据。

具体文件数、增删行、测试计数、复现命令，一律以 Evidence 原文为准，本页不复述以免与源失同步。

---

## 4. 确定件（Evidence 基线 + 内化要点）

本轮只在工作区保留 1 份签字确定件；其余 3 份确定件的要点已内化到 §4.1–§4.3，原文可从 Git 历史检出。

- 保留（唯一签字件）：[周末增量能力基线 Evidence（Sprint 2 输入）](./superpowers/reports/2026-07-27-weekend-increment-capability-baseline-evidence.md)
  — 三层历史能力边界（A 当时已进 main / B 分支未推送 / C 未跟踪）、三方签字表、复现命令附录。
- 仓库级依据另见 [`../README.md`](../README.md)（产品概述）与 [`../CLAUDE.md`](../CLAUDE.md)（设计约束与工作规则）。

### 4.1 Meta Skill Engine 单核迁移（要点内化）

7 项已确认的产品决策：
1. Engine（`packages/nseap-meta-skill-engine/`）迁入 Git 跟踪，成为唯一 KSTAR 核心。
2. PC 侧只保留 MCP 适配 / 存储 / IPC / UI / Wake / KB，KSTAR 计算全部下沉 Engine。
3. 本轮只做「单核心迁移」，不含检索优先、typed Delta、完整 replay/canary（属后续阶段）。
4. IPC 名不变；PC 经现有 `McpConnection` 拉起 Engine，`kstar-adapter.ts` / `kstar-factory.ts` 是唯一批准的引擎 spawn 路径。
5. 旧数据高可信选择性迁移 + 只读归档，不做全量强迁。
6. 迁移门槛（12 点删除门）满足后，删除旧 PC KSTAR 运行时。
7. 品牌与路径不硬编码，遵循 prompts / paths 既有约束。

工程形态：ESM + MCP stdio server；构建产物 `packages/nseap-meta-skill-engine/dist/index.js`；打包经 extraResources；依赖 `yaml@^2.6.1`（待批准）。

### 4.2 KSTAR 论文一致性审计（要点内化）

结论：**部分一致（Partial / C 级）**。当前实现是「KSTAR 启发的事后取证 / 归因 / 学习治理子系统」，尚不是论文 Def 3.7 的检索优先控制回路。

5 个 P0 差距：
- **P0-1**：KSTAR 跑在事后，不在派发前控制路径。
- **P0-2**：KB 是「能力」而非检索优先策略。
- **P0-3**：晋升缺受保护的 replay / canary 校验。
- **P0-4**：Delta 算法过弱（数值差分 else 字符串相等 0/1），易误判「执行偏差」→ 重复生成 KSTAR 卡片。
- **P0-5**：Episode 溯源不完整。

六知识分量映射：K_C / K_R / K_A / K_G / K_F / K_L。
落地顺序：Phase1 前移 KSTAR 到派发前 → Phase2 CognitiveAsset 注册表 → Phase3 typed Delta → Phase4 K_L 治理链 → Phase5 H1–H6 benchmark。

### 4.3 P3394 Sprint 2 技术交接（要点内化）

四人任务方向：
- 张照航：协议层由记录型改造为控制器型。
- 冯静雯：KSTAR Skill / MCP 统一到 Engine API，优化 DeltaR。
- 牛保康：报销智能体本地 Agent。
- 吴嘉宇：TaskAgent 接入 CogSeed。

已完成重大变更：KSTAR Engine 迁移（删 `kstar-runtime.ts` / `kstar-engine.ts`）；Engine 打包 extraResources；Hermes 版本探测 fallback；`paths.ts` 新增 `metaSkillEnginePackageDir()`。

阻塞依赖：B 层分支 `codex/meta-skill-engine-single-core` @ `5e7480f` 未推送 / 未集成（对应 Evidence R-07）；`yaml@^2.6.1` 待批准；需真实 electron-builder 打包核验 `yaml` 在 asar 边界的可用性。

验证命令见 §7。代码约束以 [`../CLAUDE.md`](../CLAUDE.md) 为准。

---

## 5. 交付包（P3394 Meta Skill Engine · 本地锚点）

> 本节是"周末增量"可交付件的清单与自证。范围：Engine 单核 + 本地锚点。正式签名打包与 PC↔Engine 端到端集成不在本包内（见 §5.4、§5.5）。

### 5.1 可追溯 Commit / Tag（本地）

- 历史集成分支：`integration/abc-meta-skill-engine`（当时基于现已停用的 `origin/main`，不得作为新分支基线）。
- 打包提交：本节所在的这次提交即打包提交；随后在其上打本地附注标签 `p3394-meta-skill-engine-20260727`。
- 本地核验：

```bash
git tag -l p3394-meta-skill-engine-20260727
git show --stat p3394-meta-skill-engine-20260727
```

> 历史说明：标签与提交当时仅落在本地集成分支，没有推送或合并。今天的集成目标是 `develop`，不再合入已停用的 `main`。

### 5.2 可运行包与启动说明

Engine 工作区：`packages/nseap-meta-skill-engine/`（ESM · MCP stdio 服务器 · 产物 `dist/index.js`）。

```bash
cd packages/nseap-meta-skill-engine
npm install
npm run build        # tsc -p tsconfig.json → 生成 dist/index.js
npm start            # node dist/index.js --stdio，MCP stdio 服务器
```

MCP 客户端接入（stdio）：命令 `node dist/index.js --stdio`，环境变量 `NSEAP_ONTOLOGY_DIR` 指向本体目录。嵌入 PC 时由 `kstar-adapter.ts` / `kstar-factory.ts` 经既有 `McpConnection` 拉起，无需手动启动。

### 5.3 一次真实运行 Evidence

在 `packages/nseap-meta-skill-engine/` 下，`rm -rf dist && npm run build` 起，实测结果：

| 环节 | 命令 | 结果 |
| --- | --- | --- |
| 干净构建 | `npm run build` | exit 0，产出 `dist/index.js`（约 30 KB） |
| 单元测试 | `npm test` | 11 个测试文件 · 49 用例全部通过 |
| Engine 自检 | `npm run check` | 30 项通过 / 0 失败，判定 L5 Meta-Skill 合规 |
| MCP 握手 | `node dist/index.js --stdio` | `initialize` → `notifications/initialized` → `tools/list` 正常；serverInfo=`nseap-meta-skill-engine`，暴露 26 个工具；stderr 打印 `NSEAP Meta-Skill Engine running on stdio` |

### 5.4 Mock 边界

- 单元测试（隔离层）：打桩 `McpConnection`、`apiFetch`、本地 CLI 二进制、DOM/i18n；不触网、不真正 spawn。
- 真实集成（无 Mock）：加载真实 Engine 包并起真实 stdio 进程，走真实文件系统与 MCP 进程（如 `mcp-process-get-engine-info` 类用例）。
- 本包只保证 **Engine 侧** 真实运行覆盖；**PC↔Engine 端到端** 与 **正式签名打包** 属 Sprint 2 范围，本包未覆盖。

### 5.5 Known Issues

| # | 问题 | 影响 / 归属 |
| --- | --- | --- |
| 1 | serverInfo 版本 `0.1.0` ≠ package.json `1.0.0` | 版本漂移，需对齐 |
| 2 | README 声称 "23 个 MCP 工具"，运行时 `tools/list` 暴露 26 个 | 文档漂移，需对齐 |
| 3 | PC adapter 调 `record_evidence`，Engine catalog 为 `add_evidence` | KSTAR 证据写入命名不一致（冯静雯） |
| 4 | Engine DeltaR 为原型级：仅字符串相等/不等，无语义预测 | 原型实现（冯静雯） |
| 5 | P3394 当前为"记录型"协议，dispatch 前无法预约束 Agent 边界 | 协议能力缺口（张照航） |
| 6 | B 层分支未推送/未集成（Evidence R-07） | 端到端集成瓶颈 |
| 7 | `yaml@^2.6.1` 依赖待批准；asar 打包边界待真实 electron-builder 验证 | 依赖/打包待确认 |
| 8 | 无 Apple / Windows 签名证书，正式 `.dmg`/`.exe` 不可用 | 仅可提供 unsigned `--dir` 包 |
| 9 | 源码多处标注 `Simplified`/`Heuristic` | 原型占位，Sprint 2 升级为 typed Delta 与语义评分 |


---

## 6. 核心原则与约束（速记）

1. Orkas 是基座，不是对外品牌；Mate Agent 是对外品牌，Mate 智伴是中文名。
2. P3394 负责治理闭环：Wake Gate、KSTAR、ExperienceCandidate。
3. 单一 dispatch 路径 `features/group_chat/bus.ts::enqueue`；单一 CLI spawn 路径 `features/local_agents/runner.ts`；单一 MCP spawn 路径 `features/connectors/mcp-client.ts`。
4. `#core-agent` 仅动态导入；主进程不开 HTTP server / 端口 / 本地鉴权；渲染层只走 `window.orkas.{invoke,stream}`。
5. 用户数据只落在 `<uid>/cloud/`（可同步）与 `<uid>/local/`（本机）。
6. 新增 npm 依赖需先讨论（如 `yaml@^2.6.1` 属引擎迁移的待批准依赖）。
7. KSTAR durable deliverable 必须带 `kstar: required` + `kstar_expectation`。

---

## 7. 验证命令

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

## 8. 收敛说明

- 累计从 `docs/superpowers/` 删除 27 份文稿：首轮 24 份过程稿（10 份 plans、11 份 specs、3 份阶段 reports），本轮再删 3 份确定件（引擎迁移设计、KSTAR 一致性审计、Sprint 2 技术交接）——其要点已内化进本页 §4.1–§4.3。
  过程稿是 superpowers-zh 工作流"设计先于编码"按功能逐版产出的规格 / 计划 / 报告，功能落地后即为过程副产物。
- 工作区最终只留 2 份：本页总览 + 1 份签字 Evidence 基线（见 §4）。全部为中文。
- 删除仅作用于工作区常驻文稿，Git 历史完整保留，需要旧稿可从历史检出。

---

## 9. 备注

`docs/` 顶层还有若干独立工作文档（`P3394_Team2_RouteB_*`、`Mate Agent 开发实施说明.*`、
`companion-repro-demo-runbook.md`、`research/`），不属于本次 `docs/superpowers/` 收敛范围，保持原样。
后续如需扩展新功能，应优先更新本页索引，再补对应确定件，避免文稿再次分散。
