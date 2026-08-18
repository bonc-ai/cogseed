# CogSeed（P3394）生产级技术架构设计

> 基于 PRD doc-v1.6（Review-3）与 Mate Agent (Orkas) Electron 代码库现状的融合架构。
> Harness Engineering 视角：**模型是引擎（engine），CogSeed 是整车（harness）——"模型是大家的，认知是你的"。**

| 项 | 值 |
|---|---|
| 文档版本 | arch-v0.1（评审候选） |
| 成文日期 | 2026-08-10 |
| 上游文档 | PRD P3394 doc-v1.6；AGENTS.md；docs/T2-S3-02-MainSkill-Baseline-规划.md；docs/superpowers/specs/2026-08-05-kstar-ability-asset-reuse-design.md |
| 目标版本 | v0.1.0-preview \| 2026-08-19 |
| 状态 | 内部评审材料；不代表已实现、已验收或获准发布。正式决策以 Decision Log 为准 |
| 关联 PRD 章节 | §0.6（对象模型）、§3（产品对象）、§6.5（Workspace/TaskRun）、§8（Agent/Skill/Ontology/KSTAR 契约）、§9（概念数据与接口）、§11（验收与 Evidence）、§14（风险与依赖） |

---

## 0. 执行摘要（大白话版）

**CogSeed 的工程本质：在用户已有的 Agent 工作流之上，架设一层"个人认知资产的受控 harness"。** 用户继续用 Codex / Claude Code / 其他 Agent 干活，CogSeed 负责：从授权来源发现值得保留的认知 → 生成候选 → 用户确认 → 形成带版本、可回滚、可验证的正式资产 → 在目标 Agent 上真实复用并产出回执 → 用 KSTAR 双 Gate 受控进化。

**本架构的核心决策（一句话各一条）：**

1. **单进程模块化单体**：延续现有 Electron 单进程架构，领域逻辑全部收敛在 `features/`，IPC 只做校验与转发（AGENTS.md 强制）。不引入 HTTP server、不引入独立后端。
2. **数据以 JSON/JSONL 为事实源，sqlite 只服务向量检索**：事件账本走 append-only JSONL 原子追加；资产/空间/基线走单文件 JSON 版本化；sqlite（sqlite-vec）仅用于 KB 向量库。
3. **先事件、后视图**：任何资产状态变化必须 AssetEvent → AuditReceipt → AssetViewProjection 三步落盘成功后才更新 UI；失败保持原状态（PRD 原则 14）。
4. **TaskRun 版本冻结是并发与归因的基石**：Main Skill Baseline 先冻结、后执行、不可变；漂移即拒绝；历史与运行中 TaskRun 永不静默换版。
5. **外部 Agent 是契约化边界，不是黑盒依赖**：统一 `ExecutionBoundary: real / degraded / test-double` 三态，所有外部调用有 Mock 双模，系统在纯 Mock 下可端到端运行。
6. **本地优先、诚实降级**：无资产治理后端 / 无 CogSeed 账号 / 无网络时个人主链路成立；`native_session → exported_evidence → reference_only` 能力分级，绝不冒充原生执行。
7. **成本受控是设计约束而非事后补救**：首次 Aha 候选上限 3 条、提取走低成本模型通道、no_change 是合法结论、夜间整理限时限量。

**8月19 保底工程含义**：一条真实任务、一条受支持来源路径、一个通过上架 Gate 的空间（复杂项目交付）、一个冻结的 Main Skill Baseline、一次目标端真实加载并产出 Action Plan 与 ContextReuseReceipt、任务结束后至少一项可审查的更新候选或"暂不更新"结论。**所有保底 Evidence 必须真实，禁止 Mock 冒充（PRD 11.3）。**

---

## 1. 问题、用户与成功指标（WHY）

### 1.1 目标用户与痛点

高频 AI 项目工作者（FDE 为灯塔 Persona，产品经理为内部 Dogfood）已经在用 Codex / Claude Code / WorkBuddy 等工具，但：

- 项目边界、决策规则、工作方法无法跨工具持续；
- 有价值的纠正、约束、方法藏在会话里，无法系统发现与审查；
- 模型记忆不透明（来源、版本、作用域、撤销能力缺失）；
- 换模型 / Agent / 项目后，个人经验带不走。

### 1.2 为什么现有方案不够（2026-08-09 核验的公开文档）

| 方案 | 解决 | 不解决 |
|---|---|---|
| Codex（Project/Thread） | 单工具内组织代码与会话 | 个人资产独立于 Project、跨入口复用、受控进化 |
| Claude Code（Memory/Session resume） | 单工具内记忆召回与会话恢复 | 资产级治理（Owner/版本/Evidence/回滚）、跨 Agent 传递证明 |
| WorkBuddy（Project/Skill/Workflow/Memory） | 单工具内执行与召回 | 双 Gate 验证、事件账本、版本冻结、诚实降级分级 |

**差异化结论（PRD §2.6）**：CogSeed 不重复"能建项目、有 Agent、能聊天"；必须证明的是——个人资产独立、跨入口使用、版本冻结、Evidence 回执、受控演进。**工程上对应五个能力：稳定资产 ID + 用户 Owner；跨入口能力包；TaskRun 版本冻结；Receipt/事件账本；KSTAR 双 Gate。**

### 1.3 成功指标（可量化，来自 PRD §11.5；目标值待用户研究校准，本文不虚构数值）

| 层级 | 指标 | 测量方式 |
|---|---|---|
| 首屏理解 | 5 秒价值理解率 | 可用性测试 |
| 首次 Aha | 60 秒能力接续完成率（Discovery 阈值，非 SLA） | 遥测埋点（reuse_receipt_viewed / action_plan_generated） |
| 传递质量 | 能力包带入正确率 | TransferReviewDecision 分布 |
| 归因质量 | 可比较运行比例 | Baseline/Treatment 隔离条件满足率 |
| 治理健康 | 撤销生效率、回滚成功率、重复骚扰率 | AssetEvent 账本统计 |
| 成本健康 | 单任务 token 成本、月均成本 | 模型调用遥测（新增，见 §9） |

---

## 2. Harness Engineering 框架映射（设计总纲）

> 检索来源（2026-08-10）：OpenAI 社区与工业界对 harness 的共识表述——"The model is commodity. The harness is moat."；模型是马、harness 是缰绳与鞍；Phil Schmid（Hugging Face）：模型是 CPU、harness 是操作系统；framework 是蓝图、harness 是工厂车间。同样的模型，两个团队任务完成率可相差 60% vs 98%，差异几乎全部来自 harness 质量。行业归纳的 Agent Harness 六大组件：上下文工程、工具编排、状态管理、验证循环、人在环控制、生命周期管理。

CogSeed 作为"个人认知资产 harness"，六组件映射如下——**每一组件都必须落在现有代码锚点上，禁止为映射而新建平行通道**：

| Harness 组件 | CogSeed 对应能力 | 现有代码锚点 | 8月19 前缺口 |
|---|---|---|---|
| ① 上下文工程（Context Engineering） | 最小 ContextProjection：按任务目的、OntologyContract、权限生成只读快照；不默认注入完整人物关系图/全部角色资产 | `features/recall/context-projection.ts`（buildRecallView / previewContextProjection，状态 preview/confirmed/deferred/rejected/expired/revoked） | 主导/辅助角色组合的投影优先级（FR-WSP-08） |
| ② 工具编排（Tool Orchestration） | core-agent 工具目录 + 本地 CLI Agent 调度 + MCP 连接器；全部经过路径沙箱与工具结果上限 | `features/local_agents/runner.ts`（唯一 CLI spawn 路径）、`features/connectors/mcp-client.ts`、`util/path-sandbox`、`util/tool-result-cap` | 目标 Agent"加载能力包并生成首个 Action Plan"的连接能力分级验证（FR-REU-04） |
| ③ 状态管理（State Management） | Session 持久事实容器 + Checkpoint + 事件账本 + TaskRun 版本冻结；崩溃后可恢复 | `features/execution-records.ts`（queued→running→completed/failed/cancelled/timed_out）、`features/kstar/episode-store.ts`、`features/workbench/main-skill-baseline.ts` | TaskContinuationSnapshot 最小版（决策项，见 §7.6） |
| ④ 验证循环（Verification） | KSTAR 双 Gate：R-hat 执行前冻结、R 独立记录、Delta/归因、Gate A 候选、Gate B 隔离复用；污染样本失效重跑 | `features/workbench/gate.ts`、`features/p3394/behavior-contrast.ts`、`features/kstar/episode-builder.ts`、`ExecutionBoundary: real/degraded/test-double` | CogSeed 正式 KSTAR 引擎的完整闭环（🔴-4，见 §16） |
| ⑤ 人在环控制（HITL） | 候选审查四决定、短确认语前指绑定、Skill 四分支建议、Receipt 与回滚入口 | `features/kstar/review-service.ts`、`features/kstar/requirement-*.ts`、`features/recall/proof-service.ts` | 短确认语 antecedent 绑定的全链路覆盖（FR-REV-03） |
| ⑥ 生命周期管理（Lifecycle） | 四类资产成熟度状态机（Confirmed→Transfer→Effectiveness→Paused/Revoked）、Workspace 引用升级策略（pinned/review_required/follow_latest） | `features/p3394/ability-assets.ts`、`features/evolution/versions-store.ts`、`features/evolution/patch-service.ts` | Workspace 引用升级建议的完整事件链（FR-WSP-09） |

**设计结论**：CogSeed 不是"再做一个 Agent"，而是**管理其他 Agent 及其产出的治理 harness**。模型可换、Agent 可换、工具可换——资产、版本、证据、回执属于用户。

---

## 3. 系统上下文与边界（AGENTS.md 合规约束）

### 3.1 进程与通信边界（强制）

```
┌────────────────────────────────────────────────────────────┐
│ Electron 主进程（Node + tsx/cjs hook）                       │
│                                                            │
│  ┌─────────────┐   IPC (invoke/stream)   ┌──────────────┐  │
│  │  Renderer   │◄────────────────────────►│  Main 域     │  │
│  │ vanilla JS  │   window.orkas.{invoke,  │  features/   │  │
│  │ 无 bundler  │   stream} 白名单         │  ipc/ 校验层  │  │
│  └─────────────┘                          └──────┬───────┘  │
│                                                   │          │
│  ┌────────────────────────────────────────────────▼───────┐ │
│  │ 领域层 features/：spaces · workbench · kstar · recall · │ │
│  │ cognition · p3394 · evolution · projects · role_templates│ │
│  └────────────────────────────────────────────────┬───────┘ │
│            │                    │                  │         │
│   ┌────────▼───────┐  ┌─────────▼───────┐  ┌───────▼──────┐  │
│   │ Mate Runtime   │  │ local_agents/   │  │ connectors/  │  │
│   │ Worker（唯一   │  │ runner.ts（唯一 │  │ mcp-client.ts│  │
│   │ spawn 路径：   │  │ CLI spawn 路径）│  │ （唯一 MCP   │  │
│   │ worker-process)│  │ Codex/Claude... │  │  stdio spawn）│  │
│   └────────────────┘  └─────────────────┘  └──────────────┘  │
└────────────────────────────────────────────────────────────┘
```

**强制约束（违反即架构违规，全部来自 AGENTS.md）：**

1. 无 HTTP server、无占用端口、主进程无本地鉴权层；
2. Renderer 访问只经 `window.orkas.{invoke, stream}` 白名单；preload.js 保持 `.js`；
3. `#core-agent` 只能动态 `import()`，静态导入破坏 SDK 超时补丁时序；
4. `sdk-timeout-patch.ts` 在 index.ts 中 logger 初始化后、feature 导入前执行；
5. 本地 CLI Agent 只能经 `local_agents/runner.ts` spawn；Runtime worker 只能经 `mate_agent_runtime/worker-process.ts` spawn，且内部工具执行只走 `kernel/tools/` 的 shell-tools.ts / skill-tools.ts → `bin/run-skill.cjs` 两个 choke point；MCP stdio 只经 `connectors/mcp-client.ts`；
6. 文件类工具入口必须 `util/path-sandbox.isPathAllowed`；工具结果走 `util/tool-result-cap`；
7. 新 core-agent 工具必须注册进 `tool-catalog.ts::TOOL_CATALOG`；工具描述放 SDK `tools[]`，不放 prompt 重复清单；
8. 启动期异步工作走 `util/boot_init.ts`；
9. 业务规则不进 ipc/；ipc/ 只校验参数并调用 features；
10. 新增 npm 依赖必须先讨论（当前依赖集已含 zod / better-sqlite3 / sqlite-vec / fastembed / async-mutex / electron-log / node-pty / yaml，8月19 范围预计无需新增重型依赖）。

### 3.2 外部依赖拓扑

| 外部依赖 | 用途 | 连接方式 | 降级链 |
|---|---|---|---|
| 本地 CLI Agents（Codex / Claude Code 等） | 源 Agent 会话读取、目标 Agent 执行 | `local_agents/runner.ts`（仅 spawn 路径） | native_session → exported_evidence（粘贴/文件）→ reference_only（只读能力包） |
| core-agent（内置） | LLM 调用与工具执行 | 动态 `import('#core-agent')` | 本地模型（Ollama 兼容端点）→ 候选降级为仅来源记录 |
| 资产治理 Backend | 云端夜间整理、组织资产治理（可选增强） | 明确为 Later，不进 8月19 承诺 | 本地主链路完全不依赖 |
| 免费/国内模型 API | 提取/候选低成本通道 | 现有 custom_providers / marketplace API-base 路由 | Feature Flag 控制，默认关闭 |

---

## 4. 总体架构分层

```
┌──────────────────────────────────────────────────────────────┐
│ L0 渲染层（renderer/）vanilla JS + CSS，无 bundler             │
│    spaces.js · onboarding.js · 认知树 · 候选卡 · 复用证明       │
└──────────────────────────┬───────────────────────────────────┘
                           │ window.orkas.{invoke,stream}（白名单）
┌──────────────────────────▼───────────────────────────────────┐
│ L1 IPC 适配层（ipc/）                                          │
│    校验参数（zod 或手工 safeId 检查）→ 调用 features → 返回      │
│    不持有业务逻辑；不直接读写 data/                             │
└──────────────────────────┬───────────────────────────────────┘
┌──────────────────────────▼───────────────────────────────────┐
│ L2 应用服务层（features/* 业务工作流）                          │
│    spaces · workbench(task-run/gate/action-plan/main-skill)   │
│    recall · cognition · kstar · evolution · p3394(能力资产/    │
│    receipt/behavior-contrast) · projects · role_templates     │
│    local_agents · connectors · expense_workbench              │
└──────────────────────────┬───────────────────────────────────┘
┌──────────────────────────▼───────────────────────────────────┐
│ L3 基础设施与支撑（storage · paths · logger · locks ·          │
│    path-sandbox · log-redact · boot_init · tool-result-cap ·  │
│    execution-records · mate_agent_runtime worker）             │
└──────────────────────────┬───────────────────────────────────┘
┌──────────────────────────▼───────────────────────────────────┐
│ L4 存储（<container>/data/<uid>/{cloud,local}/）               │
│    JSON/JSONL 事实源 + sqlite(sqlite-vec) 向量库（仅 KB）       │
└──────────────────────────────────────────────────────────────┘
```

**依赖方向（单向）**：L0→L1→L2→L3→L4。`util/` 禁止反向 import features/model；`model/` 不读写 data/；`i18n.ts` 只读 locales。

**现有代码锚点核对**：上述分层与现状一致（ipc/ 目录、features/ 目录、storage.ts/paths.ts/logger.ts 均存在且职责匹配）。**本架构不引入新分层，只收敛既有模块的边界。**

---

## 5. 核心域模块设计（现状锚点 + 缺口 + 设计）

> 每个模块给出：职责 / 现有代码 / 关键数据 / 错误路径 / 8月19 缺口。遵循 architecture-design 原则：新模块给伪代码与数据结构，既有模块只记增量。

### 5.1 空间（Workspace）

**现状**（`features/spaces.ts`，513 行）：`Space { space_id, name, icon, primary_template_id, secondary_template_ids(≤2), extra_skills[], extra_agents[], created_at, updated_at }`；资源解析 = 模板 bundle ∪ extra，过滤失效、去重保序（`resolveSpaceResources`）。CRUD 齐全。

**PRD 要求**（§0.6.5/§3.4）：空间是"持续成果或工作领域"容器；用户唯一主体；资产归用户、空间只引用；一个主导角色 + 若干辅助角色；TaskRun 冻结版本；引用升级建议。

**缺口与设计**：

| 缺口 | 设计 | 8月19 |
|---|---|---|
| 空间类型（complex_project/professional_work/recurring_routine/temporary_task） | `Space` 增加 `space_type: string` 枚举字段（缺省 complex_project），数据迁移默认值 | 🟡 可后置，但 Gate 验收需标记类型 |
| 持续目标（唯一） | 增加 `sustained_outcome: string` 字段 + 创建时校验非空；列表页首屏展示 | 🟡 可后置 |
| 上架 Gate 状态 | 增加 `gate_status: 'not_checked'|'passed'|'failed'`；`features/workbench/gate.ts` 已有 Gate 检查逻辑可复用 | ✅ 保底验收要用 |
| Main Skill 绑定 | 空间挂 `main_skill_ref: AssetRef`（复用 `workbench/main-skill-baseline.ts` 的 AssetRef 契约，只引用不复制） | 🔴 保底必需 |
| 资产引用版本策略 | 增加 `asset_reference_bindings: { asset_ref, version, policy: 'pinned'|'review_required'|'follow_latest_compatible' }[]`；默认 review_required；TaskRun 启动时快照 | 🔴 保底需最小版（冻结+建议） |
| Workspace 升级建议事件链 | 新版本发现 → `workspace_asset_update_suggested` 事件 → 用户 accepted/deferred/pinned → 仅影响后续 TaskRun | 🟡 完整目标 |

**错误路径**：name 重复/过长（已有 SpaceError）；引用的技能/Agent 失效（已有 invalid_refs 清理）；gate 未过禁止展示（渲染层 + 列表接口双重过滤）。

### 5.2 Main Skill Baseline（核心，已实现）

**现状**（`features/workbench/main-skill-baseline.ts`，369 行）——**PRD §8.2 的核心契约已落地，本架构将其定为不可动摇的契约基线**：

- `MainSkillBaseline { baseline_id, skill_ref: AssetRef(asset_id/version/content_hash), source: 'workspace-builtin'|'external-admitted'|'session-draft-confirmed', action_plan_ref?, ontology_binding_ref?, evaluation_contract_ref?, frozen_at, frozen_by: 'user' }`
- 冻结先于执行（RG-S3-15）；冻结后不可变；漂移检测（content_hash 重算）；用户唯一可冻结；引用不复制。
- 存储：`<uid>/local/kstar/baselines/<baseline_id>.json`（单文件，机器私有，无聚合索引）。
- 哈希复用 `util/marketplace-tree-hash`（跨语言契约、跳过 .DS_Store/_install.json）。

**8月19 缺口**：`evaluation_contract_ref` 指向的 Evaluation Contract 对象本身需要最小落地（success_criteria + 版本），供 Gate A 使用（见 5.4）。

### 5.3 TaskRun 与执行生命周期（已实现桥接）

**现状**（`features/workbench/task-run.ts`，276 行）：TaskRun 是**桥接器**而非新存储——基线未验证不启动；执行状态在 `features/execution-records.ts`；任务进度派生不存储；`TaskRunRole: 'agent-a'|'agent-b'` 是运行时角色，vendor（codex 等）是 `ExecutionKind` 执行身份，二者分离（PRD US-20 AC5 不硬编码厂商）。

**设计确认**：
- 执行记录 = record + append-only events + artifact refs（已有 `ExecutionRecord/ExecutionEvent/ExecutionLifecycleSink`）；
- `ExecutionBoundary: 'real'|'degraded'|'test-double'` 三态——**这是测试与降级的统一机制，禁止另建测试通道**；
- 运行中资产版本引用不可变：`task-run.ts` 启动时快照 `asset_version_refs`（需补：从空间引用绑定读取冻结集）。

**8月19 缺口**：TaskRun 启动时从空间 `asset_reference_bindings` 读取并冻结版本集；运行结束后生成"更新候选或暂不更新"结论的事件链（连接 `evolution/recommend-service.ts`）。

### 5.4 KSTAR 子系统（双 Gate 验证循环）

**现状**（`features/kstar/` + `features/p3394/kstar-*`）：
- Episode：`episode-builder.ts` / `episode-store.ts`；Requirement 状态机：`requirement-router/state/closure/store/types`；
- Review：`review-service.ts` / `review-inference.ts` / `review-card.ts`；
- p3394：`kstar-adapter.ts` / `kstar-factory.ts` / `kstar-store.ts` / `kstar-lock.ts` / `kstar-migration.ts`（legacy 数据迁移）/ `kstar-recovery.ts` / `behavior-contrast.ts`；
- Gate：`workbench/gate.ts`（168 行）。

**设计确认**：
- KSTAR 四层粒度（信号/Episode/候选/进化）与 PRD §8.5 一致；
- R-hat 冻结 → R 独立记录 → Delta/归因 → Gate A → 隔离复用 → Gate B 的管线已有骨架；
- **污染检测**（invalid_expected_result_contamination）已作为 REWORK 语义存在（RG-S3-15）。

**8月19 缺口**：CogSeed 正式 KSTAR 引擎的端到端闭环验证（R-hat 冻结 → Delta → 候选 → 用户四决定 → 版本写入），需以真实 TaskRun 跑通 Gate A 一次（见 §16 已知限制 🔴-4）。

### 5.5 认知候选管道（cognition/ + recall/）

**现状**：
- `features/cognition/`：assets-adapter / candidates-adapter / receipts-adapter / capture-draft / normalize / dashboard / skill-summary——候选与资产的对象适配层；
- `features/recall/`：source-catalog / capture-service / teaching-service / context-projection / proof-service / prompt-injection / timeline-service / recall-view-service——来源、捕获、投影、证明。
- `features/cognition_extraction.ts`（git status 显示正在修改）。

**设计确认**：
- 五类来源（conversation/artifact_file/execution_evaluation/user_teaching_signal/authorized_external_system）→ 统一候选管道 → 四类正式资产或非资产对象；
- 来源授权：PermissionDecision 先行，未授权只显示元数据；
- 候选去重与拒绝抑制（同一 Evidence 不重复骚扰）；
- 首次 Aha 候选上限 3 条（成本控制，见 §9）。

**8月19 缺口**：候选审查"四决定"（保存/修改/暂缓/拒绝）与"短确认语 antecedent 绑定"的端到端验证（FR-REV-02/03）；候选去重抑制的真实样本。

### 5.6 事件账本与资产视图（先事件后视图）

**设计（PRD 原则 13/14，§9.4 最小事件表）**：

```
资产状态变化请求
  → 校验权限与当前版本
  → 持久化 AssetEvent（appendJsonlAtomic，append-only）
  → 生成 AuditReceipt（含 before/after refs）
  → 更新 AssetViewProjection（派生视图，可重建）
  → 更新 UI / 提示 / 成长动画
  任一失败 → 界面保持原状态 + 提示重试（不展示"已保存/已发芽"）
```

- 事件账本 = `<uid>/cloud/mate_agent/<domain>-events.jsonl`（append-only，原子追加；`storage.ts::appendJsonlAtomic` 已有）。
- 树/列表/历史/关系视图必须消费同一账本（FR-TREE-03），禁止各维护独立状态。
- 失败注入测试：事件写入失败 → Receipt 失败 → 视图不更新（测试策略见 §12）。

**8月19 缺口**：最小事件账本落地（资产状态四事件：user_confirmed / transfer_verified / effectiveness_validated / scope_changed）+ 失败注入测试；`evolution/versions-store.ts` 已有版本谱系，需接到账本。

### 5.7 任务接续快照（TaskContinuationSnapshot）

**现状**：无独立实现（PRD FR-WSP-07 / FR-CNT-01~10 为 Sprint 3/4）。

**设计（最小可用版，若纳入保底——决策项，见 §16 🔴-1）**：

```
TaskContinuationSnapshot {
  snapshot_id, workspace_ref, task_ref,
  task_goal, current_phase,
  source_session_refs[], source_versions[],       // 只引用已提交版本
  confirmed_fact_refs[], confirmed_decision_refs[],
  pending_question_refs[], rejected_option_refs[],
  latest_artifact_refs[],
  active_constraint_refs[], relationship_refs[], asset_refs[],
  next_actions[],
  created_by, generated_at, expires_at, scope, permissions, sensitivity,
  status: draft|user_confirmed|issued|consumed|superseded|expired|revoked,
  receipt_ref
}
```

- 只从已提交 Session 版本 / Checkpoint / 事件游标派生（`execution-records` + `kstar/requirement-store` 已提交状态）；
- 同一 Task 仅一个 issued 当前版本；新快照签发 → 旧版 superseded；
- 目标 Agent 使用前必须先生成任务理解 + Action Plan（FR-CNT-06）；
- 每次实际使用生成 ContextReuseReceipt。

### 5.8 关系断言（RelationshipAssertion）

**现状**：`personal_ontology_*` 系列存在（candidates/groups/router/template_files），但受控谓词引擎未实现（FR-REL-01~08 为 Sprint 3/4）。

**设计要点**：非资产对象；稳定实体 ID + 可撤销别名合并；受控谓词（reports_to 等 10 个）闭集；candidate/user_confirmed/corroborated/conflicted 状态；冲突不静默覆盖；**禁止从 prepares_for/works_with 推断 reports_to**（负向测试强制）。8月19 仅做最小谓词（prepares_for 等 2-3 个）+ 最小投影。

### 5.9 跨空间绑定与外部执行映射（v1.6 新方向）

**明确不进 8月19**（PRD 11.3：蓝图/联邦/社区除非已实现并经 Refinement 显式纳入，否则不自动进承诺）。架构上预留：`WorkspaceContextBinding`（只读/最小/版本化/限时/可撤销）与 `ExternalExecutionBinding` 作为 `Space` 的引用字段扩展，**数据模型先行、UI 后置**。

---

## 6. 数据层设计

### 6.1 存储选型（强制）

| 数据 | 存储 | 理由 |
|---|---|---|
| 会话/消息/事件账本 | JSONL（append-only + 原子追加） | 可读、可审计、同步友好；`appendJsonlAtomic` 已实现 |
| 资产/空间/基线/角色模板 | 单文件 JSON（版本化 + content_hash） | 单写者、易迁移、可回滚 |
| KB 向量库 | sqlite（sqlite-vec + fastembed） | 向量检索唯一用途；AGENTS.md 保留项 |
| 运行现场/窗口/临时状态 | 不持久化（RuntimeState 排除项） | PRD §3.3 |

### 6.2 数据路径布局（现状 + 扩展）

```
<container>/data/<uid>/
├── users.json / logs/                        # 顶层仅允许这些
├── cloud/mate_agent/                         # 可同步的用户私有状态
│   ├── tasks/ task-events/ sessions/ requests/
│   ├── execution-records/                    # 执行记录 + 事件 + artifacts
│   ├── connectors/                           # 连接器元数据
│   ├── coordinations/                        # 协调/联邦
│   ├── kb/sources/                           # 知识库源文件
│   └── <domain>-events.jsonl                 # 资产事件账本（新增）
├── local/mate_agent/                         # 机器私有
│   ├── connectors/                           # 含 token 的 grant 数据（secrets_enc）
│   ├── kb/vector/                            # sqlite 向量库
│   └── worker-state/                         # last-recovery.json 等
├── local/kstar/
│   ├── baselines/<baseline_id>.json          # 已实现
│   └── episodes/ / candidates/               # 已实现（kstar-store/episode-store）
└── cloud/mate_agent/artifacts/...            # 现有 artifact 体系
```

**规则**：uid 是单路径段不解析；不得缓存 uid 派生路径为模块常量（运行时取）；`cloud/` 是可同步状态、`local/` 是机器私有状态——**机器私有数据（baseline、向量库、worker-state）绝不标脏同步**。

### 6.3 数据迁移策略（用户硬要求）

| 场景 | 策略 |
|---|---|
| Space 增加 space_type/sustained_outcome/gate_status 字段 | 读时默认值 + 写时补齐（`resolveSpaceResources` 模式）；无破坏性重写 |
| baseline 契约演进 | 只增字段；`kstar-migration.ts` 已有 legacy 数据迁移通道 |
| 既有 Project → 空间 | 前台入口统一，底层 ProjectContext 保留；`ExternalExecutionBinding` 映射；迁移映射表 + 回滚（FR-WSP-10，Sprint 4） |
| 版本不兼容 | 每个资产对象带 schema_version；读取时按版本路由解析器；迁移先行验证 + 旧版本备份 |
| 目录结构变更 | `paths.ts` 单一事实源；变更走 deprecation 窗口（旧路径读 + 新路径写，双写日志） |

**迁移原则**：所有迁移必须 (a) 可回滚；(b) 幂等；(c) 有迁移前后哈希对比证据；(d) 不迁移用户已确认资产的 Owner/内容。

---

## 7. 并发与一致性

### 7.1 并发模型

- **单进程 + async 单线程**执行模型（Electron 主进程）；CPU 重活（ONNX 向量化等）走 `mate_agent_runtime` worker 子进程隔离（禁止 worker_threads 多 ONNX session）。
- 文件级互斥：`util/locks`（fileEditLock）+ `async-mutex`（已依赖）；JSONL 追加天然串行（单进程内 append 顺序即事件顺序）。
- 跨文件事务：事件账本 → Receipt → 视图投影三步，**以"事件写入成功"为提交点**；视图投影失败可重建（幂等）。

### 7.2 一致性契约（PRD 硬规则映射）

| 规则 | 实现机制 |
|---|---|
| TaskRun 启动冻结 asset_version_refs；运行中不静默切换 | task-run 启动时从空间引用绑定快照；运行中只读 |
| 同一 Task 仅一个 issued 快照 | 签发时 CAS 检查当前 issued 状态；并发签发冲突 → 阻断并提示（AC-CNT-04 并发测试） |
| 同一资产一条事件账本 | 账本按 asset_id 分区（`<asset_id>.jsonl`）；视图全部派生 |
| 短确认语唯一前指 | antecedent_ref 绑定；歧义 → review_decision_unresolved，资产零变化 |
| 资产引用升级只影响后续 TaskRun | 升级事件带生效游标；历史 TaskRun 版本快照不受影响 |

### 7.3 死锁与长任务

- 不在锁内调用 LLM（模型调用移出锁区，锁只保护文件写）；
- 长任务（夜间整理、批量提取）走 worker 隔离 + 状态机（scheduled/running/delayed_device_unavailable/completed/failed/cancelled），不阻塞主进程；
- 用户中止是唯一全局停止路径（群聊 abort 语义），不做 wall-clock 超时。

---

## 8. 故障恢复

### 8.1 崩溃恢复

- `worker-state/last-recovery.json`（已有）：记录最近一次可恢复状态；
- execution-records 状态机：进程崩溃后启动时扫描 `running` 记录 → 标记 `timed_out` 或恢复为可重试（按 ExecutionBoundary 分级）；
- 事件账本 append-only：崩溃最多丢"未落盘的一次视图更新"，事实源不丢；
- 资产写路径：临时文件 + rename（`writeJson`/`writeTextAtomicSync` 已原子化）。

### 8.2 幂等与重试

- 执行/事件/Receipt 均带稳定 ID（executionId/eventId/receiptId），重复投递按 ID 去重；
- `appendJsonlAtomic` 返回是否已追加（防重复写）；
- 外部 Agent 调用：网络失败重试仅限网络语义（PRD：用户中止不是 transient retry）；连接失败走降级链。

### 8.3 降级链（PRD §10.2 失败状态 → 系统处理）

| 失败 | 降级 | 证据 |
|---|---|---|
| Agent 未安装/未登录 | 本地检查提示，不索要凭证 | 失败文案 + 日志 |
| Session 不可读 | exported_evidence：粘贴/文件导入候选 | access_mode 标记 |
| 目标工具仅参考文件 | reference_only：能力包只读，不冒充原生执行 | 能力等级 + 主张检查 |
| 设备夜间不可用 | delayed_device_unavailable；下次可运行继续 | NightlyDigest 状态 |
| 候选证据不足 | 暂不学习，保留待验证 | no_change 回执 |
| 基线漂移 | 拒绝启动 TaskRun（baseline_drift） | 哈希对比 Evidence |
| 事件/Receipt 写入失败 | 界面保持原状态 + 重试 | 失败注入测试 |
| 本地数据损坏 | 从最后有效版本恢复 + Known Issue 记录 | 恢复日志 |
| 负迁移 | 停止默认推荐 + 建议暂停/回滚 | 回滚点 |

### 8.4 回滚

- 资产版本回滚点：`evolution/versions-store.ts` + `patch-service.ts`（已有版本谱系）；
- Baseline 不可变 → 回滚 = 引用旧 baseline_id（不覆盖）；
- 引用升级失败 → 保留旧版本 + 冲突/回滚/重试 Evidence（FR-WSP-09 规则 5）。

---

## 9. 成本模型（用户硬要求，必须量化）

### 9.1 单操作 token 估算（以主流中端模型价 ~$1/M input、$8/M output 为参考；最终以实际选择模型校准）

| 操作 | 输入 token | 输出 token | 估算成本 | 关键路径? |
|---|---|---|---|---|
| 候选提取（首次 3 条，单 Session） | 8–15K（会话摘要+规则注入） | 1–2K | $0.02–0.03 | ✅ 60 秒 Aha |
| 候选审查辅助（去重/分类） | 2–4K | 0.3–0.5K | $0.005–0.01 | ❌ 后台 |
| 能力包组装 + 目标 Action Plan | 5–10K | 1–2K | $0.02–0.04 | ✅ 60 秒 Aha |
| 复用证明生成（Receipt 摘要） | 2–3K | 0.5K | $0.005 | ✅ |
| KSTAR Episode 评价（R-hat + Delta + 归因） | 5–10K | 1–2K | $0.02–0.04 | ❌ 任务后 |
| 夜间整理（每 Session） | 10–20K | 1–3K | $0.03–0.07 | ❌ 后台 |
| Skill 更新候选（Diff + 建议） | 5–8K | 1–1.5K | $0.02 | ❌ 任务后 |

**60 秒 Aha 主链路合计**：~15–28K input + ~2.5–4.5K output ≈ **$0.04–0.08/次**。

### 9.2 月度规模投影

| 场景 | 月操作数 | 月成本（中端模型） |
|---|---|---|
| 个人重度用户（10 任务/月 + 夜间整理 20 Session） | ~40 次 | $2–5 |
| 团队验证（50 任务/月） | ~200 次 | $10–25 |
| 万级用户（10K 活跃 × 15 次） | 150K 次 | $6K–12K |

### 9.3 成本控制机制（设计约束）

1. **首次 Aha 候选上限 3 条**（PRD §4.3）——提取成本硬顶；
2. **模型分级**：提取/候选/摘要走低成本通道（国内模型/免费额度，Feature Flag 控制）；KSTAR 评价与 Skill Diff 走强模型；默认配置可在设置中调整；
3. **no_change 是合法结论**：无新 Evidence 不重复触发提取（去重抑制）；
4. **夜间整理限量**：单夜 Session 上限 + 失败即停；
5. **本地模型降级**：Ollama 兼容端点（AGENTS.md 允许的 custom_providers 路由）作为离线成本归零选项；
6. **遥测成本**：模型调用计数 + 单任务成本上报（匿名，仅计数与量级），异常成本告警阈值。

---

## 10. 安全与隐私

### 10.1 安全边界

- **凭证**：CogSeed 不接收、不保存外部 Agent 登录凭证；本地 token/密钥不入认知资产、日志、公共仓库（PRD §10.4）；connector 含 token 数据放 `local/connectors/` 加密区（secrets_enc 模式）；
- **路径沙箱**：所有文件类工具 `isPathAllowed` 入口校验（已强制）；
- **工具结果上限**：`tool-result-cap`（已强制）；
- **最小外发**：ContextProjection 只含任务所需子图；跨产品只发最小 AssetPackage；
- **供应链**：社区蓝图 Gate（来源/许可证/依赖/安全/最小运行 Evidence）——SCR-06 默认隐藏，不进 8月19。

### 10.2 隐私

- 授权先行：PermissionDecision 记录可查可撤；未授权只显示元数据；
- 敏感过滤：扫描前后安全过滤 Evidence（FR-SRC-03）；
- 匿名化合成示例：PRD/Demo/模板/社区一律合成数据，真实 Dogfood 只进受控验收材料（PRD §10.5）；
- 数据保留：本地来源索引/候选/资产保留周期用户可配；删除来源不自动删已确认资产（保留"来源已删除"状态）。

---

## 11. 可观测性

- **日志**：`createLogger('<module>')` 统一；可恢复失败 warn、不变量破坏 error；敏感字段 `log-redact`（maskId/logErrorRef）后输出；
- **遥测**：Monitor.click/event/error/identify，payload 仅 id/类型/计数/量级；本地链路事件（reuse_receipt_viewed、action_plan_generated、transfer_reviewed、outcome_evaluated）为产品指标埋点；
- **审计**：AssetEvent + AuditReceipt 即审计事实源（不另建审计系统）；
- **诊断**：KSTAR 详情页专家 Evidence 抽屉（PRD §8.5）直接读 Episode 记录，不复制数据。

---

## 12. 测试策略

### 12.1 分层测试

| 层 | 工具 | 覆盖 |
|---|---|---|
| 单元/纯函数 | vitest（`npm test` 统一入口，脚本管理 sqlite ABI 交换） | baseline 哈希、候选分流、快照状态机、关系谓词负向测试、成本计算 |
| 契约测试 | vitest + fixtures | baseline 冻结时序（先冻结后执行）、事件→Receipt→视图失败注入、短确认语前指歧义、JSONL 幂等追加 |
| 集成 | `npm test`（run-tests.mjs） | 空间 CRUD + 资源解析、TaskRun 全链路（Mock 执行）、KSTAR Gate A/B 管线 |
| 端到端 | `scripts/smoke-p3394-real-execution.mjs`（已有）+ 新 smoke | 保底切片：真实来源→候选→能力包→目标 Action Plan→Receipt |
| 平台原生 | run-platform-native-tests.mjs | macOS/Windows 分支 |
| 资源测试 | run-python-tests.mjs | builtin 技能脚本（run-skill.cjs 契约） |

### 12.2 关键测试纪律（AGENTS.md + PRD）

- **不测**：类型包装、平凡 getter、纯 happy path、实现内部细节；
- **必测**：业务不变量、恢复路径、并发、跨层契约、文本处理陷阱；
- **LLM 输出解析器**：真实形状 + 拒绝外观相似物两套夹具（PRD §0.3 原则）；
- **污染样本**：RG-S3-15 要求重新运行被污染的 KSTAR Evaluation 样本，Expected/Observed 独立且完整性通过才进 Gate A；
- **Mock 双模**：`ExecutionBoundary: test-double` 下全链路可跑；外部依赖 mock 契约合规；
- **隐私测试**：合成夹具通过不代表获授权发布真实案例（PRD §10.5）。

### 12.3 质量门（Quality Gates）

- typecheck（tsc --noEmit）→ npm test → smoke:p3394 → 人工验收（Submitted/Verified/Accepted 分层，Workspace 骨架/Mock/文档声明不计为通过）。

---

## 13. Feature Flag 与渐进上线（用户硬要求）

| Flag | 默认 | 说明 |
|---|---|---|
| `p3394.baseline.gate` | on | Baseline 冻结+漂移拒绝（保底核心） |
| `p3394.candidate.extract` | on | 候选提取（保底核心） |
| `p3394.receipt` | on | 复用回执（保底核心） |
| `p3394.skilllifecycle` | on（最小分支） | 创建/调用/更新/暂不更新四分支建议（完整目标；8/19 按 Evidence Scope Cut） |
| `p3394.rolecomposition` | off | 主导/辅助角色组合（Sprint 3/4） |
| `p3394.snapshot` | off（决策项） | 任务接续快照（Sprint 3/4 或保底最小版） |
| `p3394.relationship` | off | 关系断言最小谓词（Sprint 3/4） |
| `p3394.nightly` | off | 本地夜间整理（条件增强） |
| `p3394.realtime` | off | 实时发现（条件增强） |
| `p3394.blueprint` | off | 空间蓝图安装（Later） |
| `p3394.federation` | off | 跨空间联邦（Later） |
| `p3394.community` | off | 社区（SCR-06 隐藏，Later） |
| `p3394.kstar.gateb` | off | Gate B 隔离复用验证（Sprint 3 完整目标） |

**渐进上线规则**：flag 开关必须 (a) 渲染层与主进程双读同一配置；(b) 关闭时对应 UI 入口不渲染（不展示空壳）；(c) 每个 flag 有关联 AC；(d) 灰度节奏由 Refinement 决定，不进 PRD。

---

## 14. 部署与打包

- **开发模式**：`./run.sh` → tsx hook 直跑 src/（改码即生效）；`npm test` / `npm run typecheck` 门禁；
- **生产模式**：electron-builder 打包 asar；`scripts/package-dev-mac.cjs` 已有 dev 打包验证通道；
- **runtime-variants**：`ORKAS_WORKSPACE_ROOT` 指向 `~/.orkas/runtime-variants/<variant>/data/`；重启脚本 `scripts/restart-mate.sh`；
- **发布前置**（PRD §0.4）：Release Owner 任命 + 安全/合规 + 可追溯构建（Build/Commit/Tag）+ Known Issues；缺失任一不得公开发布二进制；
- **签名/公证**：macOS 签名与公证是发布 Gate（Tech Lead 评估）。

---

## 15. 实现路线图（对齐 8月19）

| 阶段 | 内容 | 退出 Evidence |
|---|---|---|
| P0 保底（8/19 Must） | ① 空间 gate_status + main_skill_ref；② Baseline→TaskRun 冻结全链路；③ 候选提取（≤3 条）+ 审查四决定；④ 能力包→目标 Action Plan→Receipt；⑤ 更新候选/暂不更新结论；⑥ 一条真实链路 + 一个 Workspace 上架；⑦ 最小事件账本 + 失败注入 | smoke:p3394 真实执行 + 录屏 + 事件账本 |
| P1 完整目标 | 角色组合、Skill 生命周期四分支、快照（决策项）、关系最小谓词、Gate B 验证 | AC-S3-01~34 对应切片 |
| P2 条件增强 | 实时发现、夜间整理、菜单栏捕获、FDE/职场事务 Workspace 上架 | 对应 FR 验收 |
| P3 Later | 蓝图、联邦、社区、跨设备同步 | — |

---

## 16. 已知限制（诚实声明）

| # | 限制 | 严重度 | 技术说明 | 缓解 |
|---|---|---|---|---|
| 1 | 保底切片不含任务接续快照，"复杂项目接续"在保底中无法完整验证（PRD 11.3 vs FR-CNT） | 🔴 高 | 快照是 Sprint 3/4 承诺；保底验证的是"能力包传递"而非"复杂项目接续" | 决策项：保底主张降级 或 快照最小版入保底（§5.7 设计已就绪） |
| 2 | 真实连接链路未验证（受支持 Agent 名单/能力分级/Connector） | 🔴 高 | 保底命门；FR-ONB-02/FR-REU-04 是 Must 但依赖开放 | 连接 Spike 决策 Gate（如 8/12）：通过→原生链路；未通过→exported_evidence 保底 + 主张降级 |
| 3 | CogSeed 正式 KSTAR 引擎完整闭环未验证 | 🔴 高 | KSTAR 版 Hermes 明确为参考实现；Gate A 管线（R-hat→Delta→归因→候选）需本工程自证 | Sprint 计划显式安排引擎闭环验证任务；或 Gate A 完整闭环砍出 8/19 |
| 4 | 成本模型为估算，未实测校准 | 🟡 中 | §9 估算基于中端模型参考价 | P0 阶段埋点实测；超过预算阈值触发 Scope Cut |
| 5 | 认知树成长与有效性证明长期脱节（真实工作难做 Baseline/Treatment） | 🟡 中 | 大多数资产将长期停在 Transfer Verified | 显式接受该权衡；以传递证明积累为成长信号（不造假） |
| 6 | 60 秒 Aha 的候选确认 UX 是激进假设 | 🟡 中 | 五段式候选卡 + 作用域确认 + 目标 Agent 选择在 60 秒内完成 | Round A 干跑测试；"完成率低=确认环节设计问题"解读护栏 |
| 7 | 关系/快照机制被列进 8月19 完整目标但 FR 属 Sprint 3/4（PRD 11.3 vs 11.2） | 🟡 中 | 范围纪律裂缝 | Refinement 显式 Scope Cut；依赖未就绪 Gate 自动降级 |
| 8 | 既有 Project→空间迁移仅概念级 | 🟡 中 | FR-WSP-10 一句话；迁移 AC/回滚缺失 | Sprint 4 补迁移映射表 + 回滚测试 |

---

## 17. 附录

### 附录 A：概念 → 代码映射表（核心）

| PRD 概念 | 代码锚点 | 状态 |
|---|---|---|
| Workspace | `features/spaces.ts`（Space CRUD + 资源解析） | ✅ 有，缺 type/gate/asset-refs |
| Main Skill Baseline | `features/workbench/main-skill-baseline.ts` | ✅ 已实现（冻结/哈希/不可变） |
| TaskRun | `features/workbench/task-run.ts` + `execution-records.ts` | ✅ 已实现桥接 |
| Gate A/B | `features/workbench/gate.ts` + `p3394/behavior-contrast.ts` | ✅ 有骨架 |
| KSTAR Episode | `features/kstar/episode-builder/store.ts` + `p3394/kstar-*` | ✅ 有实现 |
| 候选管道 | `features/cognition/*` + `recall/capture-*` | ✅ 有实现 |
| ContextProjection | `features/recall/context-projection.ts` | ✅ 有实现 |
| 复用证明 Receipt | `features/p3394/context-reuse-receipt.ts` + `recall/proof-service.ts` | ✅ 有实现 |
| 四类资产 | `features/p3394/ability-assets.ts` + `evolution/versions-store.ts` | ✅ 有实现 |
| 事件账本 | 无（`storage.ts::appendJsonlAtomic` 可支撑） | 🔴 新增（P0） |
| TaskContinuationSnapshot | 无 | 🔴 新增（决策项） |
| RelationshipAssertion | 无（`personal_ontology_*` 有邻近实现） | 🟡 新增（Sprint 3/4） |
| 跨空间/蓝图/社区 | 无 | Later |

### 附录 B：端到端示例（保底切片走查）

1. 用户在本机 Codex（已登录）推进一个交付项目；CogSeed 首页"继续最近的工作"；
2. 系统列出最近来源 → 用户授权读取（PermissionDecision 落盘）；
3. 提取 ≤3 条候选（低成本模型通道）+ 推荐"跨Agent项目接续与验收 Skill v1.0"；
4. 用户确认候选与作用域（ReviewDecision 带 antecedent_ref）；
5. 空间（complex_project，gate_status=passed）绑定 Main Skill Baseline（冻结：skill_ref + content_hash + evaluation_contract_ref）；
6. 形成 MinimumCapabilityPack（Ontology 切片 + 规则 + 模板 + 权限）；
7. 目标端（Claude Code 或隔离新 Session）真实加载 → 输出任务理解 + 首个 Action Plan；
8. CogSeed 生成 ContextReuseReceipt（用了什么/来自哪/计划变化），展示"复用证明"；
9. 用户即时校验（带入正确/需要调整/不该带入）→ TransferReviewDecision；
10. 任务结束 → OutcomeEvaluation（四选一）；KSTAR 生成更新候选或"暂不更新"结论（no_change 合法）；
11. 用户决定 → 新版本或维持原状；AssetEvent → Receipt → 视图更新（先事件后视图）；
12. 全过程事件账本可审计；任何一步失败按 §8.3 降级链处理，绝不冒充成功。

---

## 18. 待确认决策（进入 Decision Backlog）

| # | 决策 | 默认（未决前） | 截止 |
|---|---|---|---|
| D-1 | 保底主张：能力包传递（降级）还是含快照最小版的复杂项目接续 | 主张降级为"能力包传递"；快照留 Sprint 3 | 8/12 |
| D-2 | 真实连接 Spike 结果与保底链路选择 | exported_evidence 保底，主张如实分级 | 8/12 |
| D-3 | CogSeed 正式 KSTAR 引擎闭环是否入 8/19 | 入保底仅"候选+暂不更新"；Gate A 完整闭环待 P1 | 8/14 |
| D-4 | 模型通道默认配置（提取走低成本模型？KSTAR 评价走强模型？） | 提取/候选走低成本；评价走强模型；均可设置覆盖 | 8/14 |
| D-5 | 成本预算上限（月/用户） | $5/用户/月（中端模型）；超限触发 Scope Cut | 8/14 |
