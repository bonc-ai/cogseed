# 四类正式能力资产 — 实施规范

> 代码基线：`develop` @ `6c85649a`（2026-08-15）
> PRD 真值来源：`P3394_CogSeed_PRD_doc-v1.6_Review.docx`
> 状态：Draft，待 PO / Tech Lead 确认 §23 Open Questions
>
> 标记约定：**[PRD Required]** = PRD 原文明确要求；**[Impl Rec]** = 本文的实现建议，PRD 未冻结；**[Open]** = 需要 PO 拍板。
>
> 仓库现有 spec 惯例是 `docs/superpowers/specs/<date>-<topic>.md`。本文按任务指定路径放在 `specs/cognition-assets/spec.md`，如需并入既有目录请整体移动。

---

## 1. Background

CogSeed 的"能力资产"页目前列出的东西，并不都满足 PRD 3.1 对正式认知资产的定义。同时四类资产的分类完全依赖模型对四个英文枚举值的自由理解，PRD 中大量硬性边界（项目事实不得进 Personal、原文件不得直接成为 Template、Rule 必须有适用/禁止范围、Skill 必须过正式准入）在代码里没有任何对应的约束点。

结果是三类可观察的问题：

1. **语义污染** — 非资产对象（Personal Ontology 分组）出现在资产列表里，并被硬编码授予 `transfer_validated` 成熟度。
2. **字段空转** — `applicableWhen` / `forbiddenWhen` / `sensitivity` 有定义、有校验、有存储，但所有自动写入路径都不填，真实数据实测全为空。
3. **状态失真** — 代码的成熟度阶梯与 PRD 不一致；`system_precipitated_unverified` 定义了却从不写入；TransferProof 在没有 Receipt、没有用户确认的情况下自动完成。

本规范的目的是把这些差距转成可执行的工程任务。

## 2. Scope

只覆盖四类正式个人认知资产及其完整生命周期：

- PersonalOntologyAsset（`personal`）
- RuleAsset（`rule`）
- TemplateAsset（`template`）
- SkillAsset（`skill_method`）

链路范围：来源 → 识别 → Candidate → Review → Promote → Asset Record → List/Detail UI → Runtime 使用 → Receipt/Evaluation → Maturity/Version/Rollback。

## 3. Non-Goals

- 不把 Session、Memory、Evidence、Receipt、RelationshipAssertion、TaskContinuationSnapshot、Workspace/Project 状态、原始文件、日志重新定义为正式资产。PRD 3.3 已把它们列为非资产支撑对象，本规范维持该边界。
- 不引入第五类资产。
- 不改动 KSTAR 的 Episode/Review 内部模型，只改它与四类候选的接口。
- 不设计企业侧 ExternalAssetRef 的并入路径（PRD 3.4 明确禁止并入个人资产）。
- 不在本文里写实现代码。

## 4. PRD Source of Truth

### 4.1 四类资产定义与最低准入门槛（PRD 3.1）

| 用户分类 | 内部对象 | 内容 | 进入正式资产的最低门槛 |
|---|---|---|---|
| 关于我 | PersonalOntologyAsset | 身份、角色、偏好、关系、长期环境与边界 | 用户确认来源与内容；标记"使用效果尚未验证" |
| 规则与偏好 | RuleAsset | 决策、约束、原则、风格、安全规则和项目规范 | 用户确认来源、作用域、适用与禁止范围；项目事实默认保持项目作用域 |
| 模板与范例 | TemplateAsset | 文档模板、检查表、结构范例、示例 Artifact 和可复用片段 | 用户确认可复用结构、来源、敏感边界和适用范围 |
| 技能与方法 | SkillAsset | Goal、Action Plan、输入输出、Ontology Binding、工具、流程和 Evaluation | 通过正式 Skill 准入；用户确认，且有运行结果和 Evaluation 后才可标记已验证 |

PRD 3.1 结语：**"Skill 为执行中心，但不把全部资产变成 Skill"** —— Skill 运行时引用 Personal Ontology、规则、项目事实、模板和工具；这些对象保持独立 Owner、版本和作用域。

### 4.2 来源与候选分流（PRD 3.2）

五类受控来源枚举：`conversation` / `artifact_file` / `execution_evaluation` / `user_teaching_signal` / `authorized_external_system`。

固定链路：

```
CognitionSource → RecallView（Memory 派生召回）→ CognitionCandidate → 用户审查
  → 分类型正式资产 → ContextProjection → TaskRun → Evidence/Evaluation → KSTAR 更新候选
```

**候选按内容而不是按来源分流**（PRD 3.2 表）：

| 候选内容 | 目标候选对象 | 规则 |
|---|---|---|
| 身份、角色、偏好及长期事实 | OntologyDelta | 进入 Personal Ontology 候选，不直接修改 ABox |
| 人物/组织/角色/Workspace/Project/Task/Artifact 之间的关系 | RelationshipAssertion | 先形成带来源、范围、时间和确认状态的**非资产**断言；稳定、跨任务且经用户确认的个人关系可再触发 OntologyDelta；**项目或任务关系不得自动晋升** |
| 判断、约束、边界和决策原则 | RuleCandidate | 确认来源、适用与禁止范围 |
| 可复用文档结构、检查表和范例 | TemplateCandidate | 保留来源、敏感边界和版本 |
| 稳定 Action Plan、流程和方法 | SkillEvolutionCandidate | 进入 Skill 准入与 Evaluation 流程 |
| 成功标准、评分或评价方法变化 | EvaluationCandidate | 不自动覆盖现有 Evaluation Contract |

Memory 三种运行语义（均**不是**正式资产）：SessionMemory / Task State Summary、RecallView、Personal/Project Memory 候选。PRD 原文："自动记住任务进度"与"自动拥有一项长期认知资产"是两件事。

**Artifact → Template 晋升边界（PRD 3.2 原文）**：原始 Word、代码、报告、图片及其当前版本继续作为 CognitionSource、Project Context 或任务 Evidence；系统只能从中**提议可复用结构、检查表、范例或片段**。只有用户确认复用意图、来源、敏感边界、适用范围和版本后，该结构才可成为 TemplateAsset。原文件不因模板候选被创建而改变 Owner、位置或项目作用域。

**UserTeachingSignal**：用户明确表达"记住/以后使用/以后避免"时记录为 UserTeachingSignal，可作为用户在明确内容和作用域内的确认，但**必须返回可见回执并允许撤销**；敏感、冲突、跨角色或跨作用域信息仍需单独审查。

### 4.3 非资产支撑对象（PRD 3.3）

来源与选择、候选与审查、连续性与上下文、Evidence 与评价、治理与审计五组对象，均"可以持久化、版本化或自动更新，但其状态不等于正式资产成熟度，也不触发认知树成长"。RuntimeState（打开的窗口、终端命令、临时目录、运行中的计划、未保存中间状态）既不是资产也不进接续快照。

### 4.4 归属与 Workspace 作用域（PRD 3.4）

三层归属：全局个人认知资产（四类，用户拥有）/ Workspace-Project 支撑记录 / 来源与运行现场。

硬规则：每位用户只有一个全局个人资产集合和一棵认知树；Workspace 只保存稳定引用，不复制资产；同一资产被多个 Workspace 引用时保持**稳定资产 ID 和版本谱系**；`source_workspace_ref` / `source_project_ref` / `scope` 只记录来源与边界，不得解释为 Workspace 取得所有权。

版本引用策略（PRD 3.4.2）：`pinned` / `review_required`（默认）/ `follow_latest_compatible`（后续候选，未经单独授权不得启用）。TaskRun 启动时**冻结 `asset_version_refs` 与 Main Skill Baseline，运行中不得静默切换**。

### 4.5 共通元数据（PRD 3.5）

`asset_id` / `asset_type` / `owner` / `source_refs` / `source_workspace_ref` / `version` / `scope` / `applicable_when` / `forbidden_when` / `target_agents` / `evidence_refs` / `maturity` / `sensitivity` / `control`。

### 4.6 成熟度与默认使用契约（PRD 3.6）

| 状态 | 成立条件 | 是否正式资产 | 默认使用规则 |
|---|---|---|---|
| Candidate | 系统从授权来源提出，未获用户确认 | 否 | **不得注入后续任务** |
| User Confirmed / Unverified | 用户确认内容、来源、类型和作用域 | 是 | **仅在用户主动选择时使用，不得静默默认注入** |
| Transfer Verified | 目标 Agent 或隔离新 Session 真实加载该资产，形成可追溯 Action Plan 或可观察行为，**并生成 Receipt** | 是 | 可在相同作用域和权限内默认推荐或注入；仍不得宣称改善结果 |
| Effectiveness Validated | 存在可比 Baseline/Treatment、Behavior Diff、Evaluation，且质量不下降、无高严重度负迁移 | 是 | 可在已验证适用范围内优先推荐 |
| Paused / Revoked / Rolled Back | 用户暂停、撤销、回滚，或系统触发安全/负迁移保护 | 保留审计记录 | 停止默认注入 |

PRD 原文：**"正式资产"是从 User Confirmed / Unverified 开始的治理总称，不等于"已经有效"。确认、传递证明和有效性证明必须分别记录，界面、指标和对外文案不得混用。**

### 4.7 Skill Baseline（PRD 8.2）

正式 SkillAsset 与 Main Skill Baseline 至少包含：SkillManifest + 稳定 Skill ID 和版本；Goal、Trigger、适用与反触发边界；Owner、来源、Provenance 和许可证；Action Plan；Input/Output Schema；Tool、Agent 与辅助 Skill 依赖；Task Ontology、Personal Ontology 引用和 OntologyBinding；Evaluation Contract；权限、敏感范围、禁止范围和安全要求；运行结果、Evidence、状态和回滚点。

正式准入规则（PRD 8.2）：外部 Skill 导入先进兼容候选；须通过 Skill Validator、Security Scanner 适配检查和**最小真实运行验证**才可成为正式 Baseline 候选；仅有 Prompt、聊天摘要或模型建议时只能形成 Skill 候选；未经用户确认和 Evaluation 不得标记已验证；**规则、模板、Personal Ontology 和 Artifact 无需为了准入而包装成 Skill**。

### 4.8 Gate A / Gate B（PRD 8.x）

Gate A（受治理的能力改进候选闭环）：绑定显式 Baseline Skill ID 与不可变版本；记录 Action Plan、实际动作、Artifact 和 Evidence；冻结 Expected Result，独立记录 Actual Result、Delta 与 Attribution；生成类型明确的 SkillEvolutionCandidate 及可读 Diff；用户完成"有效/需要修正/不适用/暂不判断"之一；候选、新版本和回滚点不可变可追溯。通过 Gate A **只能表述为"形成受治理的能力改进候选"**。

Gate B（已验证能力进化闭环）：在隔离的新 Session 或 Agent 中用候选新版本重跑；任务、环境、输入和 Baseline 可比；证明至少一项目标结果改善且质量不下降；完成负迁移和适用范围检查；生成 ContextReuseReceipt、版本结论和暂停/回滚证据。

---

## 5. Current Implementation Audit

所有结论基于 `6c85649a` 实际代码，附文件与行号。

### 5.1 类型枚举与分类产生

| 事实 | 位置 |
|---|---|
| 四类枚举与 PRD 一一对应 | `src/main/features/recall/candidate-service.ts:64` `AbilityAssetType = 'personal' \| 'rule' \| 'template' \| 'skill_method'` |
| 会话线分类完全交给模型，提示词只给枚举值、**不给任何一类的定义或边界** | `src/main/features/recall/capture-service.ts:650 extractionSystemPrompt()`，第 654 行 schema 中仅 `"suggestedType":"personal\|rule\|template\|skill_method"` |
| KSTAR 线分类是 attribution 的硬映射，一个 Episode 只出一类 | `src/main/features/kstar/extraction-service.ts:30 gapType()` |

提示词现有 8 条约束（引用用户消息、不编造、最多 3 条、需要 concrete value 与 suggestedAction 等），**没有一条**对应 PRD 的分类边界。

### 5.2 候选与晋升

| 事实 | 位置 |
|---|---|
| 会话线建候选 | `capture-service.ts:1538 saveRecallCandidate()` |
| KSTAR 线 adapter → 候选 | `src/main/features/kstar/direct-experience-assets.ts:39 proposalToCandidateInput()` / `:92 saveRecallCandidate()` |
| 统一晋升出口（语义查重 + 质量融合） | `candidate-service.ts:826 autoApplyRecallCandidate()` / `:850 semanticDedupBeforePromote()` / `:870 loadDedupPools()` + `src/main/features/recall/similarity.ts:158 findSemanticDuplicate()` |
| 查重域覆盖候选池 + 资产库（两条线共用） | `candidate-service.ts:870` |
| **embedding 失败时查重静默失效** | `similarity.ts:64 embedForDedup()` 返回 `null` → 直接走原 promote，仅一行 warn |
| 安全 Gate 已接入 | `candidate-service.ts:1106 evaluateCandidate()` / `:1111 isCandidateBlocked()` |

### 5.3 资产记录与共通元数据

`candidate-service.ts:109-160 RecallAbilityAssetRecord` 对照 PRD 3.5：

| PRD 3.5 字段 | 代码 | 状态 |
|---|---|---|
| asset_id / asset_type / owner | `id` / `type` / `ownerId` | ✅ 已实现 |
| source_refs | `evidenceRefs`、`sourceSessionIds` | ✅ 已实现 |
| source_workspace_ref | `spaceId`（语义近似） | ⚠️ 部分实现 |
| version | `version` + `asset-service.ts:813 listAbilityAssetVersions` | ✅ 已实现 |
| scope | `scope` + `scopePolicy` | ✅ 已实现 |
| applicable_when / forbidden_when | `applicableWhen?` / `forbiddenWhen?`（`:126-128`） | ⚠️ **只有字段**，见 5.5 |
| target_agents | 无对应字段 | ❌ 完全缺失 |
| evidence_refs | `evidenceRefs` | ✅ 已实现 |
| maturity | `maturity` | ⚠️ 阶梯与 PRD 不一致，见 5.6 |
| sensitivity | `sensitivity?`（`:130`） | ⚠️ 只有字段 |
| control | `asset-service.ts:518/522/526/697/708/725/761/779` pause/revoke/resume/archive/delete/purge/restore/rollback | ✅ 已实现 |

治理 API 完整度较高，`asset-service.ts` 另有 `:833 listAbilityAssetAudit`（事件账本）、`:820 readAbilityAssetVersionSnapshot`。IPC 侧 15 个通道（`src/main/ipc/index.ts:2218-2327` `recall.assets.*`）。

### 5.4 边界污染：Personal Ontology 分组混入资产列表

`src/main/features/cognition/assets-adapter.ts:110-125`：

```ts
if (!category || category === 'personal') {
  const groups = await personalOntologyGroups.listGroups(userId);
  for (const group of groups) {
    items.push(baseAsset({
      id: `CA-PERSONAL-${group.group_id}`,
      type: 'personal',
      source: 'personal_ontology',
      maturity: 'transfer_validated',   // 硬编码
      status: 'active',
```

- 记忆分组是容器（md 文件 + 字段），按 PRD 3.3 属于支撑记录，不得占用一级资产分类。
- `maturity: 'transfer_validated'` 无 TransferProof、无 Receipt 直接授予，违反 PRD 3.6 Transfer Verified 的成立条件。
- 渲染层已发现问题并在列表中过滤（`src/renderer/modules/skills.js:1649` `item.source !== 'personal_ontology'`），但**摘要计数未过滤**（`skills.js:328 _abilityAssetSummary` 直接数 `items`）→ 卡片数字大于列表条数。

**判定：边界污染 + UI 不一致。**

### 5.5 RuleAsset 边界字段空转

- 字段定义带注释"缺失=没记录过，**不是**「无限制」"（`candidate-service.ts:126`）。
- 唯一写入来源是 `promoteRecallCandidate` 的 options（`candidate-service.ts:1252 readAbilityAssetSemantics(options)`）。
- 自动路径 `autoApplyRecallCandidate` 调用 `promoteRecallCandidate(userId, id, { actor: 'system' })`（`:834`、`:861`），**不传任何 semantics**。
- 本机真实数据实测（3 条资产，`~/.cogseed/.../cloud/recall/records/ability-assets/`）：`applicableWhen/forbiddenWhen` 全部 `0/0`，包括用户确认路径写出的资产 —— 说明评审 UI 也没有让用户填这两项。

**判定：只有字段。PRD 3.1 对 RuleAsset 的最低门槛（用户确认作用域、适用与禁止范围）未实现。**

### 5.6 成熟度阶梯与 PRD 不一致

| PRD 3.6 | 代码（`asset-service.ts:103`） |
|---|---|
| Candidate（非资产） | 候选独立存储 ✅ |
| User Confirmed / Unverified | `bud`（用户线）/ `seed`（系统线） |
| Transfer Verified | `transfer_validated` |
| Effectiveness Validated | `effectiveness_validated` |
| Paused / Revoked / Rolled Back | `status` 字段（与 maturity 正交）✅ |
| — | `stable` ← **PRD 中不存在，且全仓无写入路径** |

- `seed`/`bud` 是 PRD 没有的中间档，且与 lifecycleStatus 语义重叠。
- `stable` 只在枚举、校验集和 `asset-semantics.ts:141` 出现，`setAbilityAssetMaturity` 的两个调用点（`proof-service.ts:62` / `:76`）都不写它 → **死语义**。
- 08-06 基线 `dff352b8` 的定义只有 4 档且注释写明顶到 `effectiveness_validated`；`stable` 由 `436b2bd1`（2026-08-13）加入。

### 5.7 Transfer Verified 判定过松

`src/main/features/recall/terminal-proof.ts:33-67`：任务终态为 `completed` 且存在 confirmed projection 时，直接 `completeTransferProof({ status: 'succeeded' })`（`:62`），`proof-service.ts:62` 随即把资产升到 `transfer_validated`。

对照 PRD 3.6 Transfer Verified 的成立条件（真实加载、可追溯 Action Plan 或可观察行为、**并生成 Receipt**）：

- `completeTransferProof` 的 `receiptId` 是可选参数，terminal-proof **不传**；
- 没有"可定位使用"的检查；
- 没有用户"带入正确"确认。

**判定：把"任务跑完了"等同于"带入正确"，比 PRD 松。**

### 5.8 lifecycleStatus 三档只写两档

`candidate-service.ts:67` 定义三值并附注释区分来源；`:1390` 的赋值只有二选一：

```ts
lifecycleStatus: handoffActor === 'system'
  ? 'automatically_extracted_unverified'
  : 'user_confirmed_unverified',
```

全仓无 `system_precipitated_unverified` 写入点 → 认知树无法区分"KSTAR 自进化沉淀"与"会话自动抽取"。**判定：死语义。**

（此前 KSTAR 直写资产并谎标 `user_confirmed_unverified` 的问题已在 `49404391` 修复，现最差也只标 `automatically_extracted_unverified`，属诚实标注。）

### 5.9 TemplateAsset：无提炼链路

- 全仓 `type: 'template'` 写入点只有两处：`src/main/features/session_import/welcome-message.ts:38`（纯文案标签）和 `src/main/features/personal_context/ontology-pipeline.ts:52`（把**日程事件**映射成 `template`，注释"实例化信息 → instance / user"）。
- 后者写入的是旧 `personal_ontology_candidates` 池（`:78 ontology.addCandidates`），而该池的 IPC 已在 `f4e6177f` 合并中全部删除；`submitCandidatesForResource` **零调用方**。
- 没有任何 Artifact → 可复用结构提炼的代码。

**判定：Artifact ≠ Template 的边界目前没被破坏，但不是因为有约束，而是因为整条链路不存在。`template` 类型实际空跑。同时 `ontology-pipeline.ts` 是含错误分类的死代码。**

### 5.10 SkillAsset：资产层与执行层分离且未定义关系

- `RecallAbilityAssetRecord` 对 `skill_method` **无任何专属字段**，一条 SkillAsset 就是 `title` + `statement` + `scope`，与 RuleAsset 同形。
- 结构存在于草稿：`src/main/prompts/recall_skill_draft.md:13` 的 JSON schema 含 `description` / `useWhen` / `doNotUseWhen` / `requiredInputs` / `workflowSteps` / `outputs` / `validationChecks` / `failureModes` / `ontology{concepts,relations}` / `mutableSurfaces`。
- 对照 PRD 8.2 覆盖情况：Goal ≈ `description` ✅；Trigger/反触发 ≈ `useWhen`/`doNotUseWhen` ✅；I/O ✅；Action Plan ≈ `workflowSteps` ✅；Evaluation Contract ≈ `validationChecks`+`failureModes` ✅；Ontology Binding ✅。**缺失**：Tool/Agent/辅助 Skill 依赖、Owner/Provenance/许可证、权限与安全要求、运行结果与 Evidence、回滚点、稳定 Skill ID 与版本（提示词注释称由 host 管，但 host 侧无对应落盘字段）。
- 无 Skill Validator / Security Scanner / 最小真实运行验证作为**晋升前置**（安全扫描存在于技能安装侧，不在资产晋升侧）。
- 资产与 Skill 的关联仅靠 `assetId`（`assets-adapter.ts:38 readInstalledSkillForAsset`、`:44 readRecallSkillDraft`）。**source of truth 未定义。**

### 5.11 Runtime / Workspace

| 事实 | 位置 | 状态 |
|---|---|---|
| ContextProjection 冻结 assetVersions | `src/main/features/recall/context-projection.ts:70` / `:119`，并有 `projection_asset_version_changed` 降级码（`:32`） | ✅ 已实现 |
| ContextReuseReceipt 存在 | `src/main/features/p3394/context-reuse-receipt.ts:21-63` | ✅ 已实现 |
| 提示词注入与引用回执 | `src/main/features/group_chat/bus.ts:3835 buildRecallTurnPromptContext` / `:5220 recordRecallUsage` | ✅ 已实现 |
| TaskRun 冻结 `asset_version_refs` + Main Skill Baseline | 仅 `cognition/types.ts:149 baselineSkillRef` 字段；无冻结逻辑 | ❌ 部分/缺失 |
| Workspace 引用版本策略（pinned / review_required / follow_latest_compatible） | 无 | ❌ 完全缺失 |
| `target_agents` 注入白名单 | 无 | ❌ 完全缺失 |
| **User Confirmed / Unverified 不得静默默认注入** | 注入侧未按 maturity 分档过滤 | ❌ 需核实并补齐 |

---

## 6. Gap Matrix

严重度：**S1** = 违反 PRD 硬边界或产生虚假状态；**S2** = 语义不完整、用户可感知的错误；**S3** = 缺能力但不产生错误信息。

### 6.1 PersonalOntologyAsset

| PRD 要求 | 当前实现 | 缺口 | 严重度 | 阻塞正式资产语义 |
|---|---|---|---|---|
| 只收身份/角色/偏好/关系/长期环境与边界 | 模型自由判断，提示词无定义 | 无分类约束，项目事实可能入库 | S1 | 是 |
| 项目事实、任务目标、阶段留在 Workspace/Project | 无任何拦截 | 无 | S1 | 是 |
| RelationshipAssertion 是非资产，仅稳定个人关系经确认可触发 OntologyDelta | 无 RelationshipAssertion 对象，无 OntologyDelta 晋升通道 | 完全缺失 | S2 | 部分 |
| 用户确认来源与内容后标记"效果尚未验证" | `user_confirmed_unverified` ✅ | 无 | — | 否 |
| 分组等支撑对象不得占一级分类 | `assets-adapter.ts:110` 注入分组并假授 `transfer_validated` | 边界污染 + 虚假成熟度 | S1 | 是 |

### 6.2 RuleAsset

| PRD 要求 | 当前实现 | 缺口 | 严重度 | 阻塞 |
|---|---|---|---|---|
| 用户确认来源、作用域、适用与禁止范围 | 字段有（`:126-128`），自动路径不填，用户路径 UI 不问 | 最低准入门槛未实现 | S1 | 是 |
| 条件 + 原则 + 边界结构 | 只有一段 `statement` 自由文本 | 无结构化 condition/principle | S2 | 部分 |
| 项目事实默认保持项目作用域 | `scope` 存在但无"项目事实→project scope"判定 | 无 | S2 | 部分 |
| 敏感级别与外发限制 | `sensitivity?` 只有字段 | 无写入路径 | S2 | 否 |

### 6.3 TemplateAsset

| PRD 要求 | 当前实现 | 缺口 | 严重度 | 阻塞 |
|---|---|---|---|---|
| Artifact → 可复用结构提炼 → TemplateCandidate → 用户确认 → TemplateAsset | 整条链路不存在 | 完全缺失 | S3（无错误信息，但能力为零） | 是 |
| 原文件不得直接成为 Template | 事实上没被破坏（无路径） | 无显式约束点 | S3 | 否 |
| 保留来源、敏感边界、适用范围、版本 | 通用字段可承载，无 Template 专属 payload | 缺 sections/slots/checklist 结构 | S3 | 是 |
| 死代码：日程事件 → `template` | `personal_context/ontology-pipeline.ts:52`，零调用方 | 待清理 | S3 | 否 |

### 6.4 SkillAsset

| PRD 要求 | 当前实现 | 缺口 | 严重度 | 阻塞 |
|---|---|---|---|---|
| 资产至少含 SkillManifest + 稳定 ID/版本 + 11 项内容（PRD 8.2） | 资产层只有 title/statement；结构在草稿 | 资产层与执行层关系未定义 | S1 | 是 |
| 通过正式 Skill 准入（Validator + Security Scanner + 最小真实运行）才可为 Baseline 候选 | 晋升侧无准入检查 | 缺前置 Gate | S1 | 是 |
| 有运行结果和 Evaluation 后才可标记已验证 | 依赖通用 proof 链，未按 Skill 单独把关 | 部分 | S2 | 部分 |
| Tool/Agent/辅助 Skill 依赖、权限安全、回滚点 | 草稿与资产均无 | 缺失 | S2 | 部分 |

### 6.5 Shared Asset Infrastructure

| 能力 | 状态 | 证据 |
|---|---|---|
| Owner | ✅ 已实现 | `ownerId`，`asset-service.ts:331` 校验 owner mismatch |
| source / provenance | ⚠️ 部分实现 | `evidenceRefs` / `learningProvenance` 有；`source_workspace_ref` 仅 `spaceId` 近似 |
| asset id | ✅ 已实现 | `aa-*` 稳定 id |
| immutable version | ✅ 已实现 | `listAbilityAssetVersions:813` / `readAbilityAssetVersionSnapshot:820` |
| scope | ✅ 已实现 | `scope` + `scopePolicy` |
| applicable / forbidden | ⚠️ **只有字段** | 见 5.5 |
| Evidence refs | ✅ 已实现 | `evidenceRefs` |
| Receipt refs | ⚠️ 部分实现 | `receiptRefs` 在 summary 层；资产记录无直接字段 |
| lifecycleStatus | ⚠️ 三档写两档 | `:1390`，见 5.8 |
| maturity | ⚠️ 阶梯与 PRD 不一致 + 含死值 | 见 5.6 |
| permission / sensitivity | ⚠️ 只有字段 | `sensitivity?:130`；无 `target_agents` |
| pause / revoke / rollback / delete / purge / restore / archive | ✅ 已实现 | `asset-service.ts:518-779` |
| Workspace ref | ⚠️ 部分实现 | `spaceId` + `workspace-refs.ts`；无版本策略 |
| runtime projection | ✅ 已实现（含版本冻结） | `context-projection.ts:70/119/32` |
| audit / event ledger | ✅ 已实现 | `listAbilityAssetAudit:833` + `appendAudit` |
| 死代码 | — | `ontology-pipeline.ts` 全文件；`task-closure.ts:217/:298` bridge 死参数；`stable` 成熟度 |

---

## 7. Target Domain Model

### 7.1 Common Asset Envelope **[PRD Required]**

四类共用，字段直接对应 PRD 3.5：

```
assetId            稳定唯一标识，跨 Workspace 不变
assetType          personal | rule | template | skill
owner              资产归属人（P0 固定为当前本地用户）
version            可比较、可回滚
lifecycleStatus    见 §16.1（来源标签，不是成熟度）
maturity           见 §16.2（PRD 3.6 四档 + 治理态）
scope              personal | project | task | 明确组合
sourceRefs[]       五类受控来源引用
provenance         产生这条资产的线（capture / kstar / teaching_signal / import）
sourceWorkspaceRef 仅追溯，不改变 Owner
applicableWhen[]   适用条件
forbiddenWhen[]    禁止范围
targetAgents[]     允许注入的 Agent 或连接类型
sensitivity        敏感级别与外发限制
evidenceRefs[]     运行、对比、用户评价等 Evidence
receiptRefs[]      ContextReuseReceipt 引用
governance         暂停/限域/撤销/回滚/删除规则与当前 control 状态
createdAt/updatedAt
payload            分类型专属结构，见 §8-§11
```

**关键约束 [PRD Required]**：`applicableWhen` / `forbiddenWhen` / `sensitivity` 为 `undefined` 时，语义是"**没记录过**"，**不得**解释为"无限制"或"L0"。任何以 `undefined` 作为放行依据的运行时判断都是缺陷。

### 7.2 分类型 payload 的必要性 **[Impl Rec]**

四类不应共用一个扁平结构：Rule 需要条件/原则/边界三元组，Template 需要 sections/slots，Skill 需要 Manifest 引用。建议 envelope + `payload` 联合类型，`payload` 按 `assetType` 判别。现有 `statement: string` 保留为**所有类型的人类可读摘要**，不再承担结构表达职责。

---

## 8. PersonalOntologyAsset Specification

### 8.1 语义 **[PRD Required]**

表达"用户是谁、长期是什么样"。PRD 3.1：身份、角色、偏好、关系、长期环境与边界。

### 8.2 payload **[Impl Rec]**

```
kind        identity | role | preference | stable_relationship | long_term_environment | boundary
statement   稳定认知的一句话表述
stability   为什么认为它是长期的（跨任务出现次数 / 用户明确声明）
```

### 8.3 准入 **[PRD Required]**

用户确认来源与内容；写入后标记"使用效果尚未验证"（`maturity = user_confirmed_unverified`）。

### 8.4 绝对排除 **[PRD Required]**

- 项目事实、客户资料、项目决策 → Workspace/Project 支撑记录（PRD 3.4）
- 当前任务目标、阶段、进度、Sprint 截止 → 非资产（PRD 3.2 "自动记住任务进度"≠"拥有长期资产"）
- RelationshipAssertion 本身 → 非资产断言（PRD 3.2/3.4）
- Personal Ontology 分组、角色模板文件 → 支撑记录（PRD 3.3）

### 8.5 关系晋升通道 **[PRD Required]**

`RelationshipAssertion`（带来源、范围、时间、确认状态）→ 仅当**稳定、跨任务且经用户确认**的个人关系 → 触发 `OntologyDelta` → 形成 PersonalOntologyAsset 新版本。项目或任务限定关系默认只留在局部 Context，**不得自动晋升**。

> 当前仓库无 RelationshipAssertion / OntologyDelta 对象，属新建。

---

## 9. RuleAsset Specification

### 9.1 语义 **[PRD Required]**

"遇到什么条件时，应遵守什么判断或行为原则。"PRD 3.1：决策、约束、原则、风格、安全规则和项目规范。

### 9.2 payload **[Impl Rec]**

```
condition        触发条件（对应 applicableWhen 的可读表达）
principle        应遵守的判断或行为原则
applicableWhen[] 适用边界
forbiddenWhen[]  禁止边界
scope            personal | project | task
sensitivity      敏感级与外发限制
conflictPolicy   与既有 Rule 冲突时的处置（见 §9.4）
```

### 9.3 边界缺失的处理 **[Open Decision]**

PRD 3.1 明确 RuleAsset 的最低门槛包含"用户确认作用域、适用与禁止范围"。当自动线产出的 Rule 候选没有边界时，三个候选方案：

- **A. 保留为 Candidate**：不晋升，停在 `pending_review` 等用户补边界。最符合 PRD 字面，但自动线产能归零。
- **B. 晋升但标 `boundary_pending`**：写入正式资产，`maturity` 停在 `user_confirmed_unverified` 之下的受限态，**不得进入任何默认 runtime projection**，UI 明确显示"边界待补"。
- **C. 由模型产出边界，用户确认**：扩展提取提示词要求同时产出 `applicableWhen`/`forbiddenWhen`，仍需用户确认才晋升。

**本文推荐 A + C 组合 [Impl Rec]**：模型必须产出候选边界（C），没有边界的候选停在 Candidate（A），不引入新的中间资产态。B 会在资产库里造出一批"半成品正式资产"，与 PRD"正式资产是治理总称"的表述冲突。**需 PO 确认。**

无论选哪个，硬约束不变 **[PRD Required]**：`undefined` 边界不得被解释为无限适用。

### 9.4 冲突处理 **[Open]**

PRD 未冻结 Rule 之间的冲突决策器。当前只有精确指纹去重 + 语义查重（`similarity.ts`）。冲突（同条件不同原则、范围重叠）如何裁决需 PO 定义。

---

## 10. TemplateAsset Specification

### 10.1 语义 **[PRD Required]**

"下次可以直接拿来套用的可复用结构"。PRD 3.1：文档模板、检查表、结构范例、示例 Artifact 和可复用片段。

### 10.2 正式链路 **[PRD Required]**

```
Artifact / 原始文件（保持 CognitionSource / Project Context / Evidence 身份，Owner/位置/作用域不变）
   → 可复用结构提炼（系统只能"提议"）
   → TemplateCandidate（保留来源、敏感边界、版本）
   → 用户确认：复用意图 + 来源 + 敏感边界 + 适用范围 + 版本
   → TemplateAsset
```

### 10.3 payload **[Impl Rec]**

```
structureKind   document_template | checklist | structure_example | sample_fragment | output_skeleton
sections[]      结构节点（标题/层级/说明）
slots[]         占位符（名称、含义、是否必填）
checklistItems[]
sampleFragments[]
sourceArtifactRefs[]  来源 Artifact 引用（只读引用，不复制内容）
sensitiveBoundary     哪些内容不得随模板外发
```

### 10.4 绝对排除 **[PRD Required]**

- 整份原文件复制成 TemplateAsset
- 日程、会议、任务实例等实例化信息（当前 `ontology-pipeline.ts:52` 的错误映射）
- 未经用户确认复用意图的任何结构

---

## 11. SkillAsset Specification

### 11.1 语义 **[PRD Required]**

"一套可执行、可验证的方法"。PRD 8.2 列出 11 类必需内容（见 §4.7）。

### 11.2 资产层与执行层的关系 **[Open Decision — 需 Tech Lead 拍板]**

三个方案：

| | A. SkillAsset 直接持有完整 SkillManifest | **B. SkillAsset 持稳定引用，SkillManifest 为执行体** | C. 双写 |
|---|---|---|---|
| source of truth | 资产库 | **SkillManifest（技能库）** | 需同步协议 |
| version 控制 | 资产 version | **Skill version，资产记录 `skillVersionRef` 谱系** | 双份 |
| assetId / skillId 关联 | 内嵌 | **资产持 `skillId` + `skillVersion`，Skill 持 `sourceAssetId`（双向）** | 双向 |
| capability pack 引用 | 资产 | **Skill baseline（PRD 8.2 "绑定显式 Baseline Skill ID 与不可变版本"）** | 歧义 |
| UI 详情读取 | 资产 | **资产页读 envelope，详情联查 Manifest** | 任一 |
| KSTAR Evolution 更新 | 资产版本 | **Skill 新版本 → 资产 ref 升级建议** | 冲突风险 |
| rollback 一致性 | 单点 | **Skill 回滚 → 资产 ref 回退到旧 skillVersion** | 难 |

**本文推荐 B [Impl Rec]**。理由：PRD 8.2 把 Baseline 的不可变性、准入检查、Validator/Security Scanner 都定义在 Skill 侧；Gate A 要求"绑定显式 Baseline Skill ID 与不可变版本"；把 Manifest 复制进资产会产生两个 source of truth 和无法保证的一致性。方案 B 下 SkillAsset 的 payload 是：

```
skillId           稳定 Skill ID
skillVersionRef   不可变版本引用（TaskRun 冻结用）
admissionStatus   draft | candidate | admitted（Validator + Security + 最小运行验证均通过）
goalSummary       资产页可读摘要（冗余快照，只读）
triggerSummary    同上
evaluationRef     Evaluation Contract 引用
rollbackPointRef  回滚点
```

**必须由 Tech Lead 确认后才能开工。**

### 11.3 准入 **[PRD Required]**

未通过 Skill Validator、Security Scanner 适配检查和**最小真实运行验证**的，只能是 Skill 候选，不得成为正式 SkillAsset/Baseline。仅有 Prompt、聊天摘要或模型建议时同理。

### 11.4 绝对排除 **[PRD Required]**

- "我擅长 X" 这类能力声明
- 为了准入而把 Rule / Template / Personal Ontology / Artifact 包装成 Skill

---

## 12. Candidate Classification

### 12.1 统一分类规则 **[PRD Required 的边界 + Impl Rec 的问法]**

分类必须写进提取提示词与确定性后校验两处，不能只靠模型自由理解。

| 类型 | 判定问题 | 必要成分 | 反例（必须拒绝） |
|---|---|---|---|
| `personal` | 这是关于用户**长期稳定**的什么？ | 稳定性证据（跨任务/用户明确声明） | 当前任务进度、当前 Sprint、某次会议安排、临时联系人关系、当前项目事实 |
| `rule` | 遇到什么条件时，应遵守什么判断或行为原则？ | condition + principle + boundary | 裸偏好（"喜欢简洁"）、一次性指令 |
| `template` | 是否存在可在未来重复套用的**结构**？ | 可复用结构本身 | 原始文件、单次产出物、实例化信息（日程/会议） |
| `skill_method` | 是否存在一套可执行、可验证的方法？ | Trigger + Input + Action Plan + Output + Evaluation 五项可落 | "我擅长写 PRD"、单步操作 |

### 12.2 两层判定 **[Impl Rec]**

1. **模型层**：提示词给出上表四类定义、必要成分与反例，要求模型同时输出分类理由。
2. **确定性层**：在 `capture-value-screening.ts` 现有质量校验之后追加分类校验 —— `rule` 缺 boundary、`skill_method` 五项不全、`template` 无结构、`personal` 命中任务事实词形，一律降级为 `weak_observation` 或改判类型，不得直接进 `pending_review`。

### 12.3 与 PRD 3.2 候选分流表的对齐 **[PRD Required]**

PRD 的候选对象比四类资产多两个：`RelationshipAssertion`（非资产）与 `EvaluationCandidate`。当前实现把它们都挤进四类。目标状态：

- 关系类内容 → `RelationshipAssertion`（非资产存储），不进资产候选池
- 评价方法变化 → `EvaluationCandidate`，不自动覆盖现有 Evaluation Contract
- 只有四类内容进 `RecallCandidate`

---

## 13. Promotion Gates

### 13.1 四类共用前置 **[PRD Required]**

| 检查 | 说明 |
|---|---|
| user review | 用户确认内容与来源（UserTeachingSignal 可作为明确内容与作用域内的确认，但必须回执 + 可撤销） |
| source validation | 来源属五类受控枚举且当前 available |
| scope confirmation | `scope` 明确，项目事实默认保持 project scope |
| applicable / forbidden | 见各类型要求；`undefined` ≠ 无限制 |
| sensitivity | 敏感级与外发限制已判定 |
| duplicate / conflict | 精确指纹 + 语义查重（`similarity.ts`），**embedding 不可用时必须降级为阻断或人工确认，不得静默放行** |
| immutable version write | 写入不可变版本 + 回滚点 |
| provenance | 记录产生线（capture / kstar / teaching / import） |
| evidence refs | 至少一条来源 Evidence |

### 13.2 分类型附加门槛 **[PRD Required]**

| 类型 | 附加 |
|---|---|
| personal | 稳定性判定通过；关系类必须先经 RelationshipAssertion 且用户确认 |
| rule | applicable + forbidden 均非空（或按 §9.3 结论处理） |
| template | 用户确认复用意图 + 敏感边界 + 适用范围 + 版本；来源 Artifact 保持原 Owner/位置/作用域 |
| skill_method | Skill Validator + Security Scanner + 最小真实运行验证通过（PRD 8.2） |

### 13.3 禁止事项 **[PRD Required]**

不得出现"以 `actor: 'system'` 调用 promote 从而跳过某类资产必须确认的语义字段"。当前 `candidate-service.ts:834/:861` 正是此形态，必须整改：系统线要么补齐语义字段，要么不得晋升该类型。

---

## 14. KSTAR Integration

### 14.1 一个 Episode 可产生多类候选 **[PRD Required]**

PRD 3.2 候选分流表 + PRD 8.x：一次 Episode 可同时产生 `OntologyDelta` / `RuleCandidate` / `TemplateCandidate` / `SkillEvolutionCandidate` / `EvaluationCandidate`。当前 `kstar/extraction-service.ts:30 gapType()` 是 attribution → 单一类型的硬映射，**须改为多候选产出**。SkillAsset 是 KSTAR 首要进化对象，但不是唯一。

### 14.2 Gate 职责 **[PRD Required]**

- **Gate A**：绑定显式 Baseline Skill ID 与不可变版本；记录 Action Plan / 实际动作 / Artifact / Evidence；冻结 Expected、独立记录 Actual + Delta + Attribution；产出类型明确的候选与可读 Diff；用户完成四选一；候选/新版本/回滚点不可变。通过后**只能表述为"形成受治理的能力改进候选"**。
- **Gate B**：隔离新 Session/Agent 重跑；任务环境输入 Baseline 可比；至少一项目标结果改善且质量不下降；负迁移与适用范围检查；生成 ContextReuseReceipt、版本结论、暂停/回滚证据。

**KSTAR 不得直接静默改正式资产**；候选必须过正式 Gate。

### 14.3 lifecycleStatus 来源区分 **[PRD Required 的语义 + Impl Rec 的取值]**

| 值 | 含义 | 写入来源 |
|---|---|---|
| `user_confirmed_unverified` | 真实用户审查/接受发生过 | 用户确认晋升路径 |
| `automatically_extracted_unverified` | 会话自动抽取线（system actor，无用户确认） | `capture-service` 自动线 |
| `system_precipitated_unverified` | KSTAR 自进化线（system actor，无用户确认） | KSTAR `direct-experience-assets` 线 |

当前 `candidate-service.ts:1390` 只写前两个，KSTAR 线被错标为"自动抽取"。须让 promote 接收 provenance 参数并据此赋值。

---

## 15. Runtime / Workspace Integration

### 15.1 各类型在运行时提供什么 **[PRD Required]**

| 类型 | 运行时提供 |
|---|---|
| PersonalOntologyAsset | 角色、稳定偏好、长期边界、Ontology context |
| RuleAsset | runtime constraints、决策原则、safety / forbidden conditions |
| TemplateAsset | 可复用输出结构、checklist、skeleton |
| SkillAsset | 可执行 plan / SkillManifest（经 Baseline 引用） |

### 15.2 注入准入 **[PRD Required]**

按 PRD 3.6 默认使用规则分档：

- `Candidate` → **不得注入**
- `User Confirmed / Unverified` → **仅用户主动选择时使用，不得静默默认注入**
- `Transfer Verified` → 可在相同作用域和权限内默认推荐或注入
- `Effectiveness Validated` → 已验证适用范围内优先推荐
- `Paused / Revoked / Rolled Back` → 停止默认注入

注入前还须过 `applicableWhen` / `forbiddenWhen` / `targetAgents` / `sensitivity` 四道过滤。

### 15.3 Workspace 与版本冻结 **[PRD Required]**

- Workspace 只引用资产，不复制所有权；同一资产多 Workspace 引用时保持稳定 assetId 与版本谱系。
- TaskRun 启动时冻结 `asset_version_refs` 与 Main Skill Baseline，运行中不得静默切换。
- 版本引用策略：`pinned` / `review_required`（默认）/ `follow_latest_compatible`（未经单独授权不得启用）。
- 新版本只影响之后创建的 TaskRun；正在执行与历史 TaskRun 继续引用原版本。
- 资产被撤销/暂停/检测到负迁移时，Workspace 停止默认使用并进入人工审查，不得自动回退到未授权版本。

---

## 16. Lifecycle & Maturity

### 16.1 lifecycleStatus（来源标签，与成熟度正交）

见 §14.3 三值表。**这是"谁写进来的"，不是"验证到哪一步"。**

### 16.2 maturity（PRD 3.6，须与 PRD 对齐）**[PRD Required]**

| 状态 | 触发事件 | 需要的 Evidence | 谁可触发 | 需用户确认 | 默认注入 |
|---|---|---|---|---|---|
| Candidate | 系统从授权来源提出 | 来源引用 | 系统 | — | 否 |
| User Confirmed / Unverified | 用户确认内容/来源/类型/作用域 | ReviewDecision | 用户 | 是 | 否（仅主动选择） |
| Transfer Verified | 目标 Agent 或隔离新 Session 真实加载，形成可追溯 Action Plan 或可观察行为 | **ContextReuseReceipt**（必需）+ 加载证据 | 系统（有 Receipt 时） | **[Open]** 见 §23 | 是（同作用域权限内） |
| Effectiveness Validated | 可比 Baseline/Treatment + Behavior Diff + Evaluation，质量不下降，无高严重度负迁移 | TransferProof + EffectivenessProof + 负迁移检查 | 系统 | 否 | 是（已验证范围内优先） |
| Paused / Revoked / Rolled Back | 用户操作或安全/负迁移保护 | AssetEvent + 原因 | 用户或系统 | 视操作 | 否 |

**须移除 `seed` / `bud` / `stable` 三个 PRD 中不存在的档位** —— `seed`/`bud` 的信息已由 lifecycleStatus 承载，`stable` 无写入路径。迁移见 §20。

### 16.3 硬禁止 **[PRD Required]**

- 没有真实 TransferProof + Receipt 时不得出现 `transfer_validated`。
- 不得硬编码任何 maturity（当前 `assets-adapter.ts:118` 违反）。
- 任何资产状态变化必须先持久化事件并生成 Receipt，再更新界面、提示和成长动画（PRD 1.3 原则 14）。

---

## 17. Evidence / Receipt / Evaluation

- **Evidence**：来源引用，晋升必需至少一条。
- **ContextReuseReceipt**（`p3394/context-reuse-receipt.ts` 已存在）：Transfer Verified 的必要条件，须在 `completeTransferProof` 时**强制传入**，当前为可选且 `terminal-proof.ts:62` 不传。
- **Evaluation**：Skill 的 Evaluation Contract 变化走 `EvaluationCandidate`，不自动覆盖。
- **确认 / 传递证明 / 有效性证明必须分别记录**（PRD 3.6），UI 与文案不得混用。

---

## 18. Versioning / Rollback / Governance

现状已较完整（`asset-service.ts` pause/revoke/resume/archive/delete/purge/restore/rollback + versions + audit）。需补：

- 版本谱系跨 Workspace 唯一性校验 **[PRD Required]**
- 回滚点与 Skill 侧回滚的一致性（依赖 §11.2 决策）
- 来源撤权后：停止新读取与默认注入、**保留已确认资产并标记来源状态**、提示复核（PRD 3.4）。当前有 `pauseAbilityAssetForRevokedEvidence:860` 与 `downgradeAbilityAssetMaturityForRevokedEvidence:889`，需核对是否符合"不静默删除"。

---

## 19. UI / IPC Expectations

| 需求 | 变化 |
|---|---|
| 资产列表只显示四类正式资产 | `assets-adapter.ts:110-125` 移除分组注入；`recall.assets.list` 返回值不含 `source: 'personal_ontology'` |
| 摘要计数与列表一致 | `skills.js:328` 复用列表过滤条件 |
| 四类分类卡片显示 PRD 用户侧命名 | 关于我 / 规则与偏好 / 模板与范例 / 技能与方法 |
| Rule 详情展示适用/禁止边界，缺失时显式提示 | 新 UI 区块；不得留白让用户以为无限制 |
| Skill 详情联查 Manifest | 依赖 §11.2 决策 |
| 成熟度用 PRD 用户侧表达 | 待确认 / 已确认尚未验证 / 已成功带入 / 已验证有效 / 已暂停·已撤销·已回滚 |
| lifecycleStatus 三值可见 | 区分"我确认的 / 自动抽取的 / KSTAR 沉淀的" |
| 新增 IPC | `recall.candidates.updateSemantics`（评审时补边界）**[Impl Rec]**；Template 提炼链路相关通道待 Phase 3 定义 |

---

## 20. Migration & Compatibility

| 项 | 处理 |
|---|---|
| 存量 `maturity: 'seed' \| 'bud'` | 一次性迁移为 `user_confirmed_unverified` 对应档；映射规则需 PO 确认（`seed` 多为系统线、`bud` 为用户线） |
| 存量 `maturity: 'stable'` | 全仓无写入，实际不存在数据；直接从枚举移除 |
| 存量 Rule 资产 `applicableWhen/forbiddenWhen` 为空 | 不回溯改写；UI 标"边界未记录"，引导用户补。**不得**默认填成无限制 |
| KSTAR 线存量资产 `automatically_extracted_unverified` | 可按 `learningProvenance` 存在与否回填为 `system_precipitated_unverified` |
| `personal_ontology` 伪资产 | 无需数据迁移（读时生成），移除生成逻辑即可 |
| schema migration | 需要：maturity 枚举收敛、payload 分型、provenance 字段。建议 `schemaVersion` +1 并保留读兼容 |

---

## 21. Implementation Phases

依赖关系：语义纠偏是所有后续阶段的前提（分类不准，后面每一层都在放大错误）；Rule 完整化依赖候选层能产出边界；Template 是新链路，不阻塞其他；Skill 对齐依赖 §11.2 决策；KSTAR 多候选依赖分类规则与 lifecycle 来源已就绪。

### Phase 1 — 语义纠偏（无新对象，纯纠错）

1. 提取提示词补四类定义、必要成分、反例（`capture-service.ts:650`）
2. 确定性分类后校验（`capture-value-screening.ts`）
3. 移除 Personal Ontology 分组注入与硬编码 maturity（`assets-adapter.ts:110-125`）
4. 摘要计数与列表一致（`skills.js:328`）
5. lifecycleStatus 三值按 provenance 正确写入（`candidate-service.ts:1390`）
6. maturity 枚举收敛到 PRD 四档 + 迁移（`asset-service.ts:103`）
7. Transfer Verified 强制 Receipt（`terminal-proof.ts:62` / `proof-service.ts:56`）
8. embedding 降级不得静默放行（`similarity.ts:64`）

### Phase 2 — Rule 完整化

1. 候选层产出 `applicableWhen` / `forbiddenWhen`（提示词 + schema）
2. 评审 UI 让用户确认/编辑边界与 sensitivity
3. Promotion Gate 按 §9.3 结论执行
4. 系统线不得跳过语义字段（`candidate-service.ts:834/:861`）

### Phase 3 — Template 正式链路（新建）

1. Artifact 可复用结构提炼
2. TemplateCandidate 对象与 payload
3. 用户确认（复用意图/来源/敏感边界/适用范围/版本）
4. TemplateAsset payload 落地
5. 清理 `personal_context/ontology-pipeline.ts` 死代码

### Phase 4 — SkillAsset / SkillManifest 对齐

1. 落地 §11.2 决策（推荐方案 B）
2. 资产侧 `skillId` + `skillVersionRef` + `admissionStatus`
3. 晋升前置：Validator + Security Scanner + 最小真实运行验证
4. capability pack / TaskRun 冻结引用 Baseline
5. rollback 一致性

### Phase 5 — KSTAR 多候选与成熟度闭环

1. 一个 Episode 产出多类候选（`extraction-service.ts:30` 改造）
2. RelationshipAssertion / EvaluationCandidate 落地为非资产对象
3. Gate A / Gate B 显式化与 UI 表达
4. Workspace 版本引用策略（pinned / review_required / follow_latest_compatible）

---

## 22. Acceptance Criteria

### Phase 1

**AC-1.1** Given 用户说"我今天在修 KSTAR"，When 会话沉淀运行，Then 不得产生 `personal` 类候选；若模型仍产出，确定性校验须将其降级为 `weak_observation` 并记录 `filterReason`。

**AC-1.2** Given 用户说"我长期更喜欢先看整体结构再看细节"，When 沉淀运行，Then 产生 `personal` 候选且 `status = pending_review`；在用户确认前，该内容不得出现在任何 ContextProjection 中。

**AC-1.7** Given 用户存在 Personal Ontology 分组，When 打开能力资产页，Then 列表与摘要计数中均不出现 `CA-PERSONAL-*` 条目，且两者数字一致。

**AC-1.8** Given 任一资产从未产生 ContextReuseReceipt，When 查询其 maturity，Then 不得为 `transfer_validated`；`completeTransferProof` 在缺少 `receiptId` 时必须拒绝或降级为 `degraded`。

**AC-1.9** Given 同一时段分别由 KSTAR 线与会话抽取线各产出一条资产，When 读取两者 `lifecycleStatus`，Then 分别为 `system_precipitated_unverified` 与 `automatically_extracted_unverified`。

**AC-1.10** Given embedding 服务不可用，When 两条语义重复的候选先后晋升，Then 系统不得静默产出两条重复资产（阻断或转人工确认）。

### Phase 2

**AC-2.3** Given 候选内容为"正式评审先讲产品模型"且无 `applicableWhen` / `forbiddenWhen`，When 走晋升，Then 不得静默成为完整 RuleAsset（按 §9.3 结论：停在 Candidate）。

**AC-2.4** Given 一条已入库但边界为空的存量 Rule 资产，When 在详情页查看，Then 显式显示"边界未记录"，且运行时不得把它当作无限制适用。

### Phase 3

**AC-3.1** Given 用户上传 `PRD.docx`，When 系统处理，Then 该文件保持 CognitionSource / Project Context / Evidence 身份，Owner、位置、项目作用域不变，且**不得**出现同名 TemplateAsset。

**AC-3.2** Given 系统从该文件识别出稳定章节结构，When 提炼运行，Then 只产生 TemplateCandidate；用户确认复用意图、来源、敏感边界、适用范围和版本后才成为 TemplateAsset。

### Phase 4

**AC-4.1** Given 用户说"我擅长写 PRD"，When 沉淀运行，Then 不得形成 SkillAsset（五项必要成分不全）。

**AC-4.2** Given 一段包含 Trigger / Input / Workflow / Output / Validation 的方法，When 沉淀运行，Then 形成 Skill 候选；且在通过 Validator + Security Scanner + 最小真实运行验证前，不得成为正式 SkillAsset 或 Baseline。

**AC-4.3** Given 一条 SkillAsset 与其 SkillManifest，When 查询版本，Then 只有一个 source of truth（按 §11.2 决策），且 rollback 后两侧引用一致。

### Phase 5

**AC-5.1** Given 同一正式资产被多个 Workspace 引用，When 检查归属，Then 只有一个 Owner、一个 assetId、一条版本谱系；任一 Workspace 不得取得所有权。

**AC-5.2** Given 一个 TaskRun 已启动并冻结 `asset_version_refs`，When 期间产生新资产版本，Then 该 TaskRun 继续使用冻结版本，仅对之后创建的 TaskRun 生成升级建议。

**AC-5.3** Given 一次 Episode 同时暴露规则缺口与方法缺口，When KSTAR 沉淀运行，Then 可同时产出 RuleCandidate 与 SkillEvolutionCandidate，且都不得直接改写正式资产。

---

## 23. Open Questions

| # | 问题 | 需谁拍板 | 阻塞 |
|---|---|---|---|
| Q1 | RuleAsset 缺边界时：停在 Candidate（A）/ 标 `boundary_pending` 晋升（B）/ 模型产出边界后用户确认（C）？本文推荐 A+C | PO | Phase 2 |
| Q2 | SkillAsset 与 SkillManifest 的 source of truth：A / B / C？本文推荐 B | Tech Lead | Phase 4 |
| Q3 | Transfer Verified 是否需要用户"带入正确"确认？PRD 3.6 只要求 Receipt + 可追溯行为，未提用户确认；但《认知树成长与交互规范 v0.7》不变量 1 要求四项同时成立（含用户确认）。两份文档口径不一致 | PO | Phase 1 第 7 项 |
| Q4 | 存量 `seed` / `bud` 到 PRD 四档的映射规则 | PO | Phase 1 第 6 项 |
| Q5 | Rule 冲突决策器（同条件不同原则、范围重叠）如何裁决？PRD 未冻结 | PO | Phase 2 之后 |
| Q6 | `target_agents` 白名单的粒度（Agent 实例 / Agent 类型 / 连接类型） | PO + Tech Lead | Phase 5 |
| Q7 | 自动线（无用户确认）产出的资产是否算 PRD 意义上的"正式资产"？PRD 3.6 的正式资产从 User Confirmed 起算，但代码已存在两种 system 线 | PO | 影响 Phase 1 与整体口径 |

## 24. Out of Scope

- 企业 Policy / 组织 Ontology / 组织 Skill / 组织模板的并入（PRD 3.4 明确禁止并入个人资产）
- 认知树的视觉与动效规范（另见《认知树成长与交互规范》）
- 跨空间引用协议 WorkspaceContextBinding 的完整实现（PRD 3.4.3，本文只约束资产侧不得被复制所有权）
- Raymond / Forge 等外部产品的 AssetPackage 传递
- NSEAP / 社区蓝图相关的资产分发
