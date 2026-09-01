# CogSeed KSTAR：全链路节点运行详解（附下一步优化）

- 版本：节点详解版——按"一条用户消息端到端"拆解 KSTAR 闭环的每一个节点，精确到函数、数据结构与落盘位置
- 代码基线：`<repository-root>` develop（`npm run typecheck` 通过）
- 日期：2026-08-27
- 原则：以代码实现为准；KSTAR 是群聊 / Runtime / P3394 外接所有执行通道的唯一事实、复盘与沉淀入口

---

## 总览：KSTAR 闭环节点图

```
用户消息
  │
  ▼
N0 宿主路由 hostRouteTaskTurn ──关闭意图/琐碎──► 跳过（零写入）
  │ 模型判定 is_task / continuation
  ▼
N1 任务创建 upsert_state（Task kst-* + Requirement ksreq-* + task-states）
  │
  ▼
N2 上下文投影 request_projection（workspace_policy 自动确认，proj-*）
  │
  ▼
N3 世界模型预测 autoForecastForRequirement（异步，wf-*）
  │
  ▼
N4 执行（群聊 / Runtime / P3394）+ guardKstarPrivilegedDispatch
  │ 终态事件 completed / failed / cancelled
  ▼
N5 Episode 构建 buildGroupKstarEpisode / buildRuntimeKstarEpisode（kse-*）
  │
  ▼
N6 统一 Closure captureGroupKstarClosure → finishClosure → extraction-run（ksx-*）
  │
  ├─► N7 Review 推理与确认（ksr-*）◄── 用户确认卡（met/partial/not_met/skip）
  │
  ▼
N8 经验沉淀（门槛 → requirement 级聚合 → 统一候选池 → 晋升资产）
  │
  ▼
N9 任务/需求收口（PRM + AAR，drainKstarTaskState）
  │
  ▼
N10 静默窗口与重启恢复（30min 自动闭环；startAutoCloseRecovery）

横切：N11 IPC 与渲染确认（recall.projections.* / kstar.review.* / p3394 wake）
```

存储根：`<userCloudRoot>/<userId>/kstar/{episodes,reviews,extraction-runs,tasks,requirements,task-states}/*.json`；世界模型在 `<userId>/recall/` 下（projections / forecasts / candidates / assets）。

---

## N0 宿主路由与任务识别

**触发**：Commander 回合开始前，`bus.enqueue` 内对"用户普通消息"调用 `hostRouteTaskTurn(uid, cid, messageText, sourceMessageId, workspaceId)`（`src/main/features/group_chat/bus.ts` 约 8484 行）。条件：会话不是 `space_builder`、`fromActorId === USER_ID`、非 internalControl、`COGSEED_KSTAR_HOST_ROUTING !== '0'`。

**运行步骤**：
1. `cancelAutoClose(uid, cid)`：用户来新消息，清除该会话 pending 的 30 分钟静默闭环。
2. `isClosingIntent(messageText)`（`kstar/task-intent.ts`，正则如"完成/搞定/结束/done"）→ 命中则直接 `executeKstarControl({ operation: 'finish' })`（幂等键 `host-closing-<cid>-<msgId>`），**绝不**把结束语当新任务。
3. `isObviouslyTrivial(messageText)`（问候/状态/纯 emoji/纯标点，`TRIVIAL_PATTERNS`）→ 命中则零模型调用、零 KStar 写入，直接返回。
4. `judgeModelRouting(uid, cid, messageText, openRequirement)`：专用 runner（`buildRunner`，ephemeral，disableTools，`ROUTING_JUDGE_PROMPT`，20s 超时 `CONTINUATION_JUDGE_TIMEOUT_MS`）判 `{"is_task","continuation"}`。`parseContinuationJudgement` 容忍 `<kstar-judge>...` 标签、裸 JSON、包裹 JSON 三种形状（历史 bug：只收标签形态导致全部静默失败）。
5. 判定分支：
   - `verdict === null`（模型失败/超时）→ 安全空操作，**不**开任务（不因路由不可用而乱建状态）；
   - `isTask === false` → 零写入；
   - `openRequirement && continuation === false`（旧任务未关、用户开启新任务）→ 先 `finish` 旧任务（closeReason=`user moved to a new task`，触发 requirement 级沉淀），再走新建；
   - `continuation === true` → 保持现有任务，什么都不建。
6. 需要新建：`upsert_state`（幂等键 `host-route-<cid>-<msgId>`）→ `request_projection`（幂等键 `host-route-proj-...`）→ **异步** `autoForecastForRequirement`（见 N3）。

**并行入口**：`ensureKstarTaskForDispatch`（约 8656 行）——Commander 派发具名 agent（`dispatch_to`/`hand_off_to`/`run_worker`）且无 open task 时，宿主同样自动 `upsert_state` + `request_projection` + 异步 forecast（幂等键 `host-dispatch-<cid>-<ts>`）。失败只 `log.warn`，**不**拒绝派发（advisory shaping）。

**落盘/读取**：只读会话状态；写入走 control-service（N1 统一处理）。
**异常降级**：路由判定失败 → 该轮不治理（未治理执行仍是今天的行为）；`taskIntentHint` 只在 `openedTask=true` 时向 Commander 声称"已托管"，避免误导模型调不存在的 `kstar_control`。

---

## N1 任务创建（Task + Requirement）

**入口**：`executeKstarControl(context, rawInput)`（`src/main/features/kstar/control-service.ts`），operation=`upsert_state`。

**运行步骤**（`upsertState`）：
1. `assertContext`：校验 userId/conversationId/allowedToolNames。
2. `normalizeInput`：字段/长度/枚举/数组数量校验；`expectedResult` 归一（summary≤4000、acceptanceSignals≤24 条、source∈{user_message,router,model,unknown}、confidence∈[0,1]）。
3. 幂等：`inputHash` = 输入哈希；查 `state.controlReceipts`（上限 100），命中则 `replayResult`（hash 一致 → 重放原结果并标 `replayed:true`；hash 不一致 → 拒绝"idempotencyKey was already used for different input"）。
4. 无会话状态 → `createInitialConversationTaskState`。
5. **自愈**：模型参数为空（空 tool args）且无 task/requirement 时，用 `context.sourceMessageText` 兜底建任务（governed 而不是被拒成未治理执行）。
6. 创建：`createKstarTaskRecord`（id=`kst-<genId12>`，status=`open`，title≤200，workspaceId 可选）→ `createKstarRequirementRecord`（id=`ksreq-<genId12>`，status=`open`，goalText≤4000，rHat 可选）→ task.requirementIds=[req]、currentRequirementId 指向新 req → 三个文件落盘（tasks/、requirements/、task-states/）。
7. **topic switch（B2）**：已有 open task 时再 create → 旧 requirement 置 `waiting_review`、旧 task 置 `closing(closeReason=topic_switch)`，先触发 requirement 级沉淀（best-effort），再开新任务。
8. `persistReceipt`：追加 control receipt 到 task-states（审计）。

**关键防御**：模型提供的 taskId/requirementId 只当建议，宿主以 `currentRecords` 解析真实记录并 `assertOwnedId` 校验；`currentRecords` 校验 task/requirement 的 conversationId、requirement.taskId===task.id、task.currentRequirementId===requirement.id，任一不符即拒绝。

**落盘**：`tasks/<kst-*>.json`、`requirements/<ksreq-*>.json`、`task-states/<cid>.json`。
**异常**：非法输入 → `kstar_control_invalid_input`；持久化失败 → `kstar_persistence_failed`（不产生脏状态，返回可读错误码）。

---

## N2 上下文投影（Recall Projection）

**入口**：`executeKstarControl(request_projection)` → `previewContextProjection`（`src/main/features/recall/context-projection.ts`），授权方式 `workspace_policy` + `confirm:true`（**创建即 confirmed**，无用户确认卡；卡片仅作只读记录）。

**运行步骤**：
1. 前置校验：必须有 open 的 Task+Requirement；模型给的 requirementId 与当前状态不一致 → 拒绝；缺失 → 用当前状态解析。
2. `buildRecallView(userId, { taskRunId, purpose, workspaceId, taskText })`：
   - 加载全量 ability assets（`listAbilityAssets`），跳过 paused/revoked（进 `omittedRefs`）；
   - 按 workspace 引用过滤（`listWorkspaceAssetReferences`）；
   - `applySemanticSelection`：按任务文本对资产做语义打分/匹配排序（`similarity.ts`），产出 `assetIds/assetVersions/assetMatches/sourceRefs/omittedRefs`。
3. 落盘 `projections/<proj-<genId12>>.json`：`schemaVersion:2`、`status:'confirmed'`、`confirmedAt/decidedAt`。
4. 回写 requirement：`projectionId=proj.id`、`projectionIds` 追加（保留完整历史，`projectionId` 始终是最新指针）。
5. 返回 `projection_confirmed` + `next_step`：要求先 `commit_forecast` 再执行（predict-then-execute 契约）。

**下游读取**：`loadCommittedProjectionKnowledge`（`recall/projection-knowledge.ts`）——校验投影已确认、逐资产校验 `assetVersions` 强一致，装配 `abilityAssets`（截断 statement/evidenceRefs）、`rules`（因果规则 `rule:<assetId>:<version>`）、`ontologyAssets`（无条件加载的 USER.md/MEMORY.md 个人本体）、`ontologyRules`、`ontologyTaxonomy`。

**异常**：投影未确认/过期 → `kstar_projection_not_confirmed`；资产版本不一致 → 拒绝并提示重建投影。

---

## N3 世界模型预测（Forecast）

**两条路径**：
- 宿主自动（常态）：`autoForecastForRequirement`（`kstar/auto-forecast.ts`）——幂等（已有 forecastId 跳过）；要求投影已确认；专用 runner（30s 超时 `AUTO_FORECAST_TIMEOUT_MS`）按 `AUTO_FORECAST_PROMPT` 生成候选；`parseGeneratedForecastCandidates` 解析；截断到 4 个、少于 2 个放弃。**异步执行**，失败只 `log.warn`，绝不阻塞用户回复。
- 控制提交（保留能力）：`executeKstarControl(commit_forecast)`，host 解析真实 id。

**`commitCommanderForecast`（`kstar/forecast-commit.ts`）运行步骤**：
1. `assertInput`：safeId 校验（userId/taskRunId/requirementId/projectionId/workspaceId）；`allowedToolNames` 可迭代。
2. 读 requirement+task，强校验：`requirement.taskId===task.id`、`requirement.projectionId===input.projectionId`、`task.currentRequirementId===requirement.id`、两边都 `open`。
3. `loadCommittedProjectionKnowledge` → 校验投影已提交/未过期 → workspace 一致性校验（input/projection/task 三方一致）。
4. `collectWorldSnapshot`（A-Box）：workspace 可用性、model 配置、tools、群聊状态、资产/规则数量。
5. `evaluateRules`：ontology R-Box 规则 + 资产 ΔR 因果规则按任务文本触发，命中子集进 K。
6. `validateCandidates`：**2-4 个候选**；`validateWorldModelCandidate` 校验 plan/expectedTools/expectedActors/predictedResult/assumptions；工具必须在 `allowedToolNames` 内（越权 → `kstar_unavailable_tool`），规则引用必须在 `allowedRuleRefs` 内（→ `kstar_invalid_rule_ref`）；模型给的 id/riskRuleRefs 是猜测，容错处理（fallback id、过滤未知引用）。
7. `predictedRisksForKnowledge`：`applyCausalRules` 对 A-Box 做 F002 确定性风险 pass。
8. `selectWorldModelCandidate`（`recall/world-model-scoring.ts`）：按 `score.total` 降序 → `riskPenalty` 升序 → `observability` 降序 → `modelOrder` 升序选主候选。
9. `buildWorldModelForecastRecord` + `saveWorldModelForecast`：落盘 `forecasts/<wf-<genId12>>.json`，含 `input.k/s/t` 完整快照、`assetVersions`、`ruleRefs`、`snapshotId`、`provenanceComplete`；快照另存 `snap-<genId12>.json`。
10. 回写 requirement：`forecastId`。

**WorldModelForecast 结构**：`aHat{plan,expectedTools,expectedActors}`、`rHat{summary,acceptanceSignals,predictedFiles}`、`predictedRisks[]`、`candidates[]`（全部备选+分数）、`selectedCandidateId`、`causalLinks[]`、`assumptions[]`。

**异常**：候选非法/工具越权/规则引用越权/投影未确认 → 对应错误码；auto-forecast 生成失败 → 无 forecast 记录，执行照常（guard 见 N4）。

---

## N4 执行与终态事件

**执行通道**：
- 群聊：Commander 回合执行工具，事件流写入消息 `process`（`tool`/`cli` 两类事件）。
- Runtime：`cogseed_runtime` 独立执行，`RuntimeRunRequest` + `RuntimeEventEnvelope[]`，终态 `result/error`。
- P3394 外接：`p3394_bridge/kstar-episodes.ts` 落外接 Episode（落盘前 `redact()` 脱敏，关联 id 白名单恢复），`proposed_updates` 只作为证据注入。

**门禁**：`guardKstarPrivilegedDispatch`（`bus.ts` 约 6620 行）——特权派发前，若 requirement 带 projectionId：
- projection 未确认 → 直接拦截（`kstar_projection_not_confirmed`）；
- forecastId 缺失 → `log.warn` 后**放行**（forecast 是建议性门禁，不绑架执行）；
- 通过 → 把 `logicalRunId/projectionId/forecastId` 盖到当前 taskRun，终态事件携带（provenance 来自宿主状态，非模型声称）。

**终态事件（`TaskTerminalEvent`）**：`user_id/run_id/conversation_id/status/completed|failed|cancelled/started_at_ms/finished_at_ms/logical_run_id/execution_id/projection_id/forecast_id`。Runtime 终态映射：result+completed → completed；cancelled → cancelled；无终态事件 → failed（`failureKind=missing_terminal_event`）；其余 → failed + failureKind/code。

**超时现状**：Runtime/KSTAR 状态枚举都**没有** `timed_out`，超时目前归为 failed（见优化 O2）。

---

## N5 Episode 构建（K/S/T/A/R）

**两类入口**（`kstar/episode-builder.ts`）：
- 群聊：`buildGroupKstarEpisode`（输入 `GroupKstarEpisodeInput`：userId/runId/conversationId/status/startedAtMs/finishedAtMs/messages/projectionId/forecastId/wakeRequestId/五源 refs）。
- Runtime：`buildRuntimeKstarEpisode`（输入 `RuntimeKstarEpisodeInput`：userId/runId/request/events）。

**构建逻辑（以群聊为例）**：
1. `messagesInRun`：按 startedAtMs/finishedAtMs ±5s 窗口过滤消息（执行时间窗内的才算本次运行）。
2. `userGoal`：取第一条有真实文本的用户消息（**跳过空文本的宿主控制消息**——历史上空文本被当成目标导致 `Conversation <cid>` 假 episode）；兜底 `Conversation <cid>`。
3. `toolCallsFromGroupMessages`：从 `process` 流提取 `tool`/`cli` 事件，phase start/begin/running → 建调用（status unknown），end/complete/error/failed → 配对更新 status（ok/error）；sequence 按出现顺序。
4. `abilityAssetRefsFromCitations`：从 `recall_citations` 提取本次实际引用的资产。
5. `agentActions`：结果消息 → action（status 由 failure_code 判定）；created_agents/created_skills/artifacts/plan_announcement 展开为动作。
6. **五源 evidenceRefs**：conversation（会话+消息）→ artifact_file（产出文件+附件）→ execution_evaluation（输入注入）→ user_teaching_signal（输入注入）→ authorized_external_system（输入注入）。
7. `r`：status/finalText（最后一条有文本的结果消息）/producedFiles（basename 去重）/failureKind/failureCode。
8. id=`kse-<runId>`；sessionKind=`group_chat`（或 `cogseed_runtime`）。

**补充**：`captureGroupKstarClosure` 在构建后还会：空间归属补齐（会话 `space_id` → `s.workspaceId`，safeId 校验）、从 requirement 补 completionEvidence（`enrichEpisodeFromRequirementEvidence`）。

**落盘**：`episodes/<kse-*>.json`，`writeKstarEpisode` 先 `validateEpisode`（ownerId、K/S/T/A/R 结构、status 枚举、createdAt/updatedAt）。

---

## N6 统一 Closure

**入口**：`startGroupKstarClosure`（`kstar/task-closure.ts`，由 `src/main/index.ts` 启动）订阅 `subscribeTaskTerminals`。

**运行步骤**：
1. 终态事件到达：`key = user:run`，`seen/inFlight` 集合去重；`completed/cancelled` 立即 `scheduleAutoClose`（见 N10）。
2. `runCapture(attempt)`：加载最近 500 条群聊消息 → `captureGroupKstarClosure`；失败重试 1 次（attempt<1）。
3. `captureGroupKstarClosure`：
   a. 解析五源证据：`listUserTeachingSignals`（active，≤50）+ `listCognitionSources`（execution_evaluation，≤10）→ teachingRefs/executionRefs。
   b. `buildGroupKstarEpisode`（N5）。
   c. 空间归属补齐 + `enrichEpisodeFromRequirementEvidence`。
   d. 若 `forecastId` → `readWorldModelForecast`（review 推理用确定性世界模型度量）。
   e. `serializeClosure(closureLocks, userId:episodeId)` 串行化（同一 episode 的关闭只执行一次，`closureLocks` Map 保证）。
   f. `finishClosure`：
      - `writeKstarEpisode`（证据先落盘，失败不抹执行事实）；
      - 读 review（`ksr-<episodeId>`）；没有 → `inferKstarReview`（N7）→ `saveKstarReview`；推理失败 → `createInitialKstarReview` 保守兜底；
      - `reconcileKstarExtraction`：extraction-run id=`ksx-<episodeId>`；**若已存在且 status='created' → 直接返回**（单次运行不沉淀，沉淀收敛到 requirement 级，避免 lesson 碎片化）；否则建 `status:'created'` 的记录。
   g. `attachKstarEpisodeToCurrentRequirement`：按 projectionId/wakeRequestId provenance 匹配 requirement（唯一），追加 `episodeIds`；无匹配但存在当前 requirement → 挂当前；多匹配 → 抛错（数据不一致）。
   h. `drainKstarTaskState`（N9）。
4. **用户确认 Review**：`confirmKstarReview(userId, episodeId, {verdict})`（`confirmationLocks` 串行化）——verdict `met`→ΔR=0/conf=1；`partial`→ΔR=-0.5；`not_met`→ΔR=-1；`skip`→unknown/conf=0；inferenceMethod=`user`，reviewState=`confirmed`（skip→`unknown`）。

**幂等/并发**：`closureLocks` + `confirmationLocks`（按 `userId:episodeId`）；extraction-run 幂等键；重复终态事件只重放，不重复 Review/候选。

---

## N7 Review 推理与确认

**入口**：`inferKstarReview`（`kstar/review-inference.ts`），在 closure 内后台执行（独立 runner，不占 Commander 队列）。

**主路径（forecast 存在且 completed）**：
1. `reconcileWorldModel(forecast, episode)`（`recall/world-model-reconciliation.ts`）确定性度量：
   - ΔA：missing/unexpected tools、missing/unexpected actors、missing plan steps、extra actions、failed actions、order mismatch；`deltaA = -min(1, gapCount/predictedCount)`；**只罚偏差不罚创新**（unexpected tools/actors 不进 gap）。
   - ΔR：acceptance signals met/not_met/unknown（含证据）、missing predicted files、unexpected produced files、终态；`deltaR` 由信号命中率 + 文件差 + 终态推导，**ΔA 门控 ΔR**（执行偏差大时 ΔR 不干净）。
   - 输出 `actionDelta/resultDelta` 明细。
2. 模型推理 pass：输入 = forecast（rHat/aHat/expectedTools/expectedActors）+ delta + `buildDeterministicReviewEvidence` + 对话历史尾巴（`formatConversationForReview`，最新 40 条/6000 字，过滤 kstar 控制噪音）+ selectedAssetTypes → `parseKstarReviewInference`（严格 JSON、只允许 outcome/attribution/deltaR/deltaA/reason/confidence/needsConfirmation/lesson 8 个字段）。
3. **度量值以确定性为准**（deltaR/deltaA 覆盖模型输出）；模型只出 outcome/attribution/reason/confidence/lesson。
4. **语言硬闸**：`lessonLanguageMismatches(episode.t.userGoal, lesson)` → 主导脚本不匹配的 lesson 直接丢弃并 `log.warn`（实机观测中文任务产英文 lesson 两次）。
5. reviewState=`inferred`、inferenceMethod=`model`、needsConfirmation=false（self-evolution：低置信度不暂停用户，而是不沉淀）。

**降级链**：
- failed/cancelled → 确定性：`worse_than_expected + execution_gap + ΔR=-1 + conf=0.95`；
- completed + verification 通过 → `met_expected + ΔR=0/ΔA=0 + conf=0.95`；
- 无模型配置 → `unknownInference`（诚实 unknown，不伪造 met_expected）；
- 模型失败但有输出且 `allowProvisionalEvidenceFallback`（requirement 关闭路径）→ `needs_confirmation`、conf=0.6 的 provisional；
- 彻底失败 → `createInitialKstarReview` 保守兜底。

**确认**：渲染层 Review 卡 → IPC `kstar.review.confirm`（verdict 校验）→ `confirmKstarReview`（N6 第 4 步），把 inferred 升级为 confirmed 并重跑 extraction reconcile。

**落盘**：`reviews/<ksr-<episodeId>>.json`（id 绑定 episode，evidenceRefs 必填）。

---

## N8 经验沉淀（统一候选池）

**门槛（确定性，`extraction-service.ts`）**：
- `clearsPrecipitationGate`：|ΔR|≥0.15（`MIN_PRECIPITATION_DELTA_R`）或 better/worse 结果或（conf≥0.7 的具名 gap + reason）或（lesson + conf≥0.7 + reason）；
- "met_expected 且无 lesson"不沉淀；
- 语言硬闸：lesson 与任务主导脚本不匹配 → 不产候选；
- 规则候选必须带 `applicableWhen`（如"处理代码类任务时"），只声明证据支撑得起的边界。

**产出（`proposeKstarCandidates`，最多 3 条）**：
- 已验证工作流（completed + ≥2 个不同工具 + 全部 ok + 有学习信号）→ `skill_method`（无 lesson）或 `rule`（有 lesson，gapType 决定类型）；
- 高置信度 gap（conf≥0.7 + attribution + lesson）→ `personal/rule/template/skill_method`；
- 标题 `lessonTitleCore`（40 字、去引导/模板前缀）、作用域 `scopeForTask`（report/code/review/product/general，中文关键词）。

**Requirement 级聚合（`task-level-precipitation.ts`，finish/abandon/topic-switch 时触发）**：
- 合并该 requirement 所有 episode 的工具链（保序去重）、`allCallsOk`、`anyCompleted`；
- 取最强 review（`clearsPrecipitationGate` 过滤后按 confidence 排序取首）；
- 每个信号沉淀一条（skill_method / gap 资产），避免 N 个碎片；
- personal 候选：`personal-asset-precipitation.ts` 从用户消息提取长期偏好 → 跨类型语义查重（0.85）+ `sharesTheme` 主题兜底 → 产 `personal` 候选（防"关于我"与 rule/template 重复）。

**统一出口（`direct-experience-assets.ts`）**：
1. `saveRecallCandidate`（`recall/candidate-service.ts`）：captureKey=`kstar-<sourceId>-<idx>`（同源同序幂等）；指纹去重（judgment/value/type/scope/action）；risk 归一；敏感内容闸 `assertNotForbiddenToPersist`。
2. `autoApplyRecallCandidate({ provenance:'kstar' })`：
   - 语义复核（`reviewCandidateSemantically`，模型级闭集）命中非 LOW 发现 → 候选置 `deferred` 留用户决定（不静默晋升）；
   - `semanticDedupBeforePromote`：命中正式资产 → 只产 update 候选（不经 ReviewDecision 不改资产）；命中候选 → 合并证据；
   - 通过 → `promoteRecallCandidate`（actor=system，decisionType=accept）→ 资产落成 `system_precipitated_unverified`；
   - `addWorkspaceAssetReference` 挂空间引用。
3. 结果：`createdAssetIds/candidateIds/mergedIntoIds/updateCandidateIds`。

**状态机（Recall 侧）**：候选 `observed→weak_observation→pending_review→deferred→confirmed→rejected/ignored/expired/failed/superseded`；资产 `active/paused/archived/deleted/purged/revoked`；maturity `seed/bud/transfer_validated/effectiveness_validated`。

---

## N9 任务/需求收口（PRM + AAR）

**入口**：`closeKstarRequirement`（`kstar/requirement-closure.ts`）+ `drainKstarTaskState`（`kstar/task-aggregate.ts`）。

**`closeKstarRequirement`**：
- 幂等：已 closed 且 prmReview+aar 完整且 `hasRequirementLearningSignal` → 直接返回；
- PRM 来源：有用户反馈 → `prmFromFeedback`（met=全 1 分、partial=0.8/0.5/0.8/0.8、not_met=0/0/0/0.5、skip=unknown）；无反馈 → `prmFromCompletionEvidence`（读最新 episode + forecast → `inferKstarReview`（provisional 允许）→ `prmFromInferredReview`）；
- `computeKstarPrmWeightedScore`：accuracy .3 + completeness .3 + usefulness .2 + clarity .2；
- `aarFromReview`：keep/change/lesson/candidateSeed/evidenceRefs（`hasRequirementLearningSignal` 才产非空 lesson）。

**`drainKstarTaskState`**：
- `requirementJustClosed` → 先关 requirement；
- `taskComplete === true` → 关 task（status=`closed`、`candidateRunId=kstc-<taskId>`、清 currentRequirementId）；
- **不产候选**（已收敛到 requirement 级，避免对同一 review 双路径各产一条）；
- `pendingTaskStart`（topic-switch 缓存的新任务）→ `startPendingTopicSwitchTask` 开新任务；否则清空 state 指针。

---

## N10 静默窗口与重启恢复

- `AUTO_CLOSE_QUIET_MS = 30min`（测试可注入 `_setAutoCloseQuietMsForTest`）。
- `scheduleAutoClose(uid, cid)`：终态（completed/cancelled）后写 `pendingAutoCloseAt`（task-states）并 `armAutoCloseTimer`；已到期不重复排。
- `cancelAutoClose(uid, cid)`：用户新消息到达（N0 第 1 步）清 pending + 清定时器。
- `runAutoClose(uid, cid)`：到期校验（`Date.parse(pendingAutoCloseAt) <= now`）→ `executeKstarControl(finish)`（幂等键 `auto-close-<cid>-<req>`，finalText="Auto-closed after a quiet period..."，closeReason=`auto_close_quiet`）；未到期（恢复定时器早触发）→ 按剩余时间重建。
- `startAutoCloseRecovery()`（启动时，`src/main/index.ts`）：扫描当前活跃用户 `task-states/`，未过期 → 按剩余时间重建定时器；已过期 → 直接 `runAutoClose`；扫描失败 → `log.warn`，下次启动再扫。

---

## N11 IPC 与渲染确认

`src/main/ipc/index.ts`：
- `recall.projections.confirm` / `retryForecast` / `reject`（2431-2437）：`safeId` 校验 projectionId/cid → `projection-decision-service.ts`：确认/拒绝投影 → `loadCommittedProjectionKnowledge` → `resumeOnce`（marker `projectionId:decision` 持久化 + `inFlight` 内存锁，**同一次确认只 resume 一次**）→ `bus.enqueueCommanderControlMessage` 把决策回灌 Commander。
- `kstar.review.confirm` / `kstar.review.read`（2438-2453）：verdict 枚举校验 → `confirmKstarReview` / `readKstarReview`。
- `p3394.decideWakeRequest`：approve 且 `kstar_decision.required` 且投影未在快照里 → `ensureKstarWakeProjectionConfirmed`：从 lifecycle 解析投影 id → `confirmAndApproveWake` 绑定 wake request 到 requirement（`wakeRequestId`）。

**安全边界**：Renderer 只能走受控 IPC；`ctx.userId` 由 Main 注入；所有 id 过 `safeId`；模型/渲染器给的 id 只当建议，宿主从状态解析真实 id；`allowedToolNames` 限制 forecast 候选工具；KSTAR 记录不保存 endpoint/token/raw headers/socket handle。

---

## 横切：存储层

- `paths.ts`：`kstarRoot = userCloudRoot(userId)/kstar`；6 个集合目录；路径段/记录 id 全部 `safeId` 校验（防路径穿越）。
- `episode-store.ts`：`fileEditLock` 写锁；`writeKstarJsonRecord` 冲突检测（同 id 不同内容拒绝）；`replace` 支持重建；`listKstarJsonRecords` 单条损坏跳过。
- 所有记录：`schemaVersion=1/ownerId/id/createdAt/updatedAt`；读取逐字段校验枚举与必填。
- 世界模型/候选/资产在 `<userId>/recall/` 下（projections/forecasts/candidates/assets...），由 Recall 侧 store 管理。

---

## 以 KSTAR 为核心的下一步优化

核心思路：**KSTAR 是所有执行通道的唯一事实/复盘/沉淀入口**。已完成的别重复做（语言硬闸、语义查重、候选生命周期、Requirement 聚合、空间归属、幂等/恢复）。按三波推进：

### 第一波 P0（发布门禁）
| 项 | 缺口 | 改动 |
|---|---|---|
| O1 显式状态机 | 转换隐式写在 control-service 分支，无转换表 | 新增 `kstar/state-machine.ts` + `assertTransition` + 转换审计 |
| O2 `timed_out` | KstarTaskStatus/RuntimeStatus 都无超时态 | 枚举加 `timed_out`；episode-builder 识别；review 加超时分支 |
| O3 安全边界测试 | 有 safeId/ownerId 校验，缺恶意形状测试 | 新增 `kstar-security-boundary.test.ts` |
| O4 Electron Smoke | smoke.ts 无 KSTAR 场景 | 端到端 smoke + 取消/超时/重复事件/重启恢复 |

### 第二波 P1（量化与学习质量）
| 项 | 缺口 | 改动 |
|---|---|---|
| O5 Forecast 字段 | 无 confidence/riskLevel/contextFreshness/createdAt | world-model-types 加字段，commit 派生 |
| O6 Episode 执行维度 | startedAtMs/finishedAtMs 不进记录 | Episode.r 加 durationMs/toolCallCount/failedToolCount/networkAccess |
| O7 跨任务验证计数 | 无 validationCount/自动失效 | 候选/资产加计数，二次命中提 maturity，连续失败降级 |
| O8 事实/推断/经验分层 | 隐含分层无标记 | Review 加 evidenceLayer，只沉淀 experience 层 |
| O9 取消统一 abandon | bus 无 abandon 调用 | 用户中止走 abandon op，task/req 落 abandoned |
| O10 Repository 抽象（可选） | 各 store 各自校验 | 轻量统一 Repository，不引入数据库 |

### 第三波 P2/P3（体验与运营化）
- O11 风险分级确认：低风险自动 / 中风险展示计划 / 高风险强制确认；判定留在 Main 宿主侧，Renderer 只展示。
- O12 DeepSeek Harness 配置单：属 Creator 侧，独立工作项。
- O13 运营化：闭环指标（createLogger）、Forecast 版本化（assetVersions + version-diff）、供应链变化感知（causalRule 触发词 → pause）。

---

## 结论

KSTAR 当前是一条**宿主驱动的治理闭环**：宿主开任务、自动确认投影、宿主异步生成预测，Commander 只负责执行；终态统一进 Closure，Review 用确定性度量 + 模型归因 + 语言硬闸，经验走统一候选池 + 语义查重后沉淀，全程 JSON 持久化 + 幂等 + 并发锁 + 重启恢复。

下一步以 KSTAR 为核心，按"先稳定和安全（O1-O4）→ 再量化和学习质量（O5-O10）→ 后体验与运营化（O11-O13）"推进，最终让 KSTAR 成为可发布、可恢复、可审计、可量化、可持续学习的核心认知治理层。
