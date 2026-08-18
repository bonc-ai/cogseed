# Mate Agent Recall 增量迁移实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use `$superpower-subagents` (recommended) or `$superpower-executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via `update_plan`.

**Goal:** 在 Mate Agent 现有能力之上补齐 Recall 的正式闭环，而不是重写 Memory、Contexts、p3394、Execution Records、Evolution 或 Workspace。

**Architecture:** 保留现有模块作为权威来源和执行基础设施；新增 `src/main/features/recall/` 作为 Recall 编排层和正式 AbilityAsset 业务域。现有 `features/cognition/` 继续负责 Asset Center 的展示聚合，但不再把适配出来的旧数据误认为正式资产。所有 Recall 用户状态写入 `<uid>/cloud/recall/`，IPC 只校验参数并调用 feature，Renderer 只消费稳定 DTO。

**Tech Stack:** Electron main process TypeScript；JSON/JSONL、现有 `storage.ts` 和文件锁；`window.cogseed.invoke`；vanilla Renderer classic scripts；Vitest via `npm run test:js`；全量测试 via `npm test`。

---

## 一、当前代码与 Recall 的边界

### 已有、直接复用

- `/Users/sudai/Documents/Mate Agent/src/main/storage.ts`：原子 JSON 写入、ID、锁相关基础设施。
- `/Users/sudai/Documents/Mate Agent/src/main/paths.ts`：用户 cloud/local 根目录和路径边界。
- `/Users/sudai/Documents/Mate Agent/src/main/features/memory.ts`：Memory 来源。
- `/Users/sudai/Documents/Mate Agent/src/main/features/contexts.ts`：Context 来源文件。
- `/Users/sudai/Documents/Mate Agent/src/main/features/personal_ontology_candidates.ts`：个人本体候选生成和确认。
- `/Users/sudai/Documents/Mate Agent/src/main/features/personal_ontology_groups.ts`：个人本体分组。
- `/Users/sudai/Documents/Mate Agent/src/main/features/p3394/`：经验候选、Patch 候选、执行上下文和复用能力。
- `/Users/sudai/Documents/Mate Agent/src/main/features/execution-records.ts`：执行事实和 Task/Execution 关联。
- `/Users/sudai/Documents/Mate Agent/src/main/features/p3394/context-reuse-receipt.ts`：已有复用审计。
- `/Users/sudai/Documents/Mate Agent/src/main/features/skills/`：Skill 版本和回滚。旧 evolution Patch/验证线已归档。
- `/Users/sudai/Documents/Mate Agent/src/main/features/projects.ts`、`user_workspace.ts`：Workspace/Project 基础能力。
- `/Users/sudai/Documents/Mate Agent/src/main/features/cognition/`：当前五 tab Asset Center 的适配层。

### 只优化，不重写

1. 个人本体候选继续作为来源，但 Recall 需要保留审查决定和正式资产关联；不能只依赖“确认后从候选池删除”。
2. Reuse Receipt 继续作为传输事实；在 Recall 层增加 Transfer Proof，不修改旧 receipt 语义。
3. Skill Version 继续由 Evolution 管理；AbilityAsset 只通过 `baselineSkillRef` 引用 Skill。
4. Contexts 继续存原始文件；Recall 只保存 `sourceRef` 和 projection 元数据，不复制内容。
5. Execution Records 继续管理执行状态；Recall 只关联 `taskRunId/executionId`，不建立第二套执行状态机。
6. 现有 Cognition Asset Adapter 继续兼容旧数据，但正式资产必须从独立 AbilityAsset store 读取。

### 必须新增

- 正式 AbilityAsset store。
- Candidate 编辑、暂缓、拒绝、晋升治理。
- RecallView。
- ContextProjection。
- Workspace Asset Reference。
- Transfer Proof 和 Effectiveness Proof。
- 持久化 Cognition Tree。
- Usage Records。

---

## 二、目标主链

```text
现有来源
  ├─ Memory
  ├─ Contexts
  ├─ Personal Ontology
  ├─ p3394 Experience / Patch
  ├─ Conversation / Artifact
  └─ Execution Evidence
        ↓
CognitionSourceRef
        ↓
CognitionCandidate
        ↓ 用户审查、编辑、暂缓、拒绝
AbilityAsset
        ↓ Workspace 引用 + scope
RecallView
        ↓ 预览、授权、过期判断
ContextProjection
        ↓ 用户确认
现有 Task / Execution / p3394
        ↓
TransferProof
        ↓
EffectivenessProof
        ↓
Asset maturity / pause / scope narrowing / rollback
        ↓
Cognition Tree + Usage Records
```

核心原则：

```text
Skill 不是 AbilityAsset
Memory 不是 AbilityAsset
Reuse Receipt 不是 Effectiveness Proof
适配器 view model 不是正式持久化资产
```

---

## 三、目标数据结构

### 1. AbilityAsset

建议放在 `src/main/features/recall/types.ts`：

```ts
interface AbilityAssetRecord {
  id: string;
  ownerId: string;
  type: 'personal' | 'rule' | 'template' | 'skill_method';
  title: string;
  statement: string;
  evidenceRefs: CognitionSourceRef[];
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
```

### 2. Candidate

```ts
interface RecallCandidateRecord {
  id: string;
  ownerId: string;
  sourceRefs: CognitionSourceRef[];
  judgment: string;
  uncertainty?: string;
  suggestedType: 'personal' | 'rule' | 'template' | 'skill_method';
  suggestedScope: string;
  status: 'pending' | 'deferred' | 'rejected' | 'promoted';
  promotedAssetId?: string;
  duplicateOf?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 3. ContextProjection

```ts
interface ContextProjectionRecord {
  id: string;
  ownerId: string;
  taskRunId: string;
  purpose: string;
  scope: string;
  assetIds: string[];
  includedRefs: CognitionSourceRef[];
  omittedRefs: Array<{ ref: CognitionSourceRef; reason: string }>;
  authorization: 'user_confirmed' | 'workspace_policy' | 'not_required';
  expiresAt?: string;
  status: 'preview' | 'confirmed' | 'expired' | 'revoked';
  createdAt: string;
}
```

### 4. Proof

Transfer Proof 必须记录：

- `taskRunId`
- `projectionId`
- 任务前 `expectedResultSnapshot`
- 选中的 Asset ID 和版本
- Reuse Receipt ID
- Execution ID
- permission、scope、boundary
- observed transfer result

Effectiveness Proof 必须记录：

- 对应 Transfer Proof
- 任务后观察结果
- 评价结果：`better`、`no_improvement`、`worse`、`insufficient_evidence`、`invalid`、`rework`
- 评价理由和证据 refs
- 后续动作：保持、暂停、限域、返工或回滚

---

## Task 1：建立 Recall 正式存储底座

**Files:**
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/recall/types.ts`
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/recall/paths.ts`
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/recall/store.ts`
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/recall/index.ts`
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/paths.ts`
- Test: `/Users/sudai/Documents/Mate Agent/test/main/features/recall/store.test.ts`

- [ ] 增加 `userRecallRoot(uid)`，路径固定为 `<uid>/cloud/recall/`，不缓存 active uid。
- [ ] 实现 JSON/JSONL 的读写、原子更新、文件锁和 schema version。
- [ ] 所有记录强制校验 `ownerId === userId`。
- [ ] 增加 migration marker，旧数据迁移可重复执行，未知的新 schema 不能被覆盖。
- [ ] 用测试覆盖：创建、更新、并发更新、用户隔离、损坏记录和重复迁移。

验证：

```bash
npm run test:js -- test/main/features/recall/store.test.ts
```

---

## Task 2：把现有来源统一成 CognitionSourceRef

**Files:**
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/recall/source-service.ts`
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/cognition/candidates-adapter.ts`
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/cognition/receipts-adapter.ts`
- Test: `/Users/sudai/Documents/Mate Agent/test/main/features/recall/source-service.test.ts`

- [ ] 为 Memory、Contexts、Personal Ontology、p3394、Execution、Conversation、Artifact 建立统一 source ref。
- [ ] 只保存 `kind/id/title/excerpt` 等引用元数据，不复制原始文件或完整私密内容。
- [ ] 为当前候选适配器增加 `sourceRefs` 和 `evidenceRefs` 的稳定映射。
- [ ] 对不可读取的来源返回 degraded 状态，不阻塞其他来源。
- [ ] 测试来源缺失、重复引用、过长 excerpt 和敏感内容脱敏。

---

## Task 3：把已有候选升级为 Recall Candidate Governance

**Files:**
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/recall/candidate-service.ts`
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/personal_ontology_candidates.ts`，仅增加 Recall 审查关联，不改变原有 Memory 写入规则。
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/cognition/candidates-adapter.ts`
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/ipc/index.ts`
- Test: `/Users/sudai/Documents/Mate Agent/test/main/features/recall/candidate-service.test.ts`
- Test: `/Users/sudai/Documents/Mate Agent/test/main/ipc/recall.test.ts`

状态机固定为：

```text
pending → deferred | rejected | promoted
deferred → pending | rejected | promoted
rejected / promoted → 只允许补充审计信息
```

- [ ] 保留当前三类来源候选的兼容读取。
- [ ] 新增候选编辑：判断、摘要、不确定性、建议类型、建议 scope、evidence refs。
- [ ] 新增暂缓和恢复待处理。
- [ ] 用来源 ID + 规范化判断内容做去重检测。
- [ ] 接受候选时创建正式 AbilityAsset，而不是只把候选标记 accepted。
- [ ] 候选和 Asset 之间保存双向关联。
- [ ] 重复点击 promote 必须幂等，不能创建多个 Asset。
- [ ] IPC 只负责校验 enum、ID、长度和 decision payload。

计划增加的 IPC：

```text
recall.candidates.list
recall.candidates.read
recall.candidates.save
recall.candidates.defer
recall.candidates.reject
recall.candidates.promote
```

---

## Task 4：实现正式 AbilityAsset 生命周期

**Files:**
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/recall/asset-service.ts`
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/recall/usage-service.ts`
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/cognition/assets-adapter.ts`
- Test: `/Users/sudai/Documents/Mate Agent/test/main/features/recall/asset-service.test.ts`

- [ ] 实现 `createAbilityAsset`、`updateAbilityAsset`、`pauseAbilityAsset`、`revokeAbilityAsset`、`listAbilityAssetVersions`。
- [ ] Asset ID 创建后不可变，标题和内容变更产生新版本。
- [ ] 版本快照必须保留 statement、type、scope、evidence 和 baseline skill ref。
- [ ] 资产 owner 永远来自 feature 的 `userId`，不能由 Renderer 传入。
- [ ] 资产状态变更必须写审计事件。
- [ ] Cognition Adapter 优先读取正式 AbilityAsset；旧 Personal Ontology/p3394 数据只作为 migration/legacy view。
- [ ] marketplace Skills 和 Memory 不计入正式 AbilityAsset 数量。

验收：

```text
同一个 candidate promote 两次 = 一个 Asset
同一个 Asset 更新两次 = 同一个 Asset ID + 两个版本
Skill ID 与 AbilityAsset ID 永远不混用
```

---

## Task 5：实现 Workspace Asset Reference

**Files:**
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/recall/workspace-refs.ts`
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/projects.ts` 或 `user_workspace.ts`，只暴露现有 canonical workspace identity。
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/ipc/index.ts`
- Test: `/Users/sudai/Documents/Mate Agent/test/main/features/recall/workspace-refs.test.ts`

- [ ] 新增 `{assetId, workspaceId, scope, enabled, createdAt, updatedAt}`。
- [ ] 同一个 Asset 可以被多个 Workspace 引用。
- [ ] 引用只保存 ID 和 scope，不复制 Asset 内容。
- [ ] 删除引用保留历史记录。
- [ ] scope 只能收窄，扩大 scope 需要重新确认。
- [ ] 只有 enabled、未 revoked、scope 匹配的 Asset 才能进入默认 RecallView。

IPC：

```text
recall.workspaceRefs.list
recall.workspaceRefs.add
recall.workspaceRefs.update
recall.workspaceRefs.remove
```

---

## Task 6：实现 RecallView 和 ContextProjection

**Files:**
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/recall/recall-view.ts`
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/recall/context-projection.ts`
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/p3394/execution-context.ts` 或现有上下文注入 choke point。
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/execution-records.ts`，只增加稳定关联读取。
- Test: `/Users/sudai/Documents/Mate Agent/test/main/features/recall/recall-view.test.ts`
- Test: `/Users/sudai/Documents/Mate Agent/test/main/features/recall/context-projection.test.ts`

- [ ] `buildRecallView(userId, input)` 根据 purpose、workspace、scope、授权、过期时间筛选资产和来源。
- [ ] 明确返回 included refs 和 omitted refs，省略项必须有 reason。
- [ ] paused、revoked、过期、超 scope 的内容不得进入 confirmed projection。
- [ ] 需要用户确认时只能生成 preview，不能直接注入。
- [ ] confirm 后冻结 asset version、source refs、scope 和 expiry。
- [ ] Projection 关联现有 TaskRun/Execution，不新增执行状态机。
- [ ] 真实注入必须通过现有 p3394/context 执行入口。

IPC：

```text
recall.view.preview
recall.projections.preview
recall.projections.confirm
recall.projections.read
```

---

## Task 7：补 Transfer Proof 和 Effectiveness Proof

**Files:**
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/recall/proof-service.ts`
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/p3394/context-reuse-receipt.ts`，只增加安全的关联读取。
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/cognition/receipts-adapter.ts`
- Test: `/Users/sudai/Documents/Mate Agent/test/main/features/recall/proof-service.test.ts`

- [ ] 任务开始前创建不可变 `ExpectedResultSnapshot`。
- [ ] 任务结束后关联 Execution Record 和 Reuse Receipt，生成 Transfer Proof。
- [ ] Transfer Proof 状态支持 prepared、succeeded、degraded、rejected、invalid、rework。
- [ ] Effectiveness Proof 必须依赖同一 TaskRun 的有效 Transfer Proof。
- [ ] 评价结果支持 better、no_improvement、worse、insufficient_evidence、invalid、rework。
- [ ] 只有有效 Effectiveness Proof 才能提升 maturity。
- [ ] worse 结果不能自动删除资产，必须生成显式治理动作：pause、narrow_scope、rework 或 rollback。
- [ ] 重复 complete/evaluate 必须幂等，不能重复推进成熟度。

---

## Task 8：持久化 Cognition Tree 和 Usage Records

**Files:**
- Create: `/Users/sudai/Documents/Mate Agent/src/main/features/recall/tree-service.ts`
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/cognition/dashboard.ts`
- Modify: `/Users/sudai/Documents/Mate Agent/src/main/features/cognition/assets-adapter.ts`
- Test: `/Users/sudai/Documents/Mate Agent/test/main/features/recall/tree-service.test.ts`
- Test: `/Users/sudai/Documents/Mate Agent/test/main/features/recall/usage-service.test.ts`

- [ ] 持久化 source、candidate、asset、workspace、task、transfer proof、effectiveness proof 节点。
- [ ] 用稳定 ID 建立关系，重复事件不能生成重复边。
- [ ] 只有 Effectiveness Proof 成功才允许树节点成长。
- [ ] 暂停、撤销、限域、回滚都保留在历史中。
- [ ] Usage Record 保存 asset/version/workspace/task/projection/outcome/boundary。
- [ ] 原始私密 excerpt 不写入 dashboard、日志或 telemetry。
- [ ] Dashboard 的 assets、pending、receipts、warnings 改为从正式记录聚合；旧适配数据只显示为 legacy 状态。

---

## Task 9：把 Recall 闭环接入现有 Asset Center

**Files:**
- Modify: `/Users/sudai/Documents/Mate Agent/src/renderer/index.html`
- Modify: `/Users/sudai/Documents/Mate Agent/src/renderer/modules/skills.js`
- Modify: `/Users/sudai/Documents/Mate Agent/src/renderer/modules/skills-bindings.js`
- Modify: `/Users/sudai/Documents/Mate Agent/src/renderer/modules/state.js`
- Modify: `/Users/sudai/Documents/Mate Agent/src/renderer/style.css`
- Modify: `/Users/sudai/Documents/Mate Agent/src/renderer/locales/en.json`
- Modify: `/Users/sudai/Documents/Mate Agent/src/renderer/locales/zh.json`
- Modify: `/Users/sudai/Documents/Mate Agent/src/renderer/locales/ja.json`
- Modify: `/Users/sudai/Documents/Mate Agent/src/renderer/locales/pt.json`
- Test: `/Users/sudai/Documents/Mate Agent/test/renderer/skills-recall-loop.test.ts`

- [ ] Candidates tab 增加编辑、暂缓、拒绝、晋升表单。
- [ ] 晋升前强制显示 type、scope、evidence 和最终 statement。
- [ ] Reuse Receipts 页面明确拆分 Transfer Proof 与 Effectiveness Proof。
- [ ] Assets 页面内部保持 Asset List / Cognition Tree / Usage Records。
- [ ] Asset 详情显示稳定 ID、版本、maturity、scope、workspace refs、proof 和 usage。
- [ ] 增加 Recall projection preview 和确认操作。
- [ ] 复用现有 compact row、single surface、icons 和 locale 机制。
- [ ] 不恢复 standalone evolution frontend。
- [ ] 保持 Skills tab 原有 create/import/edit/use/delete 行为不变。

---

## Task 10：补测试、迁移和发布门禁

**Files:**
- Create: `/Users/sudai/Documents/Mate Agent/test/main/features/recall/migration.test.ts`
- Modify: `/Users/sudai/Documents/Mate Agent/test/main/features/cognition.test.ts`
- Modify: `/Users/sudai/Documents/Mate Agent/test/main/ipc/cognition.test.ts`
- Modify: existing renderer regression tests as needed.

迁移策略：

1. 第一个版本只读现有 ontology/p3394 数据，不改变旧数据。
2. 用户主动 promote 时创建正式 AbilityAsset。
3. 旧数据只通过明确的 legacy adapter 展示。
4. 不自动把所有旧 Memory、Skill、候选转换成正式资产。
5. 迁移失败保留原始数据，并记录 migration error。

最终验证：

```bash
git diff --check
npm run typecheck
npm run test:js -- test/main/features/recall test/main/features/cognition.test.ts test/main/ipc/cognition.test.ts test/renderer/skills-recall-loop.test.ts
npm test
```

手动验证：

1. 打开 Skills，确认五个 tab 正常显示。
2. 打开已有候选，修改判断、类型和 scope。
3. 暂缓候选，再恢复待处理。
4. 晋升候选并确认 Asset ID 在刷新后不变。
5. 将同一资产引用到两个 Workspace。
6. 预览 RecallView，检查 included/omitted refs。
7. 确认 projection 后执行任务。
8. 查看 Transfer Proof。
9. 提交 Effectiveness Proof。
10. 确认 positive proof 推进成熟度，negative proof 显示 pause/scope/rework/rollback。
11. 确认 marketplace Skill 和 Memory 没有被统计为 AbilityAsset。
12. 确认原有 Skill Library 和 Skill Rollback 仍然可用。

---

## 四、推荐实施顺序

### 第一阶段：先补核心底座

```text
Task 1 → Task 3 → Task 4
```

结果：候选可以真正晋升为稳定正式资产。

### 第二阶段：打通实际任务使用

```text
Task 5 → Task 6 → Task 7
```

结果：资产可以按 Workspace/scope 被召回，并得到 Transfer/Effectiveness 证明。

### 第三阶段：补长期认知管理

```text
Task 8 → Task 9
```

结果：资产中心显示真实的树、成熟度、使用记录和治理状态。

### 第四阶段：再做产品外壳

以下不应阻塞 Recall 主链：

- onboarding
- 60 秒 Aha
- Permission Grant UI
- Connection Health
- Nightly Digest
- 主动整理
- 完整 Teaching Signal UI

---

## 五、完成标准

当以下链路全部可运行时，才认为 Recall 核心迁移完成：

```text
已有候选
→ 用户编辑和审查
→ 正式 AbilityAsset
→ 稳定 Asset ID
→ Workspace 引用
→ RecallView
→ ContextProjection 确认
→ 现有 Task/Execution
→ Transfer Proof
→ Effectiveness Proof
→ Cognition Tree 成长
```

并满足：

- 不重复建设 Memory、Contexts、p3394、Execution、Evolution、Workspace。
- 不把 Skill、Memory、旧 Adapter View Model 当作正式 AbilityAsset。
- 不新增第二套执行状态机或 Receipt 存储。
- 不在 IPC/Renderer 直接启动进程或绕过现有执行 choke point。
- Recall 数据始终位于用户 cloud 数据域，并接入现有 sync/dirty 机制。
