<!-- SPDX-FileCopyrightText: 2026 CogSeed contributors -->
<!-- SPDX-License-Identifier: MIT -->

# RC-P0-01 — 修完整 Refresh（执行记录）

> 执行日期：2026-08-26
> 分支：`feat/run-center-v1-hardening`
> spec: §9.1 ／ todo: Phase 1

## 1. 缺陷复述

`refresh()` 原实现（`run-center.js:186`）：

```js
const task = selectedTask() || state.board?.tasks?.[0];
if (task && (!state.selectedTaskId || !state.selectedSessionId)) await select(task.sessionId, task.taskId);
```

守卫的含义是「**只在没有选中任何东西时**才拉 detail」。因此一旦用户点过任意一张卡片，
Refresh 按钮就只重拉 board + session list，而 **detail / timeline / collaboration 三个区域
永久停在第一次加载的快照上**，且没有任何 UI 手段能修复——除非重新进入 Run Center。

## 2. 改动

`src/renderer/modules/run-center.js`（唯一 source 改动文件）

| 变更 | 说明 |
|---|---|
| 抽出 `loadDetail({ preserveDetail })` | `select()` 与 `refresh()` 共用同一条 detail 读取路径，不再各写一份 |
| `refresh()` 无条件调用 `loadDetail()` | 守卫删除；选中项存在就重拉 |
| `preserveDetail` | 重拉**同一个** task 时保留旧快照直到新数据到达 → 不整屏闪空；切到**别的** task 时不保留（旧内容会误导） |
| 选中项失效回落 | board projection 与 `sessionProjection()` 共用 `visibleDashboardTasks()`，故「不在 board.tasks 里」⟺「该 task 已不可见」。此时回落 board 首项，避免 `collaborationSnapshot()` 抛 `CogSeed collaboration task not found` |
| session 被删 | `{session:null, collaboration:null}` → 清空选中显示空态，**不停在 error** |
| in-flight 竞态守卫 | `loadDetail()` await 前后比对 `selectedSessionId/TaskId`，过期响应直接丢弃，不覆盖更新的选中 |
| board loading 占位 | `boardHtml()` 的 `loading` 改为 `state.loading && !state.board` —— 已有数据时刷新不再整屏替换成 spinner（`RC-P0-02` 轮询的硬前置） |
| `action()` 去重 | 删掉 `await refresh()` 之后的 `await select(...)`——`refresh()` 现在自带 detail 重读，多余的那次是纯重复 IPC |

⚠️ 一处刻意的保守处理：`selectedTaskId` 为空但 `selectedSessionId` 仍在 session list 中时
（点 session 卡片且该 session 的 `latestTaskId` 为空），**不回落**，继续按 session 维度重读。
否则 `RC-P0-02` 的 5s 轮询会每 5 秒把用户的 session 选中劫持回 board 首项。

## 3. 测试

新增 `test/renderer/run-center-refresh.test.ts`（7 条，全部基于 `RC-T01` harness，零 source-string 主断言）：

| # | 命题 | 对应 verify 项 |
|---|---|---|
| 1 | 已选中状态下 Refresh → `session.read` 第 3 次发生，且 payload 指向**用户的选中**而非 board 首项 | 「已选中状态下 `refresh()` → 断言 `cogseed.session.read` 被调用」 |
| 2 | Refresh 后 timeline（runs 视图）/ detail pane / collaboration 视图三处 DOM 同步更新 | 「detail / timeline / collaboration DOM 内容随之更新」 |
| 3 | 用 pending promise 卡住 `session.read`：在飞行期间旧 timeline 仍在，且未出现 `loading_detail` 占位 | 「detail 重拉期间不整屏闪空」 |
| 4 | 选中的 task 从 board 消失 → 回落首项，不出现 `load_failed` | 「selected task 已消失 → 回落 board 首项，不抛错」 |
| 5 | `session.read` 返回 `{session:null,collaboration:null}` → 空态而非 error，detail pane 清空 | 「selected session 已删除 → 清空选中并显示空态」 |
| 6 | session 维度选中（`latestTaskId` 为空）不被 Refresh 劫持 | 上文 §2 保守处理的回归锁 |
| 7 | 单次 abort action → `task.action` 1 次、`session.read` 恰好 2 次（初始 1 + refresh 1） | 「断言单次 action 不产生重复 `session.read`」 |

`test/renderer/run-center-harness.test.ts` 中的 `RC-P0-01` 基线见证已删除——它断言的正是被修掉的行为。

### 结果

```
✓ test/renderer/run-center-harness.test.ts  (8 tests)
✓ test/renderer/run-center-refresh.test.ts  (7 tests)

npx vitest run test/renderer test/main/features/group_chat
  Test Files  181 passed (181)
       Tests  2243 passed | 7 skipped (2250)

npx vitest run test/main/features/cogseed_backend test/main/ipc/cogseed-backend.test.ts
  Test Files  43 passed (43)   Tests  182 passed (182)

npx eslint src/renderer/modules/run-center.js test/renderer/run-center-*.ts   → 0 问题
```

`test/renderer/run-center.test.ts`（旧的 source-string 测试）仍绿：它断言的 4 个 `invoke(...)`
字面量在重构后原样保留。

## 4. 一次合并事故（已处理）

本项落地期间有并行改动写入同一文件，一度在 `run-center.js` 里留下**两个 `loadDetail()` 函数声明**
（`keepVisible` 版与 `preserveDetail` 版）。函数声明提升 + 后者覆盖前者，运行时只有第二份生效，
测试因此仍然全绿——**这类重复不会被现有 eslint 配置报错**（`no-redeclare` 未对函数声明生效）。

处理：合并为一份，保留功能更全的 `preserveDetail` 版（多出 session 删除处理与 in-flight 竞态守卫），
并把另一版注释里的「5s 轮询下闪屏会更严重」这条理由并入保留版。另一版的 `boardHtml()` loading
改动有独立价值，已保留。

## 5. 对后续项的影响

- `RC-P0-02`（轮询）现在可以直接复用 `refresh()` 作为唯一入口——这正是 spec §9.2 长期方向里
  `onPushEvent('cogseed:task-changed', () => refresh())` 所需的前提。
- `preserveDetail` 是轮询不闪屏的必要条件：5s 一次的整屏空白会让面板不可用。
- `loadDetail()` 的 in-flight 守卫是 `RC-P1-03` 确认窗口（1s cadence）的并发前提。
