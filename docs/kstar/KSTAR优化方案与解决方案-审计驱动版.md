# CogSeed KSTAR：优化方案与解决方案（审计驱动版）

- 依据：两份 2026-08-26 审计（《KSTAR-Dashboard-消费审计与上游阻塞》《KSTAR-能力真实性审计》）+ 当前 develop 代码验真（`npm run typecheck` 通过）
- 日期：2026-08-27
- 目标：把 KSTAR 从「内部状态完整但不可观测、学习闭环不可验证」升级为「可发布、可观测、可审计、自进化可证明」
- 总原则：不换技术栈；不重复建设（语言硬闸、语义查重、候选生命周期、Requirement 聚合、幂等/恢复已完成）；一切"对外可见"的语义（状态名、degraded 表达、失败 vs 未发生）由 KSTAR 方定义，Dashboard 只遵守

---

## 0. 问题域总览（审计发现 → 归并）

| 问题域 | 审计证据 | 影响 |
|---|---|---|
| **A 观测与契约缺失** | 11 阶段 11 套词汇；lineage 只在 `bus.ts` 内存 `state.taskRun`；除 Review 外无 IPC | Dashboard 只能任务级可观测，做不到阶段级；Trace 从一张卡片找不到 KSTAR 任务（U1） |
| **B 自进化闭环真实性断裂 ⛔** | seed 资产在 KSTAR 注入路径被 `maturity_below_default_use` 挡掉；升档证据只能来自"被注入"本身 → 循环卡死 | 不能宣称"越用越好"；学习闭环不可证明 |
| **C 失败静默 / 不可审计 ⛔** | closure/review/precipitation 三层失败全 `log.warn`；`persistReceipt` 硬编码 `status:'ok'`；`precipitateRequirementLevel` 返回值被丢弃 | Dashboard 显示完成、学习链已静默失败，无法发现 |
| **D 状态语义混乱** | `KstarTaskStatus`（Episode 结果）与 `KstarTaskPhase`（Task 生命周期）、`CogSeedTaskStatus` 三义；无 `timed_out` | 任何外部消费者必然在某一处翻译错 |
| **E 数据真实性** | World Snapshot 只生成 ID 不落盘、tools/model 硬编码；ExtractionRun `candidateIds` 恒 `[]`；`learningProvenance` 生产不填 | 按字面消费会得到与事实相反的结论 |

---

## 1. 解决方案总览（三波，含依赖）

```
Wave 0  P0 正确性与发布门禁   S1-S6   （失败落盘 / 状态机 / 超时 / 失败收据 / 安全测试 / Smoke）
Wave 1  P1 契约与可观测       S7-S12  （ID bridge / trace façade / 统一语义 / routing 落盘 / forecast 状态 / executing 决策）
Wave 2  P2 学习闭环真实性     S13-S22 （seed 闭环 / provenance / 候选接入 / K/S/T 全量 / snapshot / 验证计数 / 分层）
Wave 3  P3 体验与运营         S23-S25 （风险分级 / 指标 / Harness）
```

**关键路径**：`S7（ID bridge）→ S8（trace façade）→ Dashboard 接入`；`S13（seed 注入闭环）是自进化能力的唯一卡点，应尽早决策`。S1–S6 全部独立，可立即并行开工。

---

## 2. Wave 0（P0）：正确性与发布门禁

### S1 · 失败落盘与沉淀结果写回 ⛔（审计 U3/U4；对应原 O1 强化）

**背景**：三层失败只 `log.warn`；`KstarExtractionRunRecord` 的 `status/candidateIds/error` 字段存在但生产从不写真值（`task-closure.ts` `reconcileKstarExtraction` 恒写 `{status:'created', candidateIds:[]}`）；`precipitateRequirementLevel` 返回值（`{proposals, createdAssetIds, candidateIds, mergedIntoIds, updateCandidateIds}`）在 `control-service.ts` 的 finish/abandon 被丢弃。

**方案**：
1. `reconcileKstarExtraction` 改为「结果可回填」：closure 完成后把 `proposeKstarCandidates` 或 requirement 级沉淀的真实结果写回 `ksx-<episodeId>`（`candidateIds` / `createdAssetIds` / `status: created|partial|failed` / `error`）。episode 级与 requirement 级两条沉淀路径统一回填到同一 extraction-run。
2. 新增 `KstarClosureFailureRecord`（或复用 `extraction-runs` + `error` 字段）三处失败各落一条持久化标记：`captureGroupKstarClosure` 失败（重试 1 次后）、`inferKstarReview` 失败、`precipitateRequirementLevel` 失败。标记内容：`stage/errorCode/errorMessage/at/episodeId`。
3. `persistReceipt` 修复：`executeKstarControl` 失败路径也写 receipt（`status:'rejected'|'failed'`），`KstarControlReceipt.status` 枚举本来就有这两个值，只是从不写入。

**涉及文件**：`kstar/task-closure.ts`、`kstar/control-service.ts`、`kstar/requirement-types.ts`（或新 `kstar/closure-failure-types.ts`）、`kstar/paths.ts`（新集合 `closure-failures/` 可选）
**验收**：构造 closure/review/precipitation 失败 → 对应持久化标记落盘；`ksx-*` 出现真实 candidateIds；重复终态事件不重复写标记；IPC 读通道（S8）能读出这些失败。

### S2 · 显式状态机 + 非法转换守卫 + 转换审计（原 O1）

**方案**：新增 `kstar/state-machine.ts`（纯函数）：Task（`open→closing→closed`、`open→abandoned`）、Requirement（`open→waiting_review→closed`、`open→abandoned`）、Review（`inferred→confirmed`、`needs_confirmation→confirmed`）、Episode 不允许回退。`control-service.ts` / `requirement-closure.ts` 落状态前统一 `assertTransition(from,to,ctx)`；每次转换记 `{at, source: host_routing|commander|auto_close|user_confirm|recovery, idempotencyKey}`（挂 `controlReceipts` 扩展字段）。
**验收**：closed→open、cancelled→completed、重复 finish 全部拒绝；`control-service.test.ts` 补非法转换用例。

### S3 · 超时语义 `timed_out`（原 O2）

**方案**：`KstarTaskStatus` 增加 `'timed_out'`（或明确映射 failed+failureKind，但推荐独立枚举）；`episode-builder.ts` `terminalRuntimeStatus` 识别 timeout 元数据；`review-inference.ts` 加 `timed_out` 确定性分支（`worse_than_expected + execution_gap + failureCode`，不进强沉淀）。
**验收**：带 timeout 元数据的事件流 → `r.status='timed_out'` → Review 正确、无强候选。

### S4 · 失败控制收据（审计补查 ①）

**方案**：见 S1.3。`persistReceipt` 签名放开 `KstarControlResult`（含 `{ok:false}`），`executeKstarControl` 的 catch 分支也写 receipt。审计价值：现在「projection failed / forecast 被拒」等 6 类状态完全不可区分。
**验收**：对 `kstar_control_invalid_input`、`kstar_projection_not_confirmed` 等失败调用，`task-states` 出现对应 `status:'rejected'` receipt。

### S5 · KSTAR 安全边界与重复事件测试（原 O3）

**方案**：新增 `test/main/features/kstar/kstar-security-boundary.test.ts`：跨用户读、`safeId` 注入（`../`/超长）、重复 `upsert_state/finish/abandon/review/confirm` 不产生重复记录、非法 verdict、forecast 候选引用未授权工具被拒、失败 receipt 幂等。
**验收**：全部用例通过；确认 Renderer 无直接读 KSTAR JSON 的通道。

### S6 · 真实 Electron Smoke（原 O4）

**方案**：`scripts/` 新增 KSTAR smoke：开任务→投影确认→forecast→执行→Episode→Review→extraction-run；异常路径：取消（cancelled）、超时（timed_out）、重复终态事件（幂等）、重启恢复（pendingAutoCloseAt 重建）、**沉淀失败落盘（S1 标记可见）**。
**验收**：真实 Electron 环境跑通并输出验证报告。

---

## 3. Wave 1（P1）：契约与可观测（对应审计①）

### S7 · CogSeed Task ↔ KSTAR ID bridge ⛔（审计 U1）

**背景**：`CogSeedTaskRecord`（`cogseed_backend/types.ts:54`）无 KSTAR 字段；唯一同时持有两边 ID 的 `state.taskRun`（`bus.ts:1263`，内存）是五元关联（runId/logicalRunId/projectionId/forecastId/executionId）。当前 develop 上 CogSeed 任务由 `cogseed_backend/task-store.ts:320` 创建（`cogseed-task-<genId12>`）。

**方案**：
1. `CogSeedTaskRecord` 增加 4 个可选字段：`kstarTaskId?` / `kstarRequirementId?` / `kstarProjectionId?` / `kstarForecastId?`（`cogseed_backend/types.ts` + `task-store.ts` `validateTask` 校验 safeId）。
2. 写入点（两处）：
   - **创建时**：CogSeed 任务 start 入口（`ipc-service.ts start` 或 collaboration dispatcher）解析当前会话 `readKstarTaskLifecycle`，有 open requirement 则带上 4 个 ID；
   - **运行中 provenance 盖戳处**：`guardKstarPrivilegedDispatch` / `state.taskRun` 更新时同步写回 task 记录（更新 `kstarProjectionId/kstarForecastId`）。
3. `schemaVersion` 递增 + 迁移兼容（旧记录缺字段不拒绝）。

**验收**：任一 CogSeed 任务卡片可经 `kstarTaskId` 找到 KSTAR Task；反向（`kst-*` → `cogseed-task-*`）经 `taskRunId`/`executionId` 可查；类型校验通过。

### S8 · KSTAR trace façade + 只读 IPC ⛔（审计 U2/U5）

**方案**：
1. 新增 `kstar/trace.ts`：`readKstarTrace(userId, {taskId | conversationId})` 纯拼装现有记录 → 返回统一节点数组（见 S9 形状）。
2. IPC 白名单加 `kstar.trace.read`（`src/main/ipc/index.ts` + `src/main/preload.js` + renderer shim 同步）；隐私白名单：只出 `stage/status/at/primaryId/parentId/source/summary/errorCode/degradedReason`，不出 `inputHash`、`argumentsSummary`、`evidenceRefs` 全量、`candidate.judgment` 正文、`forecast.input.k.abilityAssets[].statement`。
3. 节点形状由 KSTAR 定稿（一页字段约定），Dashboard DTO 随后落。

**验收**：`kstar.trace.read({conversationId})` 返回九层节点（Routing→Task→Requirement→Projection→Forecast→Runtime→Episode→Review/ExtractionRun→Precipitation）；空态/降级文案诚实（"未持久化/未发生/失败"可区分）。

### S9 · 统一 stage/status/errorCode/degradedReason 语义 + 命名修正（审计②§5.2、①§5）

**方案**：
1. 新增统一类型（`kstar/trace-types.ts`）：`TraceStage`（11 个）+ `TraceStatus`（`ok|pending|failed|degraded|skipped|not_started`）+ `degradedReason: string`。
2. **`KstarTaskStatus` 改名**：`EpisodeStatus`（`completed|failed|cancelled|waiting_input|timed_out`），全仓替换引用，杜绝三义。
3. 各阶段映射到统一枚举由 KSTAR 提供（`trace-status-map.ts`），Dashboard 禁止自译。
4. "失败 vs 未发生"显式化：结合 S1 失败标记 + S11 forecast 状态，让 `skipped/failed/not_started` 可区分。

**验收**：`grep -rn "KstarTaskStatus"` 只剩兼容别名（deprecated）；11 阶段到 TraceStatus 的映射表有测试。

### S10 · Routing 决策落盘（审计①§2.1）

**方案**：`task-states` 增加 `routingDecisions[]`（上限 100，环形）：`{at, kind: closing_intent|trivial|model_judged|dispatch_auto, isTask, continuation, reason, sourceMessageId}`；`hostRouteTaskTurn` / `judgeModelRouting` / `isClosingIntent` / `isObviouslyTrivial` 各出口写一条；trivial 分支也从零写入变成一条轻量记录。
**验收**：Dashboard 能回答"这条消息为什么没开任务"（闲聊/超时/延续）；`task-intent.test.ts` 补用例。

### S11 · Forecast 失败/跳过显式状态 + 查询维度（审计①§2.5、补查②）

**方案**：
1. requirement 增加 `forecastStatus?: 'pending'|'committed'|'failed'|'skipped'` + `forecastError?`；`autoForecastForRequirement` 每个出口（无候选/生成失败/超时/幂等跳过）写状态。`forecastId` 为空不再三义。
2. `listContextProjections` 增加 `taskRunId?` / `conversationId?` 过滤（`context-projection.ts`）。

**验收**：无 forecast 时能区分"异步未跑完/生成失败/无候选"；按 task 列出该任务全部投影。

### S12 · `executing` / wake 语义决策（审计①§9.2）

**背景**：`bindKstarRequirementWakeRequest` 生产无调用方 → `wakeRequestId` 恒空 → `executing` 永不可达。

**决策（二选一，建议 B）**：
- **方案 B（推荐）**：`lifecycle-adapter.ts` 把 `executing` 判据改为「requirement 有 forecastId 且存在未终态的执行」；删除/标注 `wake` 分支；首版 Runtime 格用 CogSeed 任务状态（已 durable 且更细）。
- 方案 A：接上 P3394 wake 审批链（跨模块、大改，不推荐为观测而改语义）。
**验收**：`KstarLifecycleStatus` 无永不可达公开值；Trace 的 Runtime 格用 CogSeed 状态。

---

## 4. Wave 2（P2）：学习闭环真实性（对应审计②）

### S13 · seed 资产注入闭环决策 ⛔（审计② EP-6，自进化唯一卡点）

**背景**：KSTAR 治理路径 `buildPromptContextForCommittedProjection` 传 `silentDefaultInjection=false` → seed 资产被 `maturity_below_default_use` 挡掉；静默自动投影路径（`context-projection.ts:648`）放行但不带 KSTAR 语义；升档需要"被真实注入"的 receipt，而 seed 进不去 → 循环卡死。

**方案（三选一，建议 B 或 C）**：
- **方案 A**：KSTAR committed 路径也允许 seed 注入，但像静默路径一样带 `lifecycle_status` 标注（prompt 块提示"系统自评、参考不盲从"）——改 `prompt-injection.ts` 对 KSTAR 路径传 `silentDefaultInjection:true` 或新增 `allowSeedInjection:true`。
- **方案 B（推荐）**：给 KSTAR 沉淀一条**独立升档证据**：用户对 Review 确认 `met`（`confirmKstarReview`）即生成 `ContextReuseReceipt`-like 的升档凭证（reuse 证据 = 用户确认，不依赖注入 receipt），`seed→bud` 可走；`bud→transfer_validated` 仍要求真实注入 receipt。
- 方案 C：KSTAR 沉淀直接落 `bud`（而不是 `seed`），`bud` 的 `usePolicy` 允许默认注入——改 `asset-semantics.ts` 的成熟度阶梯，需产品确认"未经多次验证的经验默认注入"是否可接受。

**验收**：新沉淀资产在**下一次 KSTAR 治理任务**中真实进入提示词（有测试断言 prompt block 含该 asset）；或用户确认后升档并有持久化凭证；端到端自进化测试（两次任务，第二次引用第一次的 lesson）。

### S14 · `learningProvenance` 生产构造（审计② WM/§10）

**方案**：`task-level-precipitation.ts` / `extraction-service.ts` 构造 `KstarCandidateProposal` 时填 `learningProvenance: {projectionId, forecastId, episodeId, ruleRefs, attribution, actionDelta?, resultDelta?}`（数据全在 requirement/episode/review 上，纯装配）。
**验收**：沉淀出的 candidate 带 provenance；`cand-* → wf-* → proj-* → kse-*` 可反查（审计①§4 的"完全断裂"变可查）。

### S15 · ExtractionRun 写真值 + `proposeKstarCandidates` 决策（审计①§2.9、②WM-11）

**方案**：
1. S1 已把真实 candidateIds/createdAssetIds 回填 `ksx-*`。
2. **`proposeKstarCandidates`（episode 级）决策**：当前生产从不调用（仅类型引用），是死代码。二选一：要么在 requirement 级沉淀路径里也调用它做"单 episode 快照候选"（与聚合结果并列，供 Trace 显示），要么删除并明确注释废弃。**推荐**：保留为 requirement 级聚合的输入之一（`aggregateRequirementProposals` 已复用其门槛函数），把导出函数收敛到实际使用面，避免"看似可用实则没接"的审计结论再现。
**验收**：`ksx-*` 内容与真实沉淀一致；`grep proposeKstarCandidates` 有真实调用点或明确废弃注释。

### S16 · Forecast 基于完整 K/S/T + causal rule 进候选生成（审计② FC-2/WM-5）

**背景**：生成候选的模型只收到 `taskGoal + projectedAbilityAssets + acceptanceSignals`（`auto-forecast.ts:164`）；rules/ontologyAssets/ontologyTaxonomy/matchedRules/situation 全部落盘但不进生成。

**方案**：
1. `auto-forecast.ts` 生成 payload 扩展：加入 `matchedRules`（已由 `evaluateRules` 算出）、`ontologyRules`（≤N 条）、`situation`（workspaceAvailable 等真实测量值）——注意 token 预算，按重要性截断。
2. 明确取舍：若产品确认"规则不进生成、只做风险标注"是设计意图，则在代码注释与文档中**显式声明**，消除"记录完整≠预测建立在其上"的歧义（审计要的是语义诚实，不一定是全接）。
**验收**：生成 payload 结构含规则/情境；或文档/注释显式声明边界。

### S17 · Forecast 约束 Runtime 的语义明确（审计② FC-3/WM-6）

**方案**：三选一（建议 ②）：
1. 严格执行：`guardKstarPrivilegedDispatch` 在 forecast 缺失时**拦截**（但 AGENTS.md 与现注释都反对执行被预测质量绑架）；
2. **推荐**：保持 advisory，但把「无 forecast 仍放行」从 `log.warn` 升级为**持久化标记**（S1/S11），让"预测缺失"可见可审计，而不是静默降级；
3. 把 forecast 内容真正注入 Commander 提示词（`aHat.plan/expectedTools/rHat`，目前只给 `{id, selectedCandidateId}`）——可作为 P3 产品增强，需评估 token 成本。
**验收**：无 forecast 的执行在 Trace 上明确显示"未预测"；或 Commander 能看到预测内容。

### S18 · World Snapshot 落盘 + 修硬编码（审计①§6、②WM-1/2/3/4）

**方案**：
1. `collectWorldSnapshot` 产物落盘 `world-model-snapshots/<snap-*>.json`（`recall` store），`saveWorldModelForecast` 引用完整快照（或至少把快照内嵌进 `input.s` 已有字段）。
2. 修三处硬编码：`model:{configured:true}` → `hasConfiguredModel()` 真实值；`tools:{fileSystem:true,bash:true}` → 真实能力探测；`skills.total` 语义错配 → 用真实技能数（或改名 `assets.total`）。
3. `provenanceComplete` 不再把「有 snapshotId」当完整（当前是假阳性）。
**验收**：snapshot 集合有记录；`forecast.input.s.environment` 与真实测量一致；Trace 的 Snapshot 格展示真实数据或诚实降级。

### S19 · T-Box / A-Box / R-Box 消费路径决策（审计② PO-1/2/3）

**方案**（语义诚实优先）：
1. **R-Box（关系规则）**：已真实参与风险标注与引用校验（`applyCausalRules`/`allowedRuleRefs`）——保持，并把"不进候选生成"显式声明（S16.2 联动）。
2. **T-Box（词汇）**：当前无消费者。决策：要么接入 S16 的生成 payload（低成本、价值待评估），要么显式标记为"为未来准备的记录"，不宣称"参与推理"。
3. **A-Box（普通事实）**：当前有意不读字段值。**对外澄清**：只说"Personal Ontology 的关系型值（A→B）会进 R-Box 被消费"；普通事实是记录，不宣称被调用。若要真正接入，需设计"事实 → 候选/提示词"的读取路径（新工作项，涉及隐私语义，需产品评审）。
**验收**：对外能力声明与代码一致；文档/代码注释写明边界。

### S20 · 跨任务验证计数 + 自动失效（原 O7）

**方案**：候选/资产加 `validationCount/lastValidatedAt/consecutiveFailures`；第二次相似候选命中提升 maturity；连续失败置 `paused/deprecated`。与 S13 联动（验证计数可作为 seed 升档的另一条证据）。
**验收**：两次相似任务成功后 maturity 提升；模拟环境变化连续失败触发降级。

### S21 · Episode 执行维度落盘 + Forecast 可量化字段（原 O6/O5）

**方案**：Episode.r 加 `durationMs/toolCallCount/failedToolCount/networkAccess`（`startedAtMs/finishedAtMs` 现在只用于消息窗口过滤）；`WorldModelForecast` 加 `forecastConfidence/riskLevel/contextFreshness/forecastCreatedAt`；`reconcileWorldModel` 消费执行时长做偏差量化。
**验收**：新记录带这些字段；Δ 描述可引用数字；旧记录兼容。

### S22 · 事实/推断/经验分层 + 取消统一 abandon（原 O8/O9）

**方案**：Review 加 `evidenceLayer: fact|inference|experience`；只把 experience 层过门槛的送候选池。`bus.ts` 用户中止路径调用 `executeKstarControl(abandon)`，task/requirement 落 `abandoned`，Episode 保留 cancelled 证据。
**验收**：分层字段有类型/单测；中止后状态机与审计一致。

---

## 5. Wave 3（P3）：体验与运营

### S23 · 风险分级确认（原 O11）
按 riskLevel + 工具集合 + 写入范围分三档：低自动 / 中展示计划 / 高强制确认；判定留在 Main 宿主侧，Renderer 只展示（复用 `kstar_review_card` 渲染）；新增 `kstar.approval.confirm` IPC（同步 preload 白名单与 contract 测试）。

### S24 · 运营化指标（原 O13）
`createLogger` 输出结构化闭环指标（任务数/完成率/ΔR 分布/沉淀率/取消率/超时率/静默失败数）；Forecast 版本化（复用 `assetVersions` + `formal-assets/version-diff.ts`）；供应链变化感知（causalRule 登记依赖/项目结构触发词，失败触发 pause）。

### S25 · DeepSeek Harness 配置单（原 O12，独立）
Creator 侧工作项：产出配置单（职责/可读路径/工具/写入范围/网络策略/秘密文件策略/外接策略/输出语言/验收标准），用户确认后落盘；KSTAR 只记录关联 id、不存机密。

---

## 6. 依赖关系与建议排期

```
立即并行：S1 S2 S3 S4 S5 S6（全部独立，P0）
第一批串行：S7（ID bridge）→ S8（trace façade）→ Dashboard DTO/UI
第二批：S9 S10 S11 S12（语义与状态，随 trace 定稿一起做）
第三批（学习闭环）：S13（决策）→ S14 S15 S16 S17 → S18 S19 S20 S21 S22
运营：S23 S24 S25
```

**关键决策点（需产品/KSTAR 负责人拍板）**：
1. S13：seed 注入走 A / B / C 哪条（自进化卡点，**最早做**）；
2. S17：Forecast 对执行的约束强度（advisory + 可见 vs 硬 gate）；
3. S19：A-Box 是否真正接入（涉及隐私语义）；
4. S12：executing 语义（建议 B）。

---

## 7. 不做清单（防范围蔓延）

- 不引入数据库/新运行时（维持 JSON + 现有锁）。
- 不把 `kstar_control` 重新暴露给 Commander（已证明失败的模式）。
- 不为观测而接 P3394 wake 进 group_chat（S12 方案 A 不推荐）。
- 不把 forecast 变成执行硬前置（S17 方案 1 不推荐）。
- 不在 Renderer 定义任何 KSTAR 业务语义（一律 KSTAR façade 出）。

---

## 8. 发布门禁验收总表

| 门禁 | 通过标准 |
|---|---|
| 正确性 | 三层失败有持久化标记；`ksx-*` 内容真实；非法状态转换全拒；失败 receipt 落盘 |
| 可观测 | `kstar.trace.read` 九层节点可读；routing/forecast 失败/缺失可区分；Snapshot 诚实降级 |
| 学习闭环 | 新沉淀资产能在下一次 KSTAR 任务进入提示词（或用户确认升档有凭证）；`learningProvenance` 可反查 |
| 安全 | 跨用户/路径穿越/重复事件/越权工具测试通过；Renderer 无直读 JSON 通道 |
| 验证 | typecheck + `npm test` + 真实 Electron Smoke 全绿 |
