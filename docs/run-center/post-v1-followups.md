# Run Center v1 — Post-RC Follow-ups

> 建立 2026-08-26 · 分支 `feat/run-center-v1-hardening`
> **这是 Run Center v1 之后所有遗留项的唯一入口。** 任何「以后要做的事」只登记在这里；
> evidence 里可以描述，但必须回链本文档，否则换 session 就会丢。

---

## 1. 当前状态

- **Run Center v1 Hardening 已 RC-DONE**（2026-08-26）。spec §16 DoD 20 项逐项有证据，
  见 [`evidence/phase-6/RC-T06-final-acceptance.md`](./evidence/phase-6/RC-T06-final-acceptance.md) §7。
- **当前 correctness 已收口**：全量 `npm run test:js` = **9606 passed / 24 failed / 105 skipped**，
  24 条为既存 `@napi-rs/canvas` 集，失败集合逐条同名、零新增零消失、`Unhandled Errors` = 0。
- **本文档中的所有条目都不阻塞 RC-DONE。** 它们是**下一阶段任务**，
  不是「v1 功能没做完」。唯一的例外已在 §3 明确标注为「有当前用户影响」。

> **hardening Done ≠ 架构债务 resolved。** D-1 / D-2 / D-3 / D-9 全部保持 open。

---

## 2. Architecture Debt

编号沿用 spec §18 Debt Registry，**不重编号**。本表是索引与优先级；
详细字段（当前事实 / 止血 / 未解决风险 / owner）见 spec §18.2–§18.4。

| ID | 问题 | 当前影响 | 为何 defer | Upstream 依赖 | 触发条件 | 优先级 |
|---|---|---|---|---|---|---|
| **D-1** | actor-turn-per-task：每轮 1 个 Task + 1 个 events JSONL | 无用户可见影响；增长与轮次线性，`RC-P1-15` 窗口已压平延迟 | 模型存废取决于 Runtime 侧 Task/Event Plane 形态，非工程单方可决（DECISION-02） | Runtime Task Plane / Event Plane | ① Observability Expansion 启动、event schema 进入设计；② Runtime 原生 Task Plane 出现；③ Store 体积或刷新延迟越过 `RC-P1-15` 窗口仍不可接受 | P2 |
| **D-2** | `state.taskRun.cogseedTaskId` 仅内存 | v1 下**无功能缺失**（见 §2.1） | 只有当 run 变成可恢复时才成为阻塞 | Runtime 侧 run 恢复能力 | 当 run 需要跨重启恢复、或需要把重启前的 run 与其 shadow task 重新关联时 | P2 |
| **D-3** | Group Chat lazy healing 与 CogSeed startup recovery 两套 orphan 判定，ownership 未定 | **当前 correctness-safe**（见 §2.2） | 统一意味着先回答「orphan 真相长期由谁持有」，是跨模块 ownership 决策 | Runtime Task Plane / 统一 lifecycle owner | ① Runtime 原生 Task Plane；② Event Plane / restart reconciliation 统一；③ 修改任一侧谓词；④ 出现第三套 reconciliation | P2 |
| **D-9** | `waiting_user` 影子任务生命周期 owner 未定 | ⚠️ **有当前用户可见影响** —— 见 §3 FU-1 | 解决它等于定义 `waiting_user` 的生命周期与「用户回复后新 run 与旧 task 的关系」，是模型决策 | Group Chat orchestration lifecycle / Runtime Task Plane | ① 正式定义 `waiting_user` 生命周期；② Runtime Task Plane 开始设计；③ 需要反向收口旧 task；④ 历史量开始影响 UI / retention | **P1**（其 correctness 外溢见 FU-1） |
| D-4 | 无 push 通道，preload 白名单缺 `cogseed:` 前缀 | 靠 `RC-P0-02` 的 5s 轮询过渡 | Observability Expansion 的前置 | preload 白名单 + `webContents.send` 通道 | Observability Expansion 启动 | P2 |
| D-5 | `cogseed.task.events` 名为 stream 实为分页读 | 契约误导，无功能缺陷 | 改造为真订阅时一并正名，单独改名是纯churn | 同 D-4 | 与 D-4 同批 | P2 |
| D-6 | Task Store 无索引，全目录扫描 | `RC-P1-15` 已加窗口，但仍**读取**每个 task 文件 | 规模化前引入索引是过早优化 | — | 任务量或刷新延迟不可接受时 | P2 |
| D-7 | renderer 测试长期靠字符串匹配 | `RC-T01` 的 jsdom harness 已在 Run Center 落地，**尚未推广到全仓** | 推广是独立工作量 | — | 下一个需要 renderer 行为测试的模块 | P2 |
| D-8 | 布局正确性无法被单测覆盖 | `RC-T05` 已建立 Run Center 的 CDP 冒烟层，**未推广、未进 CI** | 进 CI 需要图形栈，属基础设施决策 | CI 图形栈能力 | 需要为其它页面做布局回归时 | P2 |

### 2.1 D-2 补充：v1 下究竟缺了什么

重启后丢失的是「**内存里那条 run ↔ shadow task 的关联**」。但 v1 语义下，
被重启打断的 group-chat run 一律落 `failed` + `app_restart`（Phase 2），
判定输入是**持久化的** task 记录 + `PROCESS_STARTED_AT`，不依赖该内存关联。
所以 **v1 下没有可观察的功能缺失**。

它真正阻塞的是：当 run 变成「可跨重启恢复」时——那时必须能把旧 run 与其 shadow task 重新对上。
**因此它应当与 upstream 的 run 恢复能力一起改，而不是现在单独持久化一个字段。**

### 2.2 D-3 补充：为什么当前是 correctness-safe

两套机制作用于**互不相交的存储**：

| | 触发 | 判定 | 写入 |
|---|---|---|---|
| Group Chat lazy healing | 读时 | `(status==='running' \|\| diskInFlight>0) && !runtime.processing && !backendActive` | 只写 group_chat `state.json`（`setStatus()`） |
| CogSeed startup recovery | 启动时（deferred） | `isCogSeedInterruptibleStatus(status) && updatedAt < PROCESS_STARTED_AT` | 只写 CogSeed task 记录 |

**不存在同一 task 在不同 timing 得到不同终态**，因此可以写确定性 invariant
（RC-T04 Scenario E 即是）。谓词**不重复** —— 一个管「当前会话是否还在跑」，
一个管「历史 task 是否是上一进程遗留」。

耦合只有一处且方向单一：Group Chat 读 CogSeed 任务状态算 `backendActive`（只读），
用作**阻止** healing 的护栏。这条耦合正是 FU-1 的来源。

**现在统一会明显返工**：唯一 owner 的人选取决于 Runtime Task Plane 是否接管 task 生命周期；
若接管，`recovery.ts` 的分流分支与 `PROCESS_STARTED_AT` 护栏都会被替换。
**明确 defer 到 upstream transition。**

**应保留到未来实现的 invariant**（无论谁最终 own）：
① 本进程 live task 不得被 startup sweep 误伤；② 重复 sweep 幂等、不重复计数；
③ group-chat 中断落终态而非 `recoverable`；④ `waiting_user` 不被判为 `app_restart`。
对应测试：`app-restart-recovery.test.ts`、`task-transitions.test.ts`、RC-T04 Scenario E。

---

## 3. Correctness / Product Follow-ups

**只列审计后确认仍有当前用户影响的项。** 审计结论：**一项。**

### FU-1 — `waiting_user` 影子任务让会话长期显示为「处理中」 ⚠️ 用户可见

| 字段 | 内容 |
|---|---|
| **来源** | Phase 6 Debt Gate（D-9 的外溢），本轮只读复核确认 |
| **链路** | `group_chat/index.ts:177-181` 计算 `backendActive` 时，排除列表是 `completed / failed / cancelled / recoverable` —— **`waiting_user` 不在其中** → `backendActive = true` → `index.ts` 返回 `backend_active: true` → `conversation.js:2594` `processing = data.processing \|\| data.backend_active \|\| …` |
| **用户可见后果** | 该会话被当作 busy：spinner / `setGroupConversationBusy(cid, true)`、侧栏 badge、发送 UI 状态、group event observer 不退出 |
| **为什么会长期滞留** | `waiting_user` 的合法出边是 `['queued','cancelled']`，但**没有任何调用方**使用它 —— bridge 的 `startTurn` 只处理 `created→queued→running` 并为新一轮**新建** task。用户回复后旧 shadow task **无人收口**，这正是 D-9 的定义 |
| **触发范围** | 需要 `orchestration_ledger.status ∈ {waiting_for_form, waiting_for_agent}`（`bus.ts:1528-1536`），即编排表单/等待 agent 路径；不是每次群聊都会命中 |
| **本轮为何不修** | Part 11 明确禁止，且**单独修 `backendActive` 只是掩盖症状**：把 `waiting_user` 加进排除列表能让会话不再假 busy，但该 task 仍永久计入 `activeTaskCount`、永不被保留窗口裁剪、仍无人收口 |
| **建议定性** | **可与 D-9 分离的独立 correctness 修复**。症状修复（1 行排除列表）与 lifecycle owner（D-9）是两件事，可以先修前者止血 |
| **下一步先查什么** | ① 该路径的真实命中频率（有多少会话会走到 `waiting_for_form`）；② 把 `waiting_user` 加入排除列表后，lazy healing 是否会在表单仍待填时错误地把会话 heal 成 idle —— **这才是当初不排除它的可能原因**，必须先证伪；③ 是否存在其它同样读 `backendActive` 的消费者 |
| **owner** | Group Chat orchestration（`backendActive` 语义）+ CogSeed task layer（谁收口） |
| **优先级** | **P1** |

> 除 FU-1 外，**无其它未收口 correctness bug**。
> Phase 6 的 BUG-1（`sessionProjection` 清空 native 幸存任务详情）与 RC-P2-20
> （`taskTree()` 吞掉孤儿 turn）**均已修复并有回归锁**，不属遗留。

---

## 4. Test Infrastructure

### TI-1 — 全量 coverage 无结果，且**CI 根本没有 coverage gate** ⚠️ 认知纠正

| 字段 | 内容 |
|---|---|
| **事实 1** | `vitest.config.ts` 定义了阈值 lines 61 / functions 62 / statements 58 / branches 52 |
| **事实 2** | **`.github/workflows/ci.yml` 不跑 coverage** —— CI 步骤为 `npm ci` / `test:resources:setup` / `typecheck` / `lint` / `npm test` / `readme:check` / `builtin:manifest:check` / email gate。`npm test` = `test:js && test:resources`，**不含 `--coverage`** |
| **结论** | **当前不存在生效的 coverage threshold gate。** 阈值只在有人手动跑 `npm run test:coverage` 时才被检查。**RC-DONE 不得暗示存在 coverage 门禁** |
| **事实 3** | 手动全量 `npm run test:coverage` 结束后**不产出报告段、也不生成 `coverage/` 目录**；相同命令在**子集**上运行则正常打印 text 表并写出 `coverage-summary.json` |
| **已排除** | 不是本轮引入 —— 未改动任何覆盖率配置；不是 provider 缺失 —— 子集可用 |
| **下一步先查什么** | ① 在全量规模下把 reporter 降到只留 `json-summary`，看是否是 text 表渲染阶段的问题；② 检查 `scripts/run-tests.mjs` 的 Electron-as-Node 包装是否影响 v8 coverage 的落盘（`NODE_V8_COVERAGE` 传递）；③ 用 `--maxWorkers=1` 跑全量 coverage，判断是否为多 worker 合并阶段的规模问题；④ 确认是否有 OOM / 静默退出 |
| **优先级** | **P1**（不是因为覆盖率数字，而是因为「以为有门禁其实没有」这件事本身危险） |

### TI-2 — 全量负载下 PDF/附件家族偶发失败

| 字段 | 内容 |
|---|---|
| **观察** | 每次全量运行会有**一条**时序敏感用例偶发失败，且**每次不是同一条**：`messaging.test.ts`（Phase 4）、`session_import.test.ts` 两条不同用例（Phase 5 / Phase 6 coverage）、`chat_attachments.test.ts > reuses a single attachment when matching uploads arrive concurrently`（Phase 6 全量） |
| **隔离结果** | 全部 3/3 通过；隔离时这些文件只剩各自**已知的** canvas 失败 |
| **已排除** | **不是共享 FS** —— 三个文件都用 `mkdtemp` + `COGSEED_WORKSPACE_ROOT` 自建临时根；**不是测试隔离配置** —— `vitest.config.ts` 为 `isolate: true` |
| **最可能方向** | 共享 native module（`@napi-rs/canvas` / pdfjs）+ 4 worker 并发下的时序；三条全部落在 PDF/附件/抽取缓存链路，与既存 24 条 canvas 失败**同一家族** |
| **调查顺序建议** | ① 先确认这三条在**没有 canvas 失败的环境**（如 CI Linux runner）是否也偶发 —— 若不偶发，问题指向本机 canvas 原生模块；② 用 `--maxWorkers=1` 跑全量，看是否消失（→ 并发时序）；③ 检查这三条各自是否有真实的并发/去抖断言（`chat_attachments` 那条名字就叫 concurrently）；④ 最后才看 teardown 泄漏 |
| **优先级** | P2（不影响判定 —— 已有「隔离重跑 + 复跑全量 + 比对失败集合」的既定流程） |

### TI-3 — 测试 runner 约束缺正式文档

`npm run test:js` 把 Vitest 跑在 **Electron 内嵌 Node** 下（`ELECTRON_RUN_AS_NODE=1`），
以对齐 `better-sqlite3` 的原生 ABI。直接用 `npx vitest run` 会因
`NODE_MODULE_VERSION` 不匹配额外产生约 **70 条**无关的 `ERR_DLOPEN_FAILED`。

本轮曾据此得到过一次**无效读数**。目前该约束只写在 Run Center 的 evidence 与 README 里，
**不在仓库级测试文档中**。建议提升到 `AGENTS.md` 或测试 README。优先级 **P2**。

### TI-4 — RC-T05 冒烟层未推广、未进 CI

见 D-8。`scripts/run-center-layout-smoke.mjs` 目前是 Run Center 专用的本地脚本。
**本轮未改动任何 CI 配置**，接入方式的建议见
[`evidence/phase-6/RC-T05-layout-smoke.md`](./evidence/phase-6/RC-T05-layout-smoke.md) §5。优先级 P2。

---

## 5. Future Capability

| 能力 | 当前替代 | 触发/依赖 | 相关 |
|---|---|---|---|
| push / event-driven projection | `RC-P0-02` 的 5s 可见期轮询 | preload 白名单加 `cogseed:` 前缀 + `webContents.send`；`RC-P0-01` 的 refresh 入口即挂载点 | D-4 |
| 增量刷新 / push 去重 | 全量重拉 | `board.updatedAt` 已预留（§6） | D-4 |
| 真订阅 events | `cogseed.task.events` 分页读 | 与 push 同批，届时一并正名 | D-5 |
| 看板分组头部 | 只渲染 progress | `group.title` / `titleKey` / `status` 已预留 | — |
| 技能版本治理界面 | 无 | `skillVersionPinStatus` 已预留 | — |
| 投影协议多版本共存 | 单版本 | `board.schemaVersion` 已预留 | — |
| Task Store 索引 / SQLite | 全目录扫描 + `RC-P1-15` 窗口 | 规模化 | D-6 |
| N+1 与重复上溯优化（`RC-P2-16` / `RC-P2-17`） | 本轮明确不做 | spec 要求「在 `RC-P1-15` 落地后**重新测量**」—— 现已落地，**测量尚未做** | D-6 |
| Observability Expansion | 无 | Token / Cost / Trace / Span / Logs / tool payload / latency / 队列指标 / 隐私授权通道，spec §H 全部本轮不做 | D-1 |

> **`RC-P2-16` / `RC-P2-17` 是本次审计中唯一「有明确前置条件、且前置已满足、但动作尚未执行」的条目。**
> spec §11（RC-P2-16/17）写明「记录并在 `RC-P1-15` 落地后重新测量」，`RC-P1-15` 已于 Phase 1 完成，
> **那次重新测量至今没有做**。建议作为 P2 的第一件事补上一条性能基准。

---

## 6. RESERVED 契约字段

逐项与 `ipc-service.ts` 的注释一致；任何一项被消费或删除时，**两处必须同时更新**。

| 字段 | Producer | 当前 Consumer | 为何保留 | Future consumer | Upstream 依赖 | 重审触发 |
|---|---|---|---|---|---|---|
| `board.updatedAt` | `boardProjection`（board 内 task `updatedAt` 最大值） | **无** | 增量刷新 / push 去重的天然输入，重新导出需要 diff 整个看板 | push / event-driven projection | **D-4（无 push 通道）** | **push 通道落地、或 incremental refresh 立项时** |
| `board.schemaVersion` | `boardProjection` | 无 | 协议版本位，删掉后再加回等于破坏兼容 | 第一个需同时容忍两种形状的客户端 | Observability Expansion | event schema 设计时 |
| `group.title` / `titleKey` / `status` | `boardProjection` 的 group 聚合 | 无（board 只读 `progress` / `parentTaskId` / `coordinationId`） | 数据已在聚合时算好，renderer 侧重算需要重走 `parentTaskId` | 看板分组头部 | — | 分组头部设计时 |
| `skillVersionPinStatus` | `taskSummary` | 无 | 只有 task 记录层面知道 pin 状态；删除会迫使治理界面重读全部 task | 技能版本治理界面（`cogseedAgentSkillLifecycleDir`） | 技能治理 UI | 该 UI 立项时 |

> 约束由测试强制：`contract-fields.test.ts` 的元规则测试会扫描源码每处 `RESERVED`，
> 要求 8 行内出现消费方说明 —— 「标了 RESERVED 却没说谁消费」直接失败。

---

## 7. Upstream Replacement Map

**下表不假装 upstream 设计已确定**，只标注「当前实现中最可能受影响的技术落点」。

| 当前 v1 机制 | Future upstream trigger | 可能动作 | 届时可能退役的实现 |
|---|---|---|---|
| CogSeed shadow task ledger | Runtime 原生 Task Plane | replace / migrate / adapt | `group-chat-task-bridge.ts` 全部；`taskSummary()` 的多数字段 |
| 5s 可见期轮询（`RC-P0-02`） | push / event plane | retire，或降级为 fallback | `run-center.js` 的 interval 与四门控；`board.updatedAt` 转为真消费 |
| 双套 reconciliation（D-3） | 统一 lifecycle owner | consolidate | `recovery.ts` 的 `executionKind` 分流分支；`PROCESS_STARTED_AT` 护栏 |
| `waiting_user` shadow lifecycle（D-9 / FU-1） | 权威 runtime lifecycle | redefine owner | `backendActive` 的排除列表；`waiting_user → queued` 这条无人使用的出边 |
| 会话删除清理 primitive（`RC-P1-14`） | upstream lifecycle event | migrate / retire | `purgeCogSeedGroupChatTasksByConversation()`；`chats.ts` 中的挂载块 |
| actor-turn-per-task（D-1） | Event Plane 的 span/trace 模型 | 模型替换 | `parentTaskId` 树、per-turn events JSONL、turn 级幂等 claim |
| `rendererSafeIdentifier()` 白名单 | 授权化的 observability 通道 | **保留** —— spec §17 的硬性红线要求任何深度可观测能力必须经授权 + renderer-safe projection，**不得旁路** | 无（这是要守住的，不是要退役的） |

---

## 8. Recommended next investigations

每项先写「**下一步先查什么**」，不直接写重构方案。

### P0
**无。** 当前没有阻塞性问题；FU-1 有用户影响但不阻塞任何已交付能力。

### P1
1. **FU-1 —— `waiting_user` 导致会话假 busy**
   先查：把 `waiting_user` 加入 `backendActive` 排除列表后，
   lazy healing 会不会在表单仍待填时把会话错误 heal 成 idle。
   **这很可能正是当初不排除它的原因，必须先证伪再动手。**
2. **TI-1 —— coverage 门禁的真实状态**
   先查：CI 确实没有 coverage 步骤（已确认），因此第一步是**决定是否需要门禁**；
   若需要，再排查全量 coverage 不出报告的根因（reporter / Electron runner / worker 合并）。
   **在此之前，任何文档都不得声称存在覆盖率门禁。**
3. **D-9 lifecycle owner**
   先查：用户回复后，从产品语义上「旧 waiting_user run」应当是 `cancelled`、`completed`
   还是保留为历史？这个答案决定了后面所有实现。

### P2
1. **`RC-P2-16` / `RC-P2-17` 的重新测量** —— 前置 `RC-P1-15` 已满足，只欠一条性能基准。
2. **TI-2 flaky** —— 先在无 canvas 失败的环境复现，再用 `--maxWorkers=1` 区分并发时序。
3. **TI-3** —— 把「必须用 `npm run test:js`」的 runner 约束提升到仓库级文档。
4. **D-7 / D-8 / TI-4** —— 把 jsdom harness 与 CDP 冒烟层推广出 Run Center。
5. **D-6** —— 规模化时的索引方案，与 `RC-P2-16/17` 的测量结果一并决策。
6. **D-4 / D-5** —— push 通道与 events 契约正名，作为 Observability Expansion 的前置。

---

## 9. 与其它文档的关系

| 文档 | 关系 |
|---|---|
| [`run-center-v1-hardening-spec.md`](./run-center-v1-hardening-spec.md) §18 | Architecture Debt 的**详细字段**在那里；本文档是索引 + 优先级 + upstream 视角。**两处的 open/closed 状态必须一致** |
| [`run-center-v1-hardening-todo.md`](./run-center-v1-hardening-todo.md) | v1 的执行清单，已全部勾选。未完成项只剩 `RC-P2-16` / `RC-P2-17`（本轮明确不做），已收进本文档 §5 |
| [`evidence/`](./evidence/) | 「当时发生了什么」的证明。**evidence 里描述的任何 future work 都必须在本文档有对应条目** |
