# Run Center v1 Hardening — 设计依据（Design Rationale）

> **日期**：2026-08-26
> **基线 commit**：`0c0b7907 feat(run-center): add unified task dashboard`

## 文档职责划分

| 文档 | 职责 |
|---|---|
| `docs/run-center/run-center-v1-hardening-spec.md` | 完整技术设计依据 / **source of truth**（25 条事实基线、架构图、18 项解决方案表） |
| `docs/run-center/run-center-v1-hardening-todo.md` | 实际执行清单（按真实依赖排序，含 verify 标准） |
| **本文档** | 设计依据与关键技术选择的压缩入口（2–4 页密度） |

本文档不重复 spec 内容。需要证据细节时请查 spec 对应小节（文中已标 §）。

---

## 1. 本文档的作用

本轮按这套方案对 Run Center v1 做了一次 hardening（6 个 Phase）。方案基于对 `0c0b7907` 的完整代码审查、调用链追踪、Git 历史比对，以及一次 **Electron + CDP 实机验证**（真实数据、真实点击）。

本文档记录的是**方向、边界、实施顺序与架构选择的依据**，不是逐行 code review 记录。它回答三个问题：

- 当前 Run Center 的**本质**是什么；
- 哪些地方选择加固现状、哪些地方选择留给上游重构，以及为什么；
- 哪些约束是仓库既有的、本轮无法消除。

接口对接不是本文档的重点——控制链路已经追通（见 §2）。

---

## 2. 当前系统判断

### 真实形态

```
Group Chat Execution (bus.ts)          ◀── Runtime 真相在这里
        │  单向投影，不回控
        ▼
Shadow Task Ledger (group-chat-task-bridge.ts)
        │  run → parent task, actor turn → child task
        ▼
CogSeed Task Store + Event Store        ◀── Snapshot / Event history 在这里
        │  ipc-service.ts renderer-safe projection
        ▼
Run Center Dashboard (Board / Runs+Timeline / Collaboration)
```

`bus.ts:1301` 的注释把定位写得很清楚：**`Dashboard projection only; never controls Group Chat execution.`**

### 已有 vs 未形成

| 已有（真实可用） | 尚未形成 |
|---|---|
| Task 展示 / ledger（Task Store 与 Event Store 都是**原有能力**，本次只新增 `executionKind:'group-chat'` 与 `groupChat*` 关联字段） | Runtime 原生统一 **Task Plane** |
| refresh / 状态查询基础（3 个 IPC：`cogseed.task.list` / `cogseed.session.list` / `cogseed.session.read`） | **Event Plane**（当前 event 仅 `task.*` + `tool.started/finished`，且 payload 只有 toolName/isError/errorCode） |
| **abort / retry 真实控制**（见下） | Metrics |
| 一定程度持久化（task JSON + events JSONL + request claim，均带 fingerprint 幂等） | Trace / Span |
| Group / Session / Task 关联视图（这是本次质量最高的部分） | 完整 Observability |

### 控制链路（已追通，非猜测）

```
Run Center → cogseed.task.action → ipc-service.action()
  ├─ abort → group_chat.abort() → busAbort()                       ✅ 真实打到 Runtime
  └─ retry → group_chat.retryFailedTurn() → enqueue()（claim 幂等） ✅ 真实新起一轮
  └─ resume → 对 group-chat 硬 throw，且 taskActions() 恒 resume:false（UI 从不显示）
```

证据：`ipc-service.ts:503-504` 的 `abortGroupChat` / `retryGroupChat` 默认实现。

### 核心判断

**当前 Run Center 更接近 Task 管理 / Task projection，不是完整 Observability 系统。**

它是 Group Chat execution 的 shadow ledger + Dashboard。名字叫 Dashboard 是准确的；把它当 Observability 会高估它。

> **这是本方案的根判断。** 如果它不成立（Run Center 已经/应该是别的东西），后面整套 Phase 划分都要重排。

---

## 3. 对问题的核心判断（7 个问题簇）

> 完整 25 条事实基线见 spec §2。这里只给簇。

### 簇 1 — 状态真实性 / stale state
**问题**：Run Center 是静态快照。无 polling、无 push、无 subscription。
**为什么是问题**：Runtime 变 failed 后页面永远停在 running。更糟的是 **Refresh 按钮也修不好**——`run-center.js:186` 的守卫 `if (task && (!state.selectedTaskId || !state.selectedSessionId))` 导致有选中项时 `select()` 被跳过，detail / timeline / collaboration 全部不重拉。**实机验证 `detailReloaded:false`，前后 DOM 逐字相同。**
补充事实：push 通道在 preload 层就不存在（`PUSH_EVENT_PREFIXES` 无 `cogseed:` 前缀）；`cogseed.task.events` 虽然注册为 streamHandler，实现却是**一次性分页读**（`ipc-service.ts:1011-1019`），不是订阅，且 Renderer 零消费者。
**本轮怎么处理**：先修完整 Refresh（RC-P0-01），再加可见期 5s 轮询（RC-P0-02）。push 留到下一阶段，但 refresh 入口即未来 push handler 挂载点。

### 簇 2 — restart zombie task
**问题**：`state.taskRun.cogseedTaskId` 只在内存（`bus.ts` CidState）。重启即丢，运行中 task 永久停在 `running`。
**为什么是问题**：`recoverCogSeedTasks()` 存在但**未接启动**（只由 `cogseed.runtime.recover` IPC 触发，Renderer 零调用）。而且就算接上，它会把 group-chat task 扫成 `recoverable`——此状态下 `taskActions()` 给出**零动作**（retry 需 `failed`，abort 需 `created|queued|running`），且 `retryCogSeedTask` / `resumeCogSeedTask` 对 group-chat 硬 throw。**即 running zombie 会变成 recoverable zombie。**
**本轮怎么处理**：group-chat 非终态 task 直接落 `failed` + `errorCode:'app_restart'`，**不进 `recoverable`**；恢复策略与 `taskActions` 语义**必须同一个 PR**。

### 簇 3 — retry 关联缺失
**问题**：retry 产生新 run / 新 parent task，旧 failed task 原地不动且无关联。
**为什么是问题**：attention 列的失败卡片永不消失，用户看不出两张卡是同一件事的两次尝试。
**补充事实（本次压缩时新查证）**：`retryOfTaskId` 字段**已经端到端存在**——`types.ts:19/89`、`task-store.ts:72/273/459`，且 CogSeed-native 的 `lifecycle.ts:93` `retryCogSeedTask()` **已经在写它**。缺口只有两处：(a) group-chat retry 路径（`retryFailedTurn → enqueue → startRun`）没传；(b) `ipc-service.ts` 的 projection **完全没透出该字段**（grep 零命中），所以连 native 任务的关联也看不见。
**本轮怎么处理**：补 (a) 与 (b)。**无需 schema 变更**，只是 plumbing。

### 簇 4 — 查询放大 / data governance
**问题**：`listCogSeedTasks()`（`task-store.ts:325-337`）是 readdir + 串行逐文件 read/validate，**无 limit**；每次 Refresh 调 2 次（board 一次、sessionList 一次）。`dropConv()` 只 `purgeGroupDir()`，不清理 CogSeed task，orphan 永久残留并持续被扫。
**为什么是问题**：一旦开轮询，成本 ×12/分钟。**这是 RC-P0-02 的硬前置。**
**本轮怎么处理**：加时间窗/limit + 活跃优先（RC-P1-15，提前到 Phase 1），`dropConv` 级联清理（RC-P1-14）。

### 簇 5 — 用户可达性（含渲染正确性）
**问题**：三件事叠加，导致「看得见但够不着」。
- **「打开任务」按钮不可达**：`taskSummary()`（`ipc-service.ts:390-408`）不返回 `conversationId`，而 `detailsHtml()` 优先用 `collaboration.task`。**实机验证：选中任务后详情区 `{hasOpenBtn:false, btns:[]}`——零个按钮。** 只有 detail 加载**失败**时才 fallback 到含 `conversationId` 的 board task，即「功能正常时按钮消失，异常时才出现」。
- **看板 completed 列 100% 被裁**：1456px（标准 MacBook 宽度）下实测 `completed=8 <CLIPPED>`，列 `left=1152px` 恰等于 `.run-center-main` 的 `right=1152px`；board 要 820px，中间栏只有 608px，溢出 212px 且无滚动条。**用户打开新功能看到四列全空，而实际有 8 个任务。** 断点定在视口 1050/720px，完全没覆盖真实故障区间（需视口约 ≥1874px 才不裁）。
- **卡片身份不可辨识**：实机 8 张卡片只有「群聊运行」「指挥者执行」两种标签，3 条运行记录同名。
**为什么是问题**：修好出口不等于闭环——用户仍分不清该点哪张卡。
**本轮怎么处理**：RC-P0-07（一行修）+ RC-P0-06（responsive 重做，P0）+ RC-P0-13（**阻塞于 DECISION-01**）。

### 簇 6 — 测试真实性
**问题**：`test/renderer/run-center.test.ts` 4 个 case 中 3 个是 `readFileSync` + `toContain` 源码字符串匹配。
**为什么是问题**：抓不住任何行为回归，而 Phase 1–3 全是行为改动。
**根因（重要：这是仓库既有约束，不是实现疏漏）**：仓库**没有 jsdom / happy-dom**，`vitest.config.ts` 未设 `environment`（默认 node）。147 个 renderer 测试中 57 个靠 `vm.runInContext` 手搓 window。仓库自己的注释写得很明白：`test/renderer/chat-rich-composer-newline.test.ts:14` —「jsdom/happy-dom aren't installed and **do no layout anyway**」。
**本轮怎么处理**：把测试脚手架**前移到 Phase 0.5**（不是等 Phase 6）。见 §5-E 的关键选择。

### 簇 7 — Task 模型长期架构债务
**问题**：一个 run = 一个 parent task；**每个 actor turn = 一个 child task = 1 个 JSON + 1 个 events JSONL**。
**为什么是问题**：写放大与 Task Store 增长和对话轮次线性相关，无上界。Phase 4 的清理与限流只是止血，不改变增长斜率。
**本轮怎么处理**：**不重构**，记为架构债务，见 **DECISION-02**。

---

## 4. 当前实施路线

> 以 `run-center-v1-hardening-todo.md` 的真实排序为准。

```
Phase 0    RC-T00  基线固化
   │       建 feat/run-center-v1-hardening（从 0c0b7907 切，不是 develop）
   │       10 个测试文件跑基线并存档 + 同步 bus.ts 冲突热点
   ▼
Phase 0.5  RC-T01  最小 Renderer 交互测试脚手架          ★ 前移
   │       jsdom devDep + test/renderer/_run-center-harness.ts
   ▼
Phase 1    RC-P0-01 → RC-P1-15 → RC-P0-02 → RC-P1-09 → RC-P1-03
   │       完整 Refresh → 查询边界 → 可见期轮询 → retry 关联 → 收敛确认窗口
   ▼
Phase 2    RC-P0-04 + RC-P0-05（同一 PR，不可拆）
   │       启动恢复 + action 语义：group-chat 中断 → failed + app_restart
   ▼
Phase 3    3A RC-P0-07 → RC-P1-08 → RC-P2-10 → RC-P2-11
   │       3B RC-P0-06(P0) → RC-P2-12 → RC-P2-13a
   │       3C RC-P0-13  ← 阻塞于 DECISION-01
   ▼
Phase 4    RC-P1-14  orphan 清理（RC-P1-15 已在 Phase 1 完成）
   ▼
Phase 5    RC-P1-18  前后端契约死字段收口
   ▼
Phase 6    RC-T02~T06  Renderer / Integration / 闭环 / 布局冒烟 / 覆盖率
   ▼
Run Center v1 Hardening Done  →  Observability Expansion
```

### 每个 Phase 的意图与依赖

| Phase | 解决什么 | 为什么是这个顺序 | 依赖前面什么 | 做完后系统状态变化 |
|---|---|---|---|---|
| **0** | 分支 + 测试基线 + 冲突热点清单 | 不在 detached HEAD 上开发；`bus.ts` 三个热点函数需提前同步给并行开发者 | — | 有可回退基线 |
| **0.5** | DOM 测试能力 | Phase 1–3 全是行为改动，等 Phase 6 补测试 = 全程裸奔 | RC-T00 | 行为改动开始有兜底 |
| **1** | 状态可信 + 时效上界 | `RC-P1-15` 必须**先于**`RC-P0-02`（否则轮询放大全盘扫描）；`RC-P1-09` 必须**先于**`RC-P1-03`（retry 收敛的终止条件就是「出现 retryOfTaskId === 原 taskId 的新 task」） | RC-T01 | 最大延迟从「无上界」降到 ≤5s；Refresh 真正完整 |
| **2** | 消灭重启僵尸 | 轮询上线后僵尸更显眼；恢复与 action 语义拆开会造出 recoverable zombie | RC-T00（可与 P1 并行开发，P3 前合入） | 重启后无永久 running / recoverable |
| **3** | 用户能定位并处理 | 必须在状态可信之后——否则用户点开的是错状态 | RC-P0-01 / DECISION-01 | 看得见、分得清、够得着 |
| **4** | 数据治理止血 | orphan 清理触碰删除，放在行为稳定后更安全 | RC-T00 | 增长不再无治理 |
| **5** | 契约收口 | 必须在 1/3 之后——那些改动决定了哪些字段真正被消费 | P1 / P3 | 无「后端算、前端永不读、且无注释」的字段 |
| **6** | 真实测试补齐 | 覆盖前面每个 P0/P1 | P1–P4 | 回归可被抓住 |

---

## 5. 已做出的关键技术选择

> 这一节是本轮技术选择的核心，也是最需要 upstream 复核的部分。

### A. 本轮继续保留 shadow task ledger

**选择**：不把 Group Chat execution 重构成 Runtime 原生 Task，继续用 `group-chat-task-bridge.ts` 的单向投影。

**当前理由**：
1. 投影是**单向且不回控**的（`bus.ts:1301` 注释 + bridge 全 catch 返回 null），对 Group Chat 执行零风险；
2. 幂等做得扎实（`req-groupchat-run-<runId>` / `req-groupchat-turn-<turnId>` claim + sha256 fingerprint），不会重复建任务；
3. 本轮定位是**收口**，不是重构；
4. 真正的统一 Task Plane 应该是 Runtime 侧的决策，不该由 Dashboard 侧倒逼。

**潜在风险**：如果 Runtime 侧已经在规划原生 Task 模型，本轮加固可能在**为一个将被替换的中间层投入**。

**开放问题**：Runtime 是否已有/在规划原生 Task Plane？如果有，shadow ledger 应该继续加固，还是应该冻结在当前状态、等 Runtime Task 就绪后直接切？

---

### B. restart 后 orphan running 的处理策略

**选择**：group-chat 非终态 task 在启动恢复时直接落 `failed` + `errorCode:'app_restart'`，**不进 `recoverable`**。恢复入口用 `src/main/index.ts` 现有的 `registerDeferred(...)` 模式（先例：`:1223` `skills:version-recovery`、`:1336` `recall:capture-recovery`）。

**当前理由**：这不是我们发明的语义，而是**跟随 Group Chat 自己的既有行为**。`group_chat/index.ts:213-216` 有 orphan running healing：

```
谓词：(state.status === 'running' || diskInFlight.length > 0) && !runtime.processing && !backendActive
动作：log.warn('healing orphan running state') → setStatus(uid, cid, 'idle')
```

即 **Group Chat 对中断 run 的处理是「放弃并治愈」，本身没有 run 恢复能力**。影子任务如果落 `recoverable`，等于承诺一个上游根本不提供的能力。而 `failed` 有现成 retry 出口（`taskActions().retry` 条件即 `status==='failed'`），改动面最小。

**潜在风险**：
1. 两套判定并存——Group Chat 的 healing 是**读时惰性**触发，CogSeed recovery 是**启动时**触发，可能短暂不一致；
2. `app_restart` 与用户主动 abort 的 `cancelled` 在 UI 上都落 attention/archived，语义可能需要区分。

**开放问题**：
- `failed + app_restart` 是否符合 Runtime / Group Chat 的预期语义？还是应该用 `interrupted` 之类的独立状态？
- 两套 orphan 判定是否应该统一？如果统一，应该由谁持有真相？

---

### C. polling + query bound（顺序绑定）

**选择**：本轮先用 polling（Run Center 可见 && `!document.hidden` && `!busyAction` → 每 5s），**且 `RC-P1-15`（查询边界）必须先于或同轮于 `RC-P0-02`**。

**当前理由**：`listCogSeedTasks()` 无 limit 全盘串行扫描，一次 Refresh 调 2 次。5s 轮询 = 24 次全盘扫描/分钟。**不先加边界就上轮询，等于把一个隐性问题变成显性性能事故。**

**潜在风险**：polling 是过渡方案；如果 Runtime 侧已有事件总线可复用，这轮 polling 可能是白做的工。

**开放问题**：
- Runtime / Group Chat 侧是否已有可复用的变更通知机制？（我查到 preload 白名单 `PUSH_EVENT_PREFIXES` 里有 `conversations:` 前缀，但 Run Center 没订阅；main 侧也无任何针对 cogseed/task 的 `webContents.send`。）
- 如果有，是否应该直接跳过 polling 走 push？

---

### D. retry relation 提前到 Phase 1

**选择**：`RC-P1-09` 从 Phase 3 提前到 Phase 1，排在 `RC-P1-03` 之前。

**当前理由**：`RC-P1-03`（abort/retry 收敛确认窗口）的 **retry 终止条件**就是「出现 `retryOfTaskId === 原 taskId` 的新 task」。关联不建立，收敛窗口就没有可判定的终止条件，只能靠超时——那等于没做。

**补充**（本次压缩新查证）：`retryOfTaskId` 字段已端到端存在且 CogSeed-native retry 已在用（`lifecycle.ts:93`），**无需 schema 变更**；缺的只是 group-chat 路径 plumbing + projection 透出。这降低了提前的成本。

**潜在风险**：需要触碰 `bus.ts:_enqueueBody`，是并行开发热点。计划单独成 PR 优先合入。

**开放问题**：group-chat retry 建立 `retryOfTaskId` 的最佳插入点在哪？在 `ipc-service.action()` 透传，还是在 `retryFailedTurn()` 里带，还是在 `startRun()` 时从 `actionRequestId` 反查？

---

### E. 测试策略：不用假 DOM 证明 UI 可见性

**选择**：
- 引入 `jsdom` 做**交互**测试（点击 / IPC 调用 / DOM 断言），用 `// @vitest-environment jsdom` docblock **局部启用，不改全局默认**；
- **布局可见性（RC-P0-06）不用 jsdom 验证**，改为「结构断言 + Electron/CDP 真实浏览器冒烟」。

**当前理由**：仓库注释已经写明 jsdom **do no layout** —— `getBoundingClientRect()` 恒为 0。用 jsdom 断言「completed 列可见」会得到一个**永远通过但毫无意义**的测试，比没有测试更危险。而 completed 列被裁正是本次实机发现的最严重缺陷，必须有真实验证。

冒烟方案已在本次审查中跑通并可直接固化：Electron `--remote-debugging-port` + CDP `Emulation.setDeviceMetricsOverride`，在 720 / 1050 / 1456 / 1920 四档断言 `column.right <= main.right`。

同时倾向把 `RC-P0-06` 修成 **2×2 wrap**（`repeat(auto-fit, minmax(190px,1fr))`，去掉 `min-width:820px`），让「可见性」不再依赖 layout，从而**可以**被结构化测试覆盖。

**潜在风险**：新增 `jsdom` devDependency 会触发 `sbom:check` / `reuse:check` / `THIRD_PARTY_NOTICES.md` / `third_party_licenses/` 归档流程——这是真实成本，不是零代价。

**开放问题**：
- 引入 jsdom 是否可接受？还是团队有其他既定的 renderer 测试方向？
- 真实浏览器冒烟应该进 CI 还是保持手动？

---

### F. Event / Observability 暂不进入本轮

**选择**：
- **本轮 = Task Plane hardening**
- **下一阶段 = Event / Metrics / Trace / Diagnostics**

**当前理由**：当前 event 只有 `task.*` 与 `tool.started/finished`，payload 经 `safeToolEventsFromGroupChatProcess()` 收敛到只剩 `{toolName, isError, errorCode}`。要做真 Observability，需要的是**新的、带用户授权的数据通道**，而不是在现有 projection 上加字段。这是架构级工作，塞进收口轮会两头不到岸。

**如何保证不堵死后面**：
1. `RC-P0-01` 修好的**完整 refresh 入口**就是未来 push handler 的挂载点——`onPushEvent('cogseed:task-changed', () => refresh())`，一行接入；
2. 保留 `rendererSafeIdentifier()` / `safeToolEventsFromGroupChatProcess()` 白名单机制，不为了「好用」拆掉——未来授权通道要复用它；
3. `board.updatedAt` 标为 **KEEP + RESERVED** 而非删除，因为增量刷新/push 去重会用到；
4. DECISION-02 明确把 turn 粒度留给下一阶段与 event schema 一起决策（turn 正是未来 trace/span 的天然载体）。

**潜在风险**：如果 Runtime 侧的 Event Plane 已在设计中，本轮的 polling 与 projection 形态可能需要提前对齐。

**开放问题**：见 §6 第 4 条。

---

## 6. 尚未回答的 upstream 问题

以下问题**无法在工程侧单方面回答**，需要 Runtime / Group Chat 的架构决策。
它们不阻塞 v1 hardening 的交付，但决定后续演进方向。
每条的当前事实、触发条件与 owner 归属见 [`post-v1-followups.md`](./post-v1-followups.md) 与 spec §18。

1. 当前 Task 粒度（run = parent task，actor turn = child task）是否会和**未来 Runtime Task 模型**冲突？（DECISION-02 / D-1）
2. restart reconciliation 语义（`failed` + `app_restart`）是否符合 Runtime / Group Chat 的预期？还是应该用独立的 `interrupted` 状态？（§5-B）
3. abort / retry 长期属于**哪个 control plane**？当前是 Run Center → `cogseed.task.action` → 转发给 Group Chat；长期是继续转发，还是由 Runtime 提供统一 control API？
4. Event Plane 后续从哪里产生、如何持久化、如何投影到 Run Center？若已有设计，本轮的 projection 形态需要提前对齐吗？（§5-F / D-4 / D-5）
5. Group Chat 已有读时 orphan healing，本轮又在 CogSeed 侧加了一套启动 recovery —— 两套判定长期是否应该合并、由谁持有真相？（§5-B / D-3）

---

## 7. 两个需要团队拍板的 DECISION

### DECISION-01 — 卡片身份可辨识信息边界 ★ 阻塞 Phase 3 DoD

**当前候选**

| | 方案 | 示例 |
|---|---|---|
| **A** | 纯结构化标识（零新增数据）：run ordinal + 相对时间 + conversationId 前 8 位 | `群聊运行 #3 · 2 分钟前 · conv-8fd6` |
| **B** | A + actor 身份：加 `agentId` + turn ordinal | `Agent turn · agent-reviewer · #2 · 2 分钟前` |
| **C** | 复用用户显式命名的 conversation title（侧边栏已显示的那个） | `<用户会话标题> · 2 分钟前` |

四维比较（可辨识性 / 隐私 / 稳定性 / 实现成本）见 spec §5。

**当前工程倾向**：**候选 B**。可辨识性够用，且 `agentId` 已经过 `rendererSafeIdentifier()` 白名单、已在现有 projection 中透出、卡片 meta 行已在渲染——**不扩大暴露面**。

**为什么不能由工程单方面决定**：候选 C 的可辨识性最高（与用户在侧边栏的心智模型完全一致），但 conversation title 常由用户首条消息生成——采纳它等于**决定 Run Center 可以承载用户可读内容**，这推翻了 `0c0b7907` 刻意做的隐私收敛（同批次删除 `redactRendererText()`、移除 `workflow.objective` 与 `step.resultSummary`）。这是产品与隐私的判断，不是工程判断。

**阻塞什么**：`RC-P0-13` 无法开工 → **Phase 3 DoD（「用户能定位并处理具体任务」）无法达成**。建议在 Phase 1 进行期间并行决策。

---

### DECISION-02 — 每个 actor turn 是否继续独占一个 CogSeed Task

**当前模型**：run → parent task；每个 actor turn → child task → 1 个 JSON + 1 个 events JSONL。

**当前带来的价值（真实存在，不应低估）**：任务树与看板分组直接建立在 `parentTaskId` 上；每个 turn 有独立 event JSONL，tool 事件天然归属 actor；actor 名册靠 turn task 的 `agentId` 去重合并；幂等 claim 天然按 turn 粒度。

**代价**：写放大（每轮 2 个新文件）；Task Store 增长与轮次线性相关且无上界；`boardProjection()` 需三轮 `groupIdForTask()`；`listCogSeedTasks()` 全量读，增长直接转化为刷新延迟。

**若改成 run task + turn events 会影响**：`boardProjection()` 与 `collaborationSnapshot()` 大改；actor 名册需改为从 event payload 派生；turn 级幂等 claim 语义需重设计；已落盘历史 turn task 需迁移或双读兼容。

**当前工程倾向**：**本轮不重构**，记为架构债务。理由：现状尚未严重到不改无法收口（Phase 4 止血足够）；重构面覆盖 projection 全部核心函数，风险远超收口定位；且它与 Observability Expansion 强相关（turn 粒度正是未来 trace/span 的天然载体），应连同 event schema 一起决策。

**为什么不能由工程单方面决定**：这个模型的存废取决于 **Runtime 侧未来 Task Plane 与 Event Plane 的形态**，那超出本轮的可见范围。

**阻塞什么**：不阻塞本轮执行，但**如果决定改，Phase 4 的止血工作会大部分作废**。

---

## 8. 本轮明确不做什么

防止 Review 时范围重新膨胀。**本轮不做**：

- 完整 Event ingestion
- Metrics system
- Distributed trace / span
- 完整 Runtime Observability platform
- Token / Cost / Latency breakdown
- Tool input / output / 完整 tool result
- Model metadata
- queue / concurrency metrics
- deep runtime diagnostics
- **为了「统一」而一次性重写 Group Chat / Runtime**

**本轮目标**：把 Run Center v1 从「有功能」变成「真实可信、用户可达、可维护、可验证」，**而不是借 hardening 做一次大重构**。

如果 Review 结论是「应该直接改架构」，那正确的动作是**中止本轮**、重新立项，而不是把重构塞进这 6 个 Phase。

---

## 9. 长期演进关系

```
【现在 —— 真实实现】
Group Chat Execution
        ↓  单向投影，不回控
Shadow Task Ledger
        ↓
Run Center (Task projection / Dashboard)


【未来 —— 目标架构，尚未实现】
Runtime
├── Task Plane
│      ↓
│   Run Center
│
└── Event Plane
       ├── Events
       ├── Metrics
       ├── Trace
       └── Diagnostics
              ↓
       authorized renderer-safe observability projection
              ↓
           Run Center
```

> 注：右侧「未来」全部为**目标架构，当前均未实现**。本文档不把它描述为已有能力。

**本轮所有修改必须满足一个原则**：

> **可以渐进，但不能形成未来 Event-driven Observability 无法替换的强耦合。**

具体落实见 §5-F 的四条保证。

**红线**：不允许为了 Observability 直接取消当前隐私白名单、把敏感 Runtime payload 原样暴露给 Renderer。任何深度可观测能力必须经由「用户授权 + renderer-safe projection」通道。

---

## 附：编写本文档时发现的疑点

> 按流程记录，**未回改 source of truth**，待确认后再决定是否更新 spec / TODO。

### 疑点 1 — spec RC-P1-09 的表述不够精确（建议补充，非错误）

**问题**：spec RC-P1-09 的「根因」写的是「`CreateCogSeedTaskInput.retryOfTaskId` 未被传入」。这句本身正确，但**遗漏了两个重要事实**。

**证据**（本次压缩时重新 grep）：
- `retryOfTaskId` 已端到端存在：`types.ts:19`、`types.ts:89`、`task-store.ts:72`（input 类型）、`:273`（进 fingerprint）、`:459`（持久化）；
- **CogSeed-native retry 已经在写它**：`lifecycle.ts:93` `retryOfTaskId: previous.taskId`；
- 但 `grep retryOfTaskId src/main/features/cogseed_backend/ipc-service.ts` → **零命中**，即 projection **对所有任务类型都没透出该字段**。

**影响**：
1. 好消息——RC-P1-09 **无需 schema 变更**，成本比 spec 描述的低；
2. 坏消息——即使是 CogSeed-native 任务，retry 关联在 UI 上**同样不可见**，所以这不只是 group-chat 的问题，范围比 spec 描述的**大**。

**建议**：把 RC-P1-09 的修法拆成两步并明确标注 —— (a) group-chat 路径 plumbing；(b) `taskSummary()` 透出 `retryOfTaskId`（对所有 executionKind 生效）。第 (b) 步是一行，且独立有价值。

### 疑点 2 — spec §2.2 标题写「18 条」，实际列了 25 条（F-01 ~ F-25）

**问题**：小节标题为「### 2.2 事实基线（18 条）」，但表格实际有 F-01 到 F-25 共 25 行。

**影响**：仅文档标注错误，不影响任何技术结论。

**建议**：改为「（25 条）」。

### 疑点 3 — TODO 中 `RC-P2-13a` 编号风格与其余不一致

**问题**：其余编号形如 `RC-P{0,1,2}-NN`，`RC-P2-13a` 带字母后缀，且 `RC-P0-13` 已占用 13 号。

**影响**：编号可能引起歧义（`RC-P2-13a` 与 `RC-P0-13` 无关，但看起来像子项）。

**建议**：改为 `RC-P2-19`（空看板文案与保留窗口协同），并同步更新 spec §4 D5 的引用。
