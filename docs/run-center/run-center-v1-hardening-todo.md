# Run Center v1 Hardening — 执行 TODO

> Spec：`docs/run-center/run-center-v1-hardening-spec.md`
> 基线 commit：`0c0b7907`
> 分支：`feat/run-center-v1-hardening`
>
> **本清单严格按真实依赖排序。** 上一项未完成，下一项不得开工（除非标注「可并行」）。
> 每项字段：`depends` / `files` / `verify` / `spec`。

---

## DECISION（阻塞项，需团队拍板）

- [x] **DECISION-01** 卡片身份可辨识信息边界 ✅ **已拍板 2026-08-26 → 候选 B**
  - blocks: ~~`RC-P0-13`，进而阻塞 Phase 3 DoD~~ → **已解除阻塞**
  - **决议**：`run ordinal + 相对时间 + conversationId 前 8 位 + agentId + turn ordinal`
  - 理由：可辨识性够用；`agentId` 已过 `rendererSafeIdentifier()` 白名单、已在 `taskSummary()` 中透出、卡片 meta 行已渲染 → **零新增暴露面**；不动 `0c0b7907` 的隐私收敛
  - **候选 C 明确否决** —— Run Center 不承载用户可读内容（conversation title 常由用户首条消息生成）
  - 对 `RC-P0-13` 的硬约束：projection 不得新增 conversation title / prompt / objective / step result / 首条消息文本；ordinal 由服务端按同 session `createdAt` 升序稳定计算，**不得用数组下标**
  - spec: §5 DECISION-01

- [x] **DECISION-02** 每个 actor turn 是否继续独占一个 CogSeed Task ✅ **已拍板 2026-08-26 → 本轮不重构**
  - blocks: 无
  - **决议**：维持 run → parent task / turn → child task，记为架构债务 D-1
  - Phase 4 止血工作（`RC-P1-14` / `RC-P1-15`）**照常执行，不降级、不冻结**
  - 模型存废连同 event schema 留给 Observability Expansion 阶段
  - spec: §5 DECISION-02

---

## Phase 0 — 基线与开发安全

- [x] **RC-T00** 建立修复分支与测试基线 ✅ 2026-08-26（记录：`evidence/baseline/RC-T00-baseline.md`）
  - depends: 无
  - files: —
  - verify:
    - `feat/run-center-v1-hardening` 已从 `0c0b7907` 切出（**不是从 develop**）
    - 以下测试全绿并存档结果：`test/main/features/cogseed_backend/task-store.test.ts`、`group-chat-task-bridge.test.ts`、`group-chat-dashboard-action.test.ts`、`renderer-projection.test.ts`、`runtime-controller.test.ts`、`test/main/features/group_chat/bus.test.ts`、`bus-integration.test.ts`、`failed-turn-retry.test.ts`、`test/renderer/run-center.test.ts`、`test/main/ipc/cogseed-backend.test.ts`
    - 冲突热点清单（`bus.ts` 的 `_enqueueBody` / `runActorTurn` / `_emitTaskRunTerminalIfQuiescent`、`conversations.sendStream` 签名）已同步给并行开发者
    - 已确认 `git rev-list --left-right --count origin/develop...0c0b7907` 仍为 `0  1`
  - spec: §7

---

## Phase 0.5 — 最小 Renderer 交互测试脚手架

- [x] **RC-T01** 引入 DOM 测试环境与 Run Center harness ✅ 2026-08-26（记录：`evidence/baseline/RC-T01-harness.md`）
  - depends: `RC-T00`
  - files（实际）:
    - `package.json`（新增 `jsdom` devDependency `^30.0.1`；lock +37 包，0 移除 0 版本变更）
    - `vitest.config.ts` —— **一行未改**（见下方偏离说明）
    - `test/renderer/_run-center-harness.ts`（新建）
    - `test/renderer/run-center-harness.test.ts`（新建，5 条冒烟 + 3 条基线见证）
    - ~~`THIRD_PARTY_NOTICES.md`、`third_party_licenses/`~~ —— **经核查本项不适用**：该文件只收录 production 依赖与随发行分发的 license 正文，现有 devDeps（vitest/electron/typescript/eslint）零命中
    - `sbom.cdx.json` —— **需重新生成**（实测该 BOM 含 devDependencies）
  - ⚠️ **对 spec §8 的设计偏离**：`// @vitest-environment jsdom` docblock **不可用** —— `test/setup-env.ts` 的 `import 'tsx/cjs'` 会加载 esbuild，其 load 时断言 `new TextEncoder().encode('') instanceof Uint8Array` 在 jsdom realm 下为 false，整个文件收集不到用例即崩。改为**把 jsdom 当库用**：harness 内部 `new JSDOM(...)`，测试跑在默认 node environment。全局配置零改动，且每测试一个独立 window（真隔离）
  - ⚠️ **坑**：Vitest 4 的 environment pragma 检测匹配**整个文件内容（含注释散文）**，在注释里写出该 pragma 字面名会把 suite 切回坏环境
  - verify:
    - `npm run sbom:check` 通过
    - `npm run reuse:check` 通过
    - harness 能**在加载 `run-center.js` 之前**注入 mock `window.cogseed`（实测 contextBridge 对象 `writable:false, configurable:false, frozen:true`，事后覆盖必然失败）
    - 5 条冒烟通过：①点 Refresh → `cogseed.session.read` 被调用；②选中 Task → detail 渲染 taskId；③mock 状态翻转 → 卡片换列；④**改写后**：4 个 column 节点存在且 completed 含预期卡片数；⑤`[data-run-center-open]` 可达
    - 新测试**零 source-string 主断言**
  - ⚠️ 注意：jsdom **不做 layout**，`getBoundingClientRect()` 恒为 0 —— 原「completed 列实际可见」命题不可测，已按 spec §8 改写为结构断言
  - spec: §8

---

## Phase 1 — Refresh / Realtime / 状态收敛

- [x] **RC-P0-01** 修完整 Refresh（Board + Session + Detail + Timeline + Collaboration）✅ 2026-08-26（记录：`evidence/phase-1/RC-P0-01-refresh.md`）
  - depends: `RC-T01`
  - files（实际）:
    - `src/renderer/modules/run-center.js`
    - `test/renderer/run-center-refresh.test.ts`（新建，7 条）
    - `test/renderer/run-center-harness.test.ts`（删除已被推翻的 RC-P0-01 基线见证）
  - 修改点（实际）:
    - 抽出 `loadDetail({ preserveDetail })` —— `select()`（用户切选中，立即清空旧内容）与 `refresh()`（同一选中项静默重拉，保留旧内容直到新数据到达）共用同一条读取路径
    - `refresh()` 的 `:186` 守卫删除；改为「选中项仍在 board → 原地重拉；task 已消失 → 回落 board 首项；session 被删（`{session:null,collaboration:null}`）→ 清选中 + 空态，不停在 error」
    - `loadDetail()` 增加 in-flight 竞态守卫：await 前后比对选中 id，过期响应直接丢弃（`RC-P1-03` 1s 确认窗口的并发前置）
    - 删除 `action()` 里 `refresh()` 之后重复的 `select()`
    - board 的 loading 占位改为 `state.loading && !state.board` —— 刷新时不再整屏替换成 spinner（`RC-P0-02` 轮询的硬前置）
  - ⚠️ 一处保守偏离：`selectedTaskId` 为空但 session 仍存活时**不回落 board 首项**，继续按 session 维度重读 —— 否则 `RC-P0-02` 的 5s 轮询会每 5 秒把用户的 session 选中劫持回 board 首项（已加回归锁）
  - ⚠️ 合并事故已处理：并行改动一度在同文件留下**两个 `loadDetail()` 定义**（`keepVisible` 版 + `preserveDetail` 版），已合并为一份（保留功能更全者：多 session 删除处理与竞态守卫）
  - verify（7 条测试全绿）:
    - 已选中状态下 `refresh()` → `cogseed.session.read` 被调用，且 payload 指向**用户的选中**而非 board 首项
    - detail / timeline / collaboration DOM 内容随之更新
    - selected task 已消失 → 回落 board 首项，不抛错
    - selected session 已删除 → 清空选中并显示空态，不停在 error
    - detail 重拉期间不整屏闪空（用 pending promise 卡住 `session.read`，断言旧 timeline 仍在屏且无 `loading_detail` 占位）
    - 去除 `action()` 路径的重复 `select()`：单次 abort → `task.action` 1 次、`session.read` 恰好 2 次
  - spec: §9.1 / RC-P0-01

- [x] **RC-P1-15** `listCogSeedTasks()` 查询边界（**提前到此，因 RC-P0-02 会放大扫描成本**）✅ 2026-08-26
  - depends: `RC-T00`
  - files: `src/main/features/cogseed_backend/task-store.ts`、`ipc-service.ts`、`test/main/features/cogseed_backend/task-query-bounds.test.ts`（新建，15 条）
  - 实现要点:
    - `listCogSeedTasks(userId, { limit?, since? })`；窗口逻辑抽成**纯函数** `applyCogSeedTaskWindow()` 导出，供 ipc-service 复用同一次扫描结果
    - **保留策略**：仅 `completed` / `cancelled` 可被裁（`AGEABLE_TASK_STATUSES`）。`created/queued/running/waiting_user/recoverable/failed` **永不被裁，且不消耗 limit 预算** —— 故意窄于 `ipc-service` 的 `TERMINAL_TASK_STATUSES`（后者含 `failed`），因为 failed 正是 attention 列要暴露的东西
    - **祖先保留**：被保留任务的所有祖先一并保留，否则 `boardProjection()` 上溯 `parentTaskId` 时会因父任务过期而把一次 run 拆成多张卡
    - **单次 Refresh 一次扫描**：`scanTasks()` 复用 in-flight promise（board 与 sessionList 由 renderer 并发发起）。**纯 in-flight，非缓存** —— 结算即释放，顺序刷新仍各自落盘，失败也会释放不毒化后续
    - 窗口默认 `limit=200 / since=30 天`，**仅用于 board 与 sessionList**；`sessionProjection` / `collaborationSnapshot` 明确不套窗口，保证过期任务仍可经 session 详情访问
  - verify:
    - `listCogSeedTasks()` 支持可选 `{ limit, since }`
    - 构造 > limit 个 task → 断言按 `updatedAt` 降序截断
    - 断言**非终态（活跃）任务永不被时间窗裁掉**
    - 单次 Refresh 不产生两次完整目录扫描
    - 保留策略已文档化（active 永久可见 / recent 近 N 天 / archived 仅 session 详情可达）
  - spec: §12 / RC-P1-15

- [x] **RC-P0-02** Run Center 可见期轮询 ✅ 2026-08-26
  - depends: `RC-P0-01`, `RC-P1-15`
  - files: `src/renderer/modules/run-center.js`、`test/renderer/run-center-polling.test.ts`（新建，10 条）、`test/renderer/_run-center-harness.ts`（加 timer / visibility 测试缝）
  - 实现要点:
    - 5s `setInterval`，四个门控：`panel-run-center.active` / `!document.hidden` / `!state.loading` / `!state.busyAction`
    - **离开视图无 teardown 钩子**（路由只摘 `active` class），故由 tick 自己发现并 `clearInterval` —— 真退休，不是空转
    - `visibilitychange`：隐藏立即停；恢复可见且面板仍 active 时立即补一次 refresh 再重启轮询
    - 重复进入不叠加 interval（`pollTimer !== null` 直接返回）
  - ⚠️ 测试缝说明：jsdom 自带 `window.setInterval`，Vitest fake timers 打的是 Node global，**看不见**。harness 在 eval 模块前替换该 window 的 timer 函数，`harness.tick()` 直接触发回调，`activeIntervals()` 让「只有一个 interval」可直接断言
  - verify:
    - 条件 `panel-run-center.active && !document.hidden && !state.busyAction` → 5s `refresh()`
    - 进入 Run Center 建立 interval
    - 离开页面 / `document.hidden` → 停止
    - 重复进入**不产生第二个 interval**
    - `busyAction` 期间不并发 refresh
    - `visibilitychange` 回到可见立即补一次 refresh
    - teardown 正确（无泄漏 timer）
  - ⚠️ 不得复用 `cogseed.task.events` stream —— 它是一次性分页读，不是订阅
  - spec: §9.2 / RC-P0-02

- [x] **RC-P1-09** retry 新旧 task 建立关联（**提前到此，因 RC-P1-03 的 retry 终止条件依赖它**）✅ 2026-08-26
  - depends: `RC-P0-01`
  - files: `src/main/features/cogseed_backend/ipc-service.ts`、`group-chat-task-bridge.ts`、`src/main/features/group_chat/bus.ts`、`src/renderer/modules/run-center.js`
  - ⚠️ **触碰 `bus.ts:2127 _enqueueBody`（并行开发热点）→ 单独成 PR 且优先合入**
  - ℹ️ **范围修订 2026-08-26（疑点 1 已复核确认）**：`retryOfTaskId` 已端到端存在（`types.ts:19/89`、`task-store.ts:72/273/459`），CogSeed-native retry 已在写（`lifecycle.ts:93`）→ **无需 schema 变更**；但 `ipc-service.ts` 对该字段 0 命中 → **投影缺口对所有 executionKind 生效，范围比原描述大、成本比原描述低**
  - **拆两步，(b) 可独立先行：**
    - **(a) 写入侧**：`ipc-service.action()` retry 分支透传原 `taskId` → `bus.ts:_enqueueBody` 的 `startRun()` 带上 `retryOfTaskId`
    - **(b) 投影侧（一行，独立有价值）**：`taskSummary()` 增加 `...(task.retryOfTaskId ? { retryOfTaskId: task.retryOfTaskId } : {})`
  - verify:
    - retry 后新 parent task 的 `retryOfTaskId === 旧 taskId`
    - projection 透出 `retryOfTaskId`
    - **CogSeed-native retry 任务（`lifecycle.ts:93` 路径）的 `retryOfTaskId` 同样透出**
    - UI 在卡片与详情区渲染「重试自 …」关联标注
    - 旧 failed task 状态不被篡改
  - 实现（(a)(b) 两步均已落地，无 schema 变更）:
    - (b) 投影：`taskSummary()` 透出 `retryOfTaskId`，**对所有 executionKind 生效**（native retry 早已在写，只是从未被投影）
    - (a) 写入：`ipc-service.action()` → `retryGroupChat({retryOfCogSeedTaskId})` → `retryFailedTurn` → `enqueue({retryOfCogSeedTaskId})` → `bus.ts:_enqueueBody` → `observedTaskBridge().startRun({retryOfTaskId})` → bridge `createObservedTask`
    - `retryOfCogSeedTaskId` **不进 retry 幂等 fingerprint** —— 它是投影关联，不改变被执行的内容
    - bridge 侧经 `safeCorrelationId()` 白名单，非法 id 丢弃而非落盘
    - UI：卡片 meta 与详情区各渲染一处 `[data-run-center-retry-of]`，新增 i18n `run_center.label_retry_of`（en/zh）
  - 回归：既有 `group-chat-dashboard-action.test.ts` 的 `toHaveBeenCalledWith` 为精确匹配，已随新增字段更新
  - spec: RC-P1-09

- [x] **RC-P1-03** abort / retry 状态收敛确认窗口 ✅ 2026-08-26
  - depends: `RC-P0-01`, `RC-P0-02`, `RC-P1-09`
  - files: `src/renderer/modules/run-center.js`、`locales/{en,zh}.json`、`test/renderer/run-center-action-convergence.test.ts`（新建，7 条）
  - 实现要点:
    - 确认窗口：cadence 1s，**按次数计上界（10 次）而非挂钟**，使边界确定、不受单次重读耗时影响
    - abort 终止条件：board 中该 task ∈ `{cancelled, failed, completed}`
    - retry 终止条件：board 中出现 `retryOfTaskId === 原 taskId` 的新 task（**依赖 RC-P1-09**；否则只剩超时，等于没有终止条件）
    - **超时不伪造状态**：保留最后一次真实快照，另置 `state.unconfirmedAction` 并渲染 `[data-run-center-unconfirmed]` 提示（新增 i18n `run_center.action_unconfirmed`，en/zh）
    - `busyAction` 在 `finally` 释放，超时路径同样释放（否则会连带卡死 RC-P0-02 轮询——它以 `busyAction` 为门控）
  - 测试缝：harness 接管 `setTimeout`，`flush()` 排空队列 —— 10 次迭代真实执行但零挂钟耗时
  - verify:
    - action 后进入确认窗口：cadence 1s，timeout 10s
    - abort 终止条件：task ∈ `{cancelled, failed, completed}`
    - retry 终止条件：出现 `retryOfTaskId === 原 taskId` 的新 task
    - mock 延迟 2 tick 翻转 → UI 最终收敛，`busyAction` 正确释放
    - **超时路径不伪造状态**，保留最后真实快照 + 提示
    - 前端全程无假改状态代码
  - spec: §9.3 / RC-P1-03

**Phase 1 完成条件** — spec §9 DoD 全部勾选。 ✅ **Phase 1 已完成（2026-08-26）**：RC-P0-01 / RC-P1-15 / RC-P0-02 / RC-P1-09 / RC-P1-03 全部落地，新增 39 条测试，全量套件零回归（失败项仅为既存的 `@napi-rs/canvas` 截断，见 README）。

---

## Phase 2 — 重启恢复（RC-P0-04 与 RC-P0-05 必须同一 PR）

- [x] **RC-P0-04 + RC-P0-05** 启动恢复 + action 语义（**不可拆分**）✅ 2026-08-26
  - depends: `RC-T00`（可与 Phase 1 并行开发，但需在 Phase 3 前合入）
  - ⚠️ **实施中发现 spec §10 两处判断与代码不符，方案已相应调整**（详见 `evidence/baseline/RC-P0-04-05-restart-recovery.md`）:
    1. **状态机禁止该 transition** —— `lifecycle.ts` 的 `TRANSITIONS` 里 `created`/`queued` **没有 `failed` 出边**，`recoverable` 也没有。原方案「非终态直接落 failed」**无法执行**。已最小扩边：`created→failed`、`queued→failed`、`recoverable→failed`
    2. **`failed 有现成 retry 出口` 不成立** —— `groupChatMessageId` **只在 `finishTask` 写**，被重启打断的 task 从未走到那里，故必然缺失 → `taskActions().retry` 恒 false。且 `groupChatSourceMessageId`（用户消息）**不能**当 fallback：`resolveFailedTurnRetry` 要求目标是**失败的助手回复**。故 RC-P0-05 采用**选项 (2)：明确不可 retry**
    3. spec 引用的 `index.ts:1223 skills:version-recovery` 实为 `registerImmediate`，非 `registerDeferred`（已改用 `recall:capture-recovery` 为先例）
  - `waiting_user` **故意不纳入**（理由经二次 review 修正）：`bus.ts:1526-1536` 显示那次 run **已经正常终结**（`state.taskRun` 先清空，才算出 `waiting_input` 并调 `finishTask`），**重启并没有打断它**，盖 `app_restart` 属事实错误；真正「用户仍需回复」的权威信息在持久化的 `OrchestrationLedger`（`state.ts:72-88`）。状态机亦无合法出边
  - ### corrective patch（二次 review 后，同轮修复）
    - **B-1 ★ blocker**：startup sweep 原本只看磁盘状态，会把**本进程正在运行**的 run 判成 orphan → `failed + app_restart`，而 `failed → completed` 非法，导致**成功完成的 run 永久显示 failed**。已加 process-start 护栏：`src/main/storage.ts` 新增 `PROCESS_STARTED_AT = nowIso()`，recovery 只处理 `updatedAt < processStartedAt`
      - ⚠️ **时间戳陷阱**：任务时间戳是 `nowIso()` 的**本地时间/秒精度/无时区**，与 `toISOString()` 的 **UTC 带毫秒**不可字典序混比 —— 混用会让护栏静默失效**且测试照样通过**。故 boundary 必须由 `nowIso()` 产出
      - 用 `updatedAt` 而非 `createdAt`；用严格 `<` 而非 `<=`（同秒视为活的：漏一个 orphan 下次启动自愈，误杀活 run 不可逆）
    - **B-2**：已 `recoverable` 的 native task 每次 sweep 重复计数并重复投影 → 在**候选集层面**排除（不靠同状态早返回掩盖）。实测 `recoveredCount` 1/0/0，投影仅 1 次
    - **B-3**：`run_center.retry_unavailable_group_chat` 旧文案承诺「请打开会话继续」，但 `RC-P0-07` 未落地前该按钮不渲染 → 改为只陈述事实「此运行被应用重启中断，无法从运行中心恢复」。待 RC-P0-07 落地后再升级
    - 新增测试 +21（`app-restart-recovery.test.ts` +12、`task-transitions.test.ts` 新建 9）
    - 既有 `recovery.test.ts` 同步加 boundary（它模拟的正是「上一进程遗留」）
  - files:
    - `src/main/index.ts`（`registerDeferred('cogseed:task-recovery', ...)`，先例 `:1223` `skills:version-recovery`、`:1336` `recall:capture-recovery`）
    - `src/main/features/cogseed_backend/recovery.ts`
    - `src/main/features/cogseed_backend/ipc-service.ts`（`taskActions()`）
    - `src/main/features/cogseed_backend/lifecycle.ts`
  - 方案（唯一）：group-chat 非终态 task → `transitionCogSeedTask(..., 'failed', {errorCode:'app_restart'})`，**不进 `recoverable`**；非 group-chat 维持 `markCogSeedTaskRecoverable()`
  - 依据：`group_chat/index.ts:213-216` `healing orphan running state` → Group Chat 自身无 run 恢复能力
  - verify:
    - 构造 `running` group-chat parent + child task → 跑 recovery → 全部 `status==='failed' && errorCode==='app_restart'`
    - **断言不存在任何 `recoverable` 的 group-chat task**（禁止 running zombie → recoverable zombie）
    - `taskActions().retry === true` 对 `app_restart` 失败任务成立
    - `groupChatMessageId` 缺失的 parent run task 有明确处理（可 retry 或明确不可 retry + 文案）
    - recovery 失败不阻塞应用启动
    - 非 group-chat task 恢复行为无回归（现有 `runtime-controller.test.ts` 仍绿）
  - spec: §10

**Phase 2 完成条件** — spec §10 DoD 全部勾选。 ✅ **Phase 2 已完成（2026-08-26，含 corrective patch 后重新验收）**：累计新增 38 条测试；全量套件 **9438 passed**，失败集合与 Phase 1 结束时 `diff` **逐条同名**（仍为既存 canvas 24 项），零回归。
> Phase 2 曾于首次实现后被二次 review 判定存在 correctness blocker（B-1），**已修复并重新验收**，实测 probe 确认活任务不再被误杀。

---

## Phase 3 — 用户可达性

### 3A 交互可达

- [x] **RC-P0-07** 修「打开任务」按钮 ✅ 2026-08-26（记录：`evidence/phase-3/RC-PHASE-3-acceptance.md`）
  - depends: `RC-T01`
  - files: `src/main/features/cogseed_backend/ipc-service.ts`（`taskSummary()` `:390-408`）
  - 修改点: 增加 `...(task.conversationId ? { conversationId: task.conversationId } : {})`
  - verify:
    - 选中 group-chat task → `[data-run-center-open]` 存在且值 === `conversationId`
    - 点击触发 `setView('conversation', cid)`
    - **回归**：正常加载路径下按钮存在（当前 bug 是「功能正常时按钮消失，异常时才出现」）
  - spec: RC-P0-07

- [x] **RC-P1-08** `waiting_user` 出口 ✅ 2026-08-26 —— 只解决 UI 出口，**不解决** D-9 生命周期 ownership
  - depends: `RC-P0-07`
  - files: `src/renderer/modules/run-center.js`、`src/renderer/locales/en.json`、`src/renderer/locales/zh.json`
  - verify:
    - `waiting_user` task 选中后「打开任务」按钮突出显示
    - 渲染说明文案（新增 i18n key，en/zh 双语齐全）
    - **不新增后端动作**
  - spec: RC-P1-08

- [x] **RC-P2-10** resume 语义核验（仅补测试，不改代码）✅ 2026-08-26 —— main 20 条 + renderer 3 条，零实现改动
  - depends: `RC-T01`
  - files: `test/`
  - verify:
    - group-chat task 各状态下 `actions.resume === false`
    - DOM 中无 `data-run-center-action="resume"`
    - 锁定该不变量防止回归
  - spec: RC-P2-10

- [x] **RC-P2-11** filter scope 与 tab 语义一致 ✅ 2026-08-26 —— 实机 runs 视图 `filtersVisible:false, filtersEnabled:0`
  - depends: 无（可并行）
  - files: `src/renderer/modules/run-center.js`
  - verify: 切到 runs / collaboration 视图后 `.run-center-filter` 不可见或 `disabled` + `aria-disabled`
  - spec: RC-P2-11

### 3B 视觉可达

- [x] **RC-P0-06** 修看板 completed 列裁剪 ★ **P0** ✅ 2026-08-26 —— 采纳方案 (a)：`repeat(auto-fit, minmax(190px,1fr))` 并去掉 `min-width:820px`；CDP 四档实测无 `<CLIPPED>`
  - depends: `RC-T00`
  - files: `src/renderer/style.css`、（若改结构）`src/renderer/modules/run-center-board.js`
  - 现状实测: 1456px 下 completed 列 `left=1152px` == `.run-center-main` `right=1152px`；`colsScrollW=820 / clientW=608`，溢出 212px 无滚动条
  - 方案倾向: **(a) 窄栏时 2×2 wrap**（`repeat(auto-fit, minmax(190px,1fr))`，去掉 `min-width:820px`）—— 让可见性不再依赖 layout，从而可被结构化测试覆盖
  - verify:
    - **不得只在 1456px 修死一个宽度**
    - 结构断言：4 个 column 节点均在 DOM，无 `min-width` 强约束
    - 真实浏览器冒烟（Electron + CDP）：**720 / 1050 / 1456 / 1920 四档**均满足 `column.right <= main.right`
  - spec: RC-P0-06

- [x] **RC-P2-12** 补 `activity` icon ✅ 2026-08-26
  - depends: 无（可并行）
  - files: `src/renderer/modules/icons.js`（或 `src/renderer/index.html`）
  - verify: `UI_ICONS['activity']` 存在；侧边栏不再回退到 `info`
  - spec: RC-P2-12

- [x] **RC-P2-19** 空看板文案与保留窗口协同 ✅ 2026-08-26 —— `retentionHiddenCount > 0` 走 `board_empty_retention`
  - depends: `RC-P0-06`, `RC-P1-15`
  - files: `src/renderer/modules/run-center-board.js`、`locales/{en,zh}.json`
  - verify: 因时间窗被裁而空 vs 真正无任务，文案可区分，不再误导
  - spec: §4 D5

### 3C 卡片身份

- [x] **RC-P0-13** 卡片身份可辨识 ✅ 2026-08-26（记录：`evidence/phase-3/RC-P0-13-card-identity.md`）
  - depends: ~~DECISION-01~~（已完成）, `RC-P0-01`
  - 实现方案（DECISION-01 = B）：`run ordinal + 相对时间 + conversationId 前 8 位 + agentId + turn ordinal`；ordinal 服务端按同 session `createdAt` 升序稳定计算，不得用数组下标
  - files: `src/main/features/cogseed_backend/ipc-service.ts`、`src/renderer/modules/run-center.js`、`run-center-board.js`、`locales/{en,zh}.json`
  - verify:
    - 同一 session 下多个 run 的卡片标识**两两不同**
    - 运行记录列表项两两可区分
    - **断言 projection 不含 prompt / objective / step result / 首条消息文本**
    - 隐私复审通过
  - spec: RC-P0-13 / §5 DECISION-01

**Phase 3 完成条件** — spec §11 DoD 全部勾选。 ✅ **Phase 3 已完成（2026-08-26）**：3A/3B/3C 全部 8 项落地，新增 84 条测试；
Phase 0 baseline 仍为 266 passed / 7 skipped；全量 **9522 passed / 24 failed / 105 skipped**，失败集合与 Phase 2 结束时 **逐条同名**（既存 canvas 24 项），零新增回归；
CDP 720 / 1050 / 1456 / 1920 四档均无 `<CLIPPED>`。总验收记录：`evidence/phase-3/RC-PHASE-3-acceptance.md`。
> 验收中修正一处文案缺陷：出口按钮 `Open task` / `打开任务` → **`Open conversation` / `打开会话`** —— 它的动作是打开会话另起新 run，旧文案与 retry / resume 混写（spec Phase 2→3 语义联动）。
> **D-9 未因此 resolved**：`RC-P1-08` 只解决 UI 出口，生命周期 ownership 仍 open。

---

## Correctness follow-ups（Phase 完成后发现，独立收口）

> 与文末「长期架构债务」区分：那里是 ownership 未决；这里是**已确诊、有确定修法、有可验证 DoD** 的具体缺陷。

- [x] **RC-P2-20** `taskTree()` 吞掉父任务缺失的 turn ✅ 2026-08-26
  - depends: 无（独立收口，**不重开 Phase 3**）
  - 性质: Renderer correctness，pre-existing（`0c0b7907` 起即存在），非本轮引入
  - files: `src/renderer/modules/run-center.js`、`src/renderer/locales/{en,zh}.json`、`src/renderer/style.css`、`test/renderer/run-center-tree-orphan.test.ts`（新建，13 条）
  - 根因: 根判定 `!byParent.has(task.parentTaskId)` —— `byParent` 的 key 由**子任务自己**登记，故该查询对任何有父的任务恒为真，判定退化成 `!task.parentTaskId`
  - 实测: 父任务不在投影中的 turn → `roots` 为空 → Runs 视图落到 `tasks_empty` 空态，而**看板同时仍显示该卡片**
  - 修法: 改用 `present`（本次投影 taskId 集合）判定；父缺失的 turn 提升为自己的 root。**不伪造 parent、不猜状态、不动 task-store**
  - 附带: 渲染递归加环路守卫；根集为空时扁平列出全部任务而非显示空态
  - verify（13 条全绿）:
    - Case 1 正常 parent-child 树无回归，且健康树上无 orphan 标记
    - Case 2 orphan turn 渲染为 root，status / identity 真实，标记只带 parentTaskId，不生成假 parent 行、无 undefined 占位
    - Case 3 多个 orphan 各自成 root，互不吞掉、不合并成假 run；同名缺失父的两个 orphan 并列
    - Case 4 正常树与 orphan 混合，各自正常，仅 orphan 被标记
    - Case 5 orphan 的 detail 可达、Open Conversation 可达并真实导航；不误显示 resume/retry
    - Case 6 fallback 不新增 renderer 敏感字段；不伪造 run ordinal
    - 环形数据扁平列出（每个任务恰好一次）；真正无任务时仍显示空态
  - spec: §17.5 RC-P2-20

---

## Phase 4 — 数据生命周期止血

> ⚠️ **执行顺序已调整（2026-08-26）：Phase 5 → Phase 4。** 本节在 Phase 5 完成后执行。
> 理由（均为代码事实）：① Phase 5 的 depends 已全满足；② 本节原写的 production hook 判断错误（见下）；
> ③ 本节尚有 native task 可见性语义需按方案 (c) 收口；④ 两阶段无 contract 双向依赖，调序不返工。

- [x] **RC-P1-14** orphan task 级联清理 ✅ 2026-08-26（记录：`evidence/phase-4/RC-P1-14-conversation-cleanup.md`）
  - depends: `RC-T00`、**Phase 5（RC-P1-18）先行** —— 均已完成
  - files:
    - `src/main/features/chats.ts`（**真实落点** `_purgeDeletedConversationFiles()` `:2297`）
    - ~~`src/main/features/group_chat/index.ts`（`dropConv()` `:1201`）~~ —— **落点更正**：该函数实际在 `:1212`，且在 `src/` 与 `test/` 中**零调用方**（所有引用都指向 `bus.ts:10841` 的同名函数）。按原落点实现，cleanup 在生产中**永不执行**
    - `src/main/features/cogseed_backend/task-store.ts`（**需新增**最小 cleanup primitive —— 当前该文件没有任何删除 API；先例形状见 `connector-store.ts:146 deleteCogSeedConnector`）
    - `src/main/features/cogseed_backend/ipc-service.ts`（方案 (c) 的可见性收口）
  - 先例: 同函数 `chats.ts:2341` 以 `try/catch + log.warn` 调 `chat_attachments.purgeByCid(userId, cid)` —— best-effort、不阻塞会话删除
  - **native task 语义（方案 (c)，已拍板）**:
    ```
    conversation 删除
      → group-chat shadow task / events / claims：物理删除
      → local-cli / cogseed-native task：不删除（数据保留）
      → 若其 conversation 已不存在：Run Center 不再提供/展示失效 conversation 出口
    ```
    **不要把方案 (c) 描述成「删除 native task」** —— 它在 projection / visibility 层处理，不动磁盘。
    依据：`interactive-turn.ts:65` 的 per-agent 追问任务带同一 `conversationId` 但 `executionKind` 为 `local-cli` / `cogseed-native`；而 `ipc-service.ts:676` 的可见性过滤只对 `group-chat` 生效
  - ⚠️ **claim 必须与 task 同删** —— `task-store.ts:454` 在 claim 指向的 task 缺失时抛 `references a missing task`
  - ⚠️ **不依赖树完整性** —— `RC-P2-20` 已证实现实中存在 parent 缺失、child 仍在的形状；cleanup 按每个 task 自己的 `conversationId` + `executionKind` 独立判定
  - verify:
    - 建 group-chat task → 删除会话 → task JSON / events JSONL / request claim 均不存在
    - **只删 `executionKind==='group-chat'` 且 `conversationId` 精确匹配的 task**
    - 另一 conversation 的数据完全保留
    - 同 `conversationId` 的 native / local-cli task **物理文件保留**
    - 会话已删的 native task 不再留下可点击的失效 conversation action
    - parent 缺失的 child（`conversationId` 匹配）同样被清
    - 清理失败不阻塞会话删除（best-effort），有日志
    - 重复执行幂等，无额外副作用
    - claim 与 task 同删，后续不出现 missing-task claim 错误
  - 实施（实际）:
    - `task-store.ts` 新增 `purgeCogSeedGroupChatTasksByConversation()` —— 逐条自答式选择，清 4 个文件：task JSON / events JSONL / **per-task 投影缓存 `_projections/<taskId>.json`**（核查中新发现）/ request claim
    - `chats.ts:2297 _purgeDeletedConversationFiles()` 中以 `try/catch + log.warn` 调用，形态与紧邻的 `chat_attachments.purgeByCid` 一致
    - **方案 (c) 定为 c2**（依据见 evidence §4）：native task 继续可见，但 `conversationId` 不透出、新增 `conversationUnavailable` 标记与说明文案；group-chat shadow task 仍整条过滤（它是会话的投影，脱离会话无独立含义，且该过滤是 best-effort 清理失败时的兜底）
    - 修掉两处实施中发现的真实缺口：① `boardProjection` 的 session fallback 会把刚 withhold 的 conversationId 塞回去；② `collaborationSnapshot` 的 selected task 走 `readTask` 绕过可见性解析，详情区仍显示 Open 按钮
    - 读不出来的记录**不盲删**，进 `failedTaskIds` 上报
  - verify（29 条全绿）: Case 1/2/3/5/7/8 见 evidence §5；Case 4 以真实 projection 对象断言 c2 语义；Case 6 覆盖抛错 / 部分失败 / 干净运行三条 best-effort 路径；另有测试断言 hook **没有**被写进零调用方的 `group_chat/index.ts`
  - ⚠️ **D-9 / D-3 保持 open** —— 清掉「已删除会话下的 waiting_user 影子任务」只减少 D-9 的一种累积情况，不解决「会话仍在时谁收口」；新增一条按 conversation 判定生命周期的路径**不改动任何现有 reconciliation 谓词**，不等于 D-3 已统一
  - spec: §12 / RC-P1-14

> `RC-P1-15` 已在 Phase 1 完成（因 `RC-P0-02` 依赖）。

- [ ] **RC-P2-16 / RC-P2-17** N+1 与重复上溯 —— **本轮不做**（v1 中唯一未勾选项，已移交下一阶段）
  - 在 `RC-P1-15` 落地后重新测量，作为下一阶段输入
  - ⚠️ **前置已满足**：`RC-P1-15` 已于 Phase 1 完成，但**那次重新测量至今没有做**。
    已登记为 [`post-v1-followups.md`](./post-v1-followups.md) §5 与 §8 P2 的第一件事
  - spec: RC-P2-16 / RC-P2-17

**Phase 4 完成条件** — spec §12 DoD 全部勾选。 ✅ **Phase 4 已完成（2026-08-26）**：production hook 落在真实路径并有测试锁定；精确删 group-chat、native 数据零误删；claims 不悬空；best-effort 且幂等；
新增 29 条测试；Phase 0 baseline 仍为 266 passed / 7 skipped；全量 **9595 passed / 24 failed / 105 skipped**，失败集合与已知 canvas 集**逐条同名**，零新增回归。

---

## Phase 5 — 前后端契约收口  ★ 调序前移，在 Phase 4 之前执行（2026-08-26）

- [x] **RC-P1-18** 死字段逐项定性 ✅ 2026-08-26（记录：`evidence/phase-5/RC-P1-18-contract.md`）
  - depends: `RC-P0-01`, `RC-P0-06`, `RC-P0-13`（这些改动会改变哪些字段真正被消费）—— **全部已完成**
  - ⚠️ **未沿用旧处置表**，重新做了 producer/consumer 实测；旧表 6 项 DISPLAY 之外**新发现第 7 项** `timeline.isError`
  - 实施（DELETE 2 / DISPLAY 7 / RESERVED 已注释）:
    - **DELETE `board.counts`** —— 0 消费者；renderer 过滤后自行 `items.length`，后端在过滤前算，两者不一致 → 留着会误导
    - **DELETE `actions.skip`** —— `action()` 对它无条件抛错，是纯假承诺。级联删除仅为它存在的死代码：`hasWorkflowStep`（`taskActions` / `taskSummary` 两处参数）、`workflowStepIds`、`hasSelectedWorkflowStep`、`CogSeedRendererTaskAction` 里的 `'skip'`、输入白名单与那句抛错
    - **DISPLAY 7 项** —— `session.taskCount` / `activeTaskCount` / `hasRecovery` 进会话列表行；`recovery` 进详情区；`reviews` / `conflicts` 进协作视图新增两个 section；`timeline.isError` 作为时间线错误标记。全部落在**已有**区域，不新开页面
    - 顺带修掉一处后端产出 prose：`reviews[].name` 硬编码英文字面量 `'Review gate'` → `nameKey: 'run_center.review_gate'`（原代码就没读 `gate.name`，无数据丢失）
    - 新增 i18n 21 key，en/zh 齐全；枚举状态走 `dynamicLabel()`，未知值回落可读文案
  - 既有测试同步: `skip` 断言由「`=== false`」改为「**字段不存在**」（resume-invariant 9 条 + app-restart 1 条）；`cogseed-backend.test.ts` 移除过期 `counts` mock
  - verify（31 条全绿）:
    - DELETE 项已从**真实 projection 对象**与类型定义中移除；`action('skip')` 被输入校验挡下；源码零残留死代码
    - DISPLAY 项均以**真实 DOM** 断言，且各有 0 / 空 / false 的**不误导**断言（不写「0 active」「0 tasks」，空列表说「没有」）
    - RESERVED 项仍存在且有注释；**元规则测试**扫描每处 `RESERVED` 标记，强制 8 行内出现消费方说明
    - privacy：objective / workingDir 哨兵串在三个投影中零命中；session summary 字段白名单封闭
  - spec: §13 / RC-P1-18

**Phase 5 完成条件** — spec §13 DoD 全部勾选。 ✅ **Phase 5 已完成（2026-08-26）**：DELETE 2 项真删、DISPLAY 7 项真渲染、RESERVED 全部有 owner/用途/重审时机注释并被元规则测试强制；
新增 31 条测试；Phase 0 baseline 仍为 266 passed / 7 skipped；全量 **9566 passed / 24 failed / 105 skipped**，失败集合与已知 canvas 集**逐条同名**，零新增回归。
  - files: `src/main/features/cogseed_backend/ipc-service.ts`、`src/renderer/modules/run-center.js`、`run-center-board.js`
  - 处置表:
    - DELETE: `board.counts`、`actions.skip`
    - KEEP + DISPLAY: `reviews`、`conflicts`、`recovery`、`session.taskCount`、`session.activeTaskCount`、`session.hasRecovery`
    - KEEP + RESERVED: `board.updatedAt`、`group.status`、`group.titleKey`、`group.coordinationId`、`skillVersionPinStatus`
  - verify:
    - DELETE 项已从类型定义与实现中移除
    - DISPLAY 项在 UI 中真实渲染
    - **RESERVED 项在类型定义处均有注释说明预期消费方与时间点**
    - 不存在「后端算、前端永不读、且无注释」的字段
  - spec: §13

---

## Phase 6 — 补齐所有 P0/P1 测试

- [x] **RC-T02** Renderer 主链测试补齐 ✅ 2026-08-26（记录：`evidence/phase-6/RC-T02-T03-coverage-audit.md`）
  - 结论：DoD 全项已由 Phase 1–5 与 RC-P2-20 的 **renderer 115 条**真实运行时断言覆盖，**不重复造第二套**；唯一缺口「跨层一致性」由 `RC-T04` 补齐
  - depends: `RC-T01`, Phase 1–3 全部完成
  - files: `test/renderer/`
  - verify（每条均需通过）:
    - Refresh 重拉 detail / Timeline 更新 / Collaboration 更新
    - polling lifecycle（建立 / 停止 / 不重复 / busyAction 不并发）
    - completed 列**结构断言**
    - Open Task / waiting_user / retry UI 关联标注 / resume 不误显示 / filter scope / 卡片身份
    - 零 source-string 主断言
  - spec: §14

- [x] **RC-T03** Main / Integration 测试补齐 ✅ 2026-08-26（同上记录）
  - 结论：Refresh / polling / abort / retry / restart / 状态机边 均已有真实断言；「真实落盘后仍成立」由 `RC-T04` Scenario B / C / E 补齐
  - depends: Phase 1–4 全部完成
  - files: `test/main/features/cogseed_backend/`、`test/main/features/group_chat/`
  - verify:
    - Group Chat run → parent Task；actor turn → child Task
    - abort → Runtime → task 最终 `cancelled`（**真实 FS**）
    - retry → new run/task + `retryOfTaskId` 关联
    - restart → `failed` + `app_restart`，且无 `recoverable`
    - retry after `app_restart` 可成功
    - orphan cleanup
    - query limit / retention（活跃任务不被裁）
  - spec: §14

- [x] **RC-T04** 一条较真实闭环测试 ✅ 2026-08-26（记录：`evidence/phase-6/RC-T04-e2e.md`）
  - `test/renderer/run-center-e2e.test.ts`，**8 个场景 A–G**：真实 `task-store` + 真实 `ipc-service` + 真实文件系统，仅 mock 到 Group Chat 边界
  - **抓到一个真实 bug**（`sessionProjection` 清空 native 幸存任务详情），见 `RC-T06-final-acceptance.md` §5
  - depends: `RC-T02`, `RC-T03`
  - files: `test/renderer/` 或 `test/main/`
  - verify:
    - 链路：`Renderer(harness) → invoke('cogseed.task.action') → 真实 ipc-service.action() → 真实 group_chat action（真实 FS，mock 到 bus 边界）→ 真实 Task projection → Renderer refresh → DOM 收敛`
    - **`ipc-service` 与 `task-store` 必须是真实实现 + 真实文件系统**，不得全部 mock 到只剩函数名
  - spec: §14

- [x] **RC-T05** 布局冒烟脚本固化 ✅ 2026-08-26（记录：`evidence/phase-6/RC-T05-layout-smoke.md`）
  - 新增 `scripts/run-center-layout-smoke.mjs` + `npm run smoke:run-center`；四档 × 16 项 = **64/64 通过**
  - **未改动任何 CI 配置**（workflow / required checks / release gate 均未动）
  - depends: `RC-P0-06`
  - files: `scripts/`（新建，如 `scripts/run-center-layout-smoke.mjs`）
  - verify:
    - Electron + CDP（`--remote-debugging-port`）驱动
    - 720 / 1050 / 1456 / 1920 四档断言 `column.right <= main.right`
    - 可手动运行，**不进默认 CI**
  - spec: §14 / §15

- [x] **RC-T06** 覆盖率守门 + 最终回归矩阵 ✅ 2026-08-26（记录：`evidence/phase-6/RC-T06-final-acceptance.md`）
  - ⚠️ **覆盖率阈值本轮未能测得** —— 全量 `npm run test:coverage` 结束后不产出报告段、也不生成 `coverage/` 目录（子集运行正常）。这是既有基础设施状况，本轮未改动任何覆盖率配置，**故不宣称阈值通过**。建议作为独立跟进项，不阻塞验收。详见 evidence「覆盖率门槛的实测情况」
  - depends: `RC-T02`, `RC-T03`, `RC-T04`
  - files: `vitest.config.ts`
  - verify: 不低于现有阈值（lines 61 / functions 62 / statements 58 / branches 52）
  - spec: §14

**Phase 6 完成条件** — spec §14 DoD 全部勾选。 ✅ **Phase 6 已完成（2026-08-26）**：Debt Gate 判定 GO（D-1/D-2/D-3/D-9 均不影响 Phase 6 判定）；
RC-T02/T03 覆盖审计通过、RC-T04 8 场景、RC-T05 64/64、RC-T06 回归矩阵全绿；
Phase 0 baseline 仍为 266 passed / 7 skipped；全量 **9606 passed / 24 failed / 105 skipped**，失败集合与已知 canvas 集**逐条同名**，零新增回归。
> Phase 6 发现并修复 1 个真实 bug（`sessionProjection` 会清空 native 幸存任务的详情），另修正 2 处自身测试可靠性缺陷（慢环境下未等待异步渲染、teardown 后泄漏 refresh）。

---

## 收口

- [x] **RC-DONE** Run Center v1 Hardening 验收
  - depends: 全部以上
  - ✅ **2026-08-26 完成**（记录：`evidence/phase-6/RC-T06-final-acceptance.md` §7 逐项证据）
  - verify:
    - spec §16 Definition of Done 全部 20 项勾选
    - **debt review**：走查下方「长期架构债务」三条，逐条确认「本轮止血仍然成立、未解决风险描述仍然准确、future trigger 未被本轮改动触发」。**hardening Done ≠ 架构债务 resolved** —— 若某条已被本轮无意中触发（例如改动了 startup recovery 谓词 → D-3），必须在收口前重新决策，而不是默默带过
  - 之后方可进入 **Observability Expansion**（spec §17）
  - spec: §16 / §18

---

## Long-term architecture debt — not blocking v1 hardening

以下条目**不是** Phase 3–6 的开发 TODO，不阻塞任何 DoD，也不要被当成待办去「顺手修掉」。
它们是**模型 ownership 尚无最终答案**的部分：当前方案已经正确，但谁长期持有真相还没定。
登记在此，是为了 `RC-DONE` 的 debt review 与后续 session 能重新发现它们 —— 详细字段
（当前事实 / 本轮止血 / 未解决风险 / future trigger / owner / evidence）见 spec §18。

| # | 债务 | 本轮位置 | 详细条目 |
|---|---|---|---|
| D-1 | actor-turn-per-task 模型 —— 账本粒度谁定 | DECISION-02（本轮不重构） | spec §18.2 |
| D-3 | 双套 orphan reconciliation 的 ownership —— 中断后谁判定真相 | Phase 2 second review（correctness 已修，ownership 未定） | spec §18.3 |
| D-9 | `waiting_user` 生命周期 / ownership —— 谁负责最终收口 | Phase 2 second review（`RC-P1-08` 只解决 UI 出口） | spec §18.4 |

> **编号按仓库既有规则**：本仓库的 `D-2` 早已指向 F-16（`cogseedTaskId` 仅内存），
> `D-3` 早已指向 F-18（两套 orphan 判定）。因此「dual orphan reconciliation ownership」
> 是**补全既有 D-3**，而「waiting_user ownership」取下一个空闲编号 **D-9**，不制造冲突编号。
>
> **已解决的不在此列**：startup sweep 误杀 live task、process-start boundary 缺失、
> 重复 sweep 计数、`app_restart` 错误承诺 Retry、`waiting_user` 被误判 `app_restart`、
> running / recoverable zombie —— 均由 Phase 2 corrective patch 收口，不得回填为长期债务。

三条债务应在 **Runtime Task Plane / Event Plane 统一决策**时一并重新打开（spec §18.5）；
单独修任何一条都会给另外两条留下新的接缝。
