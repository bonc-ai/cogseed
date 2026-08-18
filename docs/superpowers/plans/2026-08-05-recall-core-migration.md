# Recall Core Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `$superpower-subagents` (recommended) or `$superpower-executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via `update_plan`.

**Goal:** 把当前“能力资产中心的适配层”推进为 Recall 的可闭环核心：认知来源 → RecallView → 认知候选 → 正式 AbilityAsset → Workspace 引用 → ContextProjection/TaskRun → Transfer Proof → Effectiveness Proof → 认知树成长。

**Architecture:** 新增 `src/main/features/recall/` 作为正式 Recall 业务域；现有 `features/cognition/` 保留为资产中心的只读聚合/展示适配层，不再承担正式资产持久化。Recall 的用户私有状态写入 `<uid>/cloud/recall/`，使用现有 `storage.ts`、路径沙箱、锁和 dirty/sync 引擎；IPC 只做参数校验和委托，Renderer 只消费稳定 DTO。现有 `skills`、`memory`、`contexts`、`p3394`、`execution-records`、`projects/workspace`、`evolution` 继续作为来源或执行基础设施，不复制它们的权威数据。

**Tech Stack:** Electron main process TypeScript；JSON/JSONL + `storage.ts` 原子写入；`window.cogseed.invoke`；vanilla Renderer classic scripts；Vitest via `npm run test:js`；全量验证 via `npm test`。

---

## 1. Recall 范围判定

### 1.1 属于 Recall 核心、必须迁移

| 能力 | Recall 定义 | 本计划落点 |
|---|---|---|
| CognitionSource | 从对话、执行记录、artifact、个人本体、教学信号提取可沉淀依据 | `features/recall/source-service.ts` |
| RecallView | 针对当前任务，按目的、范围、授权和过期时间筛选可召回内容 | `features/recall/recall-view.ts` |
| CognitionCandidate | 从来源生成待审查对象，支持编辑、接受、暂缓、拒绝和去重 | `candidate-service.ts` |
| AbilityAsset | 用户拥有的稳定正式能力资产，带 ID、版本、Owner、Scope、成熟度和治理状态 | `asset-service.ts` + `store.ts` |
| Workspace 引用 | 同一 Asset ID 可被多个 Workspace 引用，不复制资产所有权 | `workspace-refs.ts` |
| ContextProjection | 把允许召回的资产/来源投影为本次任务可见上下文，并支持预览和确认 | `context-projection.ts` |
| TaskRun 绑定 | 记录任务使用了哪个 projection、哪些资产和哪些 scope | `task-run.ts`，复用 `features/execution-records.ts` |
| Transfer Proof | 任务前冻结预期结果，任务后记录实际复用和边界 | `proof-service.ts` |
| Effectiveness Proof | 对观察结果做更好/无改善/变差/证据不足评价，决定成熟度成长或风险动作 | `proof-service.ts` |
| 认知树 | 持久化资产节点、来源/证据/版本关系和成熟度变化 | `tree-service.ts` |
| 使用/审计记录 | 能查清资产何时被哪个任务使用、哪些来源被省略、是否降级 | `usage-service.ts` + proof records |

### 1.2 属于 Recall，但依赖宿主平台，不应在 Recall 内重写

- `skills` 是可执行组件，不是 AbilityAsset；Skill 只作为 `baselineSkillRef` 或资产关系存在，不能被 marketplace/custom skill 自动晋升为资产。
- `memory.ts` 是可召回来源/候选素材，不是顶层 AbilityAsset store。
- `contexts.ts` 是用户上下文源文件库；Recall 只保存 source ref 和 projection 元数据，不复制文件内容。
- `features/p3394/context-reuse-receipt.ts` 是现有 Transfer 运行审计基础；Recall 将其关联到 Transfer Proof，但不能把旧 receipt 误判为 Effectiveness Proof。
- `features/execution-records.ts` 是 TaskRun 的执行事实来源；Recall 记录关联 ID，不新增第二套执行状态机。
- `features/projects.ts`、`features/user_workspace.ts` 是 Workspace/项目选择基础设施；Recall 只保存引用、scope 和引用历史。
- `features/evolution/` 是 Skill 版本/patch/eval 基础设施；Recall 可以引用其 version/evidence，但 Recall Asset 有自己的版本 lineage 和成熟度。
- `features/sync/`、账户、权限和 IPC 是宿主能力；Recall 的 cloud 数据通过现有 dirty/sync 入口接入，不能写 ad-hoc uploader。

### 1.3 不属于 Recall 核心闭环，单独排期

以下属于 CogSeed 产品外壳或宿主功能，不能阻塞 Recall 主链：

- 首页 60 秒 Aha、首次 onboarding、连接检查、Permission Grant、Connection health。
- Workspaces/Workspace Start 的完整产品流程；Recall 只先实现 asset reference 和 projection contract。
- Nightly Digest、主动整理、完整 User Teaching Signal UI；Teaching Signal 的数据入口属于 Recall source adapter，页面属于后续产品层。
- marketplace 管理、Agent/Skill creator、Skill Library 的原有创建/编辑/启停/删除流程。
- 独立 evolution console 前端和旧 evolution 后端已归档；当前工作树只保留轻量 Skills/Cognition 版本与回滚服务。

---

## 2. 目标数据模型与不变量

Recall store 以 `<uid>/cloud/recall/` 为根，推荐文件布局如下：

```text
<uid>/cloud/recall/
  candidates.jsonl
  ability-assets.jsonl
  workspace-refs.jsonl
  recall-views.jsonl
  projections.jsonl
  task-runs.jsonl
  transfer-proofs.jsonl
  effectiveness-proofs.jsonl
  tree.json
  usage-events.jsonl
  migrations.json
```

所有记录必须包含 `schemaVersion`, `ownerId`, `createdAt`, `updatedAt`；用户私有 feature 函数签名均以 `userId` 为第一个参数。稳定 ID 由首次创建时生成并永久复用，不能从标题、workspace 或 session id 推导。

### 2.1 核心 DTO

在 `src/main/features/recall/types.ts` 固定以下接口（字段名以此为准，Renderer 不读取 raw source）：

```ts
interface CognitionSourceRef {
  kind: 'conversation' | 'message' | 'artifact' | 'execution' | 'context' | 'memory' | 'ontology' | 'skill_evolution' | 'teaching_signal';
  id: string;
  title?: string;
  excerpt?: string;
}

interface CognitionCandidateRecord {
  id: string;
  ownerId: string;
  status: 'pending' | 'deferred' | 'rejected' | 'promoted';
  judgment: string;
  evidence: CognitionSourceRef[];
  uncertainty?: string;
  suggestedType: 'personal' | 'rule' | 'template' | 'skill_method';
  suggestedScope: string;
  targetSkillId?: string;
  duplicateOf?: string;
  promotedAssetId?: string;
  createdAt: string;
  updatedAt: string;
}

interface AbilityAssetRecord {
  id: string;
  ownerId: string;
  type: 'personal' | 'rule' | 'template' | 'skill_method';
  title: string;
  statement: string;
  evidence: CognitionSourceRef[];
  scope: string;
  status: 'active' | 'paused' | 'revoked';
  maturity: 'seed' | 'bud' | 'transfer_validated' | 'effectiveness_validated';
  version: string;
  parentAssetId?: string;
  baselineSkillRef?: string;
  workspaceRefIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface ContextProjectionRecord {
  id: string;
  taskRunId: string;
  purpose: string;
  scope: string;
  assetIds: string[];
  sourceRefs: CognitionSourceRef[];
  omittedRefs: CognitionSourceRef[];
  authorization: 'user_confirmed' | 'workspace_policy' | 'not_required';
  expiresAt?: string;
  status: 'preview' | 'confirmed' | 'expired' | 'revoked';
  createdAt: string;
}
```

Required invariants:

1. `promoted` candidate must reference exactly one existing `AbilityAsset`.
2. Asset ID is immutable; edits create a new version and preserve `parentAssetId`/lineage.
3. A workspace reference never changes `ownerId` and never copies the asset body.
4. Expired, revoked, out-of-scope, or unauthorized items never enter a confirmed projection.
5. `EffectivenessProof` is invalid unless its `TransferProof` is succeeded and its observation is linked to the same `TaskRun`.
6. Only a valid Effectiveness Proof can advance maturity to `effectiveness_validated` or grow a tree leaf.
7. A degraded or negative outcome must not silently delete evidence; it creates a risk event and may pause/limit/rollback by an explicit policy action.

---

## Task 1: Formalize Recall domain types, paths, and storage

**Files:**
- Create: `src/main/features/recall/types.ts`
- Create: `src/main/features/recall/paths.ts`
- Create: `src/main/features/recall/store.ts`
- Create: `src/main/features/recall/index.ts`
- Modify: `src/main/paths.ts` — add a user-scoped cloud Recall root helper; do not cache the active uid.
- Modify: `src/main/features/sync/dirty-engine.ts` or the existing sync dirty entrypoint discovered from `features/sync/` — register Recall cloud files through the existing dirty/sync path.
- Test: `test/main/features/recall/store.test.ts`

- [ ] **Step 1: Add failing store contract tests** for atomic create/update, owner scoping, stable IDs, malformed-record rejection, and legacy empty-directory initialization.
- [ ] **Step 2: Run the focused test and confirm failure** with `npm run test:js -- test/main/features/recall/store.test.ts`.
- [ ] **Step 3: Implement the store** with `readJson`/JSONL helpers, per-file locks, schema versioning, atomic writes, and `markDirty` only for cloud records. Reject records whose `ownerId` differs from the requested `userId`.
- [ ] **Step 4: Add migration records** so a rerun is idempotent; never overwrite unknown future schema versions.
- [ ] **Step 5: Run the focused store tests** and verify PASS plus no writes outside `<uid>/cloud/recall/`.

## Task 2: Build source adapters and RecallView

**Files:**
- Create: `src/main/features/recall/source-service.ts`
- Create: `src/main/features/recall/recall-view.ts`
- Modify: `src/main/features/cognition/candidates-adapter.ts` — consume source refs where it currently adapts p3394/ontology candidates; keep compatibility DTOs.
- Modify: `src/main/features/cognition/receipts-adapter.ts` — expose proof links without treating receipts as effectiveness.
- Test: `test/main/features/recall/recall-view.test.ts`
- Test: `test/main/features/cognition.test.ts`

- [ ] **Step 1: Test source normalization** for conversation/artifact/execution/context/memory/ontology/evolution/teaching-signal refs, including missing titles and redacted excerpts.
- [ ] **Step 2: Test RecallView filtering** by purpose, scope, workspace references, authorization, expiration, paused/revoked asset status, and explicit user confirmation.
- [ ] **Step 3: Implement `listCognitionSources(userId, query)`** as read-only adapters over existing authoritative features; it must return refs, not copy source bodies into Recall storage.
- [ ] **Step 4: Implement `buildRecallView(userId, input)`** with deterministic ordering, bounded result counts, omitted refs, and a preview/confirmed distinction.
- [ ] **Step 5: Re-run cognition regression tests** to prove the existing five-tab adapter remains backward compatible.

## Task 3: Implement candidate governance and promotion

**Files:**
- Create: `src/main/features/recall/candidate-service.ts`
- Modify: `src/main/features/personal_ontology_candidates.ts` only where a read/decision hook is needed; do not move its existing storage authority.
- Modify: `src/main/features/cognition/index.ts` and `src/main/features/cognition/types.ts` to expose the normalized candidate view from Recall records.
- Modify: `src/main/ipc/index.ts` with validation-only Recall candidate routes.
- Create: `test/main/features/recall/candidate-service.test.ts`
- Modify: `test/main/ipc/cognition.test.ts` or create `test/main/ipc/recall.test.ts`.

- [ ] **Step 1: Write failing tests** for edit/save, accept/promote, defer, reject, duplicate detection, source/evidence preservation, and idempotent repeated decisions.
- [ ] **Step 2: Define the state machine:** `pending → deferred|rejected|promoted`; `deferred → pending|rejected|promoted`; `rejected` and `promoted` are terminal except audit-only metadata updates.
- [ ] **Step 3: Implement `saveCandidate(userId, input)`** with normalized judgment, uncertainty, type, scope, and evidence refs; preserve original source refs.
- [ ] **Step 4: Implement `promoteCandidate(userId, input)`** to create one stable AbilityAsset, link `promotedAssetId`, and reject duplicate promotion under the store lock.
- [ ] **Step 5: Add IPC channels** `recall.candidates.list`, `recall.candidates.read`, `recall.candidates.save`, `recall.candidates.defer`, `recall.candidates.reject`, `recall.candidates.promote`; validate IDs, enum values, max lengths, and evidence ref shapes at the boundary.
- [ ] **Step 6: Run feature and IPC tests** and verify no IPC handler contains promotion business logic.

## Task 4: Implement formal AbilityAsset lifecycle and version lineage

**Files:**
- Create: `src/main/features/recall/asset-service.ts`
- Create: `src/main/features/recall/usage-service.ts`
- Modify: `src/main/features/skills/version-store.ts` only for shared version snapshot compatibility; keep Skill rollback behavior unchanged.
- Modify: `src/main/features/cognition/assets-adapter.ts` to read formal AbilityAssets first and retain legacy adapter rows only as explicitly labeled migration views.
- Test: `test/main/features/recall/asset-service.test.ts`

- [ ] **Step 1: Write failing lifecycle tests** for stable IDs, owner isolation, version increment, parent lineage, scope changes, pause, revoke, restore policy, and export/audit views.
- [ ] **Step 2: Implement `createAbilityAsset`, `updateAbilityAsset`, `pauseAbilityAsset`, `revokeAbilityAsset`, and `listAbilityAssetVersions`** under per-asset locks.
- [ ] **Step 3: Add version snapshots** containing statement, type, scope, evidence refs, and baseline skill ref; never mutate historical snapshots.
- [ ] **Step 4: Implement export as a redaction-safe DTO** (IDs, title, statement, scope, maturity, evidence refs, lineage), not a raw internal record dump.
- [ ] **Step 5: Update the cognition adapter** so marketplace skills and memory entries remain references/sources and are not auto-promoted.
- [ ] **Step 6: Run asset/evolution/cognition tests** and verify legacy assets remain readable during migration.

## Task 5: Add Workspace references and scope governance

**Files:**
- Create: `src/main/features/recall/workspace-refs.ts`
- Modify: `src/main/features/projects.ts` or `src/main/features/user_workspace.ts` only to expose the existing canonical workspace identity needed by Recall.
- Modify: `src/main/ipc/index.ts` with validation-only workspace reference routes.
- Test: `test/main/features/recall/workspace-refs.test.ts`
- Test: `test/main/ipc/recall.test.ts`

- [ ] **Step 1: Test add/list/update/remove** for one asset referenced by multiple workspaces, duplicate reference idempotency, scope narrowing, and reference history.
- [ ] **Step 2: Implement references as `{assetId, workspaceId, scope, enabled, createdAt, updatedAt}`**; never copy the Asset body and never encode workspace/project IDs into Asset IDs or session IDs.
- [ ] **Step 3: Require explicit scope on first reference**; default injection may only use enabled references whose scope contains the requested purpose.
- [ ] **Step 4: Add IPC channels** `recall.workspaceRefs.list`, `.add`, `.update`, `.remove`; validate workspace IDs with the existing project/workspace helpers and asset IDs with `safeId`.
- [ ] **Step 5: Run workspace reference tests** and verify dirty/sync marks only the cloud reference records.

## Task 6: Implement ContextProjection and TaskRun integration

**Files:**
- Create: `src/main/features/recall/context-projection.ts`
- Create: `src/main/features/recall/task-run.ts`
- Modify: `src/main/features/execution-records.ts` only to expose a stable read/link operation if needed; do not create a second execution state machine.
- Modify: `src/main/features/p3394/execution-context.ts` or the existing context injection choke point to accept a confirmed projection.
- Modify: `src/main/ipc/index.ts` with preview/confirm routes.
- Test: `test/main/features/recall/context-projection.test.ts`
- Test: `test/main/features/recall/task-run.test.ts`

- [ ] **Step 1: Test preview output** containing purpose, scope, included asset/source refs, omitted refs with reasons, authorization mode, and expiry.
- [ ] **Step 2: Test rejection** of revoked/paused/expired/out-of-scope assets, unconfirmed user-required projections, and projections exceeding the result cap.
- [ ] **Step 3: Implement `previewContextProjection(userId, input)`** using RecallView and workspace refs; return a redacted preview only.
- [ ] **Step 4: Implement `confirmContextProjection(userId, projectionId)`** with a single-use confirmation transition and immutable selected refs.
- [ ] **Step 5: Bind confirmed projections to TaskRun/execution IDs** and persist included/omitted refs for later Transfer Proof evaluation.
- [ ] **Step 6: Route injection through the existing p3394/context execution choke point**; no renderer or IPC code may spawn processes or bypass the normal task dispatch.
- [ ] **Step 7: Run projection/task tests** with real, degraded, and test-double execution boundaries.

## Task 7: Implement Transfer Proof and Effectiveness Proof

**Files:**
- Create: `src/main/features/recall/proof-service.ts`
- Modify: `src/main/features/p3394/context-reuse-receipt.ts` to expose a safe link/read adapter only if required; preserve its existing receipt format.
- Modify: `src/main/features/cognition/receipts-adapter.ts` to show proof phase/status/evidence sufficiency.
- Modify: `src/main/ipc/index.ts` with proof routes.
- Test: `test/main/features/recall/proof-service.test.ts`
- Test: `test/main/features/p3394/context-reuse-receipt.test.ts`

- [ ] **Step 1: Write failing tests** for task-before freeze, successful transfer, degraded transfer, missing observation, better/no-change/worse/insufficient-evidence evaluation, invalid proof, and rework.
- [ ] **Step 2: Implement `prepareTransferProof(userId, taskRunId)`** to freeze `ExpectedResultSnapshot`, selected asset versions, projection scope, permission mode, and boundary.
- [ ] **Step 3: Implement `completeTransferProof(userId, taskRunId, observedTransfer)`** by linking the existing reuse receipt and execution record; make completion idempotent.
- [ ] **Step 4: Implement `evaluateEffectivenessProof(userId, input)`** with required observation refs and evaluator reason; return one of `better`, `no_improvement`, `worse`, `insufficient_evidence`, `invalid`, `rework`.
- [ ] **Step 5: Enforce maturity rules:** Transfer Proof may move `seed → bud → transfer_validated`; only valid Effectiveness Proof may move to `effectiveness_validated`.
- [ ] **Step 6: Add negative-outcome policy actions** as explicit commands (`pause`, `narrow_scope`, `rework`, `rollback_to_version`); do not silently mutate the asset from an evaluator result.
- [ ] **Step 7: Run proof tests** and verify an old Reuse Receipt alone cannot grow a tree leaf.

## Task 8: Persist Cognition Tree and usage records

**Files:**
- Create: `src/main/features/recall/tree-service.ts`
- Create: `src/main/features/recall/usage-service.ts` if not completed in Task 4.
- Modify: `src/main/features/cognition/assets-adapter.ts` and `dashboard.ts` to consume tree/usage/proof summaries.
- Modify: `src/main/ipc/index.ts` with tree and usage read routes.
- Test: `test/main/features/recall/tree-service.test.ts`
- Test: `test/main/features/recall/usage-service.test.ts`

- [ ] **Step 1: Test persistent nodes and edges** for source → candidate → asset → projection → proof relationships, parent/child lineage, and deterministic ordering.
- [ ] **Step 2: Implement node types** `source`, `candidate`, `asset`, `workspace`, `task_run`, `transfer_proof`, `effectiveness_proof`; store edges by stable IDs and never duplicate edges on retry.
- [ ] **Step 3: Implement maturity growth** only from valid proof events; paused/revoked/rolled-back assets must update node status and remain visible in history.
- [ ] **Step 4: Implement usage records** with asset version, workspace, task, projection, included/omitted refs, outcome, and boundary; redact raw private excerpts.
- [ ] **Step 5: Add `recall.tree.read` and `recall.usage.list/read`** with bounded pagination and owner checks.
- [ ] **Step 6: Run tree/usage/dashboard tests** and verify dashboard counts are derived from formal records, not marketplace or memory rows.

## Task 9: Complete the Skills Asset Center UI for the Recall loop

**Files:**
- Modify: `src/renderer/index.html` — keep the existing five-tab center; add candidate review/edit/promotion controls, projection preview/confirmation, proof detail, and Ability Asset internal views.
- Modify: `src/renderer/modules/skills.js` — render only DTOs from cognition/recall IPC; show asset lineage, scope, workspace refs, maturity, proof status, tree links, and usage records.
- Modify: `src/renderer/modules/skills-bindings.js` — wire save/defer/reject/promote, workspace reference changes, projection preview/confirm, proof evaluation, pause/scope/rollback actions.
- Modify: `src/renderer/modules/state.js` — store active candidate/asset/projection detail without reintroducing standalone evolution state.
- Modify: `src/renderer/style.css` — reuse the integrated single-surface/compact-row design already established.
- Modify: `src/renderer/locales/en.json`, `zh.json`, `ja.json`, `pt.json` — add all visible labels/status/actions.
- Test: `test/renderer/skills-recall-loop.test.js` or `.test.ts` following the existing renderer test convention.

- [ ] **Step 1: Add failing DOM tests** for candidate form fields, disabled promotion without required judgment/evidence/scope, projection omitted-ref explanation, proof phase display, and asset/tree/usage detail.
- [ ] **Step 2: Implement candidate review** with editable judgment, uncertainty, type, scope, evidence list, defer/reject, and promote confirmation; show source links without exposing raw private content unnecessarily.
- [ ] **Step 3: Implement projection preview** as an explicit review surface; require confirmation when authorization is `user_confirmed` and display expiry/scope.
- [ ] **Step 4: Implement Reuse Receipts as proof/audit** with separate Transfer Proof and Effectiveness Proof states, including degraded/invalid/rework reasons.
- [ ] **Step 5: Implement Ability Assets internal views** `Asset List / Cognition Tree / Usage Records`; do not show Skills or Memory as formal assets.
- [ ] **Step 6: Ensure all visible strings use `t(...)` and re-render on `i18n-change`; preserve IME guards on input shortcuts and existing icon/button primitives.
- [ ] **Step 7: Run focused renderer tests** and verify the original Skills library behaviors remain intact.

## Task 10: Add product-shell adapters after the core loop is green

**Files:**
- Create: `src/main/features/recall/teaching-signal-adapter.ts` only if existing teaching-signal storage cannot be read through a stable adapter.
- Modify: the existing onboarding/connection/workspace/digest IPC and Renderer modules only after Tasks 1-9 pass.
- Test: focused tests next to each migrated flow.

- [ ] **Step 1: Add capture entry points** that create `CognitionSourceRef`/`CognitionCandidateRecord`; do not write directly to AbilityAsset.
- [ ] **Step 2: Add Workspace Start defaults** by creating references/projection policy, never copying assets into project directories.
- [ ] **Step 3: Add Nightly Digest/主动整理** as candidate generation jobs registered through `util/boot_init.ts`, not raw timers or async IIFEs.
- [ ] **Step 4: Add onboarding/permission/connection-health UI** as product-shell gates around RecallView authorization; keep hosted entitlement failures as explicit UX states.
- [ ] **Step 5: Run the product-shell regression set** and confirm the core Recall loop remains usable without onboarding.

---

## 3. IPC contract summary

IPC handlers remain validation-only. The planned channels are:

```text
recall.candidates.list/read/save/defer/reject/promote
recall.assets.list/read/create/update/pause/revoke/versions/export
recall.workspaceRefs.list/add/update/remove
recall.view.preview
recall.projections.preview/confirm/read
recall.taskRuns.read
recall.proofs.transfer.prepare/complete
recall.proofs.effectiveness.evaluate
recall.tree.read
recall.usage.list/read
```

Validation rules:

- IDs use the existing `safeId`/session-kind validators; max lengths are enforced before feature calls.
- Enum values are allow-listed; unknown fields are ignored or rejected according to existing IPC conventions.
- `userId` comes from the active account/session, never from renderer payloads.
- Free text is bounded and normalized; raw source content is never accepted as an authorization substitute.
- All file-class reads remain behind existing path-sandbox checks.

---

## 4. Delivery order and acceptance criteria

### Phase A — Foundation and governance (Tasks 1-5)

Done when formal records can be created, migrated, reviewed, promoted, versioned, scoped, paused, revoked, and referenced from multiple Workspaces with owner isolation.

### Phase B — Recall execution loop (Tasks 6-8)

Done when a confirmed projection can be bound to a TaskRun, produce a Transfer Proof, receive an Effectiveness Proof, and update the tree/usage records without duplicating execution or receipt storage.

### Phase C — Renderer and shell (Tasks 9-10)

Done when the five-tab Asset Center supports candidate review, formal asset inspection, projection confirmation, proof inspection, tree/usage drill-down, and the original Skills library remains functional.

The core Recall migration is accepted only if all of the following are true:

1. A candidate can be edited and promoted into one stable AbilityAsset ID.
2. The same AbilityAsset can be referenced by two Workspaces without copying or changing ownership.
3. A task shows a preview of included and omitted refs before user-confirmed injection.
4. A Transfer Proof freezes pre-task expectations and links to the existing execution/reuse receipt.
5. An Effectiveness Proof is impossible without a valid Transfer Proof and observation.
6. Positive proof grows the tree; negative proof produces an explicit pause/scope/rework/rollback action.
7. Marketplace skills and memory entries are not counted as formal AbilityAssets.
8. All data remains user-scoped under cloud/local boundaries and syncs through existing mechanisms.

---

## 5. Verification gate

Run after each phase:

```bash
git diff --check
npm run typecheck
npm run test:js -- test/main/features/recall test/main/ipc/recall.test.ts test/main/features/cognition.test.ts test/main/ipc/cognition.test.ts
```

Run before declaring the migration complete:

```bash
npm run typecheck
npm run test:js -- test/main/features/recall test/main/features/cognition.test.ts test/main/ipc/cognition.test.ts test/main/features/evolution/versions-store.test.ts test/main/features/evolution/patch-service.test.ts test/renderer/evolution-console-removed.test.ts test/renderer/skills-cognition-layout.test.ts test/renderer/skills-recall-loop.test.ts test/renderer/skills-frontmatter.test.ts
npm test
```

Manual Electron smoke test with `cd PC && ./run.sh` from the project root’s application directory as applicable:

1. Open Skills and confirm exactly `Overview / Skills / Cognition Candidates / Reuse Receipts / Ability Assets`.
2. Review a candidate, edit judgment/type/scope/evidence, defer it, then promote it.
3. Confirm the created Asset ID is stable after reload and is not a Skill ID.
4. Reference that asset from two Workspaces and narrow scope in one Workspace.
5. Preview a task projection and inspect included/omitted refs, authorization, and expiry.
6. Confirm projection, complete the task, inspect Transfer Proof, then submit an Effectiveness Proof.
7. Verify positive proof grows the tree and negative proof exposes explicit governance actions.
8. Verify no standalone evolution navigation returns and the original Skill Library still supports create/import/edit/use/delete.

Do not commit the existing worktree changes or this plan unless the user explicitly asks for a commit.

---

## Plan self-review

- Covered: candidate governance, formal asset storage, stable IDs, version lineage, Workspace references, RecallView, ContextProjection, TaskRun, Transfer Proof, Effectiveness Proof, tree growth, usage audit, and the existing Skills Asset Center UI.
- Explicitly separated: host platform dependencies and CogSeed product-shell pages from Recall core.
- Preserved constraints: IPC-only renderer communication, no new HTTP server, no ad-hoc process spawning, no marketplace-to-asset auto-promotion, user-scoped cloud data, existing sync/lock/path chokepoints, and no standalone evolution frontend.
- No business logic is assigned to IPC handlers; no second execution or receipt store is introduced.
