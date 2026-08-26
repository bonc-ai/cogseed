# Run Center v1 Hardening — 收口与加固方案

> 基线 commit：`0c0b7907 feat(run-center): add unified task dashboard`
> 编写日期：2026-08-26
> 状态：见 [`README.md`](./README.md)「当前状态」
> 配套执行清单：`docs/run-center/run-center-v1-hardening-todo.md`

---

## 1. 背景与目标

`0c0b7907` 为 CogSeed 引入了 Run Center（运行中心）。经过完整的代码审查、调用链追踪、Git 历史比对与**实机验证**（Electron + CDP 驱动，真实数据），确认它是一个**可用但未收口**的功能：主链是通的、控制是真实的，但状态不可信、用户不可达、数据无治理、测试兜不住。

本轮目标不是扩展能力，而是把 Run Center 从「有功能」变成「真实可信、用户可达、可维护、可验证」。

本轮完成后应达到：

- 状态可信
- 更新有明确时效上界
- 用户能定位并处理具体任务
- 重启后不出现永久僵尸状态
- 数据增长有基本治理
- 前后端契约基本收口
- P0/P1 主链有真实测试兜底

完成后方进入下一阶段：**Observability Expansion**。

### 本方案的约束

1. **不得破坏当前 renderer-safe 隐私边界。** `0c0b7907` 刻意移除了 `redactRendererText()`，改用 `rendererSafeIdentifier()` 白名单，并主动删除了 `workflow.objective` 与 `step.resultSummary`。本轮任何改动不得以「好用」为由把 prompt / objective / tool 参数 / 结果原样放回 Renderer。
2. **不得用临时收口堵死长期 event-driven observability。** 本轮允许先用 polling，但接口与数据结构必须为后续 push 留出位置。

---

## 2. 最终事实基线

以下每条均为今日**最终查证**结果。调查过程中被推翻的中间判断已剔除（见 §2.1）。

### 2.1 已被推翻、不再作为依据的早期判断

| 早期判断 | 最终事实 |
|---|---|
| 「Run Center 完全没有消费 Event」 | 错。已通过 `cogseed.session.read` → `collaborationSnapshot()` → `readEvents()` 消费，形成 Timeline / Collaboration |
| 「Task Store / Event Store 是本次新造」 | 错。二者均为原有能力，本次只新增 group-chat 相关字段 |
| 「点看板 tab 会跳回会话」 | 错。实机 trace 证实是人工并发操作叠加，tab 切换本身正常 |

### 2.2 事实基线（18 条）

| # | 事实 | 证据 |
|---|---|---|
| F-01 | CogSeed Task / Task Store 是**原有能力**，本次仅新增 `executionKind:'group-chat'` 与 `groupChat*` 关联字段 | `types.ts` diff：`CogSeedTaskExecutionKind` 增加第三个成员；`task-store.ts` 增加 validate 分支 |
| F-02 | Event Store **原有且真实存在**，按 task 落 JSONL，带 sequence 连续性校验 | `event-store.ts:appendCogSeedTaskEvent()` → `cogseedTaskEventsFile()`；`readAllEvents()` 校验 `event.sequence !== index+1` 抛错 |
| F-03 | Run Center **已消费** Task Event，形成 Timeline / Collaboration | `ipc-service.ts:collaborationSnapshot()` → `readEvents(userId, taskId, 0, 200)` → `timelineSummary()` |
| F-04 | Event 展示经过 renderer-safe projection，**内容很薄**（只有 type / toolName / isError / errorCode） | `timelineSummary()` 只透出这四项；`rendererSafeEventSummary()` 返回固定文案 |
| F-05 | Group Chat 经 **shadow task ledger / bridge** 投影到 CogSeed Task，不影响 Group Chat 执行 | `group-chat-task-bridge.ts`；`bus.ts` CidState 注释「Dashboard projection only; never controls Group Chat execution」 |
| F-06 | 一个 run = 一个 parent task；每个 actor turn = 一个 child task | `bus.ts:2652` `startRun()`；`bus.ts:3465` `runActorTurn()` → `startTurn()`，`parentTaskId` + `coordinationDepth:1` |
| F-07 | Board / Runs / Collaboration 三视图真实存在并渲染 | `run-center.js:153` `state.view === 'board' ? boardHtml() : ... runsHtml() : collaborationHtml()`；实机截图确认 |
| F-08 | abort / retry **真实打到 Group Chat Runtime** | `ipc-service.ts:action()` → `abortGroupChat()` → `group_chat.abort()` → `busAbort()`；`retryGroupChat()` → `retryFailedTurn()` → `enqueue()` |
| F-09 | resume 对 group-chat task **明确拒绝**，且 UI 层从不显示 | `ipc-service.ts:action()` throw `'Group Chat task cannot be resumed from Dashboard'`；`taskActions()` 对 group-chat 恒 `resume:false`；`lifecycle.ts` / `runtime-controller.ts` 均有硬拒 |
| F-10 | `refresh()` **只**发两个 IPC：`cogseed.task.list` + `cogseed.session.list` | `run-center.js:182` |
| F-11 | selected detail / timeline / collaboration **不会随 Refresh 重读**（守卫拦截） | `run-center.js:186` `if (task && (!state.selectedTaskId \|\| !state.selectedSessionId)) await select(...)`；**实机验证** `detailReloaded:false`，前后 DOM 逐字相同 |
| F-12 | **无 polling / push / subscription**。全文只有 3 个 `addEventListener`，其中 `i18n-change` 只 `render()` 不取数 | `run-center.js:217/230/233`；`grep setInterval\|setTimeout` 零结果 |
| F-13 | push 通道**在 preload 层就不存在**：白名单无 `cogseed:` 前缀；main 侧无任何 `webContents.send` 发任务事件 | `preload.js:350` `PUSH_EVENT_PREFIXES`；`grep -rnE "webContents\.send\(" src/main/ \| grep -iE "cogseed\|task"` 零结果 |
| F-14 | `cogseed.task.events` 的 streamHandler **不是订阅**，是一次性分页读；且 Renderer 零消费者 | `ipc-service.ts:1011-1019` `streamEvents()` 读完即返回；`grep -rn "cogseed.task.events" src/renderer/` 零结果 |
| F-15 | abort/retry 后存在**状态收敛 race**：`action()` 立即返回快照，而终态投影在 `bus.ts` 的 `trackBackgroundWrite` 异步分支里 | `ipc-service.ts:action()` 末尾 `return this.collaborationSnapshot(...)`；`bus.ts:1538` |
| F-16 | `state.taskRun.cogseedTaskId` **只存在内存**（CidState），重启即丢 | `bus.ts` CidState 定义；无任何持久化写入 |
| F-17 | `recoverCogSeedTasks()` **未接启动**，仅由 `cogseed.runtime.recover` IPC 与 `restartRuntime()` 触发，Renderer 零调用 | `grep -rn "recoverCogSeedTasks" src` → 仅 `ipc-service.ts:995/1001` |
| F-18 | Group Chat **自身没有 run 恢复能力**，对孤儿 running 的处理是「治愈成 idle」而非 resume | `group_chat/index.ts:213-216` `healing orphan running state` → `setStatus(uid, cid, 'idle')`，谓词 `(state.status==='running' \|\| diskInFlight.length>0) && !runtime.processing && !backendActive` |
| F-19 | 「打开任务」按钮**不可达**（confirmed bug）：`taskSummary()` 不返回 `conversationId`，而 `detailsHtml()` 优先用 `collaboration.task` | `ipc-service.ts:390-408`；`run-center.js:145`；**实机验证** `{hasOpenBtn:false, btns:[]}` |
| F-20 | 看板 **completed 列在常见窗口宽度被 100% 裁剪** | 实机：1456px 下 `completed=8 <CLIPPED>`，列 `left=1152px` == `.run-center-main` `right=1152px`，`colsScrollW=820 / clientW=608`，溢出 212px 且无滚动条 |
| F-21 | 卡片标题**高度同质**，无法辨识具体会话 | `rendererTaskTitle()` 返回硬编码常量；实机：8 张卡片只有「群聊运行」「指挥者执行」两种标签，3 条运行记录全叫「群聊运行」 |
| F-22 | Task Store 存在**无界增长 + 全盘扫描**；`dropConv` 不清理 CogSeed task | `task-store.ts:325-337` `listCogSeedTasks()` readdir + 串行逐文件 read/validate，无 limit；`group_chat/index.ts:1201` `dropConv` 只 `purgeGroupDir` |
| F-23 | Renderer 测试真实性不足：4 个 case 中 3 个是源码字符串匹配 | `test/renderer/run-center.test.ts`；唯一跑代码的是 `vm.runInContext` 测 `filteredTasks()` |
| F-24 | **仓库无 jsdom / happy-dom**，vitest 未设 `environment`（默认 node）；147 个 renderer 测试中 57 个靠 `vm.runInContext` | `vitest.config.ts` 无 `environment`；`ls node_modules \| grep jsdom` 空；`test/renderer/chat-rich-composer-newline.test.ts:14` 注释：「jsdom/happy-dom aren't installed and **do no layout anyway**」 |
| F-25 | `0c0b7907` 对 `origin/develop` 是 **clean fast-forward**（parent 即 develop tip `0101219d`） | `git rev-list --left-right --count origin/develop...0c0b7907` → `0  1` |

### 2.3 三条实质改变执行骨架的新事实

> 这三条是在评审你的 Phase 0–6 草案时补查出来的，直接改变方案。

- **F-24 → Phase 0.5 的第 4 项不成立。** jsdom 不做 layout，`getBoundingClientRect()` 恒为 0，因此**「completed 列实际可见」无法用单元测试验证**。必须改为结构性断言 + 真实浏览器冒烟（见 §9、§14）。
- **F-18 → Phase 2 有了先例支撑。** Group Chat 自己对中断 run 的语义就是「放弃并治愈成 idle」，不是 resume。因此 CogSeed 影子任务落 `failed + app_restart` 与上游语义一致，不是我们发明的新规则。
- **F-20 / F-21 → 需要新增「渲染正确性」问题类别。** 原草案 A–F 六类无处安放，而这是实机跑出的最严重缺陷。

---

## 3. 当前真实架构

### 3.1 读 / 展示主链

```
用户 / Group Chat 消息
        │
        ▼
Group Chat Runtime / Bus                    ◀── ★ Runtime 真相在这里
  src/main/features/group_chat/bus.ts
  · _enqueueBody()  :2652   门控 opensObservedRun
  · runActorTurn()  :3465
  · _emitTaskRunTerminalIfQuiescent() :1519
  · CidState.taskRun.cogseedTaskId   ◀── ⚠ 仅内存，重启即丢 (F-16)
        │  (单向投影，不回控)
        ▼
group-chat-task-bridge.ts
  · startRun()    requestId = req-groupchat-run-<runId>
  · startTurn()   requestId = req-groupchat-turn-<turnId>
  · finishTask()  + safeToolEventsFromGroupChatProcess()
        │
        ▼
CogSeed Task
  ├── Task Store   cogseedTaskFile(uid, taskId).json      ◀── ★ Snapshot 在这里
  │                 status / errorCode / groupChat* 关联 id
  └── Event Store  cogseedTaskEventsFile(uid, taskId).jsonl ◀── ★ Event history 在这里
                    task.* / tool.started / tool.finished
        │
        ▼
ipc-service.ts  renderer-safe projection    ◀── ★ 以下全部是 projection，不是真相
  · boardProjection()        → cogseed.task.list
  · sessionListProjection()  → cogseed.session.list
  · collaborationSnapshot()  → cogseed.session.read
    ├─ 派生：column / groupId / progress / actors / workflow
    └─ 收敛：title 为常量、event summary 为常量、identifier 走白名单
        │
        ▼
Run Center (renderer)
  ├── Board          ← state.board        (cogseed.task.list)
  ├── Runs/Timeline  ← state.detail       (cogseed.session.read)
  └── Collaboration  ← state.detail       (cogseed.session.read)
```

**字段性质分类**

| 类别 | 字段 | 位置 |
|---|---|---|
| 持久化真相 | `status`、`errorCode`、`createdAt/updatedAt/terminalAt`、`groupChat*` 关联 id、event JSONL | Task Store / Event Store |
| **纯 projection（每次请求现算，不持久化）** | `column`、`groupId`、`progress`、`actors[]`、`title`/`titleKey`、`counts`、`sessionTitle` | `ipc-service.ts` |
| **仅内存关联（重启丢失）** | `state.taskRun.cogseedTaskId` | `bus.ts` CidState |
| 外部系统真相（只读引用） | `workflow.steps`、`reviews`(gates)、`conflicts`、`activity` | `group_chat/collaboration` |

### 3.2 控制主链与 race 位置

```
Run Center  detailsHtml() 按钮
        │  run-center.js:203  invoke('cogseed.task.action', {taskId, action, requestId?})
        ▼
IPC  cogseed.task.action           src/main/ipc/index.ts:893
        ▼
ipc-service.ts  action()
        │  readTask() → executionKind === 'group-chat' 分支
        ├─ abort  → abortGroupChat(uid, cid) → group_chat.abort() → busAbort()   ✅ 真实
        └─ retry  → retryGroupChat({cid, failedMessageId: groupChatMessageId, requestId})
                    → retryFailedTurn() → claim 幂等 → enqueue()                  ✅ 真实
        ▼
Group Chat Runtime 真正开始改变状态（异步）
        ▼
   ╳━━━━━━━━━ RACE 在这一段 (F-15) ━━━━━━━━━╳
   │  action() 不等待终态投影，立刻 return collaborationSnapshot()
   │  而终态投影在 bus.ts:1538 trackBackgroundWrite(...) 的异步分支里
   │  → 返回的快照大概率仍是 running
   ╳━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╳
        ▼
_emitTaskRunTerminalIfQuiescent() → bridge.finishTask() → transitionCogSeedTask()
        ▼
Task/Event Store 落盘
        ▼
   ╳━━━━━ 第二处断裂：无 push / 无 polling (F-12/F-13/F-14) ━━━━╳
        ▼
Run Center 仍显示旧快照，直到用户再次交互
```

**两处断裂必须区分**：
- **RACE（Phase 1.3 处理）**：action 返回过早，UI 瞬时不一致。
- **STALE（Phase 1.1 + 1.2 处理）**：无自动更新，UI 长期不一致，且 Refresh 也修不好 detail。

---

## 4. 问题树

### A. 状态可信性 / 实时性
- A1 Refresh 不刷新 selected detail / timeline / collaboration（F-11，实机确认）
- A2 完全无自动更新机制（F-12/13/14）
- A3 abort / retry 后状态收敛 race（F-15）
- A4 `i18n-change` 只 render 不取数（F-12，附带项）

### B. 重启与恢复
- B1 `cogseedTaskId` 仅内存 → 重启后 running 永久僵尸（F-16）
- B2 `recoverCogSeedTasks()` 未接启动（F-17）
- B3 group-chat task 进 `recoverable` 后零合法动作（`taskActions()` 对 group-chat：retry 需 `failed`，abort 需 `created|queued|running`）→ 若 B2 单独落地会把 running zombie 变成 recoverable zombie

### C. 用户可达性与操作闭环
- C1 「打开任务」按钮不可达（F-19，实机确认）
- C2 `waiting_user` 无出口（落 attention 列，零动作，且 C1 未修时连跳回对话都不行）
- C3 retry 产生新 run/新 task，旧 failed task 无 `retryOfTaskId` 关联
- C4 filter chip 在 Runs / Collaboration 视图仍高亮但完全无效（`state.filter` 只被 `boardHtml()` 消费）

### D. 渲染正确性  ★ 本轮新增类别
- D1 **看板 completed 列 100% 裁剪**（F-20）→ 用户看到「四列全空」而实际有 8 个任务
- D2 溢出无横向滚动条提示；容器宽度契约不成立（board `min-width:820px` vs 中间栏 608px）
- D3 断点按**视口宽度**（1050/720）而非中间栏宽度，完全没覆盖真实故障区间
- D4 `activity` icon 不存在，回退成 `info`（`icons.js` `UI_ICONS[key] \|\| UI_ICONS.info`）
- D5 空看板文案具误导性（`run_center.board_empty` 「暂无任务」与实际有数据冲突）

### E. 数据生命周期与性能
- E1 `dropConv` 后 orphan task 永不清理（F-22）
- E2 `listCogSeedTasks()` 无 limit 全盘串行扫描，且每次 Refresh 调用 2 次
- E3 `visibleDashboardTasks()` 对每个 conversation 调 `getConversation()`（已 `Promise.all`，按 distinct 收敛）
- E4 `groupIdForTask()` 在 boardProjection 内被重复调用三轮，`rootTaskId()` 每次上溯

### F. 前后端契约
- F1 后端生成、前端永不消费的字段：`board.counts`、`board.updatedAt`、`reviews`、`conflicts`、`recovery`、`session.taskCount/activeTaskCount/hasRecovery`、`group.status/titleKey/coordinationId`、`skillVersionPinStatus`
- F2 `actions.skip` 存在于契约但产品不可用（`action()` 对 skip 直接 throw）

### G. 测试真实性
- G1 renderer 测试基本是源码字符串匹配（F-23）
- G2 无 Renderer → IPC → ipc-service → Runtime 闭环
- G3 无重启恢复测试
- G4 无 abort 后终态收敛测试
- G5 **仓库无 DOM 测试环境**（F-24）——这是 G1 的根因，属仓库既有约束，不是实现疏漏

### H. 明确留给下一阶段（Observability Expansion）
Token / Cost / Trace / Span / Logs / Tool input-output / 完整 Tool result / Model metadata / latency breakdown / queue-concurrency metrics / deep runtime diagnostics / 隐私授权通道。**本轮全部不做。**

---

## 5. 两个 DECISION

### DECISION-01：卡片身份可辨识信息边界  ★ 阻塞 Phase 3 DoD

**问题.** 实机确认：8 张卡片只有「群聊运行」「指挥者执行」两种标签，3 条运行记录全叫「群聊运行」。用户无法知道某张卡对应哪个会话、哪一轮。

**为什么不能简单修.** `rendererTaskTitle()` 返回常量是本次提交**刻意的隐私收敛**：同批次删除了 `redactRendererText()`、移除了 `workflow.objective` 与 `step.resultSummary`，并把 identifier 收进 `rendererSafeIdentifier()` 白名单。把 prompt / objective / 首条消息放回去等于推翻这个设计。

**为什么必须本轮解决.** Phase 3 的 DoD 是「用户能定位并处理具体任务」。修好「打开任务」只给了出口，用户仍分不清该点哪张卡。**出口存在 ≠ 闭环成立。**

#### 候选方案

**候选 A — 纯结构化标识（零新增数据）**
`「群聊运行 #3 · 2 分钟前 · conv-8fd6」`
组合：run ordinal（同 session 内序号）+ 相对时间 + conversationId 前 8 位。

**候选 B — A + actor 身份**
`「Agent turn · agent-reviewer · #2 · 2 分钟前」`
在 A 基础上加 `agentId`（已经过 `rendererSafeIdentifier()` 白名单，且当前已在卡片 meta 行显示）+ turn ordinal。

**候选 C — 用户显式命名的 conversation title**
复用侧边栏已显示的会话标题（用户可读文本）。需新增：从 `chats.getConversation()` 取 title 并放进 projection。

#### 四维比较

| 维度 | 候选 A | 候选 B | 候选 C |
|---|---|---|---|
| **可辨识性** | 中 — 能区分「哪一次运行」，不能区分「关于什么」 | 中高 — 增加了「谁在做」 | **高** — 与用户心智模型（侧边栏）完全一致 |
| **隐私** | **最高** — 全部是系统生成 id 与时间，零用户内容 | 高 — `agentId` 已在现有 projection 中透出，无新增暴露面 | **低** — title 常由用户首条消息生成，等于把对话内容引入 Run Center |
| **稳定性** | 高 — ordinal 需服务端稳定计算，重排序有风险 | 高 — 同 A | 中 — title 可被改名/为空，需 fallback |
| **实现成本** | 低 — `boardProjection()` 内按 session 分组计序即可 | 低 — B 相对 A 只多透 turn ordinal | 中高 — 需打通 `chats` 读取 + 隐私复审 + i18n |

#### 建议与决策要求

工程侧倾向 **候选 B**：可辨识性够用，且 `agentId` 已在现有 projection 中（`taskSummary()` 已透出、卡片 meta 已渲染），不扩大暴露面。

但**候选 C 是否可接受，是产品与隐私的判断，不是工程判断**——它决定了 Run Center 是否允许承载用户可读内容。**此项不由工程侧拍板。**

> **DECISION-01 未定 → RC-P0-13 无法开工 → Phase 3 DoD 无法达成。** 建议在 Phase 1 进行期间并行决策。

---

### DECISION-02：每个 actor turn 是否继续独占一个 CogSeed Task

**当前模型.** 一个 Group Chat run → 一个 parent Task；每个 actor turn → 一个 child Task → 一个 JSON 文件 + 一个 events JSONL。

**当前带来的价值（真实存在，不应低估）**
- 任务树（`parentTaskId`）与看板分组（`groupIdForTask()` → `rootTaskId()`）直接建立在这个模型上
- 每个 turn 有独立的 event JSONL，tool 事件天然归属到 actor
- actor 名册（`collaborationSnapshot()` 的 `actorById`）靠 turn task 的 `agentId` 去重合并
- 幂等靠 `req-groupchat-turn-<turnId>` claim，天然按 turn 粒度

**代价**
- **写放大**：每轮发言 = 2 个新文件 + 若干 `transitionCogSeedTask()` 写
- **Task Store 增长**：与对话轮次线性相关，无上界
- **Dashboard 聚合复杂度**：`boardProjection()` 需三轮 `groupIdForTask()`，每次 `rootTaskId()` 上溯
- **扫描成本**：`listCogSeedTasks()` 全量读，增长直接转化为刷新延迟

**若改成 run task + turn events 会影响**
- 任务树 / 看板分组需改为按 event 聚合 → `boardProjection()` 与 `collaborationSnapshot()` 大改
- actor 名册需改为从 event payload 派生
- turn 级幂等 claim 语义需重设计
- 已落盘的历史 turn task 需迁移或双读兼容

**本轮结论：不重构。** 理由：
1. 当前实现**尚未严重到不改无法收口**——Phase 4 的 orphan 清理 + 查询上限足以止血；
2. 重构面覆盖 projection 全部核心函数，风险远超本轮「收口」定位；
3. 它与 Observability Expansion 强相关（turn 粒度正是未来 trace/span 的天然载体），应在下一阶段连同 event schema 一起决策。

**记录为架构债务**，见 §18。

---

## 6. 问题解决方案表

> 字段：ID / 问题 / 用户表现 / 根因 / 本轮修法 / 长期方向 / 涉及文件 / 依赖 / 风险 / 验证方式 / Priority / Scope / Decision dependency

---

### RC-T00 — 建立开发基线

| 字段 | 内容 |
|---|---|
| 问题 | 审查在 detached HEAD 上进行，无修复分支，无测试基线 |
| 用户表现 | （内部）无法判断后续改动是否引入回归 |
| 根因 | 尚未开工 |
| 本轮修法 | 从 `0c0b7907` 切 `feat/run-center-v1-hardening`；跑现有相关测试并存档基线结果 |
| 长期方向 | — |
| 涉及文件 | — |
| 依赖 | 无 |
| 风险 | 无 |
| 验证方式 | 基线测试结果已存档且可复现 |
| Priority | P0 |
| Scope | 本轮 |

---

### RC-T01 — Renderer 交互测试脚手架

| 字段 | 内容 |
|---|---|
| 问题 | 仓库无 DOM 测试环境，Phase 1–3 的行为改动将全程无兜底 |
| 用户表现 | （内部）回归只能靠手点 |
| 根因 | F-24：无 jsdom/happy-dom，vitest `environment` 未设；现有 renderer 测试靠 `vm.runInContext` 手搓 window |
| 本轮修法 | 引入 `jsdom` devDependency + 建 `test/renderer/_run-center-harness.ts`（详见 §9） |
| 长期方向 | 推广为全仓 renderer 交互测试标准 |
| 涉及文件 | `package.json`、`vitest.config.ts`、`test/renderer/_run-center-harness.ts`、`THIRD_PARTY_NOTICES.md`、`third_party_licenses/` |
| 依赖 | RC-T00 |
| 风险 | **中** — 新增 devDependency 触发 `sbom:check` / `reuse:check` / license 归档流程 |
| 验证方式 | 三条冒烟测试通过（点 Refresh 触发 `session.read`；选中 task 渲染 taskId；mock 状态翻转改变列） |
| Priority | P0 |
| Scope | 本轮 |

---

### RC-P0-01 — Refresh 不刷新 selected detail / timeline / collaboration

| 字段 | 内容 |
|---|---|
| 问题 | Refresh 按钮只刷新 Board 与 Session 列表 |
| 用户表现 | Runtime 已 failed，用户点 Refresh，右侧详情 / Timeline / Collaboration **纹丝不动**；重新进入页面同样无效 |
| 根因 | `run-center.js:186` 守卫 `if (task && (!state.selectedTaskId \|\| !state.selectedSessionId))` — 有选中项时 `select()` 被跳过。**实机验证** `detailReloaded:false` |
| 本轮修法 | 改为：有选中项则重拉当前选中项，无选中项则选首个。同时处理 selected task/session 已消失的降级（回落到 board 首项，并清空 `state.error`） |
| 长期方向 | detail 增量拉取（`afterSequence` 已存在于 `cogseed.task.events` 契约） |
| 涉及文件 | `src/renderer/modules/run-center.js` |
| 依赖 | RC-T01 |
| 风险 | 低。但需避免 `action()` 路径（`:204-205` 已显式 `refresh()+select()`）产生重复 IPC |
| 验证方式 | 测试：已选中状态下调 `refresh()`，断言 `cogseed.session.read` 被调用且 detail 内容更新；selected task 消失时不抛错且回落 |
| Priority | P0 |
| Scope | 本轮 |

---

### RC-P0-02 — 无自动更新机制

| 字段 | 内容 |
|---|---|
| 问题 | Run Center 是静态快照，最大延迟无上界 |
| 用户表现 | 任务从 running 变 failed，页面永远停在 running，直到用户主动交互 |
| 根因 | F-12/13/14：无 polling、无 push（preload 白名单无 `cogseed:` 前缀）、`streamEvents` 非订阅 |
| 本轮修法 | Run Center 可见期轮询：`panel-run-center.active && !document.hidden && !state.busyAction` → 每 5s `refresh()`。含正确 teardown、单例 interval、`visibilitychange` 立即补一次 |
| 长期方向 | `preload.js` 白名单加 `cogseed:` 前缀；`transitionCogSeedTask()` / `appendCogSeedTaskEvent()` 终点 `webContents.send('cogseed:task-changed', {...})`；renderer 照 `touchpoint-settings.js:422` 模式订阅。**本轮不做，但 RC-P0-01 的 refresh 入口即是未来 push handler 的挂载点** |
| 涉及文件 | `src/renderer/modules/run-center.js` |
| 依赖 | RC-P0-01（必须先保证 refresh 是完整刷新，否则轮询只刷一半） |
| 风险 | 中 — 轮询触发 `listCogSeedTasks()` 全盘扫描 ×2/次。**必须与 RC-P1-15 同轮**，否则会放大 E2 |
| 验证方式 | 测试：进入 Run Center 后 interval 建立；离开/hidden 后停止；重复进入不产生第二个 interval；`busyAction` 期间不并发 |
| Priority | P0 |
| Scope | 本轮 |

---

### RC-P1-03 — abort / retry 状态收敛 race

| 字段 | 内容 |
|---|---|
| 问题 | action 返回的快照早于 Runtime 真实状态变化 |
| 用户表现 | 点「中止」后卡片仍在「运行中」列，需再次刷新才变 |
| 根因 | F-15：`action()` 不等待终态投影；终态在 `bus.ts:1538` `trackBackgroundWrite` 异步分支 |
| 本轮修法 | **不做前端假改状态。** 在 `action()` 后进入「确认窗口」：以 1s 间隔轮询 `cogseed.session.read`，最多 10s；abort 的终止条件为 task 进入 `cancelled\|failed\|completed`；retry 的终止条件为出现 `retryOfTaskId === 原taskId` 的新 task（依赖 RC-P1-09）。超时则停止确认并保留最后快照 + 提示，不伪造状态 |
| 长期方向 | push 到达后由事件驱动结束确认窗口，取消轮询 |
| 涉及文件 | `src/renderer/modules/run-center.js` |
| 依赖 | RC-P0-01、RC-P0-02、RC-P1-09（retry 终止条件） |
| 风险 | 低 |
| 验证方式 | 测试：mock action 后延迟 2 个 tick 才翻转状态，断言 UI 最终收敛到 `cancelled` 且 `busyAction` 正确释放；超时路径不伪造状态 |
| Priority | P1 |
| Scope | 本轮 |

---

### RC-P0-04 / RC-P0-05 — 重启僵尸 + 恢复语义（**必须同一 PR**）

| 字段 | 内容 |
|---|---|
| 问题 | 重启后运行中 task 永久 stuck；且若单独接入 recovery 会把 running zombie 变成 recoverable zombie |
| 用户表现 | 应用运行中退出再启动，看板「运行中」列永远挂着一个不会动、也点不动的任务 |
| 根因 | F-16（`cogseedTaskId` 仅内存）+ F-17（recovery 未接启动）+ B3（`taskActions()` 对 group-chat `recoverable` 返回全 false，且 `retryCogSeedTask` / `resumeCogSeedTask` 对 group-chat 硬 throw） |
| 本轮修法 | **（1）** 在 `src/main/index.ts` 用现有 `registerDeferred(...)` 模式（先例：`skills:version-recovery`、`recall:capture-recovery`）注册 `cogseed:task-recovery`；**（2）** 恢复策略按 `executionKind` 分流：`group-chat` 且非终态 → 直接 `transitionCogSeedTask(..., 'failed', {errorCode:'app_restart'})`，**不进 `recoverable`**；非 group-chat 维持现有 `markCogSeedTaskRecoverable()`；**（3）** 同 PR 确认 `taskActions()` 对 `failed` 的 group-chat 已给出 retry（现有逻辑 `retry: status==='failed' && conversationId && groupChatMessageId` 成立），并为 `groupChatMessageId` 缺失的 parent run task 补 retry 路径或明确置为不可 retry + 文案说明 |
| 长期方向 | 将 `cogseedTaskId` 写入 Group Chat `state.json`，使关联本身可恢复；并与 F-18 的 `healing orphan running state` 谓词共用同一判定，避免两套真相 |
| 涉及文件 | `src/main/index.ts`、`src/main/features/cogseed_backend/recovery.ts`、`ipc-service.ts`(`taskActions`)、`lifecycle.ts` |
| 依赖 | RC-T00 |
| 风险 | **中高** — 触碰启动路径。必须 best-effort、失败不阻塞启动（照 `recovery.ts` 现有 try/catch 风格） |
| 验证方式 | 测试：构造 running 的 group-chat task → 跑 recovery → 断言 `status==='failed' && errorCode==='app_restart'` 且 `taskActions().retry === true`；断言**不存在**任何 `recoverable` 的 group-chat task |
| Priority | P0 |
| Scope | 本轮 |

> **设计依据（F-18）**：Group Chat 自身对孤儿 running 的处理是 `healing orphan running state` → `setStatus(idle)`，**没有 run 恢复能力**。因此影子任务落终态与上游语义一致，不是新发明的规则。

---

### RC-P0-06 — 看板 completed 列被裁剪  ★ 实机确认的最严重缺陷

| 字段 | 内容 |
|---|---|
| 问题 | 常见窗口宽度下第 4 列 100% 不可见 |
| 用户表现 | **打开全新功能看到「四列全空」，而实际有 8 个任务全在看不见的列里** |
| 根因 | F-20：`.dashboard-board-columns` `repeat(4, minmax(190px,1fr))` + `min-width:820px`，而三栏 `.run-center-layout`（`0.72fr/2fr/0.85fr`）把中间栏压到 608px；`.dashboard-board-scroll` 的 `overflow-x:auto` 无可见滚动条；断点定在**视口** 1050/720px，完全没覆盖真实故障区间（约需视口 ≥1874px 才不裁） |
| 本轮修法 | 三选一并落地：**(a)** 中间栏窄于阈值时看板改 2×2 wrap（`grid-template-columns: repeat(auto-fit, minmax(190px,1fr))`，去掉 `min-width:820px`）；**(b)** 用 container query 按中间栏宽度而非视口切断点；**(c)** 保留横向滚动但给出明确滚动affordance。**倾向 (a)**——它让「可见性」不再依赖 layout，从而可被结构化测试覆盖（与 F-24 的测试限制直接相关） |
| 长期方向 | 全局引入 container query 规范 |
| 涉及文件 | `src/renderer/style.css`、`src/renderer/modules/run-center-board.js`（若改结构） |
| 依赖 | RC-T00 |
| 风险 | 低（纯样式），但需覆盖 720/1050/1456/1920 四档回归 |
| 验证方式 | **不能用 jsdom**（F-24：不做 layout）。采用：**(1)** 结构断言——4 个 column 节点均在 DOM 且无 `min-width` 强约束；**(2)** 真实浏览器冒烟——沿用本次审查的 Electron+CDP 脚本，在 4 档宽度断言 `column.right <= main.right` |
| Priority | P0 |
| Scope | 本轮 |

---

### RC-P0-07 — 「打开任务」按钮不可达

| 字段 | 内容 |
|---|---|
| 问题 | 选中任务后详情区零动作按钮 |
| 用户表现 | 实机：`{hasOpenBtn:false, btns:[]}`。看板发现问题任务，却无路径回到对话处理 |
| 根因 | F-19：`taskSummary()` 不返回 `conversationId`（`ipc-service.ts:390-408`），而 `detailsHtml()` 优先取 `collaboration.task`（`run-center.js:145`）。只有 detail **加载失败**时才 fallback 到含 `conversationId` 的 board task —— 功能正常时按钮消失，功能异常时按钮出现 |
| 本轮修法 | `taskSummary()` 增加 `...(task.conversationId ? { conversationId: task.conversationId } : {})` |
| 长期方向 | — |
| 涉及文件 | `src/main/features/cogseed_backend/ipc-service.ts` |
| 依赖 | RC-T01 |
| 风险 | 极低。`conversationId` 已在 `CogSeedRendererBoardTask` 中透出，不扩大暴露面 |
| 验证方式 | 测试：选中 group-chat task → 断言 `[data-run-center-open]` 存在且值等于 `conversationId`；点击触发 `setView('conversation', cid)` |
| Priority | P0 |
| Scope | 本轮 |

---

### RC-P1-08 — `waiting_user` 无出口

| 字段 | 内容 |
|---|---|
| 问题 | `waiting_user` 落 attention 列但零可用动作 |
| 用户表现 | 看板告诉你「需处理」，点进去什么都做不了 |
| 根因 | `taskActions()` 对 group-chat：`retry` 需 `failed`、`abort` 需 `created\|queued\|running`，`waiting_user` 两者皆不满足；且 C1 未修时连「打开任务」都没有 |
| 本轮修法 | RC-P0-07 修好后，`waiting_user` 天然获得「打开任务」出口。**额外**：在详情区对 `waiting_user` 显式突出该按钮并加说明文案（新增 i18n key）。**不新增后端动作** |
| 长期方向 | 若产品需要，考虑 Dashboard 内联回复 |
| 涉及文件 | `run-center.js`、`src/renderer/locales/{en,zh}.json` |
| 依赖 | **RC-P0-07** |
| 风险 | 低 |
| 验证方式 | 测试：`waiting_user` task 选中后 `[data-run-center-open]` 存在且渲染提示文案 |
| Priority | P1 |
| Scope | 本轮 |

---

### RC-P1-09 — retry 新旧 task 无关联

| 字段 | 内容 |
|---|---|
| 问题 | retry 产生新 run/新 task，旧 failed task 原地不动且无关联 |
| 用户表现 | attention 列的失败卡片永不消失，旁边多一张新卡片，看不出是同一件事的两次尝试 |
| 根因 | `retryGroupChat()` → `enqueue()` 新起 run → `startRun()` 用新 `runId` 建全新 parent task，`CreateCogSeedTaskInput.retryOfTaskId` 未被传入 |
| 本轮修法 | `ipc-service.action()` 的 retry 分支把原 `taskId` 透传下去；`bus.ts` `_enqueueBody()` 的 `startRun()` 调用带上 `retryOfTaskId`（经 `actionRequestId` 关联回原 task）。projection 中透出 `retryOfTaskId`，UI 在卡片与详情区标注「重试自 …」 |
| 长期方向 | 建立 run 谱系视图 |
| 涉及文件 | `ipc-service.ts`、`group-chat-task-bridge.ts`、`bus.ts`、`run-center.js` |
| 依赖 | RC-P0-01 |
| 风险 | **中** — 需触碰 `bus.ts:_enqueueBody`，是并行开发热点（见 §7） |
| 验证方式 | 测试：retry 后断言新 task `retryOfTaskId === 旧 taskId`；projection 透出该字段；UI 渲染关联标注 |
| Priority | P1 |
| Scope | 本轮 |

---

### RC-P2-10 — resume 语义核验（**非 bug，仅验证**）

| 字段 | 内容 |
|---|---|
| 问题 | 需确认 resume 不会对 group-chat 误显示 |
| 用户表现 | 当前无误显示 |
| 根因 | 查证结论：`taskActions()` 对 group-chat 恒 `resume:false`（F-09），UI 从不渲染；`action()` 的 throw 仅在直接调 IPC 时可达。**契约实际是一致的** |
| 本轮修法 | 仅补测试锁定该不变量，不改代码 |
| 长期方向 | — |
| 涉及文件 | `test/` |
| 依赖 | RC-T01 |
| 风险 | 无 |
| 验证方式 | 测试：group-chat task 各状态下 `actions.resume === false`；UI 无 `data-run-center-action="resume"` |
| Priority | P2 |
| Scope | 本轮 |

---

### RC-P2-11 — filter scope 跨 tab 不一致

| 字段 | 内容 |
|---|---|
| 问题 | filter chip 在 Runs / Collaboration 视图仍高亮但无效 |
| 用户表现 | 选了「运行中」切到「协作」，chip 还亮着，内容却没过滤 |
| 根因 | `state.filter` 只被 `boardHtml()` 消费；chip 渲染在共享 toolbar |
| 本轮修法 | 非 board 视图时隐藏（或 disable + `aria-disabled`）filter chip 组 |
| 长期方向 | 让 filter 在 Runs 的任务树上也生效 |
| 涉及文件 | `run-center.js` |
| 依赖 | 无 |
| 风险 | 极低 |
| 验证方式 | 测试：切到 runs/collaboration 后 `.run-center-filter` 不可见或 disabled |
| Priority | P2 |
| Scope | 本轮 |

---

### RC-P2-12 — `activity` icon 缺失

| 字段 | 内容 |
|---|---|
| 问题 | 侧边栏「运行中心」显示 info（ⓘ）图标 |
| 用户表现 | 图标语义错误 |
| 根因 | `index.html:45` 用 `data-ui-icon="activity"`，但 `icons.js` `UI_ICONS` 无该 key，查表回退 `UI_ICONS.info` |
| 本轮修法 | 在 `icons.js` 补 `activity` 图标，或改用已有合适 key |
| 长期方向 | 增加「未知 icon key」的构建期校验 |
| 涉及文件 | `src/renderer/modules/icons.js`（或 `index.html`） |
| 依赖 | 无 |
| 风险 | 极低 |
| 验证方式 | 测试：`UI_ICONS['activity']` 存在 |
| Priority | P2 |
| Scope | 本轮 |

---

### RC-P0-13 — 卡片身份不可辨识  ★ 被 DECISION-01 阻塞

| 字段 | 内容 |
|---|---|
| 问题 | 卡片与运行记录标题高度同质 |
| 用户表现 | 8 张卡片只有两种标签，3 条运行记录同名，无法定位到具体会话/轮次 |
| 根因 | F-21：`rendererTaskTitle()` 返回硬编码常量（刻意的隐私收敛） |
| 本轮修法 | 落地 DECISION-01 的选定方案 |
| 长期方向 | 与 Observability 的隐私授权通道统一 |
| 涉及文件 | `ipc-service.ts`、`run-center.js`、`run-center-board.js`、`locales/{en,zh}.json` |
| 依赖 | **DECISION-01** |
| 风险 | 中 — 触碰隐私边界，需复审 |
| 验证方式 | 测试：同 session 多个 run 的卡片标识两两不同；断言 projection 不含 prompt/objective/首条消息文本 |
| Priority | P0 |
| Scope | 本轮 |
| Decision dependency | **DECISION-01** |

---

### RC-P1-14 — orphan task 无清理

| 字段 | 内容 |
|---|---|
| 问题 | 删除会话后对应 CogSeed task 永久残留 |
| 用户表现 | 不可见（被 `visibleDashboardTasks()` 过滤），但持续拖慢每次刷新 |
| 根因 | F-22：`dropConv()` 只 `purgeGroupDir()`，不级联清理 |
| 本轮修法 | `dropConv()` 增加 best-effort 级联：按 `conversationId` 删除对应 task JSON + events JSONL + request claim。失败不阻塞会话删除 |
| 长期方向 | 统一的数据保留策略与后台 compaction |
| 涉及文件 | `src/main/features/group_chat/index.ts`、`src/main/features/cogseed_backend/task-store.ts` |
| 依赖 | RC-T00 |
| 风险 | **中** — 删除操作。必须先按 `conversationId` 精确匹配，且只删 `executionKind==='group-chat'` |
| 验证方式 | 测试：建 group-chat task → `dropConv` → 断言 task 文件与 events 文件均不存在；断言非 group-chat task 不受影响 |
| Priority | P1 |
| Scope | 本轮 |

---

### RC-P1-15 — `listCogSeedTasks()` 无界全盘扫描

| 字段 | 内容 |
|---|---|
| 问题 | 无 limit 的串行全目录读，且每次 Refresh 调 2 次 |
| 用户表现 | 使用越久刷新越慢；开启轮询后成倍放大 |
| 根因 | F-22：`task-store.ts:325-337` readdir + 逐文件 `readFile`+validate；`boardProjection()` 与 `sessionListProjection()` 各调一次 |
| 本轮修法 | **(1)** 给 `listCogSeedTasks()` 加可选 `{ limit, since }`，Dashboard 路径默认「活跃优先 + 近 N 天」；**(2)** 单次 IPC 内复用一次扫描结果（`board()` 与 `sessions()` 若同请求周期则共享）；**(3)** 明确保留策略：archived 超出窗口的历史任务仍可通过 session 详情访问，看板只展示窗口内 |
| 长期方向 | 索引文件或 SQLite；event compaction |
| 涉及文件 | `task-store.ts`、`ipc-service.ts` |
| 依赖 | **必须与 RC-P0-02 同轮**（轮询会放大此问题） |
| 风险 | 中 — 改变可见任务集合，需与 RC-P0-06 的空看板文案协同 |
| 验证方式 | 测试：构造 >limit 个 task，断言返回被正确截断且按 `updatedAt` 降序；断言活跃任务不被窗口裁掉 |
| Priority | P1 |
| Scope | 本轮 |

---

### RC-P2-16 / RC-P2-17 — `visibleDashboardTasks()` N+1、`groupIdForTask()` 重复上溯

| 字段 | 内容 |
|---|---|
| 问题 | 读侧微优化 |
| 用户表现 | 当前规模（个位数任务）无可感知影响 |
| 根因 | E3 已 `Promise.all` 且按 distinct conversation 收敛；E4 在 `boardProjection()` 内三轮调用 |
| 本轮修法 | **不做。** 记录并在 RC-P1-15 落地后重新测量 |
| 长期方向 | 与索引方案一并处理 |
| 涉及文件 | `ipc-service.ts` |
| 依赖 | RC-P1-15 |
| 风险 | — |
| 验证方式 | RC-P1-15 后补一条性能基准 |
| Priority | P2 |
| Scope | **下一阶段** |

---

### RC-P1-18 — 前后端契约死字段收口

见 §13 逐字段表。

| 字段 | 内容 |
|---|---|
| 依赖 | RC-P0-01、RC-P0-06、RC-P0-13（这些会改变哪些字段真正被消费） |
| Priority | P1 |
| Scope | 本轮 |

---

## 7. Phase 0 — 基线与开发安全

### Git 现状

| 项 | 值 |
|---|---|
| 基线 commit | `0c0b7907` |
| 与 `origin/develop` 关系 | `git rev-list --left-right --count origin/develop...0c0b7907` → `0  1` |
| 结论 | **clean fast-forward**，parent 即 develop tip `0101219d`，当下零冲突 |

### 分支策略

- 分支名：`feat/run-center-v1-hardening`
- 切出点：**`0c0b7907`**（不是 develop——必须包含被加固的实现）
- 合并目标：`develop`

### 并行开发冲突热点

| 文件 / 函数 | 为何危险 | 本轮触碰它的 TODO |
|---|---|---|
| `bus.ts` `_enqueueBody()` | 高频热点，本次已插入 `opensObservedRun` 门控 | RC-P1-09 |
| `bus.ts` `runActorTurn()` | 已插入 `startTurn()` / `finishTask()` | 可能 RC-P0-04 |
| `bus.ts` `_emitTaskRunTerminalIfQuiescent()` | 已改为 `trackBackgroundWrite()` 包裹 | RC-P1-03 相关 |
| `conversations.sendStream` 签名 | 本次新增 `retry_request_id` 参数 | RC-P1-09 |
| `ipc-service.ts` | 本轮改动最密集 | 多数 TODO |

### rebase 节奏

- **每日** rebase 一次 `origin/develop`
- 触碰 `bus.ts` 的 TODO（RC-P1-09）**单独成 PR 且优先合入**，缩短暴露窗口
- Phase 边界处强制 rebase + 全量跑测试

### Phase 0 DoD

- [ ] `feat/run-center-v1-hardening` 已从 `0c0b7907` 建立
- [ ] 现有相关测试全绿并存档基线（`task-store` / `group-chat-task-bridge` / `group-chat-dashboard-action` / `renderer-projection` / `run-center` / `bus` / `bus-integration` / `failed-turn-retry`）
- [ ] 冲突热点清单已同步给并行开发者
- [ ] 本 spec 与 TODO 已评审通过

---

## 8. Phase 0.5 — 最小 Renderer 交互测试脚手架

> **前移的理由**：Phase 1–3 全是行为改动。当前 renderer 测试 4 个 case 中 3 个是字符串匹配（F-23），抓不住任何回归。若等 Phase 6 再补，等于 Phase 1–5 全程裸奔。

### 已知障碍与对策

| 障碍 | 事实 | 对策 |
|---|---|---|
| `window.cogseed` 不可替换 | 实测 `{writable:false, configurable:false, frozen:true}`（contextBridge 冻结） | **必须在加载 `run-center.js` 之前**把 mock 定义到 jsdom 的 window 上，不能事后覆盖 |
| 无 DOM 环境 | F-24：无 jsdom/happy-dom，`vitest.config.ts` 未设 `environment` | 新增 `jsdom` devDependency，测试文件用 `// @vitest-environment jsdom` docblock 局部启用，**不改全局默认** |
| **jsdom 不做 layout** | F-24 仓库注释：「do no layout anyway」 | **`getBoundingClientRect()` 恒为 0 → 布局类断言在单测中不可能成立。** RC-P0-06 的可见性验证必须走结构断言 + 真实浏览器冒烟 |

### 脚手架设计

`test/renderer/_run-center-harness.ts` 提供：

1. `createRunCenterHarness({ board, sessions, detail })`
   - 建 jsdom document，注入 `#run-center-root` fixture
   - 在**加载模块前**定义 `window.cogseed = { invoke: recordingMock }`
   - 定义 `window.t`（返回 key 或查真 locale）、`window.getLang`、`window.setView`（spy）
   - 用 `vm.runInContext` / `import` 加载 `run-center-board.js` → `run-center.js`（保持顺序，与 `lazy-features.js` manifest 一致）
2. `harness.invocations` — 记录所有 `(channel, payload)`
3. `harness.setResponse(channel, value)` — 可在测试中途改变返回，模拟状态翻转
4. `harness.click(selector)` / `harness.html()` — 交互与断言助手

### Phase 0.5 必须能测（修正后）

| # | 测试 | 可行性 |
|---|---|---|
| 1 | 点 Refresh → `cogseed.session.read` 被调用 | ✅ |
| 2 | 选中 Task → detail 正确渲染（taskId / status / errorCode） | ✅ |
| 3 | mock 状态变化 → Board 卡片所在列发生变化 | ✅ |
| 4 | ~~completed 列实际可见~~ → **改为**：4 个 column 节点均存在于 DOM 且 completed 列含预期卡片数 | ⚠️ 原命题不可测（F-24），已改写 |
| 5 | Open Task button 可达（`[data-run-center-open]` 存在） | ✅ |

### 反「字符串匹配」硬性要求

- 禁止在新测试中使用 `fs.readFileSync(source)` + `toContain(...)` 作为**主要**断言
- 每条测试必须至少断言一项**运行时产物**：被调用的 IPC channel、DOM 节点、spy 调用参数

### Phase 0.5 DoD

- [ ] `jsdom` 已加入 devDependencies，`sbom:check` / `reuse:check` 通过，license 已归档
- [ ] `_run-center-harness.ts` 可在加载模块前注入 mock `window.cogseed`
- [ ] 上表 5 条（含改写后的第 4 条）全部通过
- [ ] 新测试零 source-string 主断言

---

## 9. Phase 1 — Refresh / Realtime / 状态收敛

### 9.1 修完整 Refresh（RC-P0-01）

目标：

```
Refresh → Board + Session list + 当前 selected detail + Timeline + Collaboration
```

必须处理的边界：

| 边界 | 处理 |
|---|---|
| selected task 已消失 | 回落到 board 首个 task；若 board 为空则清空选中并显示空态 |
| selected session 已删除 | `sessionProjection()` 已返回 `{session:null, collaboration:null}`；前端需清空选中而非停在 error |
| loading 状态 | `state.loading` 覆盖 board；detail 重拉期间不应整屏闪空（`select()` 当前会 `state.detail=null` → 需保留旧内容直到新数据到达） |
| 重复 IPC | `action()` 路径已 `refresh()+select()`；改造后 `refresh()` 自身含 select，需去掉 `action()` 中的重复 `select()` |

### 9.2 自动更新（RC-P0-02）

本轮方案（低风险）：

```
条件：panel-run-center.active && !document.hidden && !state.busyAction
周期：5s → refresh()
```

必须保证：
- 只有 Run Center active 才轮询
- 离开页面 / `document.hidden` 停止
- 不重复创建 interval（单例 + teardown）
- `busyAction` 期间不并发 refresh
- `visibilitychange` 回到可见时**立即**补一次 refresh

长期方向（本轮不做，但不得堵死）：

```
transitionCogSeedTask / appendCogSeedTaskEvent
    → webContents.send('cogseed:task-changed', {taskId, sessionId, status})
    → preload PUSH_EVENT_PREFIXES 增加 'cogseed:'
    → renderer onPushEvent('cogseed:task-changed', () => refresh())   ← 复用 RC-P0-01 的完整 refresh 入口
```

> 参考现成范式：`src/renderer/modules/touchpoint-settings.js:422`。
> **警告**：不要复用 `cogseed.task.events` stream —— F-14 证实它是一次性读，不是订阅。

### 9.3 abort / retry 收敛（RC-P1-03）

```
用户点击 action
   ↓
真实 Runtime action（abort/retry）
   ↓
进入确认窗口：cadence 1s，timeout 10s
   ↓
终止条件：
   abort → task.status ∈ {cancelled, failed, completed}
   retry → 出现 retryOfTaskId === 原 taskId 的新 task（依赖 RC-P1-09）
   ↓
到达 → 停止确认，释放 busyAction
超时 → 停止确认，保留最后真实快照 + 提示「状态确认超时」，绝不伪造
```

### Phase 1 DoD

- [ ] Refresh 刷新 Board + Session list + Detail + Timeline + Collaboration
- [ ] Run Center 可见时最大状态延迟 ≤ 5s，且该上界有测试锁定
- [ ] 离开 / hidden 时轮询停止，重复进入不产生第二个 interval
- [ ] abort 后 UI 最终收敛到 `cancelled`
- [ ] 超时路径不伪造状态

---

## 10. Phase 2 — Restart / Recovery

### 选定方案（唯一，不列备选）

> Group Chat task 在 App 重启后，若真实 Runtime 无法恢复
> → **不进入 `recoverable` 僵尸态**
> → 明确落为 `failed`，`errorCode = 'app_restart'`

**成立依据（F-18）**：`group_chat/index.ts:213-216` 表明 Group Chat 对孤儿 running 的处理是 `healing orphan running state` → `setStatus(idle)`，**上游本身没有 run 恢复能力**。影子任务落终态与上游一致。

### 落地要点

| 项 | 决定 |
|---|---|
| 何时跑 | `src/main/index.ts` 用现有 `registerDeferred('cogseed:task-recovery', ...)`，先例：`skills:version-recovery`(`:1223`)、`recall:capture-recovery`(`:1336`) |
| 扫描哪些状态 | `created` / `queued` / `running`（沿用 `recovery.ts` 现有谓词） |
| parent run task | 落 `failed` + `app_restart` |
| 未完成 child turn task | 同样落 `failed` + `app_restart` |
| `cogseedTaskId` 丢失 | 本轮**不持久化**；靠状态扫描收敛。持久化列为长期方向 |
| `taskActions` | 同 PR 确认 `failed` 的 group-chat 给出 retry；对 `groupChatMessageId` 缺失的 parent run task 明确处理 |
| retry 能否进新 run | 能——`failed` 满足 `taskActions().retry` 条件，走 RC-P1-09 建立关联 |
| 非 group-chat task | 维持现有 `markCogSeedTaskRecoverable()` 不变 |

### 硬性约束

**恢复状态与 action 语义必须同一个 PR 落地。** 不得出现 `running zombie → recoverable zombie` 这种换标签版本。

### Phase 2 DoD

- [ ] 启动时自动跑 CogSeed task recovery，失败不阻塞启动
- [ ] 重启后不存在 `status==='running'` 的 group-chat task
- [ ] 重启后不存在 `status==='recoverable'` 的 group-chat task
- [ ] `app_restart` 失败任务在 UI 上有可用 retry 出口
- [ ] 非 group-chat task 恢复行为未回归

---

## 11. Phase 3 — 用户可达性

### 3A 交互可达
RC-P0-07（Open Task）→ RC-P1-08（waiting_user 出口，依赖 07）→ RC-P1-09（retry 关联）→ RC-P2-10（resume 核验）→ RC-P2-11（filter scope）

### 3B 视觉可达
RC-P0-06（completed 列裁剪，**P0**）→ RC-P2-12（activity icon）→ 空看板文案与 RC-P1-15 的窗口策略协同

**RC-P0-06 不允许只在 1456px 修死一个宽度**，必须给出 responsive 方案并在 720 / 1050 / 1456 / 1920 四档验证。

### 3C 卡片身份可辨识
RC-P0-13，**被 DECISION-01 阻塞**。

### Phase 3 DoD

- [ ] completed 列在 720 / 1050 / 1456 / 1920 四档均可见
- [ ] 卡片可辨识（DECISION-01 落地）
- [ ] Open Task 正常工作
- [ ] `waiting_user` 可进入原 Conversation
- [ ] retry 历史可辨认
- [ ] UI action 与后端真实能力一致（含 resume 不误显示、filter scope 一致）
- [ ] `activity` icon 正确

---

## 12. Phase 4 — 数据生命周期止血

### 本轮必须（P1）
- RC-P1-14 orphan task 级联清理
- RC-P1-15 `listCogSeedTasks()` 时间窗 / limit / 活跃优先；单次 Refresh 不重复完整扫描

### 本轮不做（P2 → 下一阶段）
- RC-P2-16 `visibleDashboardTasks()` N+1（已 `Promise.all` + distinct 收敛）
- RC-P2-17 `groupIdForTask()` 重复上溯
- 索引 / SQLite / event compaction

### 保留策略（本轮定义）

| 范围 | 策略 |
|---|---|
| active（非终态） | **永远可见**，不受时间窗裁剪 |
| recent | 默认近 N 天（建议 7 天，评审确认）进看板 |
| archived / 超窗 | 不进看板，但仍可通过 Session 详情访问 |
| orphan（会话已删） | `dropConv` 时级联删除 |

### 已知增长驱动（本轮不重构）

「每个 actor turn 独占一个 Task + 一个 events JSONL」是根本增长驱动 —— 见 **DECISION-02**，本轮明确记为架构债务。Phase 4 只止血，不治本。

### Phase 4 DoD
- [ ] 删除会话后对应 CogSeed task / events / claim 被清理
- [ ] `listCogSeedTasks()` 有明确上界，活跃任务不被裁掉
- [ ] 单次 Refresh 不产生重复完整扫描
- [ ] 保留策略已文档化并评审通过

---

## 13. Phase 5 — 前后端契约收口

| 字段 | 处置 | 理由 |
|---|---|---|
| `board.counts` | **DELETE** | 前端用 `items.length` 计数，且过滤后与 counts 不一致，留着会误导 |
| `board.updatedAt` | **KEEP + RESERVED** | 未来增量刷新 / push 去重需要，标注用途 |
| `reviews` | **KEEP + DISPLAY** | 协作视图明显该有；已算好，前端补渲染成本低 |
| `conflicts` | **KEEP + DISPLAY** | 同上；冲突是用户必须知道的「需处理」信号 |
| `recovery` | **KEEP + DISPLAY** | Phase 2 后 `app_restart` 场景需要它驱动提示 |
| `session.taskCount` | **KEEP + DISPLAY** | 运行记录列表补「N 个任务」，直接提升可辨识性（与 DECISION-01 协同） |
| `session.activeTaskCount` | **KEEP + DISPLAY** | 同上 |
| `session.hasRecovery` | **KEEP + DISPLAY** | 同 `recovery` |
| `group.status` | **KEEP + RESERVED** | 分组头部未来展示；当前仅用 progress |
| `group.titleKey` | **KEEP + RESERVED** | 同上 |
| `group.coordinationId` | **KEEP + RESERVED** | CogSeed 原生协作路径需要 |
| `actions.skip` | **DELETE** | `action()` 对 skip 直接 throw，产品不可用；留着是假承诺 |
| `skillVersionPinStatus` | **KEEP + RESERVED** | 技能版本治理相关，非 Run Center 职责，标注归属 |

**规则**：标 RESERVED 的字段必须在 `ipc-service.ts` 对应类型定义处加注释说明预期消费方与时间点，否则下轮再审时同样无从判断。

### Phase 5 DoD
- [ ] 上表每字段处置已实施
- [ ] DELETE 的字段已从类型定义与实现中移除
- [ ] RESERVED 的字段均有用途注释
- [ ] 不存在「后端算、前端永不读、且无注释」的字段

---

## 14. Phase 6 — 补齐 P0/P1 测试

### Renderer（基于 Phase 0.5 脚手架）

| 测试 | 完成标准 |
|---|---|
| Refresh 重拉 detail | 已选中状态下 `refresh()` 后 `cogseed.session.read` 被调用，且 DOM 中 detail 内容更新 |
| Timeline 更新 | mock 新增 event → 重拉后 timeline `li` 数量增加 |
| Collaboration 更新 | mock workflow step 状态变化 → 重拉后 DOM 反映 |
| polling lifecycle | 进入建立 / 离开停止 / 重复进入不重复建立 / `busyAction` 期间不并发 |
| completed 列 | **结构断言**：4 column 节点存在且 completed 含预期卡片数（**非** layout 断言，见 F-24） |
| Open Task | `[data-run-center-open]` 存在且点击调用 `setView('conversation', cid)` |
| waiting_user | 出口按钮 + 提示文案渲染 |
| retry UI | 新旧关联标注渲染 |
| resume 不误显示 | 各状态下 `actions.resume === false` 且 DOM 无 resume 按钮 |
| filter scope | 非 board 视图 chip 不可见/disabled |
| 卡片身份 | 同 session 多 run 标识两两不同，且不含 prompt/objective |

### Main / Integration

| 测试 | 完成标准 |
|---|---|
| Group Chat run → parent Task | 真实 bus + mock bridge（已有 `bus.test.ts` 范式，扩展） |
| actor turn → child Task | 同上，断言 `parentTaskId` |
| abort → Runtime → cancelled | **真实 FS**：abort 后驱动终态投影，断言 task 最终 `cancelled` |
| retry → new run/task + relation | 断言新 task `retryOfTaskId === 旧 taskId` |
| restart → failed/app_restart | 真实 FS：构造 running task → 跑 recovery → 断言 `failed` + `app_restart`，且无 `recoverable` |
| retry after app_restart | `app_restart` 任务的 `actions.retry === true` 且可成功触发 |
| orphan cleanup | `dropConv` 后 task/events/claim 均不存在；非 group-chat 不受影响 |
| query limit / retention | 超 limit 截断正确；活跃任务不被裁 |

### 至少一条较真实闭环

```
Renderer(harness) → invoke('cogseed.task.action')
    → 真实 ipc-service.action()
    → 真实 group_chat.abort() / retryFailedTurn()（真实 FS，mock 到 bus 边界）
    → 真实 Task projection
    → Renderer refresh → 断言 DOM 收敛
```

**不要求完整 Electron E2E**，但不得全部 mock 到只剩函数名 —— 至少 `ipc-service` 与 `task-store` 必须是真实实现 + 真实文件系统。

### 真实浏览器冒烟（RC-P0-06 专用）

沿用本次审查的 Electron + CDP 驱动脚本，固化为可选 smoke（不进默认 CI）：
在 720 / 1050 / 1456 / 1920 四档断言每个 column 的 `right <= .run-center-main` 的 `right`。

### Phase 6 DoD
- [ ] 上述 Renderer 与 Main 表格全部实现且通过
- [ ] 至少一条较真实闭环测试存在
- [ ] 新测试零 source-string 主断言
- [ ] 真实浏览器冒烟脚本已固化并可手动运行
- [ ] 覆盖率不低于 `vitest.config.ts` 现有阈值（lines 61 / functions 62 / statements 58 / branches 52）

---

## 15. 测试策略

| 层 | 手段 | 用途 | 限制 |
|---|---|---|---|
| 纯逻辑 | 现有 `vm.runInContext` | `filteredTasks()` 等无 DOM 依赖函数 | 无 DOM |
| Renderer 交互 | **新增** jsdom + harness | 点击 / IPC 调用 / DOM 断言 | **无 layout**（F-24） |
| Projection | 现有 vitest + mock deps | `ipc-service` 各 projection | 全 mock |
| Store / 生命周期 | vitest + 真实 FS | task-store / recovery / orphan | — |
| Bus 集成 | 真实 bus + mock bridge | run/turn 投影 | — |
| 布局 | **Electron + CDP 冒烟** | RC-P0-06 可见性 | 手动 / 可选 CI |

---

## 16. 本轮 Definition of Done

- [ ] completed 列在常见窗口宽度真实可见（720/1050/1456/1920 四档）
- [ ] Run Center 卡片可辨识（DECISION-01 已落地）
- [ ] Refresh 刷新 Board + Detail + Timeline + Collaboration
- [ ] Run Center 状态最大延迟有明确上界（≤5s，有测试锁定）
- [ ] 自动更新只在 Run Center 可见时工作，teardown 正确
- [ ] abort 后 UI 最终收敛到 `cancelled`
- [ ] retry 后能识别新 run 与旧 failed task 的关系
- [ ] App 重启不会遗留永久 running zombie
- [ ] 也不会遗留 recoverable zombie
- [ ] `app_restart` 状态有明确 retry 出口
- [ ] `waiting_user` 可以进入原 Conversation
- [ ] Open Task 正常工作
- [ ] Resume UI 与真实能力一致
- [ ] filter scope 与 tab 语义一致
- [ ] orphan task 有治理
- [ ] list 查询有合理边界，活跃任务不被裁
- [ ] 契约死字段有明确去留，RESERVED 均有注释
- [ ] P0/P1 有真实测试覆盖（非 source-string）
- [ ] **不破坏当前 renderer-safe 隐私边界**
- [ ] **不堵死下一阶段 event-driven observability**（refresh 入口即未来 push 挂载点）

---

## 17. 下一阶段：Observability Expansion（本轮明确不做）

**不做清单**：Token / Cost / Trace / Span / Logs / Tool input-output / 完整 Tool result / Model metadata / latency breakdown / queue-concurrency metrics / deep runtime diagnostics。

### 长期目标架构

```
Runtime (Group Chat bus / CogSeed runtime-controller)
        ↓
Event / Metrics / Trace 采集层
        ↓
authorized renderer-safe observability projection   ◀── 授权 + 白名单，不是旁路
        ↓
Run Center
```

### 硬性红线

**不允许为了 Observability 直接取消当前隐私白名单，把敏感 Runtime payload 原样暴露给 Renderer。**

任何深度可观测能力必须经由「用户授权 + renderer-safe projection」通道，而不是绕过 `rendererSafeIdentifier()` / `safeToolEventsFromGroupChatProcess()` 这类现有约束。这也是本轮**保留** `rendererSafeIdentifier` 白名单机制、而非为了好用把它拆掉的原因。

---

## 18. 长期架构债务

| # | 债务 | 来源 | 建议处理时机 |
|---|---|---|---|
| D-1 | 每个 actor turn 独占一个 Task + 一个 events JSONL，写放大与增长无上界 | DECISION-02 | Observability Expansion（与 event schema 一并决策） |
| D-2 | `state.taskRun.cogseedTaskId` 仅内存，关联本身不可恢复 | F-16 | Phase 2 之后独立小改造 |
| D-3 | Group Chat 的 `healing orphan running state` 与 CogSeed recovery 是两套判定 | F-18 | 统一为单一谓词 |
| D-4 | 无 push 通道，preload 白名单缺 `cogseed:` 前缀 | F-13 | Observability Expansion 前置 |
| D-5 | `cogseed.task.events` 命名为 stream 实为分页读，契约误导 | F-14 | 改造为真订阅时一并正名 |
| D-6 | Task Store 无索引，全目录扫描 | F-22 | 规模化时引入索引/SQLite |
| D-7 | 仓库缺 DOM 测试环境，renderer 测试长期靠字符串匹配 | F-24 | Phase 0.5 引入后推广为全仓标准 |
| D-8 | 布局正确性无法被单元测试覆盖 | F-24 | 建立轻量真实浏览器冒烟层 |

---

## 19. 执行顺序图

```
Phase 0    基线 / 分支 / rebase 节奏
   │       RC-T00
   ▼
Phase 0.5  最小 Renderer 交互测试脚手架          ★ 前移
   │       RC-T01
   ▼
Phase 1    Refresh + 自动更新 + abort/retry 收敛
   │       RC-P0-01 → RC-P0-02 → RC-P1-03
   │       (RC-P0-02 必须与 RC-P1-15 同轮)
   ▼
Phase 2    重启恢复：group-chat 中断 → failed + app_restart
   │       RC-P0-04 + RC-P0-05  ← 同一 PR，不可拆
   ▼
Phase 3    用户可达性
   │       3A RC-P0-07 → RC-P1-08 → RC-P1-09 → RC-P2-10 → RC-P2-11
   │       3B RC-P0-06(P0) → RC-P2-12
   │       3C RC-P0-13  ← 阻塞于 DECISION-01
   ▼
Phase 4    数据生命周期止血
   │       RC-P1-14 → RC-P1-15
   │       DECISION-02 记为债务，不重构
   ▼
Phase 5    前后端契约收口
   │       RC-P1-18
   ▼
Phase 6    补齐所有 P0/P1 测试
   │
   ▼
Run Center v1 Hardening Done
   │
   ▼
Observability Expansion
```

**并行说明**：DECISION-01 应在 Phase 1 期间并行决策，否则会阻塞 Phase 3 收尾。
