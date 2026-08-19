# CogSeed 演示场景 · Golden Path（对齐 PRD doc-v1.6 + 最新代码）

- 日期：2026-08-16
- 构建：`6c85649a`（develop）
- 产品基线：`P3394_CogSeed_PRD_doc-v1.6_Review.docx`（Review - staged 候选）
- 目的：按 PRD 的「九阶段旅程 / 60秒 Aha / 两阶段评价」主线组织演示，每一阶段标注**当前代码的真实实现状态**，让演示与验收同时对齐 PRD 契约与代码现状
- 演示对象：Sponsor / PO / Tech Lead 评审

---

## 0. 阅读图例（每阶段顶部标注）

| 标记 | 含义 |
|---|---|
| ✅ 已实现 | 后端 + IPC + 渲染层已接线，可直接在 GUI 演示 |
| ⚠️ 部分实现 | 后端/数据层已具备，端到端 UI 或真实外部 Agent 链路未完全接线 |
| ⬜ PRD 目标态 | PRD 有明确契约，当前代码尚未落地（不演示，只口述方向） |

> PRD 自己声明「不代表能力已实现、已验收或获准发布」。本场景的 ✅ 只表示「代码里存在该能力」，不等于「已通过 PRD 验收」。

---

## 1. 演示主线：九阶段旅程 → 代码映射

PRD §4.1 的九阶段，逐阶段对应到当前代码的真实实现：

| # | PRD 阶段 | 核心 Evidence | 代码实现 | 状态 |
|---|---|---|---|---|
| 1 | 极简启动 | 启动记录 | `onboarding.js` / 首页三价值动作 | ✅ |
| 2 | 捕获来源 | PermissionDecision | `continue-work.js` + `sessionImport.*` + `recall.sources.*` | ✅ |
| 3 | 临时任务与理解 | TaskContract | 导入生成可续接会话 | ✅ |
| 4 | 发现与确认 | ReviewDecision | `recall.candidates.*`（确认/修改/拒绝/暂缓） | ✅ |
| 5 | 形成能力包 | MinimumCapabilityPack | `p3394/capability-pack.ts`（引用不复制） | ⚠️ |
| 6 | 跨Agent接续 | ContextReuseReceipt | `p3394/context-reuse-receipt.ts` | ⚠️ |
| 7 | 即时校验 | TransferReviewDecision | `recall.proofs.transfer.*` → `transfer_validated` | ✅ |
| 8 | 结果评价 | OutcomeEvaluation | `p3394/behavior-contrast.ts` + `recall.proofs.effectiveness.*` | ⚠️ |
| 9 | 归档与成长 | 资产版本 / KSTAREpisode | `asset-events.ts`（账本）+ `recall.assets.*` + `workbench/main-skill-baseline.ts` | ⚠️ |

**演示口径**：主演示走阶段 1→4（可完整 GUI 操作）+ 阶段 7（传递证明），阶段 5/6/8/9 用「后端已具备、数据落盘可见」的方式演示，KSTAR 受控进化单独口述目标态。

---

## 2. 场景一：极简启动 + 继续最近的工作（阶段 1–3）

**演示话术**：「CogSeed 不是又一个 Agent，而是跨 Agent 的个人能力资产层。首页只有三个价值动作：继续最近的工作、沉淀最近工作、使用现成空间。」

### 操作

1. 启动后首页 → 点「**继续之前的工作**」（`continue-work.js` 四步向导）
2. 步骤 1 选择来源：Claude Code / Codex / Claude 桌面版（本机检测，不写入原 Agent）
3. 步骤 2 勾选要续接的会话
4. 步骤 3 导入：每个会话被提炼成一段可续接简报，并提取候选认知

### 你可见的预期

- 导入完成页显示「成功 N · 提取 M 条候选认知」（M 来自 `res.cognitions`，分 personal/rule/template 三类计数）
- 若未配置可用模型，诚实显示「已导入 · 未提炼」（`degraded`），不伪装成已完成
- 左侧列表刷新，出现可续接的新会话

### 后台验证

```
sessionImport.importCodexSession / importClaudeSession
  → 生成 conversationId + cognitions（候选认知）
recall.sources.list → 授权的认知来源（conversation / artifact_file / …）
```

---

## 3. 场景二：发现与确认 —— 候选审查 + 四类正式资产（阶段 4）

**演示话术**：「系统只**提候选**，正式资产由用户**决定**——这是 PRD 原则 2 和 7 的核心。候选按内容分流到四类资产：关于我、规则与偏好、模板与范例、技能与方法。」

### 操作

1. 打开「认知沉淀 / 待确认候选」（`recall.candidates.list`）
2. 对每条候选执行：**确认 / 修改 / 拒绝 / 暂缓（defer）/ 忽略**（`recall.candidates.save/update/reject/defer/ignore`）
3. 确认后进入「能力资产」页，按四类查看：`personal`（关于我）/ `rule`（规则与偏好）/ `template`（模板与范例）/ `skill_method`（技能与方法）

### 你可见的预期

- 候选卡片：内容提炼的中文标题 + `类型 · 作用域` 可见，正文/证据折叠在 `<details>` 后
- 确认后的资产 `lifecycleStatus = user_confirmed_unverified`（「已确认，尚未验证」），**不是**自动沉淀的 `system_precipitated_unverified`
- 能力资产页四类顺序：`['personal', 'rule', 'template', 'skill_method']`（`recall-information-architecture.js`）

### 后台验证

```
recall.candidates.list → 候选（pending_review）
recall.candidates.save/update → 用户 ReviewDecision
（确认）→ createSystemAbilityAsset（lifecycleStatus: user_confirmed_unverified）
asset-events: appendAssetEvent(asset_user_confirmed)  ← 先落账本
```

---

## 4. 场景三：形成最小能力包（阶段 5）· ⚠️

**演示话术**：「能力包只装**引用**，不装内容——Main Skill、规则、模板、本体切片都是 `asset_id + version`，24 小时有效期，目标端用完即弃。」

### 后台验证（数据落盘可见）

```
capability-pack.ts: buildCapabilityPack
  → <uid>/cloud/mate_agent/capability-packs/<pack_id>.json
  字段: main_skill_ref + rule_refs + template_refs + ontology_slice_refs
       + personal_context_ref + target_agent + expires_at（默认 24h）
log: built capability pack user=… pack=… purpose=…
```

**状态说明**：`buildCapabilityPack` 后端已具备、有单测覆盖；但「从 UI 一键生成能力包并派发到目标 Agent」的端到端入口未完全接线，故标 ⚠️。演示时展示落盘 JSON 结构即可。

---

## 5. 场景四：跨Agent接续 + 传递证明（阶段 6–7）

**演示话术**：「PRD 的 60 秒 Aha 终点是**传递证明**：目标 Agent 真实加载能力包、生成 Action Plan，CogSeed 给出 `ContextReuseReceipt`。它只证明『认知被带入并实际使用』，不证明结果变好。」

### 后台验证（数据落盘可见）

```
context-reuse-receipt.ts: prepareReceipt → completeReceipt
  → 字段: reusedRefs / omittedRefs / permissionMode / allowedScopes
         + boundary（real / degraded / test-double）
         + status（prepared → completed / rejected / degraded）
recall.proofs.transfer.prepare（required: projection confirmed）
recall.proofs.transfer.complete(status=succeeded)
  → setAbilityAssetMaturity('transfer_validated')   ← 成熟度升级
  → recordRecallUsage（usage 记录 + matchScore）
```

### 你可见的预期

- 资产成熟度从「已确认，尚未验证」→「已成功带入（Transfer Verified）」
- 「使用与证明」页列出迁移证明：带的是哪一版、带入结果、`ContextReuseReceipt`

**状态说明**：证明/回执的后端 + IPC（`recall.proofs.*`、`p3394.contextReuseReceipt.read`）已接线；「真实外部 Agent 加载能力包 → 生成 Action Plan」这一步依赖真实 Agent 连接，是 PRD 审阅重点「至少一条真实链路必须成立」的验证点，标 ⚠️。

---

## 6. 场景五：结果评价 + 有效性证明（阶段 8）· ⚠️

**演示话术**：「任务完成后做**有效性证明**：Baseline / Treatment / BehaviorDiff，只允许一个关键变量变化。结果只有 `better / no_improvement / worse / insufficient_evidence` 四种，`worse` 会建议暂停或回滚——『证明变差』也是一条合法结论，不会被藏起来。」

### 后台验证

```
p3394.behaviorContrast.start → runConfiguredBehaviorContrast（Baseline/Treatment）
recall.proofs.effectiveness.evaluate(outcome=better)
  → setAbilityAssetMaturity('effectiveness_validated')
  → 记录 EvidenceRefs + recommendedAction
recall.proofs.effectiveness.feedback（positive/neutral/negative/invalid/rework）
```

### 你可见的预期

- 资产成熟度 →「已验证有效（Effectiveness Validated）」
- `worse` → 系统建议 `pause`，`rework` → 建议 `rework`；未经用户确认不默认继续使用

---

## 7. 场景六：归档与成长 —— 单一事件账本 + 受控进化（阶段 9）· ⚠️

**演示话术**：「PRD 原则 14：任何资产状态变化，先持久化事件、生成回执，再更新界面。资产进化的正确闭环是——**KSTAR 只产候选 → 用户确认 → 不可变新版本 → 隔离复用验证 → 才可宣称已验证进化**。」

### 后台验证（账本可见）

```
asset-events.ts: appendAssetEvent（append-only，每资产一个 .jsonl）
  事件类型: asset_created / asset_user_confirmed / asset_transfer_verified
           / asset_effectiveness_validated / asset_paused / asset_revoked
           / asset_rolled_back / workspace_asset_update_*
recall.assets.versions / rollback / restore  → 版本、Diff、回滚入口
workbench.main-skill-baseline.ts: freezeBaseline（执行前冻结 id+version+content_hash）
  → verifyBaseline(drift 必须阻断 Episode)；frozen_by: 'user'（Agent 不得写正式资产）
```

---

## 8. 与 PRD 的差异清单（当前代码 → 必须向评审说明）

> 以下差异**不是演示场景的笔误**，而是最新代码与 PRD 契约之间的真实差距。演示时必须诚实标注，不能把「已实现」与「PRD 目标态」混为一谈。

| # | PRD 契约 | 当前代码现状 | 影响 |
|---|---|---|---|
| 1 | **候选由系统提出，正式资产由用户决定**（原则 2/7/17/25）；「不是未经用户审查就主动创建正式 Skill」 | KStar v4 线**自动沉淀直通能力资产**（`createSystemAbilityAsset`，`lifecycleStatus = system_precipitated_unverified`），复盘确认已取消 | KStar 自动沉淀线违反 PRD 治理契约，演示时应走「候选审查线」而非自动沉淀线 |
| 2 | **四类独立正式资产**（PersonalOntology / Rule / Template / Skill） | 单一「能力资产」+ `type` 字段（`personal/rule/template/skill_method`） | type 字段近似四类，但非四类独立治理对象 |
| 3 | 成熟度从 **User Confirmed / Unverified** 开始 | 能力资产 `maturity` 用 `seed/bud/transfer_validated/effectiveness_validated/stable`；`lifecycleStatus` 才区分 `user_confirmed_unverified` | 术语/模型与 PRD 不完全对齐，需映射说明 |
| 4 | 60秒 Aha = **Action Plan + ContextReuseReceipt**（传递证明） | `context-reuse-receipt.ts` + `capability-pack.ts` + `proof-service.ts` 已具备，但端到端 GUI（能力包→目标Agent→Action Plan→Receipt 展示）未完全接线 | 首版价值证明链路需端到端打通才算达成 |
| 5 | 「用户未反馈不得解释为认可」 | 自动闭环（`auto_close_quiet`）在无反馈时仍自动沉淀 | 与 PRD「沉默 ≠ 认可」冲突 |

---

## 9. 通过标准（对齐 PRD §11 验收口径）

1. 阶段 1–4 全程可在 GUI 操作：导入来源 → 提炼候选 → **用户确认** → 四类资产落盘
2. 确认后的资产是 `user_confirmed_unverified`，且先写 `asset_user_confirmed` 事件、再更新界面
3. 传递证明成立：`transfer_validated` + `ContextReuseReceipt`（reusedRefs/omittedRefs/boundary 完整）
4. 有效性证明成立：Baseline/Treatment 对比后 `better → effectiveness_validated`，`worse → pause` 建议
5. 全程**不使用** KStar 自动沉淀口径；若演示进化，走「候选 → 用户确认 → 新版本」
6. 文案不使用「结果改善 / 认知有效 / 完成进化」等表述，除非已完成有效性证明

## 10. 失败排查

| 现象 | 排查点 |
|---|---|
| 候选确认后资产仍是 `system_precipitated_unverified` | 走了 KStar 自动沉淀线而非 `recall.candidates.*` 候选线（差异 #1） |
| 能力包缺少 rule/template/ontology 引用 | `buildCapabilityPack` 入参未传全（差异 #2 字段映射） |
| 传递证明 prepare 失败 | projection 未 `confirmed`（`prepareTransferProof` 前置校验） |
| 成熟度不升级 | `completeTransferProof(status=succeeded)` / `evaluateEffectivenessProof(outcome=better)` 未触发 |
| 事件账本无记录 | 状态变更未走 `appendAssetEvent`（先事件后视图原则） |
| Baseline 校验 drift 阻断 | Skill 内容树被改动；需重新 freeze，**不得**自动 re-freeze |
