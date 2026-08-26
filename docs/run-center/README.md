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
| [`post-v1-followups.md`](./post-v1-followups.md) | **下一阶段唯一入口**：架构债务索引 + correctness follow-up + 测试基础设施 + future capability + upstream 替换图 + 优先级 | RC-DONE 之后要知道「还剩什么」时 |

> **Evidence ≠ Debt Registry。** `evidence/` 证明「当时发生了什么」；
> spec [§18 长期架构债务](./run-center-v1-hardening-spec.md#18-长期架构债务debt-registry)
> 记录「以后必须回来处理什么」。只写进 evidence 的问题**不算登记** —— 换 session 后无法被重新发现。

## 当前状态

> 更新于 2026-08-26

- **长期架构债务已正式登记** —— `D-1`（actor-turn-per-task 粒度）/ `D-3`（双套 orphan reconciliation 的 ownership）/ `D-9`（`waiting_user` 生命周期 ownership）三条模型债务集中在 spec §18，并列入 `RC-DONE` 前的 debt review。**hardening Done ≠ 架构债务 resolved。**
> **下一阶段还有什么？** → [`post-v1-followups.md`](./post-v1-followups.md)。
> 其中 **FU-1**（`waiting_user` 导致会话长期显示「处理中」）与 **TI-1**（**CI 实际没有 coverage 门禁**）为 P1。

- **✅ Run Center v1 Hardening 已完成（RC-DONE，2026-08-26）** —— Phase 0 → 6 全部收口，spec §16 DoD 20 项逐项有证据。
  最终验收见 [`evidence/phase-6/`](./evidence/phase-6/)（含 Debt Gate、回归矩阵、RC-DONE 逐项证据）。
  全量 **9606 passed / 24 failed / 105 skipped**，24 条失败为既存 `@napi-rs/canvas` 集，**零新增回归**。
  **四条长期架构债务 D-1 / D-2 / D-3 / D-9 保持 open —— hardening Done ≠ 架构债务 resolved。**
- **Phase 6 已完成** —— `RC-T02`～`RC-T06`。新增跨层 E2E（真实 store + 真实 ipc-service + 真实 FS，8 场景）与布局冒烟脚本 `npm run smoke:run-center`（四档 64/64）。
- **Phase 5 已完成** —— `RC-P1-18` 契约收口：DELETE 2 项真删（`board.counts` / `actions.skip` 及其全部级联死代码）、DISPLAY 7 项真渲染、RESERVED 全部有 owner/用途/重审时机注释并由元规则测试强制。记录见 [`evidence/phase-5/RC-P1-18-contract.md`](./evidence/phase-5/RC-P1-18-contract.md)。
- **Phase 4 已完成** —— `RC-P1-14` 会话删除级联清理，挂在真实路径 `chats.ts::_purgeDeletedConversationFiles()`；native task 按**方案 (c2)** 保留数据、移除失效出口。记录见 [`evidence/phase-4/RC-P1-14-conversation-cleanup.md`](./evidence/phase-4/RC-P1-14-conversation-cleanup.md)。
- **`RC-P2-20` 已修复** —— `taskTree()` 曾把父任务缺失的 turn 整条吞掉（Runs 视图落到空态，而看板仍显示该卡片）。记录见 [`evidence/phase-4/RC-P2-20-tree-orphan.md`](./evidence/phase-4/RC-P2-20-tree-orphan.md)。
- **执行顺序已调整（2026-08-26）：Phase 5 → Phase 4**（原为 4 → 5）。Phase 5 的 depends 已全满足；Phase 4 原 TODO 的 production hook 指向零调用方的死函数（真实落点为 `chats.ts::_purgeDeletedConversationFiles()`），且尚有 native task 可见性语义需按**方案 (c)** 收口。两阶段无 contract 双向依赖，调序不返工。见 spec §12 / §19。
- **两个 DECISION 已拍板** —— `DECISION-01` = **候选 B**（结构化 + `agentId`，零新增暴露面，候选 C 明确否决）；`DECISION-02` = **本轮不重构**，记为架构债务 D-1。**Phase 3 DoD 已解除阻塞。**
- **`RC-T00` 已完成** —— 分支已从 `0c0b7907` 切出，10 个测试文件基线全绿（266 passed / 7 skipped），记录见 [`evidence/baseline/RC-T00-baseline.md`](./evidence/baseline/RC-T00-baseline.md)。
- **`RC-T01` 已完成** —— jsdom harness + 5 条冒烟 + 3 条基线见证，9/9 通过；`reuse:check` / `sbom:check` / `eslint` / `tsc --strict` 全绿。记录见 [`evidence/baseline/RC-T01-harness.md`](./evidence/baseline/RC-T01-harness.md)。
  - ⚠️ 对 spec §8 有**一处设计偏离**（jsdom 当库用，不用 environment docblock），原因与取舍见该记录 §2。
- **Phase 1 已完成** —— `RC-P0-01` / `RC-P1-15` / `RC-P0-02` / `RC-P1-09` / `RC-P1-03` 全部落地，新增 39 条测试。
- **Phase 2 已完成** —— `RC-P0-04 + RC-P0-05` 作为一个语义闭环落地，新增 17 条测试。
  记录见 [`evidence/baseline/RC-P0-04-05-restart-recovery.md`](./evidence/baseline/RC-P0-04-05-restart-recovery.md)。
- **Phase 3 已完成** —— 3A/3B/3C 全部 8 项落地（`RC-P0-06` / `RC-P0-07` / `RC-P1-08` / `RC-P2-10` / `RC-P2-11` / `RC-P2-12` / `RC-P2-19` / `RC-P0-13`），新增 84 条测试。
  实机 CDP 四档（720/1050/1456/1920）布局全部通过；看板 12 张卡片只有 2 种标题但 12 个身份两两不同。
  总验收见 [`evidence/phase-3/RC-PHASE-3-acceptance.md`](./evidence/phase-3/RC-PHASE-3-acceptance.md)，
  卡片身份与隐私复审见 [`evidence/phase-3/RC-P0-13-card-identity.md`](./evidence/phase-3/RC-P0-13-card-identity.md)。
  - ⚠️ 跑测试请用 **`npm run test:js`**（Vitest 在 Electron 内嵌 Node 下运行以对齐 `better-sqlite3` ABI）。
    直接 `npx vitest run` 会额外产生约 70 条无关的 `ERR_DLOPEN_FAILED` 失败，读数无效。
  - ⚠️ 实施中发现 **spec §10 有两处判断与代码不符（含一处阻断级）**，方案已相应调整，未机械照旧。详见该记录 §2。
- **下一步：Phase 3**（用户可达性；`DECISION-01` 已拍板为候选 B，`RC-P0-13` 无阻塞）。

> ⚠️ `RC-P1-09` 触碰 `bus.ts:2127 _enqueueBody`（并行开发热点）。TODO 要求它**单独成 PR 且优先合入**；
> 本轮是在同一分支上顺序实现的，拆 PR 时需把该改动单独摘出。

### ⚠️ 全量套件当前不绿（既存问题，非本轮引入）

`npm run test:js` 有 **24 项失败 / 7 个文件**，全部是 PDF/DOCX 抽取，根因是
`@napi-rs/canvas-darwin-arm64` 的 `skia.darwin-arm64.node` **二进制被截断**（`dlopen` 报
`__TEXT ... extends beyond end of file`）。该包所有文件 mtime 均为 **2026-08-18**，本轮未触及。
处置建议见 [`RC-T01-harness.md` §10](./evidence/baseline/RC-T01-harness.md)。
**Run Center 相关 11 个文件为 275 passed / 7 skipped，零回归。**

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

## 已知疑点 —— 已全部处置（2026-08-26）

`run-center-v1-design-rationale.md` 末尾的 3 条疑点**均已对代码复核确认属实，并已回改 source of truth**：

| 疑点 | 复核结论 | 处置 |
|---|---|---|
| 1 — `retryOfTaskId` 已存在且 native retry 已在用，但 projection 从不透出 | 属实（6 处命中 vs `ipc-service.ts` 0 命中） | spec/TODO 的 `RC-P1-09` 已拆为 (a) 写入侧 + (b) 投影侧两步；**范围扩大**（对所有 executionKind 生效）但**成本下降**（无 schema 变更，(b) 为一行） |
| 2 — spec §2.2 标题写「18 条」实际 25 条 | 属实（F-01 ~ F-25） | 标题已改为「（25 条）」 |
| 3 — `RC-P2-13a` 编号风格不一致 | 属实 | 已全库改名为 `RC-P2-19` |
