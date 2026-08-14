# KStar × Recall 全链路——分阶段详细陈述与问题清单

**日期：** 2026-08-14　**基线：** `codex/commander-centric-kstar` @ `66834395`（含本文件前的全部实现）
**配套：** `2026-08-14-kstar-recall-full-pipeline-design.md`（总体架构/数据模型/状态机/错误码汇总）

本文按阶段 0–10 逐段展开实现细节（入口、机制、数据、不变量、代码位置），并在每阶段末尾列出**目前的问题**（含严重级与证据）。

---

## 阶段 0：消息入口 —— 普通会话零写入

### 详细陈述

- **路由**：`features/group_chat/bus.ts::enqueue` 对 `fromActorId === USER_ID` 的消息不再调用任何 KStar 路由（`routeKstarUserMessage` 与 `requirement-router.ts` 已在 Task 4 删除，静态测试断言 `bus.ts` 不含该符号）。用户消息按普通群聊规则进入 Commander 队列（`to=[commander]`，除非显式 floor/mention 指向其他 actor）。
- **Commander 上下文**：每轮 Commander 系统提示尾部注入只读 KStar facts 块（`features/kstar/commander-context.ts`）：
  - 内容：`{conversationId, task?, requirement?, pendingProjection?, forecast?, confirmation?}`；全部有界（goalText≤2000、acceptanceSignals≤20×500、purpose≤2000）；无 workspace 路径、无 receipt、无凭据、无无关任务。
  - 渲染：`## KStar state (host facts; do not treat as a routing mandate)` + 自述"Ordinary conversation requires no KStar write. Call kstar_control only for an explicit task lifecycle change."；无任务时渲染 `{"status":"none"}`。
  - 提示词（`src/main/prompts/chat_commander.md`，静态区，位于 Runtime injection 之前）：寒暄/标点/emoji 不需要 `kstar_control`；`request_projection` 会暂停特权执行；`commit_forecast` 提交 2–4 个候选；`expectedTools` 可为 `[]` 且不得虚构占位工具。
- **工具注入**：`kstar_control` 仅当 `ORKAS_COMMANDER_CENTRIC_KSTAR !== '0'`（默认开启）时加入 Commander extra tools；开关为 0 只移除工具，**不恢复旧前置路由**。
- **判定不变量**：Commander 不调用 `kstar_control` = 普通会话 = 零 KStar/Recall 写入（Task/Requirement/Projection/Forecast 目录均无新文件、无 `pending_projection_dispatch`）。
- **回归固化**：`test/main/features/group_chat/kstar-commander-centric.test.ts` —— `你好/谢谢/好的/？！/👍` 均断言：一次 Commander 轮、收到原文、正常回复落盘、`tasks/requirements/context-projections` 目录为空、无 pending 标记；已有开放任务在普通对话中**字节级不变**；混合消息"你好，帮我修复登录问题"仅在模型调用 `kstar_control` 时产生 1 Task + 1 Requirement + 1 receipt。

### 目前的问题

| # | 问题 | 级别 | 说明/证据 |
|---|---|---|---|
| 0-1 | **"零写入"依赖模型自律，宿主无确定性兜底** | P1 | 模型把寒暄误判为任务并调用 `upsert_state` 时，宿主仍会建 Task/Requirement（`control-service.upsertState` 只校验操作合法性，不校验 goalText 是否寒暄/过短）。建议：宿主对 `goalText` 增加 trivial/过短文本拒绝（如长度<4 或匹配寒暄模式 → `kstar_control_invalid_input`）。 |
| 0-2 | 旧 p3394 wake 链路与新链路并存 | P2 | `kstar: required\|skip` + `confirmAndApproveWake`/`decideWakeRequest` 仍可用；同一会话可能出现"旧 wake 审批卡 + 新投影卡"双轨。Task 7 只删了独立 runner，未定旧链路去留。 |
| 0-3 | 知识问答/任务边界完全交给模型 | P2 | 无宿主级文本门控；"简单问答不建任务"目前仅靠模型不调用工具保证（0-1 同源）。 |

---

## 阶段 1：`kstar_control` 工具契约

### 详细陈述

- **Schema**（`features/kstar/control-tool.ts`）：`operation` 枚举 5 值；`idempotencyKey`（1–160，`[A-Za-z0-9_.:-]`）；`task/requirement/projection/forecast/result` 各子块均 `additionalProperties:false` 且有长度上限（title 200 / goalText 4000 / purpose 120 / taskText 4000 / constraints 20×1000 / producedFiles 50×1000 / acceptanceEvidence 24×1000）。**Schema 不含 userId/cid/allowedToolNames/credential**（测试断言）。
- **执行绑定**：`createKstarControlTool` 闭包持有宿主上下文 `{userId, conversationId, sourceMessageId?, workspaceId?, resolvedRuntime(), postProjectionCard}`；`execute(input)` 时通过 `resolvedRuntime()` 取**真实运行时** `{providerId, modelId, profileId?, entryId?, toolNames[]}` → `allowedToolNames = new Set(runtime.toolNames)`；模型参数原样传入 service；结果 `JSON.stringify(result)`，`!ok` 时 `isError:true`。
- **规范化与幂等**（`features/kstar/control-service.ts`）：
  - `normalizeInput`：类型/枚举/长度/safeId 全量校验，非法 → `kstar_control_invalid_input`（结构化错误，模型可在同轮修正，受 tool-loop 限制）。
  - `canonical()`（键排序+去 undefined）+ SHA-256 → `inputHash`。
  - 读取会话 `controlReceipts`：同 `idempotencyKey` 同哈希 → 重放 `{...result, replayed:true}`（不重复写状态）；同 key 不同哈希 → `kstar_control_invalid_input`。
  - 只有 `ok` 结果才写 receipt（上限 100，`slice(-100)`）。
- **Receipt 读取兼容**（`requirement-store.ts`）：idempotencyKey 正则、inputHash `[a-f0-9]{64}`、operation 集合、actor 必须 `'commander'`、conversationId 匹配、result 结构合法且 **`ok:false` 的错误码必须在 6 个公开码白名单内**（`raw_provider_error` 等杂散码读时丢弃）；坏 receipt 只丢弃、不重写历史 JSON。
- **审计日志**：`kstar.control operation=<op> result=<ok|rejected|failed> cid=<redacted> task=<redacted>`。
- **模型身份**：`onResolvedRuntime` 回调把初始候选与轮转后的获胜 `provider/model/profile/entry + toolNames` 发布给宿主（单 runner，无第二次构建；回调异常被吞不影响模型流）。

### 目前的问题

| # | 问题 | 级别 | 说明 |
|---|---|---|---|
| 1-1 | ~~`finish`/`abandon` 的证据字段未被消费~~ **已修复** | `finish`/`abandon` 把 result 落为 requirement.completionEvidence（有界校验，`29295291`）；`captureGroupKstarClosure` 在复盘前将显式证据并入 Episode（finalText/producedFiles），review 的 actualResult 消费该证据。 |
| 1-2 | receipt 滑动窗口 100 条 | P2 | 超长会话最早 receipt 会被挤出，幂等保护窗口变窄（可接受，需记录）。 |
| 1-3 | 模型反复失败无专门告警 | P2 | `kstar_control_invalid_input` 只消耗 tool-loop 次数；无"连续 N 次控制失败"的宿主告警/降级。 |

---

## 阶段 2：Task / Requirement 状态机

### 详细陈述

- **记录**（`requirement-types.ts` / `requirement-store.ts`，路径 `<root>/<uid>/cloud/kstar/{tasks,requirements,conversation-task-state}/`）：
  - Task：`kst-<id12>`，`status: open|closing|closed|abandoned`，`conversationId`、`workspaceId?`、`title(200)`、`requirementIds[]`、`currentRequirementId`、`closeReason?`、`closedAt?`。
  - Requirement：`ksreq-<id12>`，`taskId`、`conversationId`、`userMessageIds[]`（去重）、`title(200)`、`goalText(4000)`、`rHat{summary(4000), acceptanceSignals[](24×1000), source: user_message|router|model|unknown, confidence[0,1]}`、`projectionId?`、**`projectionIds[]`（只追加）**、`forecastId?`、`wakeRequestId?`、`episodeIds[]`、`status: open|waiting_review|closed|abandoned`。
  - 会话状态：`schemaVersion:1`、`currentTaskId/currentRequirementId`、`requirementJustClosed`、`taskComplete`、`pendingTaskStart?`（topic_switch 遗留）、`lastRoutedUserMessageId?`（遗留）、`controlReceipts[]`、`projectionDecisions[]`、时间戳。
- **转换**（`upsert_state`）：
  - 无开放任务 → 必须 `task:create + requirement:create`（title 缺省取 goalText；`rHat` 取 expectedResult）；create 后再调 create → 拒绝。
  - 有开放任务 → 只允许对**当前** task/requirement 做 update/close；`taskId/requirementId` 与当前不符 → `kstar_control_invalid_input`。
  - close → `closing/waiting_review` + `requirementJustClosed` + `taskComplete:true`（幂等）。
  - 每次状态变更同步 `updatedAt`；关闭另有 `closedAt`。
- **生命周期快照**（`lifecycle-adapter.ts`）：`none → draft → preload_preview → authorized → executing → awaiting_user_satisfaction → closed|cancelled`，由记录派生（只读），供 UI 与执行守卫共用。

### 目前的问题

| # | 问题 | 级别 | 说明 |
|---|---|---|---|
| 2-1 | goalText 无"用户原话"保留字段 | P2 | goalText 是模型在工具里提交的文本；用户原始表述只在消息 jsonl 与 `userMessageIds` 可溯。审计口径建议补 `rawUserText` 或依赖消息引用。 |
| 2-2 | 验收标准仍可能为空 | P2 | `rHat.acceptanceSignals` 依赖模型在 expectedResult 中提供；模型不给则无验收标准（宿主无兜底提取）。旧版恒空问题缓解但未根治。 |
| 2-3 | 遗留字段未清理 | P2 | `pendingTaskStart`、`lastRoutedUserMessageId` 仍在校验与 schema 中（兼容保留），新代码不写；Task 7 未清理这些死字段。 |
| 2-4 | 无消息级幂等键 | P2 | 新架构下创建由模型工具调用触发，重放风险已大幅降低；但 `(conversationId, messageId)` 级去重仍不存在（渲染层串行化兜底）。 |

---

## 阶段 3：Recall Projection（创建 / 冻结 / 确认）

### 详细陈述

- **创建**：仅经 `kstar_control.request_projection`（`control-service.requestProjection`：需开放 task+requirement；`purpose(120)`、`taskText(4000)`；`workspaceId = context.workspaceId || task.workspaceId`；`authorization:'user_confirmed'`）→ `previewContextProjection`（`features/recall/context-projection.ts`）落盘 `proj-<id>` → `requirement.projectionId=id`、`projectionIds` 追加 → `postProjectionCard`（宿主投递可见卡片，`recall_projection_card` 消息）。
- **资产选择**（`buildRecallView`）：仅 `active` 资产（paused/revoked 排除并记 `omittedRefs`）；workspace 引用（`workspace-refs`）强制存在+enabled+scope 命中；语义排序（embed 失败 → `recency_fallback` 显式标记）；**无相关度阈值**；快照 `assetIds + assetVersions`；`sourceRefs` 由资产 evidenceRefs 去重汇集；**空投影合法**（"No preload candidates selected."）。
- **确认**（`confirmContextProjection`）：仅 `preview` 可确认；过期拦截；**`validateProjectionAssetVersions` 版本漂移 → 抛 `context projection asset version changed; refresh projection`**；成功写 `confirmedAt/decidedAt`。
- **状态机**：`preview → confirmed|deferred|rejected|expired|revoked`；`revise` 仅 preview；deferred/rejected/expired 不可确认；确认后资产集合冻结（add/remove 被拒）。

### 目前的问题

| # | 问题 | 级别 | 说明 |
|---|---|---|---|
| 3-1 | 无相关度阈值（G7） | P2 | 语义匹配只排序不过滤；低相关资产仍进预览并经确认注入。 |
| 3-2 | 主流程 workspaceId 可能为空 → workspace 过滤空转 | P1→P2 | `request_projection` 的 workspaceId 来自对话项目或 task.workspaceId；无项目会话中为空 → `isAssetEligibleForProjection` 退回 scope 词元匹配，workspace 引用约束不生效。 |
| 3-3 | ~~`scopePolicy` 结构化作用域未被检索消费（G2）~~ **已修复（部分）** | `isAssetScopeAllowed`（`b3c6b8f0`）在投影资格（`buildRecallView`/`isAssetEligibleForProjection`）与注入侧执行：purposeTags/workspaceIds/projectIds/conversationKinds 生效；agentIds/roleIds/fileKinds 仍无消费上下文（需执行期 Agent 维度）。 |
| 3-4 | 主流程不设 expiresAt | P2 | preview 永不自动过期，遗留投影永久滞留（仅显式 IPC 预览可带 expiresAt）。 |
| 3-5 | `revoked` 投影状态无生产者（G8） | P2 | 类型/卡片存在 revoke 分支，但无 revoke 操作与 IPC → 死状态。 |
| 3-6 | ~~注入读实时资产而非确认快照（G3）~~ **已修复** | `prompt-injection` 优先读取 `projection.assetVersions` 对应的不可变版本快照（`readAbilityAssetVersionSnapshot`，`5cde55cc`）；快照缺失时仅当实时版本仍等于确认版本才回退，漂移则跳过不注入。 |

---

## 阶段 4：审批恢复 —— 同一 Commander 会话 + 遗留 pending 恢复

### 详细陈述

- **入口**：IPC `recall.projections.confirm|reject|retryForecast` → `features/kstar/projection-decision-service.ts`：
  - `confirmProjectionAndResumeCommander`：`confirmContextProjection`（already-confirmed → 读回，幂等）→ `loadCommittedProjectionKnowledge` 构建 `confirmedSnapshot{assetIds, ruleRefs}` → `resumeOnce`：检查 `projectionDecisions` 标记（`${projectionId}:${decision}`，进程内 in-flight 锁）→ `enqueueCommanderControlMessage`（`bus.ts`：`fromActorId:USER_ID, forceTo:[COMMANDER_ID], dispatch:true`，`model_text` 为 `<kstar-control>` + JSON + "Continue in this same Commander session..."，`displayText=projection.purpose`）→ 持久化标记 `resumed:true` → 返回 `{projection, resumed}`。
  - `rejectProjectionAndResumeCommander`：`rejectContextProjection(note)` → 同上续接 `decision:'rejected'`（**不产生 Forecast**）。
  - `retryProjectionInCommander`：投影必须已 confirmed，重新续接 approved。
- **遗留 pending 恢复**（`recoverLegacyPendingProjectionDispatch`，在 `group_chat/index.ts::runtimeStatus` 状态边界 best-effort 触发）：
  - `waiting_confirmation` → 原样保留（卡片继续）；
  - `forecasting` / `world_model_failed` → 以原文本 + 已确认投影续接（legacy 携带 `originalText`）；
  - `ready_to_dispatch` → 携带 legacy `forecastId` 续接并 `clearPendingProjectionDispatch`；
  - 未知状态 → `none` + 有界 warn（`kstar_legacy_pending_status_unhandled`）；
  - 幂等：标记 + in-flight 锁；**绝不启动独立 World Model runner**。
- **同一会话保证**：续接走 `gconv-<cid>` 主 Commander 会话（`forceTo:[COMMANDER_ID]`），无 `kstar-forecast-*` 等独立 session；单元测试断言控制消息形状（decision/confirmedSnapshot/legacy）。

### 目前的问题

| # | 问题 | 级别 | 说明 |
|---|---|---|---|
| 4-1 | 控制消息以 purpose 为用户可见文本 | P2 | `enqueueCommanderControlMessage` 的 `text=displayText`（confirm 时为 projection.purpose）会作为一条用户消息写入会话历史；用户会看到一条自己"没发过"的文本。旧实现同样存在（原文本），但 confirm 路径建议用中性文案或标记不可见。 |
| 4-2 | enqueue 成功但标记写失败的小窗口 | P2 | `resumeOnce` 先 enqueue 后写标记；若标记写失败，重试会二次续接（进程内锁只在并发时有效）。 |
| 4-3 | 恢复仅在 runtimeStatus 边界触发 | P2 | 若用户从不读取该会话状态（无轮询），遗留 pending 不会被自动恢复；依赖会话打开/轮询触发。 |

---

## 阶段 5：Forecast —— 宿主校验 / 重算 / 选优

### 详细陈述

- **入口**：`kstar_control.commit_forecast` → `features/kstar/forecast-commit.ts::commitCommanderForecast`：
  1. 输入校验（safeId、taskText 非空、allowedToolNames 可迭代）；
  2. 读取 Task/Requirement 并**三向一致校验**（`requirement.taskId===task.id`、`requirement.projectionId===input.projectionId`、`task.currentRequirementId===requirement.id`、双 open）→ 失败 `kstar_invalid_candidate`；
  3. `loadCommittedProjectionKnowledge`（`projection_not_committed/expired` → `kstar_projection_not_confirmed`）→ 冻结 K（abilityAssets 内容、assetVersions、rules）；
  4. workspace 一致性 + 工作区可用性探测 → `collectWorldSnapshot`；
  5. `simulationInput = {k: 冻结资产/规则, s: 环境+lifecycle+recall 摘要, t: userGoal(4000)+constraints(20×1000)+acceptanceCriteria}`（**含内容快照，随记录落盘**）；
  6. `applyCausalRules` 确定性风险命中 → 候选校验（`world-model-scoring.ts`）：2–4 个；`plan/expectedActors/acceptanceSignals` 非空；**`expectedTools` 允许 `[]`**（缺字段/非数组/越界/白名单外工具仍拒绝 `unavailable_tool:<name>`）；`ruleRefs` 必须属于冻结规则集（`invalid_rule_ref`）；score 五维 0–1；
  7. **Total 宿主重算**：`0.35·goalFit + 0.25·feasibility + 0.20·observability + 0.20·causalSupport − 0.25·riskPenalty`，clamp [0,1]，模型自报 total 不信任；
  8. `selectWorldModelCandidate`：总分 → 低风险 → 高可观测 → **模型顺序稳定破平**；
  9. `buildWorldModelForecastRecord`（`wf-<id>`，`provenanceComplete`）→ `saveWorldModelForecast` → 回写 `requirement.forecastId`；失败 → `kstar_persistence_failed` 且不回写。
- **无独立 runner**：`world-model-bridge.ts`、`pre-execution-service.ts` 已删除；静态测试断言 kstar/recall 生产代码无 `buildRunner/chatWithModel/streamChatWithModel`（`review-inference.ts` 豁免，仅执行后复盘用）。

### 目前的问题

| # | 问题 | 级别 | 说明 |
|---|---|---|---|
| 5-1 | 非法候选**整体拒绝**（非逐条） | P2 | 一个坏候选丢弃整批 2–4 个候选，模型需整批重试（capture 侧同理）。 |
| 5-2 | 注入侧与 Forecast 快照不一致（G3 延续） | P1 | Forecast 记录里的 K 是冻结的，但后续 Prompt 注入读的是**实时资产**而非该快照（见阶段 10）。 |
| 5-3 | 未 forecast 先 dispatch 依赖模型修正 | P2 | 已确认投影但无 forecastId 时守卫拒绝；模型收到 `kstar_projection_not_confirmed` 后需自行补 `commit_forecast` 再派发——无宿主自动编排。 |

---

## 阶段 6：特权派发门禁 + 终态 provenance 盖章

### 详细陈述

- **守卫**（`bus.ts::guardKstarPrivilegedDispatch`，插入 `dispatch_to` / `hand_off_to` / `run_worker`(具名) / `run_worker`(匿名) 四处，位于依赖检查之后、wake gate 之前）：
  - `readKstarTaskLifecycle`：无 `requirement.projectionId` → 放行（非 KStar 流程零影响）；
  - 投影非 confirmed → 工具返回 `{ok:false, error_code:'kstar_projection_not_confirmed', error:'KStar Projection is not confirmed.'}`（`isError:true`，Commander 正常收尾回复用户）；
  - 无 `forecastId` → 同码拒绝（'KStar Forecast is not committed.'）；
  - 通过 → 将 `{logicalRunId: task.id, projectionId, forecastId}` **盖章到 `state.taskRun`** → 终态事件（`_emitTaskRunTerminalIfQuiescent`）携带 `logical_run_id/projection_id/forecast_id`（另加 lifecycle 回填兜底：`forecast_id` 从 `requirement.forecastId` 补齐）。
- **行动记录**：`maybeRecordKStarToolCycle` → `recordToolCycleEvidence`（稳定证据 ID、工具名、参数形状不落值、结果预览≤1000、成败、耗时）；`produced` 文件存在性校验；失败/重试/降级（pending 证据队列 + boot 重放）；人工审批节点（wake/投影）持久化；provenance 全链（taskRun → terminal → episode → requirement）。
- **结果记录**：`completed|failed|cancelled|waiting_input`（宿主推导，模型自报不覆盖）；`failure_kind/code`；同名失败/有效文件内容寻址并存（`persistToolResult` sha256 文件名）。

### 目前的问题

| # | 问题 | 级别 | 说明 |
|---|---|---|---|
| 6-1 | **门禁只覆盖 Agent 派发工具，不覆盖 Commander 自执行** | P1（待产品定界） | 守卫只挂在 `dispatch_to/hand_off_to/run_worker`；Commander 直接调用 `exec_command` 等写操作**不经投影门禁**（工作区写由 path sandbox + permission mode 兜底）。需产品确认门禁范围后再设计 Commander 自执行门控。 |
| 6-2 | 终态 `execution_id` 缺省=runId | P2 | 无真实 execution 记录时用 runId 填充，可接受但语义需注明。 |

---

## 阶段 7：Closure（复盘闭环）

### 详细陈述

- **Episode**（`episode-builder.ts`，runtime/group 双构建器）：`r.status/finalText/producedFiles/failureKind/failureCode`、`a.agentActions`（actor 归因）、`k.memoryRefs/contextRefs/abilityAssetRefs`、`k_snapshot_ref`、evidenceRefs（conversation/execution/artifact/context）。
- **Review**（`review-inference.ts` / `review-service.ts`）：
  - 确定性路径：`completed + verification passed` → met（0.95）；`failed/cancelled` → worse_than_expected（0.95）；
  - provisional：有 finalText/producedFiles → provisional met（0.6，**强制 `needsConfirmation`**）；
  - `unknownInference`：无证据 → `unclear + confidence 0 + needs_confirmation`，**绝不自动等同达标**；
  - 模型路径：严格 JSON、归因白名单、prompt 禁止虚构 tests/files/feedback；非法输出降级 unknown。
- **PRM/AAR**（`requirement-closure.ts`）：权重 accuracy .3 / completeness .3 / usefulness .2 / clarity .2，宿主重算；**`prmFromFeedback` 优先**（用户反馈 > 完成证据推断 > 保守 unknown 0.5）。
- **Task 关闭与沉淀**（`task-closure.ts`）：terminal 监听 → `captureGroupKstarClosure`（episode 挂接、去重）→ `drainKstarTaskState`（PRM/AAR → learningSignal → 候选桥）。
- **幂等**：终态捕获 seen/inFlight；`confirmKstarReview` 幂等；候选提取按 episode 去重。

### 目前的问题

| # | 问题 | 级别 | 说明 |
|---|---|---|---|
| 7-1 | ~~复盘确认卡死路径（P1-1）~~ **已修复** | 已补 `kstar.review.confirm` / `kstar.review.read` IPC（`cc694504`），接线 `confirmKstarReview` 与 `readKstarReview`；渲染层确认/纠正按钮恢复可用。 |
| 7-2 | verification 生产不写入（G9） | P2 | `episode.r.verification` 仅类型与测试存在；确定性 met 路径空转，完成态默认 provisional+needsConfirmation。 |
| 7-3 | Action/Result Delta 概念缺失 | P2 | 有 expected（forecast.aHat：plan/expectedTools/expectedActors）与 actual（episode.a.toolCalls/agentActions），但**无对比计算**（missingTools/unexpectedTools/…）；归因 6 值无法表达工具选错/环境异常/需求变化/资产过期（对应审查 6.2/6.4）。 |
| 7-4 | 差异文本可能含绝对路径 | P2 | finalText/context 原文摘要/模型 reason 未做路径清洗（审查 6.3.6，本地单机风险受控）。 |

---

## 阶段 8：Recall 候选沉淀

### 详细陈述

- **来源**：
  - 复盘学习信号（`kstar/extraction-service.ts`）：`verifiedWorkflow`（completed + ≥2 工具全成功）→ `skill_method`；`rule_gap→rule`、`template_gap→template`、`knowledge_gap→personal`；`execution_gap` → 不产候选（单次环境错误不沉淀为规则）；候选 sourceRefs 必含 `{kind:'execution', id: episode.id}`。
  - 显式教学（`recall/teaching-service.ts`）：识别 `/偏好|更喜欢|我喜欢|prefer/`、avoid/correct、remember 等意图 → pending 候选；撤销信号级联 reject 关联候选。
  - 会话捕获（`recall/capture-service.ts`）：任务 terminal 触发；无工具模型按证据标签（消息 label 白名单）产出候选；`failed/cancelled` → `waiting_manual`；无合格消息 → 跳过；重复 terminal 投递复用同一 capture 任务。
- **字段**：`cand-<id>`（或 captureKey 确定性 ID）、`judgment`（≤4000 必填，promote 后成为资产 statement）、`summary?`、`suggestedType`（personal/rule/template/skill_method）、`suggestedScope`（≤500）、`sourceRefs`（必填，kind:id 白名单，去重）、`learningSignal{deltaR,deltaA,confidence}`（仅复盘路径）。
- **状态与幂等**：`pending → deferred | rejected | promoted`（rejected/promoted 终态）；fingerprint（judgment+排序 sourceRefs 键）+ captureKey 双幂等；promote 仅 `actor:'user'` 且恰好一次（并发测试覆盖）；`kstar/recall-bridge.ts` 只存 pending（"Promotion is intentionally not part of this bridge"）。

### 目前的问题

| # | 问题 | 级别 | 说明 |
|---|---|---|---|
| 8-1 | 候选字段缺口（对应审查 7.2） | P2 | 无顶层 confidence/sensitivity/写入者/来源项目/Projection ID/Rule Refs/归因字段；capture 路径无 learningSignal；Forecast ID 概念不存在（n/a 映射）。 |
| 8-2 | `prefer` 意图映射为 `rule` 而非 `personal` | P2 | `teaching-service.ts:143` `intent==='remember' ? 'personal' : 'rule'`，与 legacy `preference→personal` 不一致（审查 7.1.5）。 |
| 8-3 | 空摘要入口不一致 | P2 | 提取/教学入口拒绝空 summary；`saveRecallCandidate` 直接路径允许缺省静默落盘（审查 7.3.4）。 |
| 8-4 | promote 审计缺审核人/note；中途失败可能留孤儿资产 | P2 | `initializeAbilityAsset` 审计 'created' 无 actor/note；跨文件无事务（审查 8.1.2/8.1.6）。 |

---

## 阶段 9：正式资产治理

### 详细陈述

- **promote**（`candidate-service.ts`）：仅 `actor:'user'`；生成 `aa-<id>`；`statement=judgment`、`scope=suggestedScope`、`evidenceRefs` 继承；候选回写 `promotedAssetId`；已 promoted 再次 promote 返回同一资产（并发安全）；rejected 不可 promote。
- **版本**（`asset-service.ts`）：内容更新 `version` 单调 +1；历史版本 append-only JSONL（快照可独立读取）；maturity 变更/推荐不升版本。
- **作用域**：`asset.scope` 词元 + `workspace-refs`（每工作空间一条 `war-<assetId>-<workspaceId>`，scope 只可收窄不可扩张，删引用不删资产本体）；`scopePolicy` 结构化字段随资产存储。
- **生命周期**：`active → paused`（不进新投影、可恢复）`→ revoked`（终态、审计保留、不再注入、不可变更）；暂停/撤销/恢复仅用户显式操作（`actor:'user'`）；负反馈只产生 `recommendAbilityAssetAction('pause'|'rework', actor:'system')`，不自动变更。
- **使用与证明**：`proof-service` transfer proof（按资产+版本）→ usage 记账（`transfer succeeded` 时）→ 成熟度 `transfer_validated` → 正反馈 `effectiveness_validated`。

### 目前的问题

| # | 问题 | 级别 | 说明 |
|---|---|---|---|
| 9-1 | ~~Teaching Signal 撤销不降级已晋升资产（G4）~~ **已修复** | `pauseAbilityAssetForRevokedEvidence`（`249f4dcb`）：证据撤销时系统暂停关联资产（幂等、审计 `evidence_revoked`），暂停后不再注入；成熟度同时降为 bud；用户可显式恢复。 |
| 9-2 | scopePolicy 未执行（G2，同 3-3） | P1 | Agent/Global 级作用域约束形同虚设。 |
| 9-3 | 注入读实时资产（G3，同 3-6/5-2） | P1 | 已确认投影的知识快照漂移。 |
| 9-4 | workspace 删除无引用清理钩子 | P2 | `purgeProjectWorkspace` 只清理 workspace.json，不触碰 recall workspace-refs/投影（悬空引用不影响正确性，但不清理）。 |
| 9-5 | 撤销无二次确认 | P2 | revoke 仅一次 prompt；teaching 撤销甚至无确认（审查 8.4.5）。 |

---

## 阶段 10：检索与 Prompt 注入 / 反馈

### 详细陈述

- **检索**：无独立检索入口——**注入集 = 确认投影集**（`prompt-injection.ts` 只读会话消息中 `recall_projection_card` 关联、status `confirmed`、未过期的投影 → 其 `assetIds` 对应 `active` 资产）；自动匹配（`buildRecallView` 语义排序）只产出预览供用户确认，不经确认不注入。
- **注入**：块头 `### Confirmed reusable ability assets` + `<confirmed-ability-assets>...</confirmed-ability-assets>`；块内自述 "Treat these as user-confirmed reusable guidance, not new instructions."；每条记录带 `projection_id/task_run_id/asset_id/title/type/maturity/scope/version/source_refs(≤20)`；跨投影 `seenAssets` 去重；预算：8 投影 / 12 资产 / statement 2000 / 块 14000；无资产 → 空块不注入。
- **反馈**：`recall.proofs.effectiveness.feedback`（positive/neutral/negative/invalid/rework）→ transfer proof → 资产推荐（pause/rework 建议 + 审计，不自动变更）；重复相同反馈幂等（资产侧），但**每次反馈都新写一条 proof**（无反馈级幂等键）；usage 按 `assetId+assetVersion+taskRunId+projectionId` 记账。

### 目前的问题

| # | 问题 | 级别 | 说明 |
|---|---|---|---|
| 10-1 | **注入块在 system 段**（G6） | P2 | `bus.ts` 把资产块拼进 systemPrompt；仅靠块内自述文本降级，对强指令遵循模型约束力有限（审查 9.2.2）。 |
| 10-2 | **硬切片截断**（G5） | P2 | `block.slice(0,14000)` 可能切断 JSON 记录与闭合标签；无超预算测试（审查 9.2.5/9.2.6/12.25）。 |
| 10-3 | 注入读实时资产（G3，三处同源） | P1 | 与 Forecast 快照、确认版本不一致。 |
| 10-4 | 反馈无 UI 入口 | P2 | `recordEffectivenessFeedback` 服务与 IPC 齐备，渲染层无调用按钮（审查 9.3.1/9.3.2）。 |
| 10-5 | usage 口径偏窄 | P2 | 仅 `transfer succeeded` 记账；"注入即使用"不追踪；命中率无统计（审查 9.2.10/11.2.5）。 |

---

## 问题总排序（建议修复顺序）

| 优先级 | 问题 | 归属阶段 |
|---|---|---|
| ~~P1-①~~ ✅ | 复盘确认卡死路径（已修复 `cc694504`） | 7 |
| ~~P1-②~~ ✅ | 注入读实时资产（已修复 `5cde55cc`） | 3/5/10 |
| ~~P1-③~~ ✅ | scopePolicy 未消费（已修复 `b3c6b8f0`，agentIds 维度待执行期上下文） | 3/9 |
| ~~P1-④~~ ✅ | Teaching 撤销不降级已晋升资产（已修复 `249f4dcb`） | 9 |
| ~~P1-⑤~~ ✅ | finish/abandon 证据字段未被消费（已修复 `29295291`） | 1/7 |
| ~~P1-⑥~~ ✅ | 门禁不覆盖 Commander 自执行（已定夺：**维持现状**——sandbox+权限模式兜底，Commander 自执行非当前主路径，宿主无法可靠区分自执行与普通对话，强拦会误伤） | 6 |
| P2 | 寒暄零写入的宿主级确定性兜底 | 0 |
| P2 | 整体拒绝非逐条、无相关度阈值、system 段注入、硬切片、反馈无 UI、字段缺口、映射偏差、遗留死字段等（详见各阶段表） | 各 |
