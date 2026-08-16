# KStar 认知资产闭环：完整代码链路地图

> 日期：2026-08-15
> 分支：codex/commander-centric-kstar（HEAD `56e36e0b`，含 develop 合并 + 审计修复）
> 说明：这条线 = "我们的线"（KStar Commander-Centric 沉淀线）。按链路环节列出每个文件的路径、核心函数、职责。全部代码在仓库本地，用编辑器打开对应文件即可查看。

---

## 总览：一条线的八个环节

```
① 路由(宿主确定性) → ② 检索 → ③ 注入 → ④ 预测 → ⑤ 执行
→ ⑥ 复盘(测量+推理) → ⑦ 沉淀(直接入资产) → ⑧ 回流(规则引擎)
```

---

## ① 路由（宿主确定性建任务）

| 文件 | 核心函数 | 职责 |
|---|---|---|
| `src/main/features/kstar/task-intent.ts` | `detectTaskIntent` / `taskIntentHint` | 任务意图检测（寒暄/状态查询反向过滤 + 目标动词信号 + 长度门槛） |
| `src/main/features/group_chat/bus.ts` | `hostRouteTaskTurn`（约 7900 行） | 任务形用户消息 → 宿主直接 upsert_state + request_projection（确定性，不依赖模型） |
| `src/main/features/group_chat/bus.ts` | `ensureKstarTaskForDispatch`（约 7860 行） | 派发即任务：dispatch_to/hand_off_to/具名 run_worker 无任务时自动建+投影 |
| `src/main/features/group_chat/bus.ts` | `guardKstarPrivilegedDispatch`（约 6101 行） | 派发门禁：已确认投影 + forecast（`allowHostAutoTracked` ONCE 语义） |

## ② 检索（资产选择）

| 文件 | 核心函数 | 职责 |
|---|---|---|
| `src/main/features/recall/context-projection.ts` | `buildRecallView`（439 行）/ `applySemanticSelection`（413 行） | 资格过滤（status/scopePolicy/workspace refs/scope 软匹配）→ 语义排序 → 双信号选择（0.25 硬下限 + 相对门 0.5）→ Top-N（8）+ 类型多样性 → 冻结 assetIds+versions |
| `src/main/features/recall/context-projection.ts` | `rankAssetsBySemanticMatch`（239 行）/ `assetMatchText`（208 行） | 语义排序：query=taskText，asset 文本=title+statement+ontologyRefs（T-Box 概念名） |
| `src/main/features/recall/scope-policy.ts` | `matchesScopeToken` / `scopeIncludes` / `scopeTokenMatches`（63-130 行） | 整词匹配（ASCII）+ 双向包含（CJK）+ 跨语言别名（review↔审查） |
| `src/main/features/recall/ontology-taxonomy.ts` | `loadOntologyTaxonomy` / `loadOntologyGroupTitleMap` | T-Box：本体分组台账 + 字段词汇；groupId→概念名 |
| `src/main/features/recall/ontology-rules.ts` | `loadOntologyRules` / `parseRelationValue` | 本体 R-Box：字段值 `A → B` → 业务规则（ontr-*） |
| `src/main/features/recall/rule-engine.ts` | `evaluateRules` | 规则引擎：本体规则 + 资产 ΔR 教训按任务文本匹配 → matchedRules |

## ③ 注入（Commander 资产上下文）

| 文件 | 核心函数 | 职责 |
|---|---|---|
| `src/main/features/recall/prompt-injection.ts` | `buildRecallTurnPromptContext`（326 行）/ `buildDispatchedAssetsPromptBlock` | Commander 注入 `<confirmed-ability-assets>`（资产+本体+T-Box+R-Box）；派发授权块 |
| `src/main/features/recall/projection-knowledge.ts` | `loadCommittedProjectionKnowledge` | 冻结知识 K：投影资产快照 + ontologyAssets + ontologyTaxonomy + ontologyRules |
| `src/main/features/group_chat/bus.ts` | `resolveDispatchedAbilityAssets`（约 7860 行） | 派发资产校验（id 真实 active）→ `<commander-dispatched-assets>` |

## ④ 预测（Commander 即世界模型）

| 文件 | 核心函数 | 职责 |
|---|---|---|
| `src/main/features/kstar/control-tool.ts` | `createKstarControlTool` | kstar_control 工具（Commander-only）：upsert_state/request_projection/commit_forecast/finish/abandon |
| `src/main/features/kstar/control-service.ts` | `executeKstarControl`（712 行）/ `upsertState`（284 行）/ `requestProjection`（461 行）/ `commitForecast` | 宿主状态机 + 校验 + 幂等回执 + 自愈（空参用 sourceMessageText 补） |
| `src/main/features/kstar/forecast-commit.ts` | `commitCommanderForecast` | 组装 simulationInput（K+S+T）→ 校验候选（2-4）→ 重算分数 → 确定性选优 → 持久化 |
| `src/main/features/recall/world-model.ts` | `collectWorldSnapshot` / `applyCausalRules` | A-Box 快照 + F002 确定性风险推导 |
| `src/main/features/recall/world-model-scoring.ts` | `selectWorldModelCandidate` | 候选评分（goalFit*0.35 + feasibility*0.25 + …）确定性选优 |
| `src/main/features/recall/world-model-reconciliation.ts` | `reconcileWorldModel` | **R̂ vs R 比较**：deltaA（工具/执行者/计划差异）门控 deltaR（验收/产物差异） |

## ⑤ 执行（派发 Agent）

| 文件 | 核心函数 | 职责 |
|---|---|---|
| `src/main/features/group_chat/bus.ts` | `dispatch_to`/`hand_off_to`/`run_worker` 工具（约 8700-9500 行） | 派发工具：ability_assets 授权 + 门禁 + 嵌套派发 |
| `src/main/features/group_chat/bus.ts` | `runCoordinatedNestedDispatch`（约 7490 行）/ `runNestedDispatch`（约 6723 行） | 嵌套派发执行 + dispatchedAssetIds 传递 |

## ⑥ 复盘（差异测量 + 模型推理）

| 文件 | 核心函数 | 职责 |
|---|---|---|
| `src/main/features/kstar/task-closure.ts` | `startGroupKstarClosure`（415 行）/ `captureGroupKstarClosure`（277 行） | 订阅任务终态 → 构建 episode → 五类来源证据 → 复盘 → 沉淀（无确认卡片） |
| `src/main/features/kstar/episode-builder.ts` | `buildGroupKstarEpisode` / `buildRuntimeKstarEpisode` | episode 构建 + **五类来源**（conversation/artifact_file/execution_evaluation/user_teaching_signal/authorized_external_system） |
| `src/main/features/kstar/review-inference.ts` | `inferKstarReview`（183 行） | 差异测量（reconcileWorldModel）→ 模型推理归因 + **lesson**（过程经验）→ 恒 inferred |
| `src/main/features/kstar/review-service.ts` | `saveKstarReview`（90 行） | review 持久化（含 lesson 字段） |

## ⑦ 沉淀（直接入能力资产）

| 文件 | 核心函数 | 职责 |
|---|---|---|
| `src/main/features/kstar/extraction-service.ts` | `proposeKstarCandidates` / `clearsPrecipitationGate` / `MIN_PRECIPITATION_DELTA_R` | 差异→提案（lesson 优先）；阈值门（|ΔR|≥0.15 / outcome / gap / 过程经验 lesson） |
| `src/main/features/kstar/direct-experience-assets.ts` | `precipitateDirectExperienceAssets` / `precipitateDirectExperienceFromSource` | **直接沉淀**：内容寻址资产（幂等）→ createSystemAbilityAsset |
| `src/main/features/kstar/task-level-precipitation.ts` | `precipitateRequirementLevel` / `aggregateRequirementProposals` | 任务级聚合：多 episode → 一条资产（lesson 优先） |
| `src/main/features/kstar/task-aggregate.ts` | `drainKstarTaskState` / `startPendingTopicSwitchTask` | 收尾聚合 + 新任务切换 |
| `src/main/features/recall/asset-service.ts` | `createSystemAbilityAsset`（299 行）/ `listAbilityAssets` | 能力资产存储（cloud/recall/records/ability-assets/） |
| `src/main/features/recall/candidate-service.ts` | `saveRecallCandidate` / `promoteRecallCandidate`（839 行） | 候选审查线（并行保留，用户可选确认）+ statement 富化（judgment+value） |

## ⑧ 回流（教训回世界模型）

| 文件 | 核心函数 | 职责 |
|---|---|---|
| `src/main/features/recall/rule-engine.ts` | `evaluateRules` → `simulationInput.k.matchedRules` | 下次任务规则引擎匹配历史教训 |
| `src/main/features/recall/projection-knowledge.ts` | `loadCommittedProjectionKnowledge` | 沉淀资产进入下次检索源（listAbilityAssets） |

---

## 数据存储位置（实机验证用）

```
cloud/kstar/task-states/      会话任务状态
cloud/kstar/tasks/            任务
cloud/kstar/requirements/     需求（projectionId/forecastId/episodeIds）
cloud/kstar/episodes/         执行记录（五类证据）
cloud/kstar/reviews/          复盘（deltaR/deltaA/lesson）
cloud/kstar/extraction-runs/  沉淀运行记录
cloud/recall/records/ability-assets/    能力资产（aa-*）
cloud/recall/records/projections/       投影
cloud/recall/records/world-model-forecasts/  预测记录
cloud/recall/jsonl/usage-records/       使用记录（matchScore）
```

## 实机验证结果摘要（截至 2026-08-15）

1. **完整闭环跑通**（00:22）：任务→宿主建任务+投影（确定性）→模型提交 3 候选（forecasts 0→1）→执行→自动复盘（model+inferred，零确认）→2 个旧资产成熟度升 transfer_validated。
2. **过程经验 lesson 上线**（10:23，`540e5899`）：成功任务也能沉淀（met_expected + lesson + confidence≥0.7）。实机场景（custom_providers 审查）Agent 发现真实问题（as 断言掩盖错误、并发幂等脆弱），但当时 lesson 语义未上线故未沉淀——下次同场景应沉淀。
3. **审计修复**（10:47，`56e36e0b`）：P0-2 诚实 lifecycleStatus；P1-1 权重常量+待校准标注；P1-3 结果信号不因执行偏差丢失；P1-4 归因降级诚实 unclear。

## 设计文档

```
docs/superpowers/specs/2026-08-16-six-box-ontology-world-model-architecture.md  六盒架构
docs/superpowers/specs/2026-08-14-kstar-recall-full-pipeline-detail.md         管线详述
docs/superpowers/specs/2026-08-15-kstar-closed-loop-rework-gap-analysis.md     差距分析
docs/superpowers/specs/2026-08-15-kstar-deterministic-routing-live-verification.md  实机验证
docs/superpowers/specs/2026-08-15-kstar-lesson-precipitation-verification-v2.md     教训沉淀验证
```
