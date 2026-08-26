# Phase 3 — 用户可达性：总验收

> 验收 2026-08-26 · 分支 `feat/run-center-v1-hardening`
> spec §11 DoD · 前置 Phase 0 / 0.5 / 1 / 2（含 corrective patch）全部完成

## 1. 逐项状态

### 3A 交互可达

| 项 | 状态 | 实现要点 | 验证 |
|---|---|---|---|
| `RC-P0-07` Open Conversation | ✅ | `taskSummary()` 透出 `conversationId`。原 bug：`detailsHtml()` 优先读 detail snapshot，而该 snapshot 不含 `conversationId` → **功能正常时按钮消失，detail 读取失败回落 board 时才出现** | 实机 `openBtn:true`，点击后 `panel-conversation.active`；jsdom 4 条 |
| `RC-P1-08` `waiting_user` 出口 | ✅ | 详情区突出该按钮（`data-run-center-open-primary`）+ 说明文案；**未新增任何后端动作** | jsdom 5 条，含「重启后仍可达」 |
| `RC-P2-10` resume 语义核验 | ✅ | 仅补测试，零实现改动 | main 20 条 + renderer 3 条，锁定 group-chat `resume === false` 与 DOM 无 resume |
| `RC-P2-11` filter scope | ✅ | 非 board 视图下 `.run-center-filters` `hidden` + 每个按钮 `disabled aria-disabled` | 实机 runs 视图 `filtersVisible:false, filtersEnabled:0`；jsdom 2 条 |

### 3B 视觉可达

| 项 | 状态 | 实现要点 | 验证 |
|---|---|---|---|
| `RC-P0-06` completed 列裁剪 ★P0 | ✅ | `.dashboard-board-columns` 由 `repeat(4, minmax(190px,1fr))` + `min-width:820px` 改为 `repeat(auto-fit, minmax(190px,1fr))`，**去掉硬性 min-width** → 窄栏自动折行 | **CDP 四档实测，见 §2** |
| `RC-P2-12` activity icon | ✅ | `icons.js` 补 Lucide `activity` path | 实机 `activityIcon:true`；jsdom 1 条 |
| `RC-P2-19` 空看板文案 | ✅ | `retentionHiddenCount > 0` → `board_empty_retention`（说明是时间窗，可开会话看完整历史）；否则 `board_empty` | jsdom 3 条 |

### 3C 卡片身份

| 项 | 状态 | 详细 |
|---|---|---|
| `RC-P0-13` 卡片身份 | ✅ | 见 [`RC-P0-13-card-identity.md`](./RC-P0-13-card-identity.md) |

## 2. 布局实测（Electron + CDP，非 jsdom）

`node docs/run-center/evidence/cdp-capture.mjs <out.png> <width> 900`
断言：每一列的 `getBoundingClientRect().right <= .run-center-main` 的 `right`，
不满足则该列被标记 `<CLIPPED>`。

| 宽度 | 结果 | 截图 |
|---|---|---|
| 720px | `["pending=0","running=0","attention=0","completed=12"]` — 无 `<CLIPPED>` | `board-720px.png` |
| 1050px | 同上，无 `<CLIPPED>` | `board-1050px.png` |
| 1456px | 同上，无 `<CLIPPED>` | `board-1456px.png` |
| 1920px | 同上，无 `<CLIPPED>` | `board-1920px.png` |

> **截图说明**：所有看板截图都裁掉了左侧栏（视口 x < 260px）。侧栏渲染的是本机真实会话列表，与被验证的看板布局无关。裁剪只去掉左侧 260px，右侧边界与列宽均未改动，`<CLIPPED>` 判定不受影响。


**对比基线（F-20，`0c0b7907`）**：1456px 下 `completed=8 <CLIPPED>`，
列 `left=1152px` == `.run-center-main` 的 `right=1152px`，`colsScrollW=820 / clientW=608`，
溢出 212px 且无滚动条 —— 用户看到的是「三列全空，这功能没数据」。
现在 **720px 下 12 张已完成卡片全部可见**。

> jsdom 不做 layout，`getBoundingClientRect()` 恒为 0，故 `run-center-visibility.test.ts`
> 只做结构断言（四列节点存在、grid 无硬性 min-width），**不冒充可见性证明**。

## 3. 用户视角验收

### A. 看得见
- 四档宽度下四列均在可视区内，无裁剪（§2 实测）
- `activity` icon 正常，侧边栏不再回退到 `info`
- 空看板区分「真的没有任务」与「有历史但被 30 天 / 200 条保留窗口裁掉」

### B. 分得清
- 实机 **12 张卡片 / 2 种标题 / 12 个两两不同的身份**
- 同 run 的多个 actor turn 靠 turn 序数区分（同一 agent 也能分开）
- 运行树列表项两两可区分，读数与卡片一致
- 全部不依赖用户文本（详见 RC-P0-13 evidence §5）

### C. 够得着
- group-chat 正常路径按钮存在（这正是原 bug 的反面）
- `waiting_user` 有真实出口且被突出
- `app_restart` 历史任务有真实出口
- 实机点击后确实进入 `panel-conversation`
- filter 在不适用的 tab 上不制造假能力

### D. 不出现假 action
- group-chat `resume` 恒 `false`，DOM 无 resume 节点（实机 `resume:0`）
- `app_restart` 任务不假装可 retry，并有文案说明原因
- `waiting_user` 文案不暗示 Runtime 仍在后台运行
- Open Conversation 不被描述成 retry / resume（见 §4）

## 4. Phase 2 → Phase 3 语义联动

Phase 2 确立：历史 run 被重启中断 → `failed` + `app_restart` → 不可 resume、通常不可 retry。
Phase 3 补上出口后，完整用户语义应为：

```
历史 run 被重启中断 → 该 task 已结束为 failed
    → 不能从 Run Center resume/retry 原 run
    → 可以打开原 conversation
    → 用户自行重新发起新的 run
```

**验收中发现并修正的文案缺陷**：出口按钮原文案为 `Open task` / `打开任务`，
但它的实际动作是 `setView('conversation', cid)` —— 打开**会话**、另起**新** run。
「打开任务」读起来像是对这条 task 本身动手，正是 §七 禁止的三者混写。
已改为 **`Open conversation` / `打开会话`**（`run_center.open_task` 的值，key 名未动，全仓仅一处使用）。

三条语义现在各自独立且有回归锁（`run-center-reachability.test.ts` 4 条）：

| 语义 | 文案（en / zh） |
|---|---|
| Retry old run | `Retry` / `重试` |
| Resume old run | `Resume` / `继续` |
| Open conversation & start a new run | `Open conversation` / `打开会话` |

`app_restart` 说明文案：
> Interrupted by an app restart, so this run cannot be resumed or retried. Open the conversation to start a new run.
> 此运行被应用重启中断，无法恢复或重试。可打开会话另起一次新的运行。

断言同时锁定：该文案**不含**「still running / in progress / in the background」之类暗示进程仍在的措辞。

## 5. `waiting_user` sanity check（D-9 止血有效性）

Phase 3 **不解决** `waiting_user` 的生命周期 ownership —— 那是长期债务 **D-9**（spec §18.4）。
这里只验证 UI 止血有效：

| 检查 | 结果 |
|---|---|
| `waiting_user` 状态保留，未被重启改写 | ✅（Phase 2 故意排除） |
| Open Conversation 可达且被突出 | ✅ |
| 文案表达「需要用户回到对话处理」 | ✅ `This run is waiting for you...` |
| 不暗示 Runtime 进程仍在后台等 | ✅ 断言排除 `still running` / `in the background` / `processing` |
| 未新增 resume | ✅ `cogseed.task.action` 零调用 |
| **D-9 未被标记 resolved** | ✅ 仍在 registry 中 open |

## 6. 回归

官方入口 `npm run test:js`（Vitest 跑在 Electron 内嵌 Node 下，`ELECTRON_RUN_AS_NODE=1`，
以对齐 `better-sqlite3` 的原生 ABI）。

> ⚠️ **不要用 `npx vitest run`**：系统 Node 的 `NODE_MODULE_VERSION` 与 `node_modules` 中
> 为 Electron 编译的 `better-sqlite3` 不匹配，会额外产生约 70 条与本改动无关的
> `ERR_DLOPEN_FAILED` 失败，得到无效读数。

| 范围 | 结果 |
|---|---|
| `RC-P0-13` 专项 | 32 passed（17 main + 15 renderer） |
| Phase 3 全部专项 | 84 passed（identity 15 / reachability 26 / visibility 6 / resume-invariant 20 + 主链） |
| Run Center renderer + cogseed backend 全集 | 54 files / 349 passed |
| Phase 0 baseline（RC-T00 的 10 个文件） | **266 passed / 7 skipped —— 与基线逐数吻合** |
| 仓库全量 | **9522 passed / 24 failed / 105 skipped** |
| 失败集合比对 | 与 Phase 2 结束时的 24 条 **逐条同名**，零新增、零消失 |
| new regressions | **无** |
| tsc `--noEmit` | 通过 |
| eslint（改动文件） | 通过 |
| CDP 720 / 1050 / 1456 / 1920 | 四档全部通过，无 `<CLIPPED>` |

**基线对比**：Phase 2 结束 9438 passed / 24 failed / 105 skipped → Phase 3 结束 9522 / 24 / 105。
`+84` 全部可解释：Phase 3 新增 84 条测试（reachability 26、resume-invariant 20、identity 15+17、visibility 6）。

**已知失败集**（24 条，全部为 `@napi-rs/canvas` 相关的 PDF 抽取链路，与 Run Center 无关）：
`extract-pdf`(3) / `file_indexer`(13) / `file-tools`(4) / `chat_attachments`(1) /
`auto_tasks`(1) / `personal_context-forget`(1) / `session_import`(1)。

**一条偶发项已排查**：某次全量运行中 `messaging.test.ts > routes inbound text into group chat
and retries failed outbound delivery once` 失败，隔离重跑 3/3 通过（每次 76 passed），
下一次全量运行亦未复现 → 判定为负载下的偶发，非本轮回归。

## 7. 长期债务状态

Phase 3 **未**解决、也**不应**被本轮标记为 resolved：

| # | 状态 | 与 Phase 3 的关系 |
|---|---|---|
| D-1 | open | 不涉及 |
| D-2 | open | 不涉及 |
| D-3 | open | 不涉及；Phase 3 未改动任一 reconciliation 谓词 |
| D-9 | **open** | `RC-P1-08` 只提供 UI 出口，**不等于**解决生命周期 ownership |

Phase 3 期间发现的唯一新问题（`taskTree()` 孤儿 turn 不渲染）判定为**低 severity 的既有
correctness 边缘**，不是架构 ownership 问题，故按规则**未**进 Debt Registry；
记录在 RC-P0-13 evidence §9。

## 8. 结论

**Phase 3 可以标记 completed，进入 Phase 4。** spec §11 DoD 全部满足，
用户视角四项（看得见 / 分得清 / 够得着 / 无假 action）均有实机或测试证据，
全量套件零新增回归。
