# CogSeed KSTAR：真实实现方案与优化方案（基于代码核对版）

- 核对对象：`<reference-document>/CogSeed-KSTAR当前技术实现方案.pdf`、`<reference-document>/CogSeed-KSTAR下一步优化方案.pdf`
- 代码基线：`<repository-root>` develop（`3e016b56` 附近），`npm run typecheck` 通过
- 日期：2026-08-27
- 原则：以代码实现为准，PDF 仅作参考。下文所有功能点都标注"已实现 / 部分实现 / 未实现"，并给出具体文件与函数。

---

## 0. 结论速览

1. PDF 描述的核心闭环（Task/Requirement -> Recall Projection -> World Model Forecast -> 执行 -> Episode -> Review -> Recall Candidate）在代码中**真实存在且更完整**，主要文件在 `src/main/features/kstar/`（34 个文件，约 6000 行）。
2. 但 PDF 有一个**过时的核心假设**：它把 `kstar_control` 描述成 Commander（模型）的"控制协议"。当前代码**已把 `kstar_control` 从 Commander 工具面移除**，改为**宿主确定性路由**（`src/main/features/group_chat/bus.ts` 的 `hostRouteTaskTurn`）：宿主开任务、自动确认 Projection、宿主异步生成 Forecast。这是"真实实现 vs PDF"最大的差异。
3. 优化方案 PDF 中的很多 P0/P1 项**其实已经在代码里做掉了**：语言硬闸（中文任务拒绝英文 lesson）、语义查重、Candidate 生命周期（Recall 侧已有一套比 `proposed -> approved -> active` 更丰富的状态机）、Requirement 级聚合沉淀、空间归属、幂等收据、重启恢复。真正剩余的缺口集中在：显式状态机、超时/取消的 `timed_out` 语义、执行耗时等可量化维度落盘、Forecast 置信度/风险/新鲜度字段、跨任务验证计数、真实 Electron Smoke、KSTAR IPC 的安全边界测试。
4. 建议：不要按 PDF 原文逐条"补"，而是按本文第 2、3 节的"真实差距清单 + 优化方案"推进，避免重复建设。

---

## 1. 真实实现方案（代码为准）

### 1.1 总体架构与边界

| 组件 | 代码位置 | 职责（真实） |
|---|---|---|
| KSTAR 治理层 | `src/main/features/kstar/` | Task/Requirement/Episode/Review/候选，JSON 持久化 |
| Recall 知识层 | `src/main/features/recall/` | Projection、世界模型、候选池、正式资产（ability asset/rule/skill/template） |
| Runtime 执行底座 | `src/main/features/cogseed_runtime/` | 工具执行，终态事件 |
| 群聊执行底座 | `src/main/features/group_chat/bus.ts` | 群聊回合、宿主路由、终态订阅、Commander 提示 |
| P3394 外接 Agent | `src/main/features/p3394_bridge/` | 外接传输/会话/恢复；`kstar-episodes.ts` 落外接 Episode（脱敏） |
| IPC | `src/main/ipc/index.ts` | 投影确认/拒绝/重试、Review 确认/读取 |

关键边界（代码事实）：

- **KSTAR 不接触远程机密**：`p3394_bridge/kstar-episodes.ts` 落盘前统一 `redact()` 脱敏；`p3394_bridge/secrets.ts`、`audit-journal.ts` 单独管理传输与审计。KSTAR 记录只保存 `executionId / runtimeSessionId / wakeRequestId / logicalRunId` 等关联 id。
- **Creator / P3394 不混链**：`kstar` feature 不导入 Creator；P3394 通过 `kstar-close-hook.ts`、`kstar-episodes.ts` 提供执行证据给主沉淀链，但不由 KSTAR 直接调度外接 Agent。

### 1.2 数据模型与状态机（真实枚举）

`src/main/features/kstar/types.ts` + `requirement-types.ts`：

- **Episode（K/S/T/A/R）**：`KstarEpisodeRecord`。K=`memoryRefs/contextRefs/abilityAssetRefs/promptContextSummary`；S=`conversationSummary/workspaceId/workingDir/modelProfile`；T=`userGoal/normalizedTask/constraints`；A=`plan/toolCalls/agentActions`（每个带 `sequence/actor/status`）；R=`status/finalText/producedFiles/verification/failureKind/failureCode`；外加 `evidenceRefs`、`projectionId/forecastId/wakeRequestId` 等溯源字段。`schemaVersion: 1`。
- **Task**：`KstarTaskRecord`。状态 `KstarTaskPhase = 'open' | 'closing' | 'closed' | 'abandoned'`；`closeReason = 'user_complete' | 'topic_switch' | 'aborted'`；`requirementIds[]`、`currentRequirementId`、`aggregateReviewId`。
- **Requirement**：`KstarRequirementRecord`。状态 `KstarRequirementStatus = 'open' | 'waiting_review' | 'closed' | 'abandoned'`；`rHat`（预期结果 summary/acceptanceSignals/source/confidence）、`projectionId + projectionIds[]`、`forecastId`、`wakeRequestId`、`episodeIds[]`、`completionEvidence`、`prmReview`（PRM 权重 accuracy .3/completeness .3/usefulness .2/clarity .2）、`aar`。
- **会话任务状态**：`KstarConversationTaskStateRecord`（`task-states/`）。`currentTaskId/currentRequirementId/requirementJustClosed/taskComplete/pendingTaskStart/pendingAutoCloseAt/controlReceipts[]/projectionDecisions[]`。
- **Review**：`KstarReviewRecord`。`deltaR/deltaA`（number 或 `'unknown'`）、`outcome`（better_than_expected/met_expected/worse_than_expected/unclear）、`attribution`（knowledge_gap/rule_gap/template_gap/skill_gap/execution_gap/unclear）、`confidence`、`lesson`、`reviewState`（inferred/needs_confirmation/confirmed/unknown）、`inferenceMethod`（deterministic/model/commander/user/unknown）、`actionDelta/resultDelta`。
- **Candidate 提案**：`KstarCandidateProposal`（judgment/suggestedType/suggestedScope/applicableWhen/learningSignal/learningProvenance）。
- **控制收据**：`KstarControlReceipt`（idempotencyKey + inputHash + operation + result，审计用，上限 100）。

状态转换现状：**是隐式的**（由 `control-service.ts` 的分支代码直接改 status），没有一张统一的转换表/守卫函数。已有一部分防御（`assertOwnedId`、`currentRecords` 校验 conversation/task/requirement 归属），但"非法转换全被拒绝"这个 P0 目标尚未以显式状态机形式达成。

### 1.3 生命周期控制（真实调用链）

`src/main/features/kstar/control-service.ts`（809 行）实现 `executeKstarControl(context, rawInput)`：

- 操作集：`upsert_state | request_projection | commit_forecast | finish | abandon`（`control-types.ts`）。
- **幂等**：`idempotencyKey` + `inputHash`；重复调用命中 `controlReceipts` 则重放原结果（`replayResult`，hash 不同则拒绝）。
- **输入容忍**：`forecast` 可能是 JSON 字符串（实测 deepseek 把嵌套对象序列化成字符串）、`constraints` 可能被拍平为单字符串——`control-service.ts` 都有兼容归一化。
- **自愈**：空 `upsert_state`（模型参数发射失败）用 `sourceMessageText` 兜底开任务。
- **topic switch（B2）**：已有 open task 时再 create 新任务 → 旧 requirement 置 `waiting_review`、旧 task 置 `closing(closeReason=topic_switch)`，触发 requirement 级沉淀，再开新任务。
- **finish（B7）**：requirement → `waiting_review` + completionEvidence；task → `closing`；触发 `precipitateRequirementLevel`（best-effort，不阻塞）。
- **abandon**：requirement → `abandoned`、task → `abandoned(closeReason=aborted)`、state 清空指针，同样触发沉淀。⚠️ 当前宿主流程（bus.ts）**没有调用 abandon**——用户取消走的是"群聊终态 cancelled → Episode(r.status=cancelled) → 正常 closure"。

**最重要的真实架构：宿主路由，而不是模型控制协议。**

`src/main/features/group_chat/bus.ts`：

- `kstar_control` **不在 Commander 工具面**（约 9056 行注释明说：world model 拥有整个受管生命周期；让模型发嵌套 JSON 生命周期 payload 正是之前线上反复失败的根因）。
- `hostRouteTaskTurn(uid, cid, messageText, sourceMessageId, workspaceId)`（约 8484 行）：Commander 回合前调用——
  1. `isClosingIntent`（"完成/搞定/结束/done"等，`task-intent.ts`）→ 直接走 `finish` 控制路径；
  2. `isObviouslyTrivial`（问候/状态/emoji，`task-intent.ts`）→ 零模型调用、零 KStar 写入跳过；
  3. 其余消息 → `judgeModelRouting`：专用 runner（20s 超时）返回 `<kstar-judge>{"is_task","continuation"}</kstar-judge>`，`parseContinuationJudgement` 容忍多种输出形状（裸 JSON、包裹 JSON，历史上因只收 tag 形态导致全部静默失败）；
  4. 判定是任务 → 宿主 `upsert_state`（幂等键 `host-route-<cid>-<msgId>`）→ `request_projection`（`workspace_policy` 自动确认，无用户确认卡）→ **异步** `autoForecastForRequirement`（10-30s 生成不阻塞回复）。
- `ensureKstarTaskForDispatch`（约 8656 行）：**dispatch 即任务**——Commander 派发具名 agent 且无 open task 时，宿主自动开任务 + 自动确认投影 + 异步 forecast（幂等键 `host-dispatch-...`）。
- `guardKstarPrivilegedDispatch`（约 6620 行）：特权派发前，Projection 未确认 → 直接拦截（`kstar_projection_not_confirmed`）；Forecast 是**建议性**门禁（auto-forecast 失败也放行，避免执行被预测质量绑架），成功后把 provenance（logicalRunId/projectionId/forecastId）盖到当前 taskRun 上，终态事件携带。
- 新用户消息到达会先 `cancelAutoClose`（清 pending 静默闭环）。

### 1.4 Recall Projection 与 World Model Forecast

- **Projection**：`src/main/features/recall/context-projection.ts`。`authorization: 'workspace_policy'` + `confirm: true` → 创建即 `confirmed`（无用户候选确认卡，卡片仅作只读记录）。`loadCommittedProjectionKnowledge`（`projection-knowledge.ts`）产出已确认知识快照（ability assets + rules + ontology）。
- **Forecast**：`src/main/features/kstar/forecast-commit.ts` `commitCommanderForecast`：
  - 校验 2-4 个候选（`validateWorldModelCandidate`，绑定 `allowedToolNames` / `allowedRuleRefs`）；
  - 规则引擎 `evaluateRules`（ontology R-Box 规则 + 资产 ΔR 因果规则）筛出命中本任务的规则子集；
  - `collectWorldSnapshot` 采集 A-Box（workspace/model/tools/群聊状态/资产状态）；
  - `predictedRisksForKnowledge` 用 `applyCausalRules` 做 F002 确定性风险 pass；
  - `selectWorldModelCandidate` 打分（goalFit/feasibility/observability/causalSupport/riskPenalty/total，`world-model-scoring.ts`）选主候选；
  - `buildWorldModelForecastRecord` + `saveWorldModelForecast` 落盘（`recall/world-model.ts`），记录含 `input.k/s/t` 完整快照、`assetVersions`、`ruleRefs`、`provenanceComplete`。
- **auto-forecast**：`src/main/features/kstar/auto-forecast.ts` `autoForecastForRequirement`——幂等（已有 forecastId 跳过）、要求 projection 已确认、专用 runner（30s 超时）、解析候选（`parseGeneratedForecastCandidates`）、截断到 4 个、少于 2 个则放弃；失败只 `log.warn`，绝不阻塞执行。

### 1.5 执行证据（两类 Episode）

`src/main/features/kstar/episode-builder.ts`：

- **Runtime 类**：`buildRuntimeKstarEpisode(input)`——从 `RuntimeRunRequest` + `RuntimeEventEnvelope[]` 提取：`terminalRuntimeStatus`（result/error 终态、cancelled、missing_terminal_event→failed）、`toolCallsFromRuntimeEvents`（tool_call/tool_result 配对、状态 ok/error）、`producedFiles`（basename 去重）、`runtimeEvidenceRefs`（run + context 引用）。
- **群聊类**：`buildGroupKstarEpisode(input)`——从群聊消息 `process` 流（tool/cli 两类事件）、`recall_citations`、`artifacts`、`created_agents/skills` 提取动作轨迹；`GroupKstarEpisodeInputRefs` 支持五源证据（teaching signals、execution evaluations、authorized external system）。
- 两类入口分别由 `task-closure.ts` 的 `captureGroupKstarClosure` / Runtime 侧适配器（`runtimeKstarCaptureInput`）接入。

### 1.6 统一 Closure

`src/main/features/kstar/task-closure.ts`（690 行）：

- 订阅群聊终态：`startGroupKstarClosure()` 监听 `subscribeTaskTerminals`（`group_chat/bus.ts`），`seen/inFlight` 集合去重，`completed/cancelled` 即 `scheduleAutoClose`（静默窗口 30 分钟 `AUTO_CLOSE_QUIET_MS`），capture 失败重试 1 次。
- `captureGroupKstarClosure`：解析 teaching/execution 证据 → build episode → 空间归属补齐（会话 `space_id` → `s.workspaceId`）→ 读 forecast → `serializeClosure(closureLocks, ...)` 串行化 → `finishClosure`（写 episode → 读/建 review → `reconcileKstarExtraction`）→ `attachKstarEpisodeToCurrentRequirement` → `drainKstarTaskState`。
- **幂等**：`closureLocks`（按 `userId:episodeId`）与 `confirmationLocks` 防止重复 Review/重复候选；`reconcileKstarExtraction` 以 `ksx-<episodeId>` 为 extraction-run 幂等键，`status: 'created'` 时直接返回（**per-run 不做沉淀**，沉淀统一收敛到 requirement 级，避免 lesson 碎片化）。
- **静默自动闭环**：`scheduleAutoClose/cancelAutoClose/runAutoClose/startAutoCloseRecovery`。重启后 `startAutoCloseRecovery` 扫描 `task-states/`，未过期按剩余时间重建定时器，已过期直接 `runAutoClose`（走 `executeKstarControl` finish，幂等键 `auto-close-<cid>-<req>`）。
- 用户确认 Review：`confirmKstarReview(userId, episodeId, {verdict: met|partial|not_met|skip})`——met → deltaR=0/confidence=1；partial → deltaR=-0.5；not_met → deltaR=-1；skip → unknown。IPC：`kstar.review.confirm` / `kstar.review.read`（`src/main/ipc/index.ts` 2438-2453）。

### 1.7 Review 推理（确定性 + 模型 + 硬闸）

`src/main/features/kstar/review-inference.ts` + `recall/world-model-reconciliation.ts`：

- **确定性度量**：`reconcileWorldModel(forecast, episode)` 计算 ΔA（missing/unexpected tools、missing/unexpected actors、missing plan steps、extra actions、failed actions、order mismatch；**只惩罚偏差不惩罚创新**——unexpected tools/actors 不计入 gap）、ΔR（acceptance signals met/not_met/unknown、missing predicted files、unexpected produced files、终态）。
- **模型归因 + lesson**：`inferKstarReview`——forecast 存在且 completed 时，把度量结果 + 对话历史（`formatConversationForReview`，最多 40 条/6000 字，过滤 kstar 控制噪音）喂模型，产出 outcome/attribution/reason/confidence/lesson。
- **语言硬闸（确定性）**：`lessonLanguageMismatches`（`util/language.ts` 主导脚本检测）——中文任务产出英文 lesson 直接丢弃并 `log.warn`（实机观测过两次）。
- **降级链**：模型失败 → 确定性模板；无模型配置 → `unknownInference`（不伪造 met_expected）；有输出但模型不可用且 `allowProvisionalEvidenceFallback` → `needs_confirmation` 的 provisional（仅 requirement 关闭路径用）。
- 当前语义：**self-evolution，无用户暂停**——低置信度不弹确认，而是不沉淀。

### 1.8 经验沉淀（统一候选池）

`src/main/features/kstar/extraction-service.ts` + `task-level-precipitation.ts` + `direct-experience-assets.ts` + `recall-bridge.ts`：

- **门槛（确定性）**：`clearsPrecipitationGate` 四类信号——|ΔR|≥0.15（`MIN_PRECIPITATION_DELTA_R`）；better/worse 结果；高置信度具名 gap（knowledge/rule/template/skill gap + reason）；成功任务上的过程经验 lesson（confidence≥0.7 + reason）。"met_expected 且无 lesson"不沉淀。
- **标题/作用域**：`lessonTitleCore`（40 字、去引导前缀、去模板前缀）、`scopeForTask`（report/code/review/product/general，中文关键词）。
- **Requirement 级聚合（B5）**：`aggregateRequirementProposals` 合并该 requirement 所有 episode 的工具链、取最强 review 信号，每个信号沉淀一条资产；`precipitateRequirementLevel` 再叠加 `personal` 候选（`personal-asset-precipitation.ts`，跨类型语义查重 + `sharesTheme` 主题兜底，防"关于我"与 rule/template 重复）。
- **统一出口**：`direct-experience-assets.ts` → `saveRecallCandidate`（指纹去重）→ `autoApplyRecallCandidate({ provenance: 'kstar' })`（语义查重 + 质量融合 + 晋升；资产落成 `system_precipitated_unverified`），并 `addWorkspaceAssetReference` 挂空间。任务级 `drainKstarTaskState` 已不再产候选（避免与 requirement 级对同一 review 各产一条、指纹不同去重拦不住的问题——见 `task-aggregate.ts` 注释）。
- **Recall 侧 Candidate 状态机已很完整**（`recall/candidate-service.ts`）：`observed → weak_observation → pending_review → deferred → confirmed → rejected/ignored/expired/failed/superseded`；资产状态 `active/paused/archived/deleted/purged/revoked`；maturity `seed/bud/transfer_validated/effectiveness_validated`。

### 1.9 持久化、恢复与安全

- 存储布局（`paths.ts`）：`<userCloudRoot>/<userId>/kstar/{episodes,reviews,extraction-runs,tasks,requirements,task-states}/*.json`；所有记录带 `schemaVersion/ownerId/id/createdAt/updatedAt`；`safeId` 校验路径段；`fileEditLock`（`episode-store.ts`）做写锁；`writeKstarJsonRecord` 有冲突检测（同 id 不同内容拒绝），`replaceKstarJsonRecord` 支持重建/恢复。
- 读取校验：`validateEpisode/validateTask/validateRequirement/validateState/validateStoredReview` 逐一校验 ownerId、枚举、必填字段；`listKstarJsonRecords` 跳过损坏记录（单条损坏不拖垮全量）。
- IPC 安全：`safeId` 校验 + Main 侧 `ctx.userId` 统一注入；模型/渲染器提供的 ID 只当建议（`control-service.ts` 注释明确"model-supplied ids are advisory at most"）；`allowedToolNames` 限制 forecast 候选工具；`kstar.review.confirm` 校验 verdict 枚举。
- P3394 边界：`p3394_bridge/kstar-episodes.ts` 落盘前 `redact()`，关联 id 白名单恢复；P3394 的 ownerless 历史记录与用户 KSTAR 沉淀链隔离，不进入用户资产，也不自动写回认知资产。

### 1.10 启动集成

`src/main/index.ts`（约 1156-1158 行）：

```ts
const stopRecallCapture = startRecallCaptureOrchestrator();      // recall/capture-service.ts
const stopGroupKstarClosure = startGroupKstarClosure();          // kstar/task-closure.ts
const stopAutoCloseRecovery = startAutoCloseRecovery();          // kstar/task-closure.ts
```

均注册 `app.once('before-quit', stop...)`。闭环不依赖 Renderer 页面存活，由 Main Process 生命周期服务持续负责（与 PDF §8 一致）。

### 1.11 测试现状（已存在）

- `test/main/features/kstar/`：20 个测试文件——`control-service`、`forecast-commit`、`auto-forecast`、`task-closure`、`review-inference`、`review-extraction`、`episode-builder`、`episode-store`、`requirement-*`、`task-aggregate`、`task-level-precipitation`、`personal-asset-precipitation`、`projection-decision-service`、`lifecycle-adapter`、`task-intent`、`review-card`、`commander-context` 等。
- `test/main/features/recall/`：`world-model`、`world-model-scoring`、`world-model-reconciliation`、`context-projection*`、`projection-knowledge` 等。
- `test/main/features/group_chat/kstar-commander-centric.test.ts`、`test/main/features/p3394/wake-kstar-integration.test.ts`、`test/main/features/p3394_bridge/kstar-episode.test.ts`、`test/renderer/kstar-review-card.test.ts`。
- IPC 层：`test/main/ipc/recall.test.ts` 已覆盖 `recall.projections.confirm/retryForecast/reject` 与 `kstar.review.confirm/read`（含非法 verdict 拒绝）。
- `npm run typecheck` 通过。

### 1.12 与 PDF 的关键差异表

| PDF 描述 | 代码真实情况 | 影响 |
|---|---|---|
| Commander 通过 `kstar_control` 工具推进状态机 | `kstar_control` 已从 Commander 工具面移除；宿主确定性路由（`hostRouteTaskTurn`/`ensureKstarTaskForDispatch`）开任务+自动确认投影+异步 forecast | 高：PDF 第 4 节协议描述已过时；实现更稳（不再依赖模型参数发射） |
| Projection 需要"预览、筛选、确认" | 默认 `workspace_policy` 自动确认（`confirm:true`），无用户确认卡 | 中：与 PDF 的"用户/策略确认"不一致（本意是降低打扰） |
| Forecast 由 Commander 提交（`commit_forecast`） | 服务仍在，但宿主用 `autoForecastForRequirement` 异步生成；guard 把 forecast 当建议性门禁 | 中 |
| Review"确定性判断 + 模型辅助归因" | 已是确定性度量（ΔA/ΔR）+ 模型归因 + 语言硬闸 + 沉淀门槛 + self-evolution 不暂停 | 一致，且更强 |
| 候选经验门槛（语言/置信度/学习信号/适用范围） | 全部已实现（`clearsPrecipitationGate`/`lessonLanguageMismatches`/`applicableWhen`） | 一致 |
| "已关闭对象禁止重开、cancelled 不被 completed 覆盖" | 部分由控制流保证，但没有显式状态机/转换表 | 中：P0 仍待补 |
| 超时进入 `timed_out` | **不存在 `timed_out` 枚举**；Runtime 只有 started/running/completed/failed/cancelled；超时落为 failed+failureKind | 高：P0 语义缺口 |
| 偏差量化（工具次数/执行时间/文件/测试/网络） | 工具/文件/验收信号已量化（`world-model-reconciliation.ts`）；**执行时间、网络策略未落盘** | 中 |
| Forecast 增加 forecastConfidence/riskLevel/assumptions/alternativePlans/contextFreshness/forecastCreatedAt | `assumptions`、`predictedRisks`、`candidates`（替代方案）已有；`forecastConfidence/riskLevel/contextFreshness/forecastCreatedAt` **未实现** | 中 |
| Candidate 生命周期 proposed→reviewed→approved→active→deprecated/rejected | Recall 侧已有更丰富状态机；**缺"多次验证提升置信度/自动失效"的跨任务计数** | 中 |
| 保持 JSON + Repository 抽象 | 保持 JSON；**无统一 Repository 层**（各 store 各自校验） | 低（可选） |
| 任务卡片/风险分级确认 | 有 Review 卡（确认/纠正按钮）；**无按风险分级的前置确认** | P1/P2 缺口 |
| DeepSeek Harness 意图驱动配置单 | 不在 KSTAR feature 内（Creator 侧）；KSTAR 代码未涉及 | 独立项 |

---

## 2. 真实差距与风险清单（按代码核实）

| # | 差距 | 现状证据 | 风险 |
|---|---|---|---|
| G1 | 无显式状态机/转换守卫表 | `control-service.ts` 内隐式改 status；`requirement-store.ts` 只校验枚举合法，不校验转换合法 | 异常事件可能把 closing/abandoned 对象推进到非法状态；审计缺"转换来源" |
| G2 | 无 `timed_out` 终态语义 | `KstarTaskStatus`/`RuntimeStatus` 均无 timed_out；`terminalRuntimeStatus` 把超时归为 failed | 无法区分"超时"与"普通失败"，复盘归因失真 |
| G3 | Episode 不落执行耗时 | `GroupKstarEpisodeInput` 有 startedAtMs/finishedAtMs 但只用于消息窗口过滤，不进记录 | PDF 的"执行时间 30s vs 120s"量化无法落地 |
| G4 | Forecast 缺置信度/风险等级/新鲜度/时间戳 | `WorldModelForecast` 无 forecastConfidence/riskLevel/contextFreshness/forecastCreatedAt | 无法判断"预测是否可靠、上下文是否过期" |
| G5 | 无跨任务验证计数 | 全库 grep 无 validationCount/多次验证逻辑 | "两次相似任务成功提升置信度、连续失败自动失效"无法实现 |
| G6 | 事实/推断/经验未显式分层 | Episode 事实、review.lesson 推断、候选经验隐含分层，但无字段标记 | 长期记忆污染治理缺少结构化支撑 |
| G7 | 取消路径未用 abandon 控制 op | bus.ts 无 `operation:'abandon'` 调用；取消走 cancelled episode + 正常 closure | 与 PDF 描述的 abandon 语义不符；abandon 分支测试覆盖不足 |
| G8 | 无真实 Electron Smoke（KSTAR 端到端） | `src/main/smoke.ts` 无 kstar 场景 | 发布门禁缺"真实环境验证"证据 |
| G9 | KSTAR JSON 安全边界缺跨用户/路径穿越专项测试 | store 有 safeId/ownerId 校验，但未见恶意形状测试（跨用户读、`../` 注入、重复事件） | 发布安全门禁风险 |
| G10 | 风险分级确认（简单/中/高）未实现 | 全部走 workspace_policy 自动确认 | 高风险操作（删文件/网络/写长期记忆）无显式确认，与优化 PDF P1 冲突 |
| G11 | kill switch 审计 | 群聊 abort 存在，但 KSTAR 侧无"kill 审计记录"专项 | 优化 PDF P0 项未闭环 |
| G12 | 运营化（指标面板/任务模板/Forecast 版本化/供应链变化感知） | 无 | P2/P3 远期 |

---

## 3. 优化方案（代码接地，按优先级）

原则：**不换技术栈、不重复建设已实现项**；每项给出"现状 → 改动点 → 涉及文件 → 验收"。

### 3.1 P0：发布门禁

**O1. 显式状态机 + 非法转换守卫（对应 G1）**

- 现状：隐式转换。
- 改动：在 `src/main/features/kstar/` 新增 `state-machine.ts`（纯函数）：为 Task/Requirement/Episode/Review 各定义合法转换表，例如 Task `open→closing`、`closing→closed`、`open/→abandoned`；Requirement `open→waiting_review`、`waiting_review→closed`、`open→abandoned`；Review `inferred→confirmed`、`needs_confirmation→confirmed`。`control-service.ts` 与 `requirement-closure.ts` 落状态前统一调用 `assertTransition(from, to, ctx)`，非法转换抛 `kstar_control_invalid_input`。
- 同时给每次转换补审计字段：`transitionedAt / transitionSource（host_routing|commander|auto_close|user_confirm|recovery）/ idempotencyKey`（可挂在 `controlReceipts` 已有结构上扩展 `transition` 字段）。
- 验收：非法转换（closed→open、cancelled→completed、重复 finish）全部被拒；已有 `control-service.test.ts` 补用例；typecheck + `npm test` 通过。

**O2. 超时语义（对应 G2）**

- 改动：`types.ts` 的 `KstarTaskStatus` 增加 `'timed_out'`（或复用 failed + `failureKind='timeout'` 但显式枚举更利于复盘）；`episode-builder.ts` 的 `terminalRuntimeStatus` 识别超时元数据（`failure_code`/`failure_kind` 含 timeout 前缀）映射为 `timed_out`；`review-inference.ts` 为 `timed_out` 增加确定性分支（`worse_than_expected + execution_gap + failureCode`），不进强沉淀（与 cancelled 同级）。
- 验收：造一条带 timeout 元数据的 Runtime 事件流 → Episode.r.status='timed_out' → Review 正确、无强候选。

**O3. KSTAR 安全边界专项测试（对应 G9）**

- 改动：新增 `test/main/features/kstar/kstar-security-boundary.test.ts`：跨用户读（userA 构造 userB 的 id）、`safeId` 注入（`../`、`/`、超长）、重复 `upsert_state/finish/abandon/review/confirm` 不产生重复记录、`kstar.review.confirm` 非法 verdict、forecast 候选引用未授权工具被 `kstar_unavailable_tool` 拒绝。
- 验收：全部用例通过；确认 Renderer 侧没有任何直接读 KSTAR JSON / 拼接路径的通道（`src/renderer` 仅经 `window.cogseed.invoke`）。

**O4. 真实 Electron Smoke（对应 G8）**

- 改动：在 `scripts/` 新增 `kstar-smoke.cjs`（或扩展 `src/main/smoke.ts`），跑低风险闭环：读 `package.json` → 确认包管理器 → 输出说明。断言链路：宿主路由开 Task → Projection confirmed → auto-forecast 生成 → 执行 → 终态 → Episode → Review → extraction-run 落盘。再补 4 条异常路径：取消（Episode=r.cancelled）、超时（timed_out）、重复终态事件（幂等）、重启恢复（pendingAutoCloseAt 重建）。
- 验收：`./run.sh` 起真实应用后 smoke 输出验证报告（或按 AGENTS.md 用 `scripts/restart-cogseed.sh` 重启后验证）。

### 3.2 P1：量化与学习质量

**O5. Forecast 可量化字段（对应 G4）**

- 改动：`recall/world-model-types.ts` 的 `WorldModelForecast` 增加 `forecastConfidence?: number`、`riskLevel?: 'low'|'medium'|'high'`、`contextFreshness?: { projectionConfirmedAt: string; projectedAt: string; ageMs: number }`、`forecastCreatedAt: string`。`forecast-commit.ts` 在 `buildWorldModelForecastRecord` 时由打分/风险计算派生（riskLevel 取最高 severity 的 predictedRisk；confidence 用 `selectWorldModelCandidate` 的总分归一）。`auto-forecast.ts` 生成时同样填充。
- 验收：新记录含 4 字段；旧记录缺失时读取兼容（字段可选）。

**O6. Episode 增加可统计执行维度（对应 G3）**

- 改动：`types.ts` 的 `KstarEpisodeRecord.r` 增加 `durationMs?: number`、`toolCallCount?: number`、`failedToolCount?: number`、`networkAccess?: boolean`；`episode-builder.ts` 的 `buildGroupKstarEpisode`/`buildRuntimeKstarEpisode` 从 `startedAtMs/finishedAtMs` 与事件流填充。`world-model-reconciliation.ts` 的 `ResultDeltaDetail` 增加 `executionTimeDeltaMs` 可选对比。
- 验收：新 Episode 带耗时与工具统计；Review 的 delta 描述可引用这些数字。

**O7. 跨任务验证计数 + 自动失效（对应 G5）**

- 改动：`recall/candidate-service.ts` 的候选/资产增加 `validationCount`、`lastValidatedAt`、`consecutiveFailures`（升级沿用现有 migration 机制，schemaVersion 递增）；`direct-experience-assets.ts`/`autoApplyRecallCandidate` 在第二次相似候选命中时提升 maturity（`seed→bud→transfer_validated`）；`rule-engine.ts`/`usage-service.ts` 在连续失败时置 `paused`/`deprecated`。
- 验收：同一 lesson 第二次出现时 validationCount=2 且 maturity 提升；依赖/环境变化模拟后连续失败触发降级。

**O8. 事实/推断/经验显式分层（对应 G6）**

- 改动：`types.ts` 的 `KstarReviewRecord` 增加 `evidenceLayer: 'fact'|'inference'|'experience'`（或复用现有 `inferenceMethod`+`confidence` 派生的只读 getter）；`extraction-service.ts` 产候选时只把 `evidenceLayer='experience'` 且过门槛的送候选池。文档层面把 Episode=事实、review.lesson=推断、候选/资产=经验写清楚（可与现有注释合并）。
- 验收：类型/单元测试覆盖三种分层；渲染不感知（纯内部字段）。

**O9. 取消路径统一 abandon 控制 op（对应 G7，可选但建议）**

- 改动：`bus.ts` 在用户中止（非群聊终态 cancelled 场景）时调用 `executeKstarControl(operation:'abandon')`，而不是只依赖终态事件；保留 cancelled episode 作为证据，同时让 task/requirement 状态机走 `abandoned` 分支，避免 `closing→(等待)→closed` 把取消当完成处理。
- 验收：中止后 task.status='abandoned'、requirement='abandoned'、Episode.r.status='cancelled'；`task-aggregate` 不把 abandoned 当 closed 聚合。

**O10. Repository 抽象（对应优化 PDF §六.3，可选）**

- 现状：`episode-store.ts` + `requirement-store.ts` 各自做校验/锁。
- 改动（轻量）：新增 `src/main/features/kstar/repository.ts`，包装 `read/write/replace/list` + `ownerId/schemaVersion/safeId/锁` 统一入口；Task/Requirement/Episode/Review/Candidate 各自薄封装。**不引入数据库**。
- 验收：现有 store 测试全部改指向 Repository 后仍绿；行为零变化。

### 3.3 P1/P2：体验与治理

**O11. 风险分级确认（对应 G10）**

- 现状：全部 workspace_policy 自动确认。
- 改动：在 `forecast-commit.ts`/`guardKstarPrivilegedDispatch` 侧按预测风险分级（riskLevel + 工具集合 + 写入范围）：低风险自动；中风险（改多文件/跑测试/调外接 Agent）展示一次"任务理解+上下文+计划"；高风险（删除、网络、改配置、写长期记忆、不可逆）强制确认后放行。确认卡可复用现有 `kstar_review_card` 的渲染模式（`src/renderer/modules/conversation.js` 已有卡片挂载），宿主侧加一个 `kstar.approval.confirm` IPC 通道（需同步 preload 白名单与 `renderer-contract-capture`）。
- 注意：AGENTS.md 规定 Renderer 无权限层，**风险判定必须在 Main 宿主侧**，Renderer 只做展示与确认。
- 验收：三档任务各自走对应路径；IPC contract 测试覆盖新通道。

**O12. DeepSeek Harness 意图驱动配置单（对应优化 PDF §四.3）**

- 说明：属于 Creator feature，不在 `kstar/` 目录。建议作为独立工作项，产出"配置单"（职责/可读路径/工具/写入范围/网络策略/秘密文件策略/外接策略/输出语言/验收标准）并在用户确认后交 Creator 落盘。KSTAR 侧无需改动，仅需保证 KSTAR 只记录关联 id、不存配置单机密。

### 3.4 P2/P3：运营化（远期）

**O13. 指标面板 / 任务模板 / Forecast 版本化 / 供应链变化感知**

- 指标：在 `task-closure.ts` 与 `review-inference.ts` 现有日志点基础上，用 `createLogger` 输出结构化闭环指标（任务数、完成率、deltaR 分布、沉淀率、取消/超时率）；不新增 telemetry 事件名之外的字段（遵守 AGENTS.md：payload 只含 id/type/count/length/status）。
- Forecast 版本化：`world-model-types.ts` 已含 `assetVersions`，可扩展 `forecastVersion` + 差异 diff（参照 `recall/formal-assets/version-diff.ts`）。
- 供应链变化感知：利用 `scopeForTask`/规则引擎的命中集，在资产 `causalRule` 里登记"依赖版本/项目结构"触发词，失败时触发 `pause`。

---

## 4. 结论

- **PDF 当前实现方案**对整体架构、数据模型、Closure、Review、沉淀、持久化/安全、启动集成的描述与代码基本一致，但 **§4 Commander 控制协议已过时**：真实实现是"宿主确定性路由 + 自动确认投影 + 宿主异步 forecast"，`kstar_control` 已退出模型工具面。若按 PDF 原样实现会退回到已失败的模型参数发射模式。
- **优化方案 PDF** 中约一半的 P0/P1 项（语言硬闸、语义查重、候选生命周期、Requirement 聚合、空间归属、幂等/恢复）**已经完成**；剩余真实缺口集中在：显式状态机、`timed_out` 语义、执行耗时/网络等量化维度落盘、Forecast 置信度/风险/新鲜度字段、跨任务验证计数、取消路径的 abandon 统一、真实 Electron Smoke、风险分级确认。
- **建议路线**：先 O1-O4（发布门禁），再 O5-O9（量化与学习质量），O10 视维护成本决定，O11-O13 随后。所有改动遵循 AGENTS.md：业务逻辑只在 features、IPC 只做校验转发、Renderer 只经 `window.cogseed.{invoke,stream}`、新增渲染资源进 `src/renderer/vendor/` 或并入现有脚本、测试用 `npm test` 管理 sqlite ABI。
