# RC-P0-13 — 卡片身份可辨识（Phase 3C）

> 完成 2026-08-26 · 分支 `feat/run-center-v1-hardening`
> 决策依据：**DECISION-01 = 候选 B**（spec §5）
> 相关：`RC-P0-01`（Refresh）、`RC-P1-15`（保留窗口）、`RC-P0-07`（Open Conversation）

## 1. 修的是什么

Group Chat 的每个 actor turn 都投影成同一个标题（`run_center.task_kind_agent_turn` → 「Agent turn」），
一次会话的多个 run 也都叫「Group Chat run」。看板上因此出现**一整列长得完全一样的卡片**，
用户无法判断哪张是哪次运行。

**实机基线（本机真实数据，1456px）**：

```
cardCount: 12    distinctTitles: 2    ← 12 张卡片只有 2 种标题
```

## 2. 使用的 identity 信息

按 DECISION-01 候选 B，identity 由以下**结构化字段**组成：

| 成分 | 来源 | 说明 |
|---|---|---|
| run ordinal | 服务端 `cogSeedTaskIdentity()` | 同 session 内按 `createdAt` **升序排序**计算，`taskId` 破同秒平局 |
| turn ordinal | 同上 | 在**所属 run 内**计数，不是 session 级流水号 |
| 相对时间 | **Renderer 计算** | 复用既有 `dashboard.ago_*` i18n key；后端只出 ISO 时间戳 |
| `conversationId` 前 8 位 | `conversationShortId` | 严格窄于 summary 已透出的完整 `conversationId` |
| `agentId` | 既有字段 | 已过 `rendererSafeIdentifier()` 白名单，`0c0b7907` 起就在投影中 |

渲染形态（三处一致）：`第 2 次运行 · 第 1 轮 · 41 分钟前 · 9f1eeaf8`

## 3. 明确未使用

以下**一律不进投影**，DECISION-01 否决候选 C 的原因正是此项：

- conversation title（Group Chat 常由用户首条消息生成）
- prompt / objective（记录里的 `task` 字段）
- 用户消息文本 / 首条消息
- step result / `resultSummary`
- tool input / output
- model response
- 任何其它自由文本（含 session `displayName`、`workingDir`）

## 4. 关键设计约束

**ordinal 由排序得出，不用数组下标。** 这是 DECISION-01 的硬约束，也是必须服务端计算的原因：
board 投影按 `updatedAt` 降序扫描，session 投影走子树遍历，两者顺序不同 ——
下标派生的 ordinal 会让同一次 run 在看板叫「第 2 次」、在详情叫「第 5 次」。

**conversation 解析与 Open Conversation 出口一致。** 实现中期发现一处真实不一致：
`boardProjection` 以 `task.conversationId || session.conversationId` 兜底透出 `conversationId`，
而 identity 只读 `task.conversationId`。结果是某些任务**有** Open Conversation 按钮却**没有**短标识。
已修正为两者共用同一解析（回归锁：`task-identity.test.ts` 「resolves the conversation the same way the Open Task exit does」）。

**相对时间不能单独构成 identity。** 卡片本身已有时间戳；若投影没有任何 ordinal
（历史记录、或无 session 上下文的单任务返回），identity 整体不渲染，而不是退化成时间戳的第二份拷贝。

## 5. 隐私复审结论

复审方式：**对真实 projection 对象断言**，不是 grep 源码。

| 断言 | 结果 |
|---|---|
| 记录的 `task`（objective）/ session `displayName` / `workingDir` 植入哨兵串后，board / collaboration / sessionList 三个投影序列化后均不含（含片段） | ✅ |
| task summary 的**字段集合**不超出白名单 —— RC-P0-13 只新增 `runOrdinal` / `turnOrdinal` / `conversationShortId` 三个 | ✅ |
| 三个新字段均为结构化值：两个 `number`，一个匹配 `^[A-Za-z0-9_.:-]{1,8}$` | ✅ |
| 非法 `agentId`（含 `<script>`）被 `rendererSafeIdentifier()` **丢弃而非净化**，投影中不含 `script` | ✅ |
| 投影不含任何用户可读文案：无 `ago`/`前`，`titleKey` 仍是 i18n key，时间戳仍是 ISO | ✅ |
| 完整 `conversationId` 不出现在 identity 中（只有短标识） | ✅ |

**结论：DECISION-01 候选 B 仍不扩大 renderer 暴露面。** 三个新字段全部由既有字段派生
（两个序数来自 `createdAt` 排序，短标识是既有 `conversationId` 的截断），零新增数据通道。

## 6. 实机验证（Electron + CDP）

```
cardCount: 12   distinctTitles: 2   identityCount: 12   distinctIdentities: 12
sample: 第 2 次运行 · 31 分钟前 · 9f1eeaf8
        第 2 次运行 · 第 1 轮 · 31 分钟前 · 9f1eeaf8
        第 1 次运行 · 32 分钟前 · 9f1eeaf8
        第 1 次运行 · 第 1 轮 · 32 分钟前 · 9f1eeaf8
```

**12 张卡片、2 种标题、12 个两两不同的身份。** 详情区与运行树读数与卡片一致：

```
detail:  第 2 次运行 · 31 分钟前 · 9f1eeaf8
tree:    第 2 次运行 · 41 分钟前 · 9f1eeaf8
         第 2 次运行 · 第 1 轮 · 41 分钟前 · 9f1eeaf8
```

## 7. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/main/features/cogseed_backend/ipc-service.ts` | 新增导出纯函数 `cogSeedTaskIdentity()`；`taskSummary()` 增加第三参 `identity`；`boardProjection` / `collaborationSnapshot` 按同 session 全量任务集计算并统一 conversation 解析；类型新增三字段 |
| `src/renderer/modules/run-center.js` | `formatRelative()` / `identityParts()` / `identityLabel()`；运行树两处与详情区渲染 `[data-run-center-identity]` |
| `src/renderer/modules/run-center-board.js` | 卡片 meta 渲染 identity（取代原先单独的 agentId span，避免同一信息渲染两次）；搜索可命中 `conversationShortId` |
| `src/renderer/locales/{en,zh}.json` | 新增 `run_center.label_identity` / `identity_run` / `identity_turn` |
| `test/main/features/cogseed_backend/task-identity.test.ts` | 新建，17 条 |
| `test/renderer/run-center-identity.test.ts` | 新建，15 条 |

## 8. 测试

**32 条全绿**（17 main + 15 renderer）。覆盖：

- 同 session 3 个 parent run → identity 两两不同，序数为 1/2/3
- 同 parent 3 个 actor turn → identity 两两不同；**同一 agent 的两个 turn 仅靠序数区分**
- turn 序数锚定在**所属 run 内**（run-b 的 turn 是 1/2，不是 session 级的 3/4）
- 调用方传入顺序无关（正序 / 逆序 / 乱序结果相同）—— 锁住「不得用数组下标」
- 同秒 `createdAt` 由 `taskId` 确定性破平
- `agentId` 缺失时 identity 仍成立，且不出现 `undefined` / `null` / 空分隔符
- 无任何 ordinal 时整体不渲染
- Board / 运行树 / 详情三处读数一致
- 父子层级真实构造（运行树按 `parentTaskId` 建树，孤儿 child 不会自行长出父节点）
- 切到 zh 后仍两两不同，且不出现未翻译的 i18n key
- 隐私：见 §5

## 9. 过程中发现、但**未**修的既有边缘行为

`taskTree()` 的根节点判定是 `!task.parentTaskId || !byParent.has(task.parentTaskId)`，
而 `byParent` 的 key 由子任务自己登记 —— 因此 `byParent.has(parentTaskId)` 对任何有父的任务**恒为真**，
该判定实际等价于 `!task.parentTaskId`。后果：父任务缺失的**孤儿 turn 在运行树中完全不渲染**。

- **不是本轮引入**：`0c0b7907` 起即如此
- **实际影响很小**：`collaborationSnapshot` 返回的是完整子树，`RC-P1-15` 又显式保留被保留任务的所有祖先，正常路径下父任务必然在场
- **不属于 RC-P0-13 语义**：后端 identity 已正确处理孤儿（回退为独立 run，见 `task-identity.test.ts`）
- 按「区分 correctness blocker 与 architecture debt」的要求：这是一个**既有 correctness 缺陷**，
  既非架构 ownership 问题，故**不进 Debt Registry**

> **后续（2026-08-26 同日）**：该问题已正式登记为 **`RC-P2-20`** 并**已修复** ——
> 见 spec §17.5 与 `evidence/phase-4/RC-P2-20-tree-orphan.md`。
> 实测比本节原先记录的更明确：orphan turn 不只是「不渲染」，而是让整个 Runs 视图
> 落到「无任务」空态，同时看板仍显示该卡片。修法为改用「本次投影的 taskId 集合」判定根节点，
> 父缺失的 turn 提升为自己的 root，**不伪造 parent**。13 条回归测试锁定。
