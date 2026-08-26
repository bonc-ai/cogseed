# RC-P1-14 — conversation 删除的级联清理（Phase 4）

> 完成 2026-08-26 · 分支 `feat/run-center-v1-hardening`
> 执行于 Phase 5 之后（调序理由见 spec §12 顶部）

## 1. 落点更正（本阶段最重要的事实）

原 TODO 写的挂载点是 `group_chat/index.ts::dropConv()`。核查结论：

- 该函数实际在 `:1212`（非 `:1201`），且**在 `src/` 与 `test/` 中零调用方** ——
  所有 `dropConv` 引用指向的都是 `bus.ts:10841` 的同名函数
- 真实编排是 `chats.ts:2297 _purgeDeletedConversationFiles()`，由
  `chats.deleteConversation()` 调用

**按原落点实现，cleanup 在生产中永不执行。** 已挂到真实路径，并有测试锁定
（`conversation-cleanup-integration.test.ts` 断言 hook 在 `_purgeDeletedConversationFiles`
内、可从 `deleteConversation` 到达、且**没有**被写进那个死函数）。

## 2. 新增 cleanup primitive

`task-store.ts` 此前**没有任何删除 API**。新增最小 primitive，不设计通用框架：

```ts
purgeCogSeedGroupChatTasksByConversation(userId, conversationId)
  → { purgedTaskIds, failedTaskIds }
```

形状参照既有先例 `connector-store.ts:146 deleteCogSeedConnector`。

**选择条件（逐条记录自答，不走树）**：
```
executionKind === 'group-chat' && conversationId === targetConversationId
```

**每个命中 task 清理 4 个文件**：

| 文件 | 路径 |
|---|---|
| task JSON | `cogseedTaskFile` |
| events JSONL | `cogseedTaskEventsFile` |
| **per-task 投影缓存** | `cogseedTaskProjectionFile`（`task-events/_projections/<taskId>.json`，核查中发现，原 TODO 未列） |
| request claim | `cogseedRequestClaimFile(userId, task.requestId)` |

## 3. 四条安全约束及其依据

**① 精确范围** —— 只删 `group-chat` 且 `conversationId` 精确匹配。
依据：`interactive-turn.ts:65` 创建的 per-agent 追问任务带**同一个 `conversationId`**，
但 `executionKind` 是 `local-cli` / `cogseed-native`，是真实在跑的路径。
按 conversationId 粗删会摧毁独立的 agent 运行历史。

**② 不依赖树完整性** —— 逐条按自己的 `conversationId` + `executionKind` 判断。
依据：`RC-P2-20` 已证实存在「parent 缺失、child 仍在」的形状；任何靠 `parentTaskId`
上溯来判定归属的做法会**恰好漏掉这些孤儿**。

**③ claim 与 task 同删** —— 依据：`task-store.ts:454` 在 claim 指向的 task 缺失时抛
`CogSeed request claim references a missing task`。悬空 claim 不是惰性垃圾，
它会让后续 `readCogSeedTaskByRequestId` 与创建路径**抛错**。

**④ 读不出来的记录不删** —— 无法证明它匹配，就不能删。这类记录进 `failedTaskIds` 上报，
不做「解析失败即删除」的盲删。

## 4. 方案 (c)：native task 数据保留，失效出口移除

### c1 vs c2 的判定（选 **c2**，依据来自代码而非偏好）

1. **投影是历史面**：`ipc-service.ts:913 / 925` 两处注释明写
   *"Unwindowed on purpose: an aged-out task must stay reachable here"* ——
   session/collaboration 投影**故意不套保留窗口**，就是为了让老任务仍可访问；
2. **保留数据只有在可达时才有意义**：既然已拍板不删这些 native task 的磁盘数据，
   c1（整条不进投影）会让「保留」变成事实上的不可见，自相矛盾；
3. **仓库刚建立同型先例**：`RC-P2-20` 的「记录还在、上下文没了 → 保持可见 + 标注不可用」
   （`run_center.parent_run_unavailable`）正是同一模式。

→ **c2**：native task 继续作为历史条目显示，但 `conversationId` 不透出、不提供 action，
并渲染 `conversation unavailable` 说明。

### 两种 executionKind 的差别待遇（有原则，非例外）

| kind | 会话被删后 | 理由 |
|---|---|---|
| `group-chat` | **整条不进投影**（并由本阶段物理删除） | shadow task 是 conversation 的**投影**，脱离会话没有独立含义。这正是 `visibleDashboardTasks` 原本就这么写的原因；该过滤同时是 best-effort 清理失败时的兜底，防止幽灵复活 |
| `local-cli` / `cogseed-native` | **保留可见**，`conversationId` withheld + `conversationUnavailable: true` | 独立的 agent 运行历史，有自己的 timeline / agentId / 状态 |

### 实施中发现并修掉的两处真实缺口

1. **session fallback 会复活死出口** —— `boardProjection` 原本用
   `task.conversationId || session?.conversationId` 兜底。若不拦，刚被 withhold 的
   conversationId 会从 session 侧被塞回去。已加守卫，并有断言
   「整个 board 序列化后不含该 conversationId」。
2. **详情区绕过了可见性解析** —— `collaborationSnapshot` 的 selected task 走
   `readTask()` 直取，不经 `visibleDashboardTasks`，因此详情区仍会显示 Open 按钮。
   已让 selected 走同一条解析。

## 5. 测试（29 条，全绿）

**`conversation-cleanup.test.ts`（18 条，真实文件系统 + 真实 store）**

| Case | 覆盖 |
|---|---|
| 1 | 删除会话 → parent + 2 个 child 的 task JSON / events JSONL / claim **全不存在** |
| 2 | 另一 conversation 的 parent 与 child **全部保留** |
| 3 | `local-cli` 与 `cogseed-native`（各一条，参数化）共享同一 conversationId → **文件保留**；不同 conversation 的 group-chat 保留；无 conversationId 的 task 保留 |
| 5 | parent 已缺失、child 的 conversationId 匹配 → **child 仍被清**（不走树的证明） |
| 7 | 连续两次执行：第二次返回空且不报错；对从未有 task 的会话安全 |
| 8 | claim 与 task 同删 —— `readCogSeedTaskByRequestId` 返回 null，且**同一 requestId 可重新创建成功**（悬空 claim 会让这一步抛错） |
| — | task 目录不存在时返回结果而非抛错；**记录损坏时不盲删**，进 `failedTaskIds` 且文件仍在 |

**Case 4（decision (c)，6 条，真实 projection 对象）**
- native task **仍在 board 上**，`agentId` / `status` 完好（c2 而非 c1 的证明）
- 无 `conversationId`、无 `conversationShortId`、`conversationUnavailable === true`
- **整个 board 序列化后不含该 conversationId**（session fallback 未复活它）
- group-chat shadow task 则整条消失
- 活会话的 task 完全不受影响
- 同一判定传导到 session 详情

**`conversation-cleanup-integration.test.ts`（6 条）**
- hook 在 `_purgeDeletedConversationFiles` 内、为 `try/catch` 形态、可从 `deleteConversation` 到达
- **断言没有**被写进零调用方的 `group_chat/index.ts`
- Case 6 best-effort：purge 抛错 → 流程仍完成、有 warn、不上抛；部分失败 → warn 且继续；干净运行 → 不产生噪声日志

**`run-center-contract-display.test.ts` 追加（5 条，renderer）**
- 任务本体仍可见、详情可达、`planner` 等历史信息仍在
- 无 Open Conversation 按钮
- 文案说明「会话已删除、本运行记录仍保留」，且**不含 retry / resume 字样**
- 不误显示 resume / retry
- 活会话的任务不出现该文案，Open 按钮正常

## 6. 回归

| 范围 | 结果 |
|---|---|
| RC-P1-14 专项 | **29 passed**（18 + 6 + 5） |
| renderer + cogseed + group_chat + chats + ipc | 240 files / **2713 passed / 7 skipped** |
| Phase 0 baseline | **266 passed / 7 skipped**（与基线逐数吻合） |
| 全量 `npm run test:js` | **9595 passed / 24 failed / 105 skipped** |
| 失败集合比对 | 与已知 canvas 24 条**逐条同名**，零新增、零消失 |
| tsc / eslint | 通过 |

`+29` 相对 Phase 5 结束（9566）完全由本阶段新增测试解释。

## 7. 长期债务边界（明确不得误标 resolved）

**D-9 保持 open。** 本阶段确实会清掉「**已删除会话**下的 `waiting_user` 影子任务」，
减少了 D-9 历史累积的**一种**情况。但 D-9 的核心是
「**会话仍然存在**时，旧 `waiting_user` 影子任务由谁负责最终收口」——
那个问题完全未被触及。

**D-3 保持 open。** 本阶段新增了一条「按 conversation 判定 CogSeed 侧数据生命周期」的路径，
但它**不改动任何现有 reconciliation 谓词**（Group Chat 读时 healing / CogSeed 启动 recovery
均未触碰），因此不构成 D-3 的 future trigger，也**不等于**两套 orphan 判定的 ownership 已统一。

**D-1 / D-2 无影响。**

## 8. Phase 4 完成条件核对

- [x] production hook 正确（真实路径，非死函数，有测试锁定）
- [x] 精确删 group-chat（parent / child 各自独立判定，不依赖树完整性）
- [x] native 数据零误删（`local-cli` / `cogseed-native` 参数化验证）
- [x] native 失效出口解决（方案 c2，含 session fallback 与详情区两处缺口）
- [x] claims 不悬空（以「同 requestId 可重新创建」反证）
- [x] best-effort（抛错 / 部分失败 / 干净运行三条路径）
- [x] idempotent（连续两次、空会话）
- [x] 无新增 regression
