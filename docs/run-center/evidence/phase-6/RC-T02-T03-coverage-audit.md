# RC-T02 / RC-T03 — 主链与 invariant 覆盖审计

> 2026-08-26 · 分支 `feat/run-center-v1-hardening`

## 方法

Phase 1–5 与 RC-P2-20 在各自阶段已经写下大量 renderer / main 测试。
RC-T02 / RC-T03 的正确做法**不是重写一遍**，而是逐条核对 DoD 要求是否已有
**真实运行时断言**（DOM 节点 / IPC 调用 / 真实 store 状态）覆盖，
并补上真正的缺口。全部测试**零 source-string 主断言**。

## RC-T02 — Renderer 主链

| DoD 项 | 覆盖位置 | 条数 |
|---|---|---|
| 卡片真实渲染 / status 正确 | `run-center-harness.test.ts`、`run-center-identity.test.ts` | 8 + 15 |
| identity 正确（run/turn/agent/短会话 id/相对时间） | `run-center-identity.test.ts` | 15 |
| session meta（taskCount / activeTaskCount / hasRecovery） | `run-center-contract-display.test.ts` | 4 |
| reviews / conflicts / recovery DISPLAY | 同上 | 8 |
| timeline error 标记 | 同上 | 2 |
| **c2 语义**（历史可见 / 无 conversationId / 无 Open / 有说明） | 同上 | 5 |
| parent-child 正常树 | `run-center-tree-orphan.test.ts` | 1 |
| orphan turn fallback | 同上 | 12 |
| 多 run / 多 turn 可区分 | `run-center-identity.test.ts` | 6 |
| filter 在 Runs 不显示/不启用 | `run-center-reachability.test.ts`（RC-P2-11） | 2 |
| detail 可达 / Open 仅在有效会话出现 | `run-center-reachability.test.ts`、`run-center-contract-display.test.ts` | 9 + 5 |
| 不出现失效 action | `run-center-reachability.test.ts`（RC-P2-10）、`group-chat-resume-invariant.test.ts` | 3 + 20 |

**RC-T02 新增缺口**：无独立缺口 —— 唯一未被覆盖的是「三个视图对**同一条真实投影**是否一致」，
这需要真实后端，已在 **RC-T04 Scenario A** 中覆盖（board / runs tree / detail 的
identity 字符串逐字相等）。

## RC-T03 — 状态与 action invariant

| DoD 项 | 覆盖位置 | 条数 |
|---|---|---|
| Refresh 真重拉 / 不重复 select / 不闪空 | `run-center-refresh.test.ts` | 10 |
| Polling 5s / 门控 / 不叠加 / teardown / visibility | `run-center-polling.test.ts` | 10 |
| abort 收敛窗口 / 不伪造状态 | `run-center-action-convergence.test.ts` | 7 |
| retryOfTaskId 关联 | `retry-relation.test.ts`、`run-center-identity.test.ts` | 7 |
| `app_restart` 不假装可 retry | `run-center-reachability.test.ts`、`app-restart-recovery.test.ts` | 1 + 12 |
| retry / resume / Open 三者文案不混写 | `run-center-reachability.test.ts` | 4 |
| waiting_user 真实状态 / Open 出口 / 无 resume | `run-center-reachability.test.ts` | 5 |
| restart：上一进程非终态 → failed + app_restart | `app-restart-recovery.test.ts` | 12 |
| restart：waiting_user 保留 | 同上 | ✓ |
| restart：本进程 live task 不被误伤 | 同上 | ✓ |
| restart：重复 sweep 幂等 | 同上（B-2 计数 1/0/0） | ✓ |
| 状态机合法边 | `task-transitions.test.ts` | 9 |

**RC-T03 新增缺口**：无独立缺口 —— 唯一未被覆盖的是「这些 invariant 在**真实 store 写盘后**
是否仍成立」，已在 **RC-T04 Scenario B / C / E** 中覆盖（abort 后读回真实记录、
restart 后读回真实状态与 errorCode、幂等第二次 sweep 计数为 0）。

## 结论

RC-T02 / RC-T03 的 DoD 全部有真实运行时断言覆盖，合计
**renderer 115 条 + main 相关约 60 条**。缺口只有一类 —— 跨层一致性 ——
已由 RC-T04 补齐，故本阶段不重复造第二套 renderer 测试。
