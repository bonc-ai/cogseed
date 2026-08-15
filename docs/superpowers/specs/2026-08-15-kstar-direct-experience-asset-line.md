# KStar 直接沉淀线：会话经验 → 能力资产（免审核闭环）

**日期：** 2026-08-15
**状态：** 已实现（`codex/commander-centric-kstar` 追加提交）
**决策：** 用户新规划确认——KStar 闭环中沉淀的经验**直接写入 Recall 能力资产，不再经过候选审核**；既有"候选 → 用户 promote"审核线**保留不动**（另一条基于会话记录的沉淀线，独立运行）。

## 1. 目标

- 任务闭环（阶段 0–7）完成后，有复用价值的经验在**同一闭环节点**直接成为正式能力资产；
- 下一次任务的 Projection 检索立即可见（`buildRecallView` 读取 `ability-assets`，无需等待审核）；
- 不引入新的用户交互，不改变既有审核线的任何行为。

## 2. 直接沉淀的准入（证据门槛，非人工审核）

沿用 `proposeKstarCandidates` 的既有证据判定，**原样复用**：

| 类型 | 准入条件 |
|---|---|
| skill_method | 任务 completed + ≥2 个工具全部成功 + review 存在显式学习信号（deltaR/deltaA 已知或 outcome 明确或高置信归因） |
| rule / template / personal | review 置信度 ≥0.7 且 attribution 为 rule_gap / template_gap / knowledge_gap 且有 reason |

- 无证据（无学习信号、低置信、unclear）→ 不沉淀；
- 寒暄/普通会话不进闭环 → 天然不沉淀；
- 证据引用（`sourceRefs`）必含执行证据 `{kind:'execution', id: episode.id}`。

## 3. 资产写入规则

- **身份**：内容寻址 ID `aa-<sha256(judgment + 排序证据键)[0:24]>`——同一经验重复沉淀幂等（同 ID 写入 `current || validated`，不产生重复资产）；跨 episode 的相同经验因执行证据不同而各自成资产（与候选 fingerprint 语义一致）。
- **Actor**：`system`（`AbilityAssetActor` 已支持）；审计 `created` note=`kstar_direct_experience:<episodeId>`；版本快照 append-only（`initializeAbilityAsset`）。
- **初始状态**：`status: active`、`maturity: 'seed'`（最保守：未经验证；后续 transfer/effectiveness proof 照常升级）、`version: '1'`。
- **字段**：`title = proposal.summary`（≤120）、`statement = proposal.judgment`（≤4000）、`type = suggestedType`、`scope = scopeForTask(userGoal)`、`evidenceRefs = sourceRefs`（normalize 校验）、`learningSignal`（若有）。
- **工作空间可见性**（best-effort）：episode `s.workspaceId` 为合法 id 时自动建 workspace 引用，使资产立即进入同工作空间的新投影。
- **失败隔离**：直接沉淀失败仅 warn 日志，绝不破坏复盘闭环（与候选桥失败的既有语义一致）。

## 4. 与既有审核线的关系

```
KStar 闭环 (reconcileKstarExtraction)
 ├─ 既有线（不动）：proposals → saveKstarCandidateProposals → pending 候选 → 用户 promote
 └─ 新线：proposals → precipitateDirectExperienceAssets → 直接能力资产（免审核）
```

- 两条线共用同一份 `proposals`（同一证据门槛），各自幂等；
- 候选仍走 pending/promote（审查线、IPC、UI 全部不变）；
- 直接资产不产生候选、不产生 ReviewDecision（无用户动作）；用户后续仍可暂停/撤销/降级该资产（既有治理能力）。

## 5. 风险与护栏

- **免审核带来的质量风险**：由证据门槛 + 保守 maturity（seed）+ 内容寻址幂等兜底；后续负反馈（effectiveness feedback）与 teaching 撤销等治理照常作用于直接资产。
- **误沉淀**：仅闭环内高置信经验进入；`hasLearningSignal` 与 `confidence>=0.7` 门槛与候选线完全一致，不额外放宽。
- 不改变任何既有测试语义（旧线测试原样通过；新增直接线测试）。

## 6. 实施

- 新模块：`src/main/features/kstar/direct-experience-assets.ts`（`precipitateDirectExperienceAssets`）；
- 资产写入：`asset-service.createSystemAbilityAsset`（system actor、asAsset 校验、幂等）；
- 接线：`task-closure.reconcileKstarExtraction` 在候选桥之后 best-effort 调用；
- 测试：同一 episode 重放不重复；候选线同时保持；无学习信号不沉淀。
