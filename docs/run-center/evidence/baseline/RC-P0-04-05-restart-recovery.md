# RC-P0-04 + RC-P0-05 — 重启恢复与 action 语义（执行记录）

> 执行日期：2026-08-26
> 分支：`feat/run-center-v1-hardening`
> spec: §10 ／ todo: Phase 2
> **两项作为一个不可拆分的语义闭环实现与验证。**

## 1. 开工前链路核查（8 项）

| # | 核查项 | 实际结果 |
|---|---|---|
| 1 | `recoverCogSeedTasks()` 调用入口 | 仅 `ipc-service.ts:1049/1055`（`cogseed.runtime.recover`）。**Renderer 零调用** —— 证实「存在但未接启动」 |
| 2 | `registerDeferred` 先例 | `recall:capture-recovery`(`index.ts:1336`)、`chats:index-repair`、`sessions:gc`、`kb:reconcile` 等 |
| 3 | 最合适挂载点 | 紧邻 `recall:capture-recovery`，同款 `'parallel', BOOT_HEAVY_DISK_DELAY_MS, {resourceClass:'disk', preferIdle:true}` |
| 4 | recovery 如何区分状态 | 硬编码 `created \|\| queued \|\| running` → `markCogSeedTaskRecoverable(…, 'worker_restart')`；**不覆盖 `waiting_user`** |
| 5 | `taskActions()` 语义 | group-chat：`retry = failed && conversationId && groupChatMessageId`；`resume` **恒 false**；`abort = created\|queued\|running`。→ **`recoverable` group-chat = 零动作**（证实 spec 判断） |
| 6 | Group Chat orphan healing | 谓词 `(state.status==='running' \|\| diskInFlight.length>0) && !runtime.processing && !backendActive` → `setStatus(uid,cid,'idle')`；**读时惰性**；无 run resume |
| 7 | parent / child 是否都会遗留非终态 | **都会**。`startRun` 与 `startTurn` 均经 `advanceToRunning` 走到 `running`，只有 `finishTask` 使其终态 |
| 8 | `groupChatMessageId` 缺失时 retry | `ipc-service.ts:1014` 抛 `'Group Chat retry target is unavailable'`；`taskActions().retry` 已为 false |

## 2. 与 spec §10 的三处不符（**方案已调整，非机械照旧**）

### 2.1 ★ 阻断级：状态机禁止「非终态 → failed」

`lifecycle.ts` 的 `TRANSITIONS` 原文：

```
created:      ['queued', 'cancelled', 'recoverable']    ← 无 'failed'
queued:       ['running', 'cancelled', 'recoverable']   ← 无 'failed'
running:      [... 'failed' ...]                         ← 有
waiting_user: ['queued', 'cancelled']                    ← 无 'failed' 也无 'recoverable'
recoverable:  ['queued']                                 ← 无 'failed'
```

即 `transitionCogSeedTask(created → failed)` 会抛 `invalid CogSeed task transition`。
**spec 的既定方案对 `created`/`queued` 根本无法执行**，对历史遗留的 `recoverable` 也无法治愈。

**处置**：最小扩边三条 —— `created→failed`、`queued→failed`、`recoverable→failed`。
理由写入代码注释：任务可以在开始运行前就死掉（宿主进程消失）；`recoverable→failed` 用于「后来判定其实无法恢复」。
扩边是**加边不是改边**，只放宽不收紧，且无任何测试断言这些边非法（`lifecycle.test.ts` 只断言终态拒绝，未受影响）。

### 2.2 ★ 阻断级：「`failed` 有现成 retry 出口」不成立

spec §5-B 选择 `failed` 的核心论据是「`failed` 有现成 retry 出口（`taskActions().retry` 条件即 `status==='failed'`）」。**对本轮 recovery 产出的 task 而言该论据为假。**

- `groupChatMessageId` 全仓**只有一处写入**：`group-chat-task-bridge.ts:245`，位于 `finishTask` 内；
- 被重启打断的 task **从未走到 `finishTask`**，故必然没有该字段；
- 因此 `taskActions().retry = failed && conversationId && groupChatMessageId` → **恒 false**。

是否可用 `groupChatSourceMessageId` 兜底？**不可以。** `resolveFailedTurnRetry`（`group_chat/index.ts:1010-1015`）要求目标是**失败的助手回复**：

```
if (!failed.from || failed.from === USER_ID || failed.dispatch) return 'retry target is not an assistant reply'
if (!failed.failure_kind && !failed.failure_code) return 'retry target is not a failed assistant reply'
```

而 `groupChatSourceMessageId` 记录的是**触发该 run 的用户消息**，两个判定都会拒绝。

**处置**：RC-P0-05 采用**选项 (2)：明确不可 retry**，并在 projection / UI 中显式表达（见 §4）。

### 2.3 次要：spec 引用的先例函数名有误

spec §10 把 `index.ts:1223 skills:version-recovery` 列为 `registerDeferred` 先例，实际是 `registerImmediate(..., 'serial')`。已改用 `recall:capture-recovery`（`:1336`，确为 `registerDeferred`）作为先例。

## 3. RC-P0-04 实现

| 文件 | 改动 |
|---|---|
| `lifecycle.ts` | `TRANSITIONS` 扩三条边；新增并导出 `COGSEED_INTERRUPTIBLE_STATUSES` / `isCogSeedInterruptibleStatus()` |
| `recovery.ts` | 按 `executionKind` 分流：group-chat → `failed` + `app_restart`；其余维持 `markCogSeedTaskRecoverable`。新增 `groupChatFailedCount` 报告字段 |
| `src/main/index.ts` | 新增 `registerDeferred('cogseed:task-recovery', ...)` |

**非终态判定不靠字符串猜**：`COGSEED_INTERRUPTIBLE_STATUSES` 由 `TRANSITIONS` 的 key **推导**而来（排除终态、`waiting_user`、`failed`），新增状态时不会漏。当前解析为 `created / queued / running / recoverable`。

**`waiting_user` 故意排除**（理由已于二次 review 修正）：

1. **主要理由 —— 那次 run 已经正常结束了，重启并没有打断它。**
   `bus.ts:1526` 先 `state.taskRun = undefined`，`:1531-1536` 才算出 `status = 'waiting_input'`
   并经 `_emitTaskRunTerminalIfQuiescent` 调 `finishTask`。即**从 bus.ts 视角这次 run 已终结**，
   `waiting_user` 是它的**结果状态**。给它盖 `app_restart` 是**事实错误**。
2. 真正「用户仍需回复」的权威信息由 **持久化的 `OrchestrationLedger`** 持有
   （`state.ts:72-88`，含 `resume_instruction` / `form_id`，重启后完好），不在 shadow task 上。
3. 状态机也无 `waiting_user → failed` 合法出边。

> ~~旧理由「因为它等的是人，不是进程」~~ —— 结论对，但论证错，已废弃。

**parent 与 child 不做区分**：两者产生与终结路径完全相同，同样处理。

**启动不被阻塞**：`boot_init.ts` 的 `_runAdmitted` 已 `try/catch` 并只 `log.warn`，任务抛错不会传播；`recovery.ts` 内层循环另有 `try/catch`，单个任务失败不中断整轮扫描（留给下次启动，`failed` 终态故幂等）。

## 4. RC-P0-05 实现

`taskActions()` **本身无需修改** —— 它已经正确：

| 状态 | retry | resume | abort | skip |
|---|---|---|---|---|
| group-chat `failed` + `app_restart`（无 messageId） | **false** | **false** | false | false |
| group-chat `failed`（有 conversationId + messageId） | **true** | **false** | false | false |
| 非 group-chat `recoverable` | false | **true** | true | — |

但「零动作的 failed 卡片」等于一张死卡。故按选项 (2) 的要求**把不可 retry 的原因显式表达出来**：

- projection 已透出 `errorCode: 'app_restart'`；
- 详情区在 `executionKind==='group-chat' && status==='failed' && !actions.retry` 时渲染
  `[data-run-center-retry-unavailable]`（新增 i18n `run_center.retry_unavailable_group_chat`，en/zh）。
  **文案已于 corrective patch B-3 修订**为只陈述事实、不承诺 UI 上不存在的动作，见文末附录。

用户的真实出路是**回到会话另起新 run**（注意：这不是 retry，也不是 resume 原 run）。
但该出口依赖 `RC-P0-07`（Phase 3），在其落地前 Run Center 正常路径上并不可达。

## 5. 测试（新增 17 条，`app-restart-recovery.test.ts`）

真实 task store + 真实临时 workspace，仅 stub 显示投影。

| 要求 | 用例 |
|---|---|
| running parent → failed + app_restart | ✅ |
| actor-turn child → 同样 | ✅ |
| 不存在任何 recoverable group-chat | ✅（4 个任务全为 failed） |
| `created` / `queued` / `running` 三态均可收敛 | ✅（`it.each`，扩边前这两态根本无法处理） |
| 历史遗留 `recoverable` 被治愈 | ✅ |
| `waiting_user` 不被误伤 | ✅ |
| 非 group-chat 维持 recoverable + worker_restart | ✅ |
| 混合扫描两个分支分别计数 | ✅ |
| **幂等**：二次扫描不产生非法二次 transition，`task.failed` 事件恰好 1 条 | ✅ |
| 单任务失败不中断整轮（`vi.doMock` 注入受控失败） | ✅ |
| recovery 抛错不阻塞启动（`runBootTaskForTest`） | ✅ |
| `resume === false`；`retry === false`（无 messageId） | ✅ |
| 有 messageId 时 `retry === true` | ✅ |
| 非 group-chat `resume === true` 不回归 | ✅ |

## 6. 回归结果

| 项 | 结果 |
|---|---|
| Phase 2 专项 | **17 passed** |
| cogseed_backend + group_chat + ipc + p3394_bridge | **145 files / 1245 passed / 7 skipped** |
| Phase 0 baseline 十件套 | **10 files / 266 passed / 7 skipped**（与 RC-T00 完全一致） |
| 全量（`npm run test:js`，Electron 入口） | **9417 passed / 24 failed / 105 skipped（9546）** |
| 失败集合 | 与 Phase 1 结束时 `diff` **逐条同名，零差异** —— 仍为既存 `@napi-rs/canvas` 截断所致 7 文件 / 24 用例 |
| 新增回归 | **0** |
| eslint / tsc | 均 exit 0 |

> 通过次数 9400 → 9417，恰为新增 17 条。

## 7. 语义一致性 sanity check

**Q1 — Group Chat runtime 真相现在是什么？**
重启后 `runtime.processing=false`、`backendActive=false`。下一次读取状态时 `healing orphan running state` 触发，会话落 `idle`。即：**运行已被放弃，会话可用**。

**Q2 — shadow task recovery 后是什么？**
`failed` + `errorCode='app_restart'`，终态。

**Q3 — 两边在 restart 后是否会短暂不一致？**
**会。** 两套判定触发时机不同：CogSeed recovery 是**启动时**（deferred，`BOOT_HEAVY_DISK_DELAY_MS` 之后），Group Chat healing 是**读时惰性**（要有人去读该会话状态）。窗口内可能出现「shadow task 已 failed，但 Group Chat state 仍标 running」，或反之。

**Q4 — 可接受吗？**
**可接受。** 两者都只向「已停止」收敛，没有任何一侧会把任务重新变活，故不会误导用户去等一个不存在的执行。窗口最长到首次会话状态读取，且两端最终状态一致（idle / failed 都表示「没在跑」）。真正的修法是统一由 Runtime 持有真相，属 DECISION-11 范畴，不在本轮。

**Q5 — 会不会出现「Group Chat idle，但 shadow task failed」？**
**会，而且这是稳态。** healing 之后会话就是 idle，shadow task 就是 failed。

**Q6 — 这是正确历史语义还是模型错误？**
**是正确的历史语义。** 会话是**当前**状态（现在没在跑 → idle），shadow task 是**那一次运行**的历史记录（那次运行没跑完 → failed）。两者描述的不是同一个对象：一个是会话的此刻，一个是某次 run 的结局。把它们强行对齐才是模型错误。

**Q7 — `failed + app_restart` 是否确实比 `recoverable` 更诚实？**
**是，但理由要修正。** spec 给的理由（「failed 有现成 retry 出口」）**经查为假**（§2.2），spec §5-B、§16 DoD 与 design-rationale 均已回改。真正成立的理由是：

- `recoverable` 在本仓库语义里意味着「可以 resume」，而 `taskActions().resume` 对 group-chat **恒 false**，`retryCogSeedTask` 对 group-chat **硬 throw** —— 这个承诺**没有任何代码能兑现**；
- `recoverable` 是非终态，会一直被计入活跃、永远停在 attention；
- `failed` 是终态，且带 `app_restart` 说明原因。

两者在「无 messageId 时都零动作」上其实**打平**；`failed` 胜出靠的是**不撒谎 + 终态收敛**，不是靠 retry 出口。

**Q8 — 是否给未来 Runtime Task Plane 制造强耦合？**
**没有。**
- 未新增跨层依赖：recovery 仍只读 CogSeed task store，不回控 Group Chat；
- 扩的三条状态机边是 CogSeed 内部语义，Runtime Task Plane 若接管，只需换掉 `recovery.ts` 的分流分支；
- `app_restart` 是一个字符串 errorCode，不是新数据通道，未触碰 renderer-safe 白名单；
- 启动钩子是独立 `registerDeferred`，删除即可停用。

## 8. 记录但不在本轮处理

| 项 | 说明 |
|---|---|
| `waiting_user` group-chat 的长期归属 | 当前不动。若未来判定它也应随重启收敛，需要先给状态机加 `waiting_user → failed` 出边，并想清楚「用户回复后新 run 与旧 task 的关系」。**已正式登记为架构债务 D-9**，详细字段见 spec §18.4 |
| 两套 orphan 判定并存 | Group Chat 读时 healing 与 CogSeed 启动 recovery 各自为政。spec §6 第 14 问已提出「是否应合并、由谁持有真相」，属架构决策。**已正式登记为架构债务 D-3**，详细字段见 spec §18.3 |
| `retryOfTaskId` 对 app_restart 任务无意义 | 这类任务不可 retry，故永远不会成为某个 retry 的来源。非缺陷，仅记录 |

---

# 附：Phase 2 corrective patch（2026-08-26，二次 review 后）

二次 review 确认 Phase 2 方向成立，但发现一个 correctness blocker 与两项收口。以下为修复记录。

## B-1 ★ blocker —— 启动 sweep 会杀死本进程的活任务

### 问题

`registerDeferred('cogseed:task-recovery')` 只按磁盘状态判 orphan，不区分「上一进程遗留」与「本进程新建且仍活着」。窗口很大：
`BOOT_BACKGROUND_DEFER_MS` 6s（`index.ts:1171`）+ `heavyDiskOffsetMs` 30s（`boot-device-profile.ts:40`），
再加 `preferIdle` 最多 `maxUserDeferralMs` 120s（`boot_init.ts:326`）。

实测复现（修复前）：

```
1. live run task status = running
2. after startup sweep  = failed app_restart  (groupChatFailedCount= 1)
3. finishTask           → Error: invalid CogSeed task transition failed -> completed
```

生产中第 3 步被 bridge 的 `catch { log.warn(...); return null; }` 吞掉 → **成功完成的 run 永久显示 failed**，且 **不可纠正**（`failed → completed` 非法）。

### 修法：process-start boundary

`src/main/storage.ts` 新增 `PROCESS_STARTED_AT = nowIso()`（模块加载时捕获）。
`recoverCogSeedTasks` 只处理 `task.updatedAt < processStartedAt` 的任务，boundary 可经 options 注入以便测试。

**四个决策点，均经实测而非想当然：**

| 决策 | 选择 | 依据 |
|---|---|---|
| `createdAt` vs `updatedAt` | **`updatedAt`** | 上一进程创建、但被本进程重新接手的任务是**活的**；`createdAt` 会把它误判成 orphan |
| 时间源 | **`nowIso()`**，不是 `toISOString()` | ⚠️ **关键陷阱**：任务时间戳是 `nowIso()` 产出的**本地时间、秒精度、无时区**（`2026-08-26T09:12:53`），而 `new Date().toISOString()` 是 **UTC 带毫秒**（`2026-08-26T16:12:53.278Z`）。二者字典序比较在负时区偏移下**永远把任务判成更早** → 护栏静默失效，而按同样写法写的测试**照样会通过** |
| `<` vs `<=` | **严格 `<`** | 秒精度下与 boundary 同秒的任务视为活的。漏掉一个 orphan 只是多等一次启动（自愈）；误杀一个活 run **不可逆** |
| 捕获位置 | `storage.ts` 模块加载 | 它是核心工具模块，在 main bootstrap 极早期被载入，远早于任何会话 run 可能开始 |

### 验证（修复后，同一 probe）

```
1. live run task status = running
2. after startup sweep    = running undefined (groupChatFailedCount= 0 )
3. finishTask returned    = completed
4. FINAL persisted status = completed          => OK
```

## B-2 —— 重复 sweep 虚报

`COGSEED_INTERRUPTIBLE_STATUSES` 含 `recoverable`，使已是 `recoverable` 的 native task 每次 sweep 都被重新计入并重新投影。
修法**在候选集层面**排除（`recovery.ts`：`executionKind !== 'group-chat' && status !== 'recoverable'`），
而不是依赖 `transitionCogSeedTask` 的同状态早返回来掩盖统计问题。

实测：`recoveredCount` 1 / 0 / 0，`projectTaskEvent` 仅 1 次，任务状态与事件数不变。
group-chat 分支仍保留 `recoverable` 候选（用于治愈历史遗留），其 `groupChatFailedCount` 为 1 / 0。

## B-3 —— 文案不再承诺不可达动作

`run_center.retry_unavailable_group_chat`：

| | 文案 |
|---|---|
| 旧 | en: “…Open the conversation to continue it there.” ／ zh: 「…请打开会话继续。」 |
| 新 | en: “Interrupted by an app restart, so this run cannot be recovered from the Run Center.” ／ zh: 「此运行被应用重启中断，无法从运行中心恢复。」 |

旧文案指向「打开会话」，但 `RC-P0-07` 未落地前 `[data-run-center-open]` **根本不渲染**（`taskSummary()` 不返回 `conversationId`）。
新文案只陈述事实，不承诺 UI 上不存在的动作。**待 Phase 3 `RC-P0-07` 落地后**，可升级为真正可执行的「打开会话继续」。

## 新增测试

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `app-restart-recovery.test.ts`（追加） | +12 | B-1 六个 case（上一进程 orphan 回收 / 本进程 live 不被碰 + 可正常 finish / created·queued 双向 / native 活任务不被标 recoverable / native 旧任务仍 recoverable / 默认 boundary 格式与生效）、waiting_user 保护、B-2 计数 1/0/0 与 group-chat 1/0 |
| `task-transitions.test.ts`（新建） | 9 | 三条新边合法且各只产生一条事件；completed / cancelled 仍拒绝复活；`failed → completed` 仍非法（正是 B-1 不可逆的原因）；`waiting_user → failed` 未被打开；`recoverable → queued` resume 路径未被挤掉；group-chat 仍被挡在 CogSeed retry 之外 |


---

## 附：本文件与 Debt Registry 的分工

本文件是 **evidence** —— 记录 Phase 2 当时发生了什么、为什么这样判断、验收了哪些断言。
它**不是**长期待办索引。上表中「记录但不在本轮处理」的两项，其长期形态（当前事实 /
本轮止血 / 未解决风险 / future trigger / owner）已分别登记为 **D-9**（`waiting_user`
生命周期 ownership，spec §18.4）与 **D-3**（双套 orphan reconciliation ownership，
spec §18.3），并列入 `RC-DONE` 的 debt review。

corrective patch 修掉的 correctness 缺陷（B-1 startup sweep 误杀本进程 live task、
process-start boundary、B-2 重复计数、B-3 文案错误承诺 Retry）**已解决，不是长期债务**，
不得回填进 registry。
