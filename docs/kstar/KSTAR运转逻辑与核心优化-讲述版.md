# CogSeed KSTAR：运转逻辑、代码实现与下一步优化（以 KSTAR 为核心）

- 版本：讲述版（以一条用户消息端到端走完 KSTAR 闭环为主线）
- 代码基线：`/Users/sudai/Documents/CogSeed` develop（`npm run typecheck` 通过）
- 日期：2026-08-27
- 原则：以代码实现为准；KSTAR 是群聊 / Runtime / P3394 外接所有执行通道的唯一事实、复盘与沉淀入口

---

## 一、当前 KSTAR 运转逻辑（端到端）

### 1. 入口：宿主路由（不再是模型控制）

`src/main/features/group_chat/bus.ts` 在 Commander 回合前调用 `hostRouteTaskTurn(uid, cid, messageText, ...)`，按优先级做四件事：

1. **关闭意图**（"完成/搞定/结束/done"等，`kstar/task-intent.ts` 的 `isClosingIntent`）→ 直接走 `finish` 控制路径，绝不把它当新任务。
2. **明显琐碎**（问候/状态/纯 emoji，`isObviouslyTrivial`）→ 零模型调用、零 KStar 写入，直接跳过。
3. **模型路由判定**（`judgeModelRouting`，专用 runner、20 秒超时）→ 返回 `<kstar-judge>{"is_task","continuation"}</kstar-judge>`：
   - 是任务且无旧任务 → 继续第 4 步；
   - 是**新**任务但旧任务还开着（continuation=false）→ 先自动 `finish` 旧任务（closeReason=`user moved to a new task`），再开新任务；
   - 是旧任务的延续（continuation=true）→ 保持现有任务。
4. **宿主开任务**：`executeKstarControl(upsert_state)` 建 Task + Requirement → 紧接 `executeKstarControl(request_projection)`（`workspace_policy` 授权，**创建即自动确认**，无用户确认卡）→ **异步** `autoForecastForRequirement` 生成世界模型预测（10-30 秒，不阻塞回复）。

关键点：Commander 的**工具面里已经没有 `kstar_control`** 了（`bus.ts` 约 9056 行注释明确说明）。之前让模型自己发嵌套 JSON 生命周期参数，线上反复失败（字符串化 forecast、候选拍平、猜错 host id），所以改成宿主确定性路由。这是与两份 PDF 最大的差异。

另外两条入口：

- **dispatch 即任务**（`ensureKstarTaskForDispatch`）：Commander 派发具名 agent（`dispatch_to`/`hand_off_to`/`run_worker`）且无 open task 时，宿主自动开任务 + 自动确认投影 + 异步 forecast。
- **特权派发门禁**（`guardKstarPrivilegedDispatch`）：派发前 Projection 未确认 → 直接拦截（`kstar_projection_not_confirmed`）；Forecast 是**建议性**门禁（生成失败也放行，执行不被预测质量绑架），成功后把 provenance（logicalRunId/projectionId/forecastId）盖到 taskRun 上，终态事件携带。

### 2. 执行：群聊 / Runtime / P3394 外接

- 群聊：Commander 正常执行工具调用，事件流（`tool`/`cli` 两类）被记录下来。
- Runtime：`cogseed_runtime` 的独立执行，终态事件 `result/error/cancelled`。
- P3394 外接：`p3394_bridge/kstar-episodes.ts` 落外接 Episode（落盘前统一 `redact()` 脱敏），`proposed_updates` 只作为证据注入，绝不自动写回认知资产。

### 3. 终态 → 统一 Closure

任务进入终态（completed/failed/cancelled）后，`startGroupKstarClosure`（`kstar/task-closure.ts`）通过 `subscribeTaskTerminals` 订阅终态事件：

1. `completed/cancelled` 立即 `scheduleAutoClose`（静默窗口 **30 分钟** `AUTO_CLOSE_QUIET_MS`）；
2. `captureGroupKstarClosure`：解析五源证据（用户教学信号 + 执行评估 + 授权外接系统）→ `buildGroupKstarEpisode` 构建 K/S/T/A/R Episode → 空间归属补齐（会话 `space_id` → `s.workspaceId`）→ 读 Forecast → `serializeClosure(closureLocks, userId:episodeId)` 串行化 → `finishClosure`；
3. `finishClosure`：写 Episode → 读/建 Review → `reconcileKstarExtraction`（以 `ksx-<episodeId>` 为幂等键建 extraction-run，**单次运行不沉淀**，沉淀统一收敛到 requirement 级，避免 lesson 碎片化）；
4. `attachKstarEpisodeToCurrentRequirement`：把 episode 挂到当前 Requirement（按 projectionId/wakeRequestId provenance 匹配）；
5. `drainKstarTaskState`：关闭 Requirement（生成 PRM 评分 + AAR），若 taskComplete 则关闭 Task。

静默窗口：窗口内用户来新消息 → `cancelAutoClose` 清除；窗口到期 → `runAutoClose` 走 `executeKstarControl(finish)`（幂等键 `auto-close-<cid>-<req>`）；重启后 `startAutoCloseRecovery` 扫描 `task-states/`，未过期按剩余时间重建定时器、已过期直接跑。

### 4. Review：确定性度量 + 模型归因 + 语言硬闸

`kstar/review-inference.ts` + `recall/world-model-reconciliation.ts`：

- **确定性度量**：`reconcileWorldModel(forecast, episode)` 计算 ΔA（missing/unexpected 工具、actor、计划步骤、顺序错位、失败动作——**只罚偏差不罚创新**）和 ΔR（验收信号 met/not_met、缺/多产出文件、终态）。
- **模型归因 + lesson**：把度量结果 + 对话历史尾巴喂模型，产出 outcome/attribution/reason/confidence/lesson；**度量值始终以确定性结果为准**，模型只做归因和教训提炼。
- **语言硬闸**：`lessonLanguageMismatches` —— 中文任务产出英文 lesson 直接丢弃并 `log.warn`（实机观测过两次）。
- **降级链**：模型失败 → 确定性模板；无模型配置 → 诚实返回 `unknown`（不伪造 met_expected）；requirement 关闭路径允许 provisional（`needs_confirmation`，置信度 0.6）。
- **用户确认**：渲染层 Review 卡（`kstar.review.confirm`，verdict `met/partial/not_met/skip`）→ `confirmKstarReview` 把 review 状态从 inferred 升级为 confirmed。

### 5. 经验沉淀：统一候选池，不污染正式记忆

- **门槛**（`extraction-service.ts` 的 `clearsPrecipitationGate`）：|ΔR| ≥ 0.15，或 better/worse 结果，或高置信度具名 gap，或成功任务上的过程经验 lesson（confidence ≥ 0.7 + reason）。"met_expected 且无 lesson"不沉淀。
- **Requirement 级聚合**（`task-level-precipitation.ts`）：finish / abandon / topic-switch 时，把该 requirement 所有 episode 的工具链合并、取最强 review 信号，每个信号沉淀**一条**资产；再叠加 personal 候选（跨类型语义查重 + 主题兜底，防"关于我"与 rule/template 重复）。
- **统一出口**（`direct-experience-assets.ts`）：`saveRecallCandidate`（指纹去重）→ `autoApplyRecallCandidate`（语义查重 + 质量融合，`provenance:'kstar'` → 资产落成 `system_precipitated_unverified`）→ 挂空间引用。任务级 `drainKstarTaskState` 已**不再产候选**（避免与 requirement 级对同一 review 各产一条、指纹不同去重拦不住）。
- Recall 侧候选状态机已很完整：`observed → weak_observation → pending_review → deferred → confirmed → rejected/ignored/expired/failed/superseded`。

### 6. 存储与安全

- 布局：`<userCloudRoot>/<userId>/kstar/{episodes,reviews,extraction-runs,tasks,requirements,task-states}/*.json`（`paths.ts`）。
- 所有记录带 `schemaVersion=1 / ownerId / id / createdAt / updatedAt`；`safeId` 校验路径段；`fileEditLock` 写锁；写冲突检测；读时逐字段校验，损坏记录单条跳过。
- 幂等：`controlReceipts`（上限 100）+ `inputHash` 重放；`closureLocks/confirmationLocks` 防止重复 Review/候选。
- IPC 白名单：`recall.projections.confirm/retryForecast/reject`、`kstar.review.confirm/read`；模型/渲染器提供的 ID 只当建议，宿主从当前状态解析真实 ID。

### 7. 启动集成

`src/main/index.ts`：`startRecallCaptureOrchestrator()` + `startGroupKstarClosure()` + `startAutoCloseRecovery()`，全部注册 `before-quit` 停止。闭环不依赖 Renderer 存活，由 Main Process 生命周期服务持续负责。

---

## 二、代码层面实现地图（要改哪里看哪里）

| 关注点 | 文件 |
|---|---|
| 数据模型/枚举 | `src/main/features/kstar/types.ts`、`requirement-types.ts` |
| 控制服务（幂等/自愈/topic-switch/finish/abandon） | `src/main/features/kstar/control-service.ts`、`control-types.ts` |
| 宿主路由 / 路由判定 / 派发门禁 | `src/main/features/group_chat/bus.ts`（`hostRouteTaskTurn`/`judgeModelRouting`/`ensureKstarTaskForDispatch`/`guardKstarPrivilegedDispatch`）、`kstar/task-intent.ts` |
| Projection | `src/main/features/recall/context-projection.ts`、`kstar/projection-decision-service.ts` |
| Forecast | `kstar/forecast-commit.ts`、`kstar/auto-forecast.ts`、`recall/world-model*.ts` |
| Closure / 静默窗口 / 恢复 | `kstar/task-closure.ts` |
| Episode 构建 | `kstar/episode-builder.ts`、`episode-store.ts` |
| Review | `kstar/review-inference.ts`、`recall/world-model-reconciliation.ts`、`kstar/review-service.ts`、`review-card.ts` |
| 沉淀 | `kstar/extraction-service.ts`、`task-level-precipitation.ts`、`personal-asset-precipitation.ts`、`direct-experience-assets.ts`、`recall-bridge.ts` |
| 存储/安全 | `kstar/paths.ts`、`episode-store.ts`、`requirement-store.ts` |
| IPC | `src/main/ipc/index.ts`（2431-2453 附近） |
| 启动 | `src/main/index.ts`（1156-1158） |
| 测试 | `test/main/features/kstar/`（20 个文件）、`test/main/ipc/recall.test.ts`、`test/main/features/group_chat/kstar-commander-centric.test.ts` 等 |

---

## 三、以 KSTAR 为核心的下一步优化

核心思路：**KSTAR 是所有执行通道（群聊、Runtime、P3394 外接）的唯一事实/复盘/沉淀入口。优化目标是把"能跑的闭环"升级成"发布级稳定 → 可量化 → 可运营"**，分三波推进，不换技术栈、不重复建设已做掉的东西（语言硬闸、语义查重、候选生命周期、Requirement 聚合、空间归属、幂等/恢复都已完成）。

### 第一波（P0，发布门禁，对应真实代码缺口）

| 项 | 缺口证据 | 改动 |
|---|---|---|
| **O1 显式状态机 + 非法转换守卫** | 状态转换隐式写在 `control-service.ts` 分支里，无转换表 | 新增 `kstar/state-machine.ts`：Task/Requirement/Episode/Review 各定义合法转换；落状态前统一 `assertTransition`；转换审计挂到 `controlReceipts`（来源 + idempotencyKey） |
| **O2 超时语义 `timed_out`** | `KstarTaskStatus`/`RuntimeStatus` 都没有 timed_out，超时被归为 failed | 枚举加 `timed_out`；`episode-builder.ts` 识别超时元数据；`review-inference.ts` 加 timed_out 分支（不进强沉淀） |
| **O3 KSTAR 安全边界专项测试** | 有 safeId/ownerId 校验，但缺跨用户读、`../` 注入、重复事件的恶意形状测试 | 新增 `kstar-security-boundary.test.ts` |
| **O4 真实 Electron Smoke** | `smoke.ts` 无 KSTAR 场景 | 新增 smoke：开任务→投影确认→forecast→执行→Episode→Review→extraction-run；再加取消/超时/重复事件/重启恢复 4 条异常路径 |

### 第二波（P1，量化与学习质量，让闭环"可衡量"）

| 项 | 缺口证据 | 改动 |
|---|---|---|
| **O5 Forecast 可量化字段** | `WorldModelForecast` 无 forecastConfidence/riskLevel/contextFreshness/forecastCreatedAt（assumptions/predictedRisks/candidates 已有） | `world-model-types.ts` 加 4 字段；`forecast-commit.ts` 由打分与风险派生；旧记录兼容 |
| **O6 Episode 执行维度落盘** | `startedAtMs/finishedAtMs` 只用于消息窗口过滤，不进记录 | Episode.r 加 `durationMs/toolCallCount/failedToolCount/networkAccess`；`world-model-reconciliation` 消费执行时长 |
| **O7 跨任务验证计数 + 自动失效** | 全库无 validationCount/多次验证逻辑 | 候选/资产加 `validationCount/lastValidatedAt/consecutiveFailures`；第二次相似候选提升 maturity；连续失败置 paused/deprecated |
| **O8 事实/推断/经验显式分层** | 隐含分层，无字段标记 | Review 加 `evidenceLayer: fact/inference/experience`；只把 experience 层过门槛的送候选池 |
| **O9 取消路径统一 abandon** | `bus.ts` 无 `operation:'abandon'` 调用，取消走 cancelled episode + 正常 closure | 用户中止时走 abandon 控制 op，task/requirement 落 `abandoned`，Episode 仍保留 cancelled 证据 |
| **O10 Repository 抽象**（可选） | 各 store 各自校验 | 轻量 `kstar/repository.ts` 统一 read/write/replace/list + 校验/锁；不引入数据库 |

### 第三波（P2/P3，体验与运营化）

- **O11 风险分级确认**（P1/P2）：现在全部 workspace_policy 自动确认，高风险操作（删除/网络/改配置/写长期记忆）无显式确认。按 riskLevel + 工具集合 + 写入范围分三档：低风险自动、中风险展示一次计划、高风险强制确认。**判定必须在 Main 宿主侧**（AGENTS.md：Renderer 无权限层），Renderer 只做展示，可复用现有 `kstar_review_card` 渲染模式。
- **O12 DeepSeek Harness 意图驱动配置单**：属 Creator feature，产出"职责/可读路径/工具/写入范围/网络策略/秘密文件策略/外接策略/输出语言/验收标准"配置单，用户确认后交 Creator 落盘；KSTAR 只记录关联 id、不存机密。
- **O13 运营化**：闭环指标（任务数、完成率、ΔR 分布、沉淀率、取消/超时率，用 `createLogger`，遵守 telemetry 红线）；Forecast 版本化（复用 `assetVersions` + `formal-assets/version-diff.ts`）；供应链变化感知（在 causalRule 登记依赖/项目结构触发词，失败触发 pause）。

### 为什么"以 KSTAR 为核心"不只是补功能

- **单一事实源**：所有执行的证据（K/S/T/A/R Episode）只从 KSTAR 这一条链路落盘，Review 只信 Episode + Forecast，不信任模型自述。
- **单一沉淀闸门**：任何经验（群聊、Runtime、外接 Agent、用户教学信号）都汇入统一候选池，过确定性门槛 + 语言硬闸 + 语义查重后才能成为正式资产，防止一次性判断污染长期记忆。
- **单一治理入口**：状态机、幂等、并发锁、重启恢复都在 KSTAR 层做，群聊/Runtime/P3394 都只是"执行通道 + 证据提供方"。

---

## 四、结论

KSTAR 当前已从"模型驱动的实验性闭环"演进为"宿主驱动的治理闭环"：宿主开任务、自动确认投影、宿主异步生成预测，Commander 只负责执行；终态统一进 Closure，Review 用确定性度量 + 模型归因 + 语言硬闸，经验走统一候选池 + 语义查重后沉淀。

下一步以 KSTAR 为核心，按"先稳定和安全（O1-O4 发布门禁）→ 再量化和学习质量（O5-O10）→ 后体验与运营化（O11-O13）"推进，最终让 KSTAR 成为可发布、可恢复、可审计、可量化、可持续学习的核心认知治理层。
