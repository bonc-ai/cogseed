# CogSeed P0 保底实施计划（8月19 发布保底切片）

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** 让"一条真实任务、一条受支持来源路径、一个通过上架 Gate 的空间（复杂项目交付）、一个冻结的 Main Skill Baseline、一次目标端真实加载并产出 Action Plan 与 ContextReuseReceipt、任务结束后至少一项可审查的更新候选或暂不更新结论"全部真实跑通，并具备事件账本审计与失败注入保护。**保底 Evidence 必须真实，禁止 Mock 冒充（PRD 11.3）。**

**上游架构文档：** `docs/superpowers/specs/2026-08-10-cogseed-production-architecture.md`（§5 缺口、§13 Feature Flag、§18 决策）

**决策依赖（未决前采用保守默认，见架构文档 §18；D-1 是产品主张决策，须 PO 显式确认后计划才可冻结）：**
- D-1 快照是否入保底 → 默认**不入**（保底主张=能力包传递）⚠️ **产品主张降级，工程计划不能替 PO 拍板——需 Sponsor/PO 在 8/12 前确认**
- D-2 真实连接链路 → 默认先以 test-double/exported_evidence 打通开发，8/12 连接 Spike 后切换真实；保底 Evidence 仍必须真实
- D-3 KSTAR 引擎闭环 → 默认保底只做"候选+暂不更新"；Gate A 完整闭环在 P1
- D-4/D-5 模型通道与成本预算 → 默认提取走低成本通道，上限 $5/用户/月（Task 8 实测校准）

**Tech Stack:** TypeScript、Vitest（`npm test` 统一入口）、现有 `writeJson`/`appendJsonlAtomic`/路径 helpers、现有 `{ ok, ... }` IPC 契约、现有 ExecutionBoundary（real/degraded/test-double）。**不新增 npm 依赖。**

---

## Scope guard（本计划不做）

- ❌ TaskContinuationSnapshot（等 D-1；最小版设计已在架构文档 §5.7 就绪）
- ❌ RelationshipAssertion 受控谓词（Sprint 3/4）
- ❌ 角色组合 UI / active_role_composition（P1）
- ❌ 夜间整理、实时发现（条件增强）
- ❌ 蓝图安装、跨空间联邦、社区（Later）
- ❌ KSTAR Gate B 完整闭环（P1，D-3）
- ❌ 渲染层大改：只做空间 gate 展示过滤与必要字段透传
- ❌ 新增 npm 依赖、HTTP server、新 spawn 路径（AGENTS.md 强制）
- ❌ **test-double 只用于开发期验证，不构成保底 Evidence**（PRD 11.3：禁止 Mock 冒充；AC-07 需要目标 Agent 真实日志或受控隔离新 Session）

---

## File map（新增/修改）

- 新增 `src/main/features/p3394/asset-events.ts`：事件账本最小实现（append-only + 类型枚举 + 幂等）
- 新增 `src/main/features/p3394/audit-receipt.ts`：Receipt 生成（before/after refs + 内容哈希）
- 新增 `src/main/features/p3394/asset-view.ts`：AssetViewProjection 最小版（账本重放派生，不独立存储）
- 新增 `src/main/features/p3394/capability-pack.ts`：MinimumCapabilityPack 最小组装器（引用不复制）
- 修改 `src/main/features/spaces.ts`：Space 增加 space_type / sustained_outcome / gate_status / main_skill_ref / asset_reference_bindings；读时默认值兼容
- 修改 `src/main/features/workbench/task-run.ts`：启动时从空间引用绑定冻结 asset_version_refs；拒绝未过 Gate 空间
- 修改 `src/main/features/workbench/main-skill-baseline.ts`：`evaluation_contract_ref` 指向的最小 EvaluationContract 落地（success_criteria + version）
- 修改 `src/main/features/p3394/index.ts`：导出新模块，保持现有 facade 风格
- 修改 `src/main/ipc/index.ts`：新增事件/Receipt/能力包只读 IPC + 空间新字段透传
- 修改 `test/main/ipc/p3394-contract.test.ts`：注册新 allow-list IPC 方法名（AGENTS.md 白名单 API 强制；不改则 npm test 红）
- 修改 `src/renderer/locales/{zh,en,ja,pt}.json`：空间类型 / Gate 状态 / 新事件文案（i18n 全覆盖，t(...) 透传）
- 修改 `scripts/smoke-p3394-real-execution.mjs`：扩展为保底切片 E2E 走查
- 新增 `test/main/features/p3394/asset-events.test.ts`：账本幂等/失败注入/重放一致性
- 新增 `test/main/features/p3394/capability-pack.test.ts`：能力包最小化与引用不复制
- 新增 `test/main/features/spaces-p3394.test.ts`：新字段兼容读/默认值/gate 过滤
- 修改 `test/main/features/workbench/task-run.test.ts`：版本冻结时序/漂移拒绝/运行中不换版

---

### Task 0: 冻结当前工作线基线

**Files:** 无生产文件改动

- [ ] **Step 0: 核对当前未提交状态并确认两条工作线分离。**
  当前 `git status` 含 12 M + 4 ??（含 cognition_extraction.ts、spaces.js 等 WIP）。先确认这些 WIP 属于本计划线；若与 KSTAR/parity 其他线混杂，先单独提交或移出。
- [ ] **Step 1: 基线验证。** 运行：
  ```bash
  git diff --check
  npm run typecheck
  npm test
  node scripts/smoke-p3394-real-execution.mjs
  ```
  预期全部 exit 0；记录基线提交哈希与未提交文件数。
- [ ] **Step 2: 确认 P0 新增文件不存在。** 检查 `asset-events.ts` / `audit-receipt.ts` / `asset-view.ts` / `capability-pack.ts` 均不存在。

---

### Task 1: 空间字段扩展（spaces.ts + gate 接入）

**Files:** `src/main/features/spaces.ts`、`src/main/features/workbench/gate.ts`、`src/main/ipc/index.ts`、渲染层 spaces.js（最小透传）、`test/main/features/spaces-p3394.test.ts`

**数据结构（新增字段，全部可选/带默认值，旧文件读时兼容）：**

```ts
export type SpaceType = 'complex_project' | 'professional_work' | 'recurring_routine' | 'temporary_task';
export type SpaceGateStatus = 'not_checked' | 'passed' | 'failed';
export type AssetReferencePolicy = 'pinned' | 'review_required' | 'follow_latest_compatible';

interface SpaceAssetReferenceBinding {
  asset_ref: { asset_id: string; version: string; content_hash?: string };
  policy: AssetReferencePolicy;          // 默认 review_required
  bound_at: string;
  updated_at?: string;
}

// Space 增加：
space_type?: SpaceType;                   // 读时缺省 'complex_project'
sustained_outcome?: string;              // 持续目标；列表首屏展示
gate_status?: SpaceGateStatus;           // 读时缺省 'not_checked'
main_skill_ref?: AssetRef;               // 复用 workbench/main-skill-baseline 的 AssetRef
asset_reference_bindings?: SpaceAssetReferenceBinding[]; // 默认 []
```

- [ ] **Step 1:** 扩展 `Space` 接口与 `createSpace`/`updateSpace` 入参（全部可选）；`_readSpace` 读时补齐默认值（缺省 space_type/gate_status/空绑定），不重写旧文件。
- [ ] **Step 2:** `evaluateWorkspaceGate` 接入 `Space.gate_status`：`isWorkspaceViewable` 在 `passed` 前一律 false；列表接口过滤未过 Gate 空间（渲染层不展示空壳，PRD 2.5）。
- [ ] **Step 3:** `listSpaces` 的 `SpaceWithMeta` 增加 gate 与空间类型透传（供首屏筛选）。
- [ ] **Step 4:** IPC 增加空间新字段的创建/更新透传（沿用现有 `{ ok, ... }` 契约）。
- [ ] **Step 5（i18n）:** 新字段展示文案（空间类型 / Gate 状态 / "未过 Gate 暂不可用"等）写入 `zh/en/ja/pt` 四个 locale，渲染层用 `t(...)` 透传；动态文案随 `i18n-change` 重渲染。
- [ ] **Step 6（测试）:** 旧空间文件（无新字段）读取不报错且默认值正确；创建时默认 complex_project + not_checked；gate_status 更新后 viewable 翻转；排序稳定；4 locale 文案齐全。

**验收 AC:** 旧数据零迁移直接可读；未过 Gate 空间不可见；IPC 契约向后兼容。

---

### Task 2: 事件账本最小版（先事件后视图）

**Files:** 新增 `src/main/features/p3394/asset-events.ts`、`audit-receipt.ts`、`asset-view.ts`、`test/main/features/p3394/asset-events.test.ts`

**数据设计（对齐架构文档 §5.6 与 PRD §9.4 最小事件表）：**

```ts
type AssetEventType =
  | 'asset_created' | 'asset_user_confirmed' | 'asset_transfer_verified'
  | 'asset_effectiveness_validated' | 'asset_scope_changed' | 'asset_source_revoked'
  | 'asset_paused' | 'asset_revoked' | 'asset_rolled_back'
  | 'workspace_asset_update_suggested' | 'workspace_asset_update_accepted'
  | 'workspace_asset_update_deferred' | 'workspace_asset_update_pinned';

interface AssetEvent {
  event_id: string;            // 稳定 ID，幂等
  asset_ref: { asset_id: string; version: string };
  event_type: AssetEventType;
  from_state?: string; to_state?: string;
  actor: 'user' | 'system';
  source_refs: string[];
  permission_ref?: string;
  committed_at: string;        // ISO
  content_hash: string;        // 事件负载哈希
  receipt_ref?: string;
}

interface AuditReceipt {
  receipt_id: string; event_ref: string; subject_ref: string;
  action: string; before_ref?: string; after_ref?: string;
  actor: string; result: 'ok' | 'failed'; timestamp: string;
}

// AssetViewProjection：不独立存储，从账本按 asset_id 重放派生（derive on read）
```

- [ ] **Step 1:** `appendAssetEvent(uid, event)`：`appendJsonlAtomic` 追加到 `<uid>/cloud/mate_agent/asset-events/<asset_id>.jsonl`；事件去重（同 event_id 已存在 → 幂等返回）。
- [ ] **Step 2:** `createAuditReceipt(uid, event)`：Receipt 落盘 `<uid>/cloud/mate_agent/audit-receipts/<receipt_id>.json`；失败不阻塞事件已提交（事件是提交点）。
- [ ] **Step 3:** `replayAssetView(uid, assetId)`：从账本重放 → 当前状态/版本/成熟度；供资产列表与认知树消费同一事实源。
- [ ] **Step 4（接入点核对先行）:** 先读 `ability-assets.ts` / `kstar-store.ts` 现有写路径与 `test/main/features/p3394/kstar-kb.test.ts` / `ability-asset-store.test.ts` 保护网，**确认接入点后**再将事件账本接入 create/update/setStatus：**先事件 → 再 Receipt → 再返回视图**；事件写入失败 → 抛错，界面保持原状态（PRD 原则 14）。不得破坏 KB promotion 幂等性与既有资产测试。
- [ ] **Step 5（测试）:** 追加幂等（同 event_id 两次）；失败注入（只读目录 → append 失败 → 资产状态不变、返回失败）；重放一致性（树/列表同源，AC-S3-17）；Receipt 字段完整；**既有 KSTAR/KB 测试全绿（回归保护网）**。

**验收 AC:** 任一资产状态变化有账本记录；事件失败时 UI 不显示"已保存"；重放可重建视图。

---

### Task 3: TaskRun 版本冻结（task-run.ts 扩展）

**Files:** `src/main/features/workbench/task-run.ts`、`main-skill-baseline.ts`（EvaluationContract 最小落地）、`test/main/features/workbench/task-run.test.ts`

- [ ] **Step 1:** `StartTaskRunInput` 增加 `spaceId` + 可选 `assetVersionRefs`；`startTaskRun` 增加拒绝理由：`space_not_found`、`space_gate_not_passed`、`space_asset_binding_missing`。
- [ ] **Step 2:** 启动时从空间 `asset_reference_bindings`（policy 不限，全部冻结）构造 `asset_version_refs` 快照，写入 ExecutionRecord（`execution-records.ts` 增加可选 `asset_version_refs` 字段，读时缺省空）。
- [ ] **Step 3:** 运行中任何路径禁止改写快照（只读引用；不提供 update 入口）。
- [ ] **Step 4:** `main-skill-baseline.ts` 的 `evaluation_contract_ref` 指向最小 EvaluationContract 对象：`{ evaluation_contract_id, success_criteria: string[], owner, version, created_at }`，冻结在 TaskRun 前（RG-S3-15 时序）。
- [ ] **Step 5（测试）:** 冻结时序（baseline 未冻结 → 拒绝启动）；空间 Gate 未过 → 拒绝；漂移（改 skill 树后重跑 → baseline_drift）；运行中版本快照不可变（构造后修改引用被拒）。

**验收 AC:** 无 baseline 无 run；空间未过 Gate 无 run；运行中版本不可变；历史 run 可复现（快照可读）。

---

### Task 4: 候选审查四决定 + 短确认 antecedent 绑定

**Files:** `src/main/features/kstar/review-service.ts`（核对现有决定集）、`src/main/features/recall/capture-service.ts`、`src/main/features/p3394/index.ts`、对应测试

- [ ] **Step 1（先核对）:** 核对 `review-service.ts` 现有决定集与 `recall/capture-service.ts` 的去重/抑制逻辑，**核对后细化本任务粒度**：候选四操作（保存/修改/暂缓/拒绝）与 Skill 四决定（有效/需要修正/不适用/暂不判断）是否齐全；缺口补齐。
- [ ] **Step 2:** `ReviewDecision` 强制带 `antecedent_ref`（原建议 ID）+ `decision_type` + `scope` + `supersedes_ref?`；无法唯一解析 → `review_decision_unresolved`，正式资产零变化（PRD 3.9.5）。
- [ ] **Step 3:** 拒绝抑制：同 source_ref + 同内容被拒后，无新 Evidence 不得再次提示（查 `cognition/` 去重逻辑，缺口补齐）。
- [ ] **Step 4（测试）:** 歧义前指用例（"采用/确认/是"多前指 → 澄清、资产零变化）；拒绝后同 Evidence 抑制；四操作与四决定全路径。

**验收 AC:** AC-25 短确认绑定、AC-S3-23 歧义零变化、FR-EXT-07 拒绝抑制通过。

---

### Task 5: 能力包 → Action Plan → Receipt 保底闭环

**Files:** 新增 `src/main/features/p3394/capability-pack.ts`、`src/main/features/p3394/index.ts`、`src/main/ipc/index.ts`、`scripts/smoke-p3394-real-execution.mjs`

**数据结构（引用不复制，PRD §3.7 最小能力包）：**

```ts
interface MinimumCapabilityPack {
  pack_id: string;
  purpose: string;
  main_skill_ref: AssetRef;
  ontology_slice_refs: string[];      // 引用 recall context-projection
  rule_refs: string[]; template_refs: string[];
  personal_context_ref?: string;
  continuation_snapshot_ref?: string; // 预留（D-1 决策）
  artifact_version_refs: string[];
  versions: { asset_id: string; version: string }[];
  scope: string; permissions: string[];
  target_agent: string;               // 运行时角色，非厂商
  expires_at: string;
}
```

- [ ] **Step 1:** `buildCapabilityPack(uid, input)`：从已确认资产/空间绑定按引用组装；只引用 asset_id+version，**不复制内容**（AC-06）。
- [ ] **Step 2（Evidence 边界）:** 目标端加载经 `local_agents/runner.ts`（真实）或隔离新 Session（受控）；`ExecutionBoundary: test-double` **仅开发期**验证契约。保底验收 Evidence 必须来自真实链路或受控隔离新 Session（AC-07 目标 Agent 日志），test-double 结果不得写入验收材料。
- [ ] **Step 3:** `action_plan_generated` 事件 → `prepareReceipt` → 用户即时校验（带入正确/需要调整/不该带入）→ `completeReceipt`（`context-reuse-receipt.ts` 已有 prepare/complete，接通即可）。
- [ ] **Step 4（成本埋点）:** 本链路模型调用埋点：每次提取/能力包/Action Plan 记录 input/output token 与耗时（匿名，仅计数与量级），供 D-5 预算实测（详见 Task 8）。
- [ ] **Step 5（测试）:** 能力包不含内容副本（只含引用）；test-double 下全链路可跑；receipt 状态机 prepared→completed/rejected/degraded；复制成功不算使用成功（FR-REU-02 负向测试）。

**验收 AC:** AC-06 最小能力包、AC-07 真实加载与 Action Plan、AC-08 传递证明、AC-09 即时校验。

---

### Task 6: Skill 生命周期建议接入（更新候选 / 暂不更新）

**Files:** `src/main/features/evolution/recommend-service.ts`（已有 buildRecommendations）、`src/main/features/workbench/task-run.ts`（结束后触发）、`src/main/features/p3394/index.ts`、对应测试

- [ ] **Step 1（先核对）:** 核对 `recommend-service.ts` 的 `recommendForSkill` / `buildRecommendations` 输入签名（触发源、Evidence 输入、建议输出结构），确认 TaskRun 结束后的触发契约；缺输入则补最小接口。
- [ ] **Step 2（Feature Flag）:** 四分支建议挂 `p3394.skilllifecycle` flag（架构文档 §13）：默认 on（最小分支），关闭时主进程与渲染层双读同一配置、不渲染建议入口。
- [ ] **Step 3:** TaskRun 结束后触发 `buildRecommendations`：依据本次 Episode 的 Evidence 输出 create / invoke / update / no_change 四分支之一（FR-EXT-08 最小分支）。
- [ ] **Step 4:** no_change 分支：区分"现有版本已覆盖/一次性配置/Evidence 不足/不可归因/未达重复阈值"并给出再次评估条件；**不升版、不触发成长动画**（FR-AST-09、AC-24）。
- [ ] **Step 5:** 用户决定（接受/修改/限域/拒绝）→ 写 `skill_lifecycle_recommended` + `skill_candidate_reviewed` 事件（Task 2 账本）；创建/更新正式 Skill 必须用户逐次确认，调用建议可跳过（FR-AST-08）。
- [ ] **Step 6（测试）:** 四分支分流正确；no_change 不产生版本号/树成长；用户拒绝后正式资产零变化（哈希对比）；flag 关闭时入口不渲染。

**验收 AC:** AC-22 四分支建议不静默改 Skill、AC-23 版本化写入与回滚入口、AC-24 暂不更新透明。

---

### Task 7: smoke:p3394 保底 E2E 走查扩展

**Files:** `scripts/smoke-p3394-real-execution.mjs`

- [ ] **Step 1:** 扩展 smoke 覆盖保底切片全链路：创建空间（complex_project）→ gate 检查通过 → 空间绑定 main_skill_ref → baseline 冻结（含 evaluation_contract_ref）→ 候选提取（≤3 条）→ 用户确认 → 能力包组装 → 目标端（真实或 test-double）加载并产出 Action Plan → prepare/completeReceipt → 即时校验 → 任务结束 → 更新候选或 no_change 结论 → 事件账本审计回放。
- [ ] **Step 2:** 断言：全程事件账本存在且可重放；Receipt 内容（用了什么/来自哪/计划变化）非空；无任何 Mock 冒充真实执行的路径（boundary 如实标注）。
- [ ] **Step 3:** 失败路径注入：目标 Agent 不可用 → exported_evidence 降级提示；事件写失败 → UI 状态不变。

**验收 AC:** 保底切片逐项 Evidence 真实可追溯（PRD 11.3 保底清单）。

---

### Task 8: 成本遥测埋点（D-5 预算实测）

**Files:** 新增 `src/main/features/p3394/cost-telemetry.ts`、`src/main/features/p3394/index.ts`、对应测试

- [ ] **Step 1:** `cost-telemetry.ts`：模型调用计数（provider/model/input_tokens/output_tokens/耗时/操作类型：extract|capability_pack|action_plan|kstar_eval）；本地聚合文件 `<uid>/local/mate_agent/cost-telemetry/<month>.jsonl`（机器私有，不标脏同步）。
- [ ] **Step 2:** 接入 Task 5 与 KSTAR 评价调用点（Task 5 Step 4 已埋点，此处统一聚合）；**匿名、仅计数与量级**（AGENTS.md 遥测纪律）。
- [ ] **Step 3:** 月汇总 + 单任务成本报告（供 D-5 预算阈值比对）；超过阈值触发 Scope Cut 建议（不自动断服务）。
- [ ] **Step 4（测试）:** 埋点字段完整性、月度聚合正确、异常缺失字段不炸链路。

**验收 AC:** 架构文档 §9 的 P0 埋点承诺落地；D-5 预算可实测校验。

---

### Task 9: 门禁与回归验证

- [ ] **Step 1:** `npm run typecheck` 全绿。
- [ ] **Step 2:** `npm test` 全绿（含新增测试与既有 KSTAR/空间回归，`p3394-contract.test.ts` allow-list 注册）。
- [ ] **Step 3:** `node scripts/smoke-p3394-real-execution.mjs` 全绿。
- [ ] **Step 4:** `git diff --check`；按 AGENTS.md 协作流提交到 dev/zhangh（不直推 develop）。

---

## 验收 Evidence 清单（对齐 PRD 11.1 8月19 Must）

| AC | Evidence 载体 |
|---|---|
| AC-01 无注册墙本地空间 | 启动日志 + 录屏 |
| AC-02 首条链路不要求手工 API Key | 权限记录 + 安全检查（本机已登录 Agent 直连） |
| AC-03 首屏三价值动作 + 全局输入 | 5 秒测试 + UI 录屏 |
| AC-04 未授权只显示元数据 | PermissionDecision 记录 |
| AC-05 ≤3 条候选 | Candidate 记录 + 界面 |
| AC-06 最小能力包 | CapabilityPack 引用清单（无副本断言） |
| AC-07 目标端真实加载 + Action Plan | 目标 Agent 日志 + Action Plan + 目标 Session |
| AC-08 传递证明 | ContextReuseReceipt + 录屏 |
| AC-09 即时校验 | TransferReviewDecision |
| AC-10 结果四选一不混淆 | OutcomeEvaluation |
| AC-12 Baseline 准入结构 | SkillPackage + 哈希 |
| AC-13 空间真实可运行 | Workspace Gate 清单 + 真实 Demo |
| AC-16 冻结时序 | SkillManifest + 版本哈希 + TaskRun 绑定 |
| AC-22/23/24 Skill 四分支 | SkillLifecycleRecommendation + 前后哈希 |
| AC-25 短确认绑定 | ReviewDecision + antecedent_ref + 冲突用例 |
| AC-31 统一路由 | 对象类型 + 路由日志 + 事件账本一致性 |

## 风险与依赖（沿用架构文档 §16）

- 🔴-2 连接链路：Task 5 的"真实"路径依赖 8/12 连接 Spike；未通过则 smoke 以 test-double + exported_evidence 走通并如实标注主张等级（D-2）。
- 🔴-3 KSTAR 引擎闭环：本计划只做"候选+暂不更新"（D-3 默认）；Gate A 完整闭环进 P1 计划。
- 成本：Task 5 提取通道默认低成本模型（D-4），超预算触发 Scope Cut（D-5）。
