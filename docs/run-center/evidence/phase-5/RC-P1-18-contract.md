# RC-P1-18 — 前后端契约收口（Phase 5）

> 完成 2026-08-26 · 分支 `feat/run-center-v1-hardening`
> ⚠️ **本阶段经调序前移，先于 Phase 4 执行**（理由见 spec §12 顶部与 §19）

## 1. 审计方式

**没有机械沿用 spec §13 的旧处置表。** 重新做了一次 producer / consumer 实测：
对每个投影字段在 `run-center.js` + `run-center-board.js` 中数真实命中，
再回到 `ipc-service.ts` 确认 producer 侧是否仍在计算。

规则：每个字段最终只能是 DELETE / KEEP+DISPLAY / KEEP+RESERVED 之一。
**不允许存在第四类**「后端算、前端永不读、也没人知道为什么留着」。

## 2. DELETE（2 项，均已真删）

### `board.counts`
- **消费者实测**：renderer / preload / 测试 **全为 0**
- **为什么必须删**：renderer 按 `column` 过滤后用 `items.length` 自己计数。
  后端的 counts 在**过滤之前**算出，两者会不一致 —— 留着不是冗余，是**会误导**
- **级联**：`CogSeedRendererBoardProjection.counts` 类型、boardProjection 中的计数循环、
  `test/main/ipc/cogseed-backend.test.ts` 的过期 mock 字段，全部移除
- **保留**：`retentionHiddenCount` 是 renderer 真实消费的（RC-P2-19 空态区分），不动

### `actions.skip`
- **为什么必须删**：`ipc-service.ts` 的 `action()` 对 `skip` **无条件抛错**
  （原文案 `CogSeed workflow skip requires a workflow step scope`，
  读起来像「换个入口再试」，但**没有那个入口**）。这是一个纯粹的假承诺
- **级联**（全部为该字段而存在的死代码）：
  - `CogSeedRendererActionSet.skip`
  - `taskActions()` 的 `hasWorkflowStep` 参数（其唯一用途就是算 skip）
  - `taskSummary()` 的 `hasWorkflowStep` 参数
  - `collaborationSnapshot` 中的 `workflowStepIds`、`hasSelectedWorkflowStep`
  - `CogSeedRendererTaskAction` 联合类型中的 `'skip'`
  - `normalizeActionInput` 的白名单与那句抛错
- **既有测试同步**：断言语义由「`skip === false`」改为「**字段不存在**」
  （`group-chat-resume-invariant.test.ts` 9 条 + `app-restart-recovery.test.ts` 1 条）。
  不变量本身没变 —— group-chat 永远不提供 skip —— 只是表达方式从「有且为假」变成「压根没有」

## 3. KEEP + DISPLAY（7 项，均已真渲染）

旧处置表列了 6 项，本次审计**新发现第 7 项**（`timeline.isError`）。

| 字段 | 落点 | 呈现 | 0 / 空 / false 时 |
|---|---|---|---|
| `session.taskCount` | 会话列表行 | `4 tasks` | 无任务 → 整条 meta 不渲染 |
| `session.activeTaskCount` | 同上 | `· 2 active` | 为 0 → **省略该子句**，不写「0 active」 |
| `session.hasRecovery` | 同上 | `Recoverable` 标记 | false → 不渲染标记 |
| `recovery` | 详情区 | `2 tasks in this session can be resumed.` + 最近事件时间 | 不可恢复、或 flag 为真但 `taskIds` 为空 → 不渲染（否则会出现「0 tasks」） |
| `reviews` | 协作视图新增 section | 关卡 / 步骤 / 状态 / 决定 / 审核者 / 时间 | 空 → `No review gates in this run` |
| `conflicts` | 协作视图新增 section | 类型 / 状态 / 受影响步骤数与列表 / 时间 | 空 → `No conflicts in this run` |
| `timeline.isError` | 运行时间线 | `Failed` 标记，携带 `errorCode` | 非错误事件 → 不标记 |

**低侵入**：全部放进**已有**区域（会话列表行、详情区、协作视图），
没有新开页面，没有重复看板已显示的信息。

**顺带修掉一处后端产出 prose**：`reviews[].name` 原本是硬编码英文字面量
`'Review gate'` —— 后端生成用户可见文案，与本仓库「标题一律以 i18n key 过河」的做法相悖，
且中文界面下永远显示英文。已改为 `nameKey: 'run_center.review_gate'`。
**没有丢数据** —— 原代码就没读 `gate.name`，只是写死。

**i18n**：新增 21 个 key，en / zh 双语齐全。枚举状态（review status / decision /
conflict type / conflict status）走既有 `dynamicLabel()` 模式，未知值回落到可读文案，
不会把 `run_center.review_status_xxx` 这种 key 泄到界面上。

## 4. KEEP + RESERVED（均已补注释）

规则：RESERVED 必须写清**谁消费、什么时候重审**，否则下轮同样无从判断。
测试对这一点做了强制（见 §5）。

| 字段 | 预期消费方 | 重审时机 |
|---|---|---|
| `board.updatedAt` | 增量刷新 / push 去重（「自上次轮询是否有变化」，无需 diff 整个看板） | **阻塞于 D-4**（无 push 通道，preload 白名单缺 `cogseed:` 前缀）。push 通道落地时重审；RC-P0-02 的 5s 轮询是过渡手段 |
| `board.schemaVersion` | 第一个需要同时容忍两种形状的客户端 | Observability Expansion（spec §17） |
| `group.title` / `group.titleKey` / `group.status` | 看板分组头部（当前只渲染 progress） | 分组头部设计时 |
| `skillVersionPinStatus` | 技能版本治理界面（`cogseedAgentSkillLifecycleDir`），**不属于 Run Center 职责** | 技能治理 UI 落地时 |

`group.coordinationId` / `group.parentTaskId` / `group.updatedAt` 经核实**已有消费者**
（前两者被 `run-center-board.js` 读取，后者用于 producer 侧排序），已就地标注，不算 RESERVED。

## 5. Phase 3 契约保护

以下字段**已有真实 renderer 消费者**，本轮明确未动（旧处置表未列，不等于可删）：

`conversationId`（RC-P0-07 出口）、`agentId`、`runOrdinal` / `turnOrdinal` /
`conversationShortId`（RC-P0-13 身份）、`retryOfTaskId`（RC-P1-09）、
`errorCode`（`app_restart` 文案）、`status`（`waiting_user` 出口）、
`parentTaskId`（运行树，RC-P2-20）、`retentionHiddenCount`（RC-P2-19）。

## 6. 测试（31 条，全绿）

**`test/main/features/cogseed_backend/contract-fields.test.ts`（16 条）**
- DELETE：`counts` 不在真实 board projection 对象上、不在类型定义里；
  `skip` 不在任何 action set 上（且 `Object.keys(actions)` 恰为 `abort/resume/retry`）；
  `action('skip')` 现在被输入校验挡下；源码中不再有 `hasWorkflowStep` / `workflowStepIds`
- RESERVED：字段仍存在，且类型定义处的注释含 `RESERVED` 与消费方说明
- **元规则测试**：扫描源码里每一处 `RESERVED` 标记，强制其 8 行内出现
  `consumer|consumed|Re-review` —— 「标了 RESERVED 却没说谁消费」直接失败
- DISPLAY：后端确实供值（`taskCount: 3 / activeTaskCount: 2`；`hasRecovery` 由真实
  task 状态推出而非常量；recovery 块由 `recoverable` 任务驱动）
- privacy：objective / workingDir 哨兵串在 board / sessionList / collaboration
  三个序列化投影中零命中；session summary 字段集合白名单封闭

**`test/renderer/run-center-contract-display.test.ts`（15 条）**
- 每个 DISPLAY 字段都断言**真实 DOM 输出**，非 source-string
- 每个字段都有 **0 / 空 / false 的不误导断言**（不写「0 active」、不写「0 tasks」、
  空列表说「没有」而不是渲染空壳）
- 枚举回落：未知 review 状态显示 `Unknown`，不泄 i18n key
- privacy：会话标题里的自由文本不进 meta 行、不进 reviews / conflicts

## 7. 回归

| 范围 | 结果 |
|---|---|
| RC-P1-18 专项 | **31 passed**（16 main + 15 renderer） |
| renderer + cogseed + group_chat + ipc | 237 files / **2628 passed / 7 skipped** |
| Phase 0 baseline | **266 passed / 7 skipped**（与基线逐数吻合） |
| 全量 `npm run test:js` | **9566 passed / 24 failed / 105 skipped** |
| 失败集合比对 | 与已知 canvas 24 条**逐条同名**，零新增、零消失 |
| tsc / eslint | 通过 |

`+31` 相对 RC-P2-20 结束（9535）完全由本阶段新增测试解释。

**一条偶发项已排查**：首次全量运行中 `session_import.test.ts > creates a continuable
conversation seeded with the summary` 失败。隔离重跑 3/3 通过（每次只有该文件里
已知的 canvas 那条失败），第二次全量亦未复现 → 判定为负载下的偶发，非本轮回归。

## 8. Phase 5 完成条件核对

- [x] DELETE 真删（含全部级联死代码）
- [x] DISPLAY 真显示（7 项，含 0/空/false 不误导）
- [x] RESERVED 有明确 owner / 用途 / 重审时机注释，并由元规则测试强制
- [x] 不存在「后端算、renderer 永不读、且无解释」的字段
- [x] 无新增隐私暴露（真实 projection 对象断言）
- [x] 无新 regression
