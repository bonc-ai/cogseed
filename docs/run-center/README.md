# Run Center v1 Hardening — 文档索引

> 基线 commit：`0c0b7907 feat(run-center): add unified task dashboard`
> 审查日期：2026-08-26

## 读哪一份

| 文档 | 职责 | 什么时候读 |
|---|---|---|
| [`run-center-v1-design-rationale.md`](./run-center-v1-design-rationale.md) | **设计依据的压缩入口**（2–4 页密度）：当前形态判断、关键技术选择与其风险、两个 DECISION | 先读这个 |
| [`run-center-v1-hardening-spec.md`](./run-center-v1-hardening-spec.md) | **source of truth**：25 条事实基线 + 架构图 + 问题树 + 2 个 DECISION + 18 项解决方案表 + Phase 0–6 + DoD + 架构债务 | 要证据、要设计依据时查 |
| [`run-center-v1-hardening-todo.md`](./run-center-v1-hardening-todo.md) | **执行清单**：按真实依赖排序，每项含 `depends` / `files` / `verify` / `spec` | 开始干活时按这个走 |
| [`evidence/`](./evidence/) | 实机验证工具（CDP 驱动脚本）+ 截图证据 + 复现方法 | 要复现事实、或做 `RC-T05` 时 |

## 当前状态

- **未开工。** 所有 TODO 均未执行，Run Center 代码未做任何修改。
- 起点是 `RC-T00`（建分支 + 跑测试基线）。
- **两个 DECISION 未拍板**，其中 `DECISION-01` 阻塞 Phase 3 DoD。

## Git 上下文

| 项 | 值 |
|---|---|
| 基线 commit | `0c0b7907` |
| 与 `origin/develop` | `git rev-list --left-right --count origin/develop...0c0b7907` → `0  1`，**clean fast-forward** |
| 建议分支 | `feat/run-center-v1-hardening`，**从 `0c0b7907` 切**（不是从 develop） |
| 并行冲突热点 | `bus.ts` 的 `_enqueueBody` / `runActorTurn` / `_emitTaskRunTerminalIfQuiescent`；`conversations.sendStream` 签名（本次新增 `retry_request_id`） |

## 三条容易被忽略的关键约束

1. **不得破坏 renderer-safe 隐私边界。** `0c0b7907` 刻意删除了 `redactRendererText()`、移除了 `workflow.objective` 与 `step.resultSummary`。任何改动不得以「好用」为由把 prompt / objective / tool 参数放回 Renderer。
2. **jsdom 不做 layout。** 仓库没装 jsdom/happy-dom，且 `test/renderer/chat-rich-composer-newline.test.ts:14` 注明「do no layout anyway」。因此**布局可见性无法用单测验证**，`RC-P0-06` 必须走结构断言 + `evidence/` 里的真实浏览器冒烟。
3. **`window.cogseed` 是 contextBridge 冻结对象**（实测 `writable:false, configurable:false, frozen:true`）。`RC-T01` 的 mock 必须在加载 `run-center.js` **之前**注入，运行时覆盖会静默失败。

## 已知待回改的疑点

见 `run-center-v1-design-rationale.md` 末尾「附：编写本文档时发现的疑点」——3 条，均**未回改 source of truth**，待确认后处理。其中疑点 1（`retryOfTaskId` 已存在且 native retry 已在用，但 projection 从不透出）会改变 `RC-P1-09` 的范围与成本。
