# RC-T06 / RC-DONE — Run Center v1 Hardening 最终验收

> 2026-08-26 · 分支 `feat/run-center-v1-hardening` · 基线 commit `0c0b7907`

## 1. Phase 6 前 Debt Gate

判据不是「这些债能不能解决」，而是**它们是否会让 Phase 6 出现假通过、假失败或非确定性**。

| # | 是否影响 Phase 6 | 证据 |
|---|---|---|
| **D-1** actor-turn-per-task | **否** | 它是增长/写放大问题。Runs 树、identity 序数、retry 关联全部由持久化的 `parentTaskId` / `createdAt` / `retryOfTaskId` 确定性导出，Phase 3 的 32 条 identity 测试与 RC-P2-20 的 13 条已在该模型上给出确定结果。**保持 open，不修。** |
| **D-2** `cogseedTaskId` 仅内存 | **否** | restart 判定的输入是**持久化的** task 记录 + `PROCESS_STARTED_AT` 边界（`recovery.ts`），内存关联不参与。`app-restart-recovery.test.ts` 与 RC-T04 Scenario E 都通过可注入的 boundary 构造「上一进程遗留」，不依赖任何未持久化字段。**保持 open，不修。** |
| **D-3** 双套 reconciliation ownership | **否** | 两者作用于**互不相交的存储**：Group Chat 的 lazy healing 走 `setStatus()`，只写 group_chat `state.json`（`state.ts`，无任何 CogSeed task 写入）；CogSeed startup recovery 只写 task 记录。**不存在同一 task 在不同 timing 得到不同终态。** sweep 的候选集是 `(持久化 status, updatedAt, 注入的 boundary)` 的纯函数 → 可写确定性 invariant，RC-T04 Scenario E 两条即为此。process-start boundary 足够锁住 live task（Scenario E 第二条实测）。**保持 open，不修。** |
| **D-9** `waiting_user` ownership | **否（但约束了测试设计）** | `waiting_user` 非终态 → 恒计入 `activeTaskCount`；非 ageable → 不被保留窗口裁剪。这是**确定性**的，可以断言精确值，且每条测试自建 fixture，不存在跨测试污染。v1 语义可明确验证：状态保留、Open Conversation 是真实出口、无 resume。**Phase 6 因此刻意不断言「用户回复后旧 shadow task 如何收口」** —— 那正是 D-9 未定义的部分。**保持 open，不修。** |

> **Debt gate 附带记录的一处外溢（未修、未入 registry）**：`group_chat/index.ts:177-181`
> 计算 `backendActive` 时，排除列表是 `completed/failed/cancelled/recoverable` ——
> **`waiting_user` 不在其中**。因此一个长期停留的 `waiting_user` 影子任务会让该会话的
> `processing` 恒为 true。这是 D-9「无人负责收口」的直接后果，修它等于定义 D-9 的
> lifecycle owner（本轮明确禁止）。**已报告，未自行改动 registry。**

**结论：GO — Phase 6。**

## 2. RC-T02 / RC-T03

见 [`RC-T02-T03-coverage-audit.md`](./RC-T02-T03-coverage-audit.md)。
结论：DoD 全项已有真实运行时断言覆盖（renderer 115 条 + main 相关约 60 条），
唯一缺口「跨层一致性」由 RC-T04 补齐，**不重复造第二套 renderer 测试**。

## 3. RC-T04

见 [`RC-T04-e2e.md`](./RC-T04-e2e.md)。8 个场景 A–G，真实 store + 真实 ipc-service + 真实 FS。

## 4. RC-T05

见 [`RC-T05-layout-smoke.md`](./RC-T05-layout-smoke.md)。
`npm run smoke:run-center`，四档 **64/64 通过**。**未改动任何 CI 配置。**

## 5. Phase 6 发现的真实 bug

### BUG-1 —— `sessionProjection` 清空 native 幸存任务的详情

- **发现方式**：RC-T04 Scenario F（mock 投影的测试结构上不可能发现）
- **根因**：`sessionProjection` 有一条早返回 ——
  `if (session.conversationId && !isConversationAvailable(...)) return { session: null, collaboration: null }`。
  在决策 (c) 之前这是对的（那时这类 session 里只有 group-chat 影子记录）。
  (c) 之后 `local-cli` / `cogseed-native` 任务会**故意存活**并继续显示在看板上，
  但这条早返回仍把它们的详情整片清空 —— **用户看得见卡片，却打不开它**。
- **修复**：把判据从「会话是否存在」改为「会话不存在**且**没有任何幸存的直接任务」。
  `visibleDashboardTasks` 已经丢弃 group-chat 记录，所以只含影子记录的 session
  自然得到空集，仍返回 null，原行为不变。
- **一次修错并纠正**：首版把判据写成裸的 `!directTasks.length`，
  破坏了「**尚未有任务的 session 仍应返回摘要**」这一既有契约
  （由 Phase 0 baseline 的 `renderer-projection.test.ts` 立即抓到）。
  已改为三者共同判定，并新增 3 条测试把这个 gate 的**三种情况**全部钉死：
  空 session 仍投影 / 只有影子记录 → null / 有 native 幸存 → 可达。

**除 BUG-1 外，Phase 6 未发现其它产品 bug。**

### 另修正两处**自身测试**的可靠性缺陷（不是产品问题，但同样不可接受）

两者都由 coverage 插桩（更慢的环境）暴露：

1. **未等待异步渲染** —— RC-T04 的每个 IPC 回复都在做真实文件系统读写，
   而 `harness.flush()` 是为「立即 resolve 的固定 fixture」设计的，
   会在渲染仍在途中就返回。插桩下看板因此是空的。
   已改为有界的 `settleUntil(predicate)` 轮询（不用挂钟 sleep），
   慢环境下同样确定。
2. **teardown 后泄漏 refresh** —— 测试结束时仍有 in-flight 刷新，
   窗口被销毁后 `panel()` 读到已销毁的 `document`，产生 unhandled rejection。
   Vitest 明确警告这类错误「可能造成假阳性」。
   已改为 `setPanelActive(false) → flush → destroy`，**最终全量 `Unhandled Errors` 为 0**。

> 这两条值得记录：一个在插桩下才失败的测试，等于在正常环境下给出了**未经证实的绿**。

## 6. 回归矩阵

| Area | Focused | Related | Baseline | Full Suite | Result |
|---|---|---|---|---|---|
| Refresh | `run-center-refresh` 10 | ✔ | ✔ | ✔ | PASS |
| Polling | `run-center-polling` 10 | ✔ | ✔ | ✔ | PASS |
| Retry | `retry-relation` 7 + E2E C | ✔ | ✔ | ✔ | PASS |
| Abort | `action-convergence` 7 + E2E B | ✔ | ✔ | ✔ | PASS |
| Restart | `app-restart-recovery` 12 + `task-transitions` 9 + E2E E | ✔ | ✔ | ✔ | PASS |
| waiting_user | `reachability` 5 + E2E D | ✔ | ✔ | ✔ | PASS |
| Identity | `run-center-identity` 15 + `task-identity` 17 + E2E A | ✔ | ✔ | ✔ | PASS |
| Orphan fallback | `tree-orphan` 13 + E2E G | ✔ | ✔ | ✔ | PASS |
| Contract | `contract-fields` 16 + `contract-display` 20 | ✔ | ✔ | ✔ | PASS |
| Conversation cleanup | `conversation-cleanup` 21 + `-integration` 6 + E2E F | ✔ | ✔ | ✔ | PASS |
| Layout smoke | `smoke:run-center` 64 checks | — | — | — | PASS |

**执行结果**

| 步骤 | 结果 |
|---|---|
| RC-T02/T03 focused | **115 passed**（9 files） |
| RC-T04 integration | **8 passed** |
| RC-T05 smoke | **64/64 passed**，failures 0 |
| Phase 0 baseline | **266 passed / 7 skipped** —— 与 `RC-T00` 基线逐数吻合 |
| related（renderer + cogseed + group_chat + chats + ipc） | 241 files / **2724 passed / 7 skipped** |
| `npm run test:js` | **9606 passed / 24 failed / 105 skipped** |
| 失败集合比对 | 与已知 canvas 24 条**逐条同名**，零新增、零消失 |
| tsc `--noEmit` | 通过 |
| eslint | 通过 |
| `npm run reuse:check` | 通过（3443 files，含新增 script） |
| `npm run sbom:check` | 通过（658 components in sync） |
| 覆盖率阈值（`npm run test:coverage`） | **未能测得 —— 见下方说明**，非本轮引入 |

> 全量一律使用仓库官方入口 `npm run test:js`（Vitest 跑在 Electron 内嵌 Node 下以对齐
> `better-sqlite3` ABI）。**裸 `npx vitest run` 不可用作依据** —— 系统 Node 的
> `NODE_MODULE_VERSION` 不匹配，会额外产生约 70 条无关的 `ERR_DLOPEN_FAILED`。

### 覆盖率门槛（RC-T06）的实测情况 —— 如实记录

`vitest.config.ts` 的阈值为 lines 61 / functions 62 / statements 58 / branches 52。
本轮**没有测到全量覆盖率数字**，原因与本轮改动无关：

- 在**子集**上运行 `--coverage` 会正常打印 text 表并写出 `coverage/coverage-summary.json`；
- 在**全量**上运行 `npm run test:coverage` 时，运行结束后**没有任何覆盖率报告段，也没有生成
  `coverage/` 目录** —— 报告阶段没有完成。这是既有的基础设施状况，
  本轮未改动 `vitest.config.ts` 的任何覆盖率配置。

因此**不宣称阈值已通过**。可以陈述的事实是：本轮**没有删除任何被覆盖的生产代码**
（唯一删除的是 `board.counts` / `actions.skip` 及其纯死代码级联），且新增约 200 条测试，
其中大量直接命中 `ipc-service.ts` / `task-store.ts` / `run-center.js`。
一次范围受限的实测（仅跑 `cogseed_backend` + `renderer` 测试）给出：

| 文件 | lines | statements | functions | branches |
|---|---|---|---|---|
| `ipc-service.ts` | 60.24 | 60.46 | 71.42 | 64.17 |
| `task-store.ts` | 61.31 | 56.11 | 68.96 | 54.06 |
| `lifecycle.ts` | 91.66 | 87.23 | 77.77 | 85.13 |

> 这是**部分测量**（只跑了两个目录的测试），不能代替全局阈值判定。
> 建议作为一条独立的基础设施跟进项处理，不阻塞本轮验收。

### 全量套件的偶发项（已按流程排查，均非本轮回归）

全量运行下，PDF / 附件家族中会有**一条**时序敏感用例偶发失败，且每次不是同一条：

| 观察于 | 偶发用例 | 隔离重跑 |
|---|---|---|
| Phase 4 期间 | `messaging.test.ts > routes inbound text into group chat…` | 3/3 通过 |
| Phase 5 期间 | `session_import.test.ts > creates a continuable conversation…` | 3/3 通过 |
| Phase 6 coverage 运行 | `session_import.test.ts > without a settled prefetch…` | 通过 |
| Phase 6 全量运行 | `chat_attachments.test.ts > reuses a single attachment when matching uploads arrive concurrently` | 3/3 通过（该文件隔离下只有已知的 canvas 那条失败） |

每次都按同一流程处理：官方 runner 隔离重跑 → 确认稳定 → 复跑全量。
**最终全量运行为 24 failed / 9606 passed / 105 skipped，失败集合与已知集逐条同名，
零新增、零消失，`Unhandled Errors` 为 0。**

**基线演进**（failed 恒为同一组 24 条 canvas 失败）

| 节点 | passed |
|---|---|
| Phase 2 结束 | 9438 |
| Phase 3 结束 | 9522 |
| RC-P2-20 | 9535 |
| Phase 5 结束 | 9566 |
| Phase 4 结束 | 9595 |
| **Phase 6 结束** | **9606** |

每一步的增量都可由该阶段新增测试完整解释。

## 7. RC-DONE 逐项证据

| DoD 项 | 证据 |
|---|---|
| Phase 0 baseline 有保留 | `evidence/baseline/RC-T00-baseline.md`；本轮复跑仍 266/7 |
| Refresh 语义已锁 | `run-center-refresh` 10 条 |
| polling 语义已锁 | `run-center-polling` 10 条（含 teardown / 不叠加 / busyAction 门控） |
| restart 语义已锁 | `app-restart-recovery` 12 + `task-transitions` 9 + E2E E |
| retry 语义已锁 | `retry-relation` 7 + E2E C（`retryOfTaskId` 真实透出） |
| abort 语义已锁 | `action-convergence` 7 + E2E B（读回真实 `cancelled`） |
| Board / Runs / detail 一致 | **E2E A**：三处 identity 字符串逐字相等 |
| waiting_user 有真实出口 | `reachability` 5 + E2E D + 真机点击导航 |
| no false resume | `group-chat-resume-invariant` 20 + `reachability` 3 + smoke 每档 3 项 |
| Open Conversation 不冒充 retry | `reachability` 4 条三方文案区分 + smoke 每档 1 项（正则排除 retry/resume/重试/恢复） |
| identity 可区分 | `run-center-identity` 15 + `task-identity` 17 + 真机 12 卡 2 标题 12 身份 |
| orphan child 不消失 | `tree-orphan` 13 + E2E G |
| completed layout 无裁切 | **CDP 四档 64/64**，`rc-t05-smoke.json` |
| conversation deletion 生命周期正确 | `conversation-cleanup` 21 + `-integration` 6 + E2E F |
| native historical task c2 正确 | `contract-display` 5 + `conversation-cleanup` Case 4 6 条 + E2E F |
| projection contract 已收口 | `contract-fields` 16（含 RESERVED 元规则测试） |
| privacy / 无自由文本回归 | 真实 projection 对象哨兵断言（identity / contract / cleanup 三处） |
| full suite 无新增回归 | 失败集合逐条同名，零新增 |
| D-1 / D-2 / D-3 / D-9 已重新 review | 本文档 §1 Debt Gate |
| debt registry 未被错误清零 | spec §18 四条全部仍为 open；§17.5 的 RC-P2-20 是 correctness follow-up，不是 debt |
| evidence 完整 | `evidence/` 下 baseline / phase-1 / phase-3 / phase-4 / phase-5 / phase-6 |

## 8. 架构债务最终复审

| # | 状态 | 本轮结论 |
|---|---|---|
| D-1 | **open** | 未触碰模型；Phase 4 的止血不改变增长斜率 |
| D-2 | **open** | 未触碰；restart 语义有独立于它的持久化依据 |
| D-3 | **open** | Phase 4 新增一条按 conversation 判定生命周期的路径，但**不改动任何现有 reconciliation 谓词**，不构成 future trigger |
| D-9 | **open** | Phase 4 只清掉「已删除会话下」的 waiting_user 影子任务；「会话仍在时谁收口」完全未触及。Debt gate 另记录一处外溢（`backendActive` 不排除 `waiting_user`），已报告未自行处理 |

**是否新增 architecture debt：否。** 本轮新增的两项均为 correctness follow-up
（`RC-P2-20` 已修，spec §17.5；`BUG-1` 已修，本文档 §5），有确定修法与可验证 DoD，
按规则**不进 Debt Registry**。

## 9. 下一阶段入口

RC-DONE **不代表没有遗留项**。本轮完成后做了一次 Post-RC 全量审计，
所有「以后仍需处理」的事项集中登记在
**[`../../post-v1-followups.md`](../../post-v1-followups.md)** —— 这是唯一入口。

其中与本文档直接相关的两条：

- **FU-1** —— §1 Debt Gate 记录的 D-9 外溢（`backendActive` 排除列表不含 `waiting_user`）
  经复核确认**有用户可见影响**（会话长期显示「处理中」），已提升为 **P1** correctness follow-up；
- **TI-1** —— 本文档「覆盖率门槛的实测情况」进一步查明：
  **`.github/workflows/ci.yml` 根本没有 coverage 步骤**，
  因此当前**不存在生效的覆盖率门禁**。本文档任何表述都不应被读作「门禁已通过」。

## 10. 结论

**Run Center v1 Hardening 可以关闭。** spec §16 DoD 全部满足并逐项有证据；
全量套件零新增回归；四条长期架构债务保持 open 且结论未被稀释。
