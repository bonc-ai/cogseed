# RC-T00 — 基线与开发安全（执行记录）

> 执行日期：2026-08-26
> 执行分支：`feat/run-center-v1-hardening`
> spec: §7 ／ todo: Phase 0

## 1. 分支

| 检查项 | 结果 |
|---|---|
| 分支存在 | ✅ `feat/run-center-v1-hardening` |
| 基线 commit 是祖先 | ✅ `git merge-base --is-ancestor 0c0b7907 HEAD` → true |
| 分支起点 | ✅ 从 `0c0b7907` 切出（**非 develop**）；其上仅 `cd93ca11 docs(run-center): ...` 一个文档 commit |
| `git rev-list --left-right --count origin/develop...0c0b7907` | ✅ `0	1`，仍是 clean fast-forward |
| 工作区 | clean |

## 2. 测试基线（10 个文件，全绿）

命令：

```
npx vitest run \
  test/main/features/cogseed_backend/task-store.test.ts \
  test/main/features/cogseed_backend/group-chat-task-bridge.test.ts \
  test/main/features/cogseed_backend/group-chat-dashboard-action.test.ts \
  test/main/features/cogseed_backend/renderer-projection.test.ts \
  test/main/features/cogseed_backend/runtime-controller.test.ts \
  test/main/features/group_chat/bus.test.ts \
  test/main/features/group_chat/bus-integration.test.ts \
  test/main/features/group_chat/failed-turn-retry.test.ts \
  test/renderer/run-center.test.ts \
  test/main/ipc/cogseed-backend.test.ts
```

结果：**Test Files 10 passed (10) ／ Tests 266 passed | 7 skipped (273)**，`success: true`。

| 测试文件 | 用例数 | 状态 |
|---|---:|---|
| `test/main/features/group_chat/bus-integration.test.ts` | 158 | passed |
| `test/main/features/group_chat/bus.test.ts` | 64 | passed |
| `test/main/features/cogseed_backend/runtime-controller.test.ts` | 14 | passed |
| `test/main/features/group_chat/failed-turn-retry.test.ts` | 10 | passed |
| `test/main/features/cogseed_backend/task-store.test.ts` | 8 | passed |
| `test/main/features/cogseed_backend/renderer-projection.test.ts` | 7 | passed |
| `test/renderer/run-center.test.ts` | 4 | passed |
| `test/main/ipc/cogseed-backend.test.ts` | 4 | passed |
| `test/main/features/cogseed_backend/group-chat-dashboard-action.test.ts` | 2 | passed |
| `test/main/features/cogseed_backend/group-chat-task-bridge.test.ts` | 2 | passed |

7 个 skipped 全部在 `bus-integration.test.ts`（Commander KSTAR dispatch narration ×1、wake-gated dispatch continuation ×2 等），**基线即为 skipped，不是本轮引入**。

> vitest 的 JSON reporter 原始输出未随仓库发布——它内嵌运行机器的绝对路径。
> 用上面的命令加 `--reporter=json` 可在本地重新生成。

## 3. 并行开发冲突热点清单（已核对行号）

| 位置 | 符号 | 谁会碰 | 说明 |
|---|---|---|---|
| `src/main/features/group_chat/bus.ts:2127` | `_enqueueBody()` | **RC-P1-09** | retry 时把 `retryOfTaskId` 带下去的候选插入点；`:2109` 是其唯一调用点 |
| `src/main/features/group_chat/bus.ts:3457` | `runActorTurn()`（body 在 `:3658`） | RC-P1-09 旁路影响 | actor turn → child task 的产生点 |
| `src/main/features/group_chat/bus.ts:1519` | `_emitTaskRunTerminalIfQuiescent()` | Phase 2（RC-P0-04/05）终态语义 | 唯一调用点 `:1748` |
| `src/main/ipc/index.ts:4964` | `conversations.sendStream` 签名 | 本次新增 `retry_request_id` 参数（`:5039-5040` 消费；renderer 侧 `src/renderer/modules/conversation.js:11174` 产生） | 签名已变更，并行分支 rebase 时注意 |

> **RC-P1-09 必须单独成 PR 且优先合入**（todo 已标注），因为它是唯一需要改 `bus.ts:_enqueueBody` 的项。

## 4. RC-T00 verify 勾选

- [x] `feat/run-center-v1-hardening` 已从 `0c0b7907` 切出（不是从 develop）
- [x] 10 个测试文件全绿并存档结果
- [x] 冲突热点清单已列出（行号已核对，见 §3）
- [x] `git rev-list --left-right --count origin/develop...0c0b7907` 仍为 `0	1`

> ⚠️ §3 的清单需要**由人同步给并行开发者**（本记录只负责产出清单，不能代替沟通动作）。
