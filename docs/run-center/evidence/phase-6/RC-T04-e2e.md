# RC-T04 — 跨层闭环 E2E

> 2026-08-26 · `test/renderer/run-center-e2e.test.ts`（8 条）

## 1. 为什么需要它

其它所有 Run Center 测试都**手写投影**再断言 DOM —— 那证明的是 renderer，
不是前后端之间的契约。本文件的投影来自
**真实 `ipc-service` 读真实 `task-store` 读真实文件系统**，
只把 Group Chat 边界（会话存在性、abort 副作用）替换掉，
满足 spec §14「`ipc-service` 与 `task-store` 必须是真实实现 + 真实文件系统，
不得全部 mock 到只剩函数名」。

链路：

```
真实 task-store（tmp FS）
  → 真实 lifecycle transition
  → 真实 ipc-service projection
  → renderer harness（jsdom，真实 run-center.js）
  → DOM 断言 / action 回写
  → 读回真实 store 验证
```

## 2. 场景

| # | 场景 | 关键断言 |
|---|---|---|
| A | 正常完成的 run | board / runs tree / detail 三处 identity 字符串**逐字相等**；父子树结构正确；run 与 turn 的 identity 互不相同 |
| B | abort | action 发出 1 次；**读回真实记录为 `cancelled`**；收敛窗口结束且无 `unconfirmed` 提示；abort 按钮消失 |
| C | retry | `retryOfTaskId` 从真实投影透出并渲染；原任务无该标记；同 session 两个 run 的序数集合为 {Run 1, Run 2} 且互不相同 |
| D | waiting_user | 落 attention 列；Open Conversation 被突出且指向真实 cid；点击真实导航；**无 resume / 无 retry**。**刻意不断言 D-9 的收口行为** |
| E | restart | 上一进程 running → `failed` + `app_restart`；`waiting_user` 保留；第二次 sweep 计数为 0（幂等）；本进程 live task 状态不变；UI 无 retry/resume 但有 Open + 说明文案 |
| F | conversation 删除 | group-chat parent + turn 被清；native 与他会话记录保留；c2 —— native 仍在板上、详情可开、`planner` 可见、**无 Open 按钮**、有说明；**整个面板 HTML 不含已删除的 cid** |
| G | orphan turn | 直接删掉父任务文件；child 仍在板上；runs 树中 child 成为根；**不存在伪造的父节点**；orphan 标记携带真实 parentTaskId |

## 3. 本阶段抓到的真实 bug

见 [`RC-T06-final-acceptance.md`](./RC-T06-final-acceptance.md) §「Phase 6 发现的真实 bug」——
Scenario F 直接暴露了 `sessionProjection` 会把 native 幸存任务的详情整片清空。
这正是 mock 投影的测试**结构上不可能发现**的一类缺陷。

## 4. 两处 fixture 教训（记录以免重犯）

1. **session 归属**：`createCogSeedTask` 不带 `sessionId` 会为**每个任务新建 session**，
   而序数是 per-session 的 —— 于是每个任务都成了「Run 1」。真实 bridge 用
   `gconv-<cid>` 让一次会话的所有任务共享 session，fixture 已对齐。
2. **时间戳格式**：`nowIso()` 是**本地时间、秒精度、无时区、带 `T`**。
   用 `toISOString()` 构造 recovery boundary 会得到 UTC + 毫秒，
   字典序比较静默失效 —— 正是 Phase 2 evidence 记录过的陷阱。
   boundary 现在由 `nowIso()` 自身产出。
