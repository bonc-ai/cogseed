# 调研结论：auto_tasks 消息派发机制与「指定飞书主页会话为派发目标」的扩展评估

**日期：** 2026-08-10
**作者：** 牛保康（C 线）
**关联设计：** `docs/superpowers/specs/2026-08-10-feishu-companion-context-design.md` §5.6（今日简报 → 飞书主页会话推送）
**结论先行：** auto_tasks 目前是 **bus 单派发 + PC 会话内目标**，与飞书主页会话（外部通道）是两个世界；「指定飞书主页会话为派发目标」不需要改 bus，只需要在 auto_tasks 的 fire 出口加一个**外部目标分支**，复用 messaging 已具备的 `manager.sendProactive`（幂等键 + 投递账本 + 重试 + 取消）能力。最小改动面在 `auto_tasks.ts` 与新的 `personal_context` 场景适配层，**不碰 messaging/、不碰 personal_ontology_***。

---

## 1. 现状机制盘点（已核实，附代码位置）

### 1.1 auto_tasks 的派发链路（单一入口）

`src/main/features/auto_tasks.ts`：

- 任务模型 `AutoTask`（90–115 行）：`recipient?: TaskRecipient`，其中
  `TaskRecipient = { kind: 'commander' } | { kind: 'agent'; id; name }`（80–82 行）——
  **只有 PC 内目标，没有外部通道目标**。
- Fire 路径 `_fireTask`（1095–1166 行）：
  1. `chats.createConversation(uid, { kind: 'normal', title, originAutoTaskId })`（1122–1127 行）——**总是先建一个 PC 内会话**；
  2. 复制附件进 `chat_attachments/<cid>/`（1137 行）；
  3. `groupChat.send({ userId, cid, text, attachments })`（1144 行）——**单一 bus 派发入口**；
  4. 失败时 `deleteConversation` 回滚空会话 + `fire_failed` 事件（1139–1165 行）。
- `group_chat/index.ts::send`（524 行起）→ `enqueue({ uid, cid, fromActorId: USER_ID, ... })`。
- `group_chat/bus.ts::enqueue`（1972 行）：每 cid 一个 runtime，FIFO 串行消费；路由只基于
  `router.resolveRecipients` 解析出的 `to[]`（bus.ts 头部注释），**目标永远是「PC 会话内的角色」**，
  没有外部通道概念。设计稿 §4 与 AGENTS.md §Conversations 均确认：`groupChat.send` 是唯一入队路径。

**结论 1：** auto_tasks 的输出**必然落在 PC 会话**（commander 会话或 agent 会话），
bus 单派发是"消息 → PC 会话 → 角色"的一跳，不存在第二跳/旁路。

### 1.2 messaging 侧已有的对外发送能力（可复用，勿重复造）

`src/main/features/messaging/`：

- `manager.ts::sendProactive(uid, { instanceId, recipientId, text, sourceKey })`（273 行）：
  向任意 recipientId（飞书 open_id）主动发文本，**自带投递账本（ledger）、幂等键（sourceKey）、
  重试（OUTBOUND_MAX_ATTEMPTS/RETRY_DELAYS）、取消（AbortSignal）、等待终态**——这正是
  auto_tasks 需要的"可重复执行 + 不重复投递"语义（设计稿 §9 风险表：重复/延迟事件触发重复任务）。
- `proactive.ts::sendToSelf(uid, { instance_id, target: 'self', text }, { cid, sourceKey })`（141 行）：
  **发给实例归属人（主页会话）**——内部解析 `instance.ownerExternalUserId` 为 recipientId
  （proactive.ts 186–209 行）。`ownerExternalUserId` 由飞书注册流程写死（feishu-registration.ts 472–477 行）。
- `proactive.ts::listTargets(uid)`（108 行）：列出飞书/微信实例与状态（available / owner_missing /
  not_connected / disabled），`sendToSelf` 依赖它做可用性门控。
- 入站侧：`manager.ts::enqueueInbound`（475 行）把飞书私聊消息投成 bus 的 USER 消息进入绑定会话；
  **目前 messaging 层没有 slash 命令解析器**（命令草案见任务 3，接入点不在 messaging 内）。

**结论 2：** 「发到飞书主页会话」的最小能力已存在（sendToSelf 就是给 owner 主页会话发消息），
缺的不是发送通道，而是 **auto_tasks → 该通道的接线**。

## 2. 差距分析：把「简报推送到飞书主页会话」需要什么

| # | 差距 | 说明 | 改动面 |
|---|------|------|--------|
| G1 | `TaskRecipient` 无外部目标类型 | 无法表达"这个任务推给哪个飞书实例/哪个人" | auto_tasks 类型扩展（向后兼容，新增联合成员） |
| G2 | `_fireTask` 无条件建 PC 会话 | 纯外部推送不需要 PC 会话；建了会污染会话列表 | fire 出口按目标分支 |
| G3 | 无归属人解析 | 主页会话 = 实例 `ownerExternalUserId`（open_id） | 通过 `proactive.listTargets` / bindings 解析，**不直接摸 messaging 内部状态** |
| G4 | 无幂等键策略 | 每日任务可重入（调度 tick 30s + 恢复），不能重复推送 | 幂等键 = `task.id + 触发日`（稳定、可解释、天然每日唯一） |
| G5 | 无失败降级语义 | 实例未运行/未绑定 → 简报不能丢，也不能阻塞调度 | 发送失败 → 回退 PC 会话回执或仅日志 + fire_failed 事件 |

## 3. 扩展方案评估

### 方案 A：扩展 `TaskRecipient` + `_fireTask` 分支（推荐）

- `TaskRecipient` 新增 `{ kind: 'messaging'; instanceId: string }`（recipient 固定为实例归属人 = 主页会话，
  与设计稿「绑定飞书主页会话 + 归属人」一致；不放开任意 recipientId，收窄攻击面）。
- `_fireTask` 开头按 recipient.kind 分派：
  - `commander` / `agent`：现有路径不变；
  - `messaging`：**不建 PC 会话**，直接组装文本 → 调 `personal_context` 场景适配层的
    `dispatchToFeishuHome(uid, { instanceId, text, sourceKey })` → 内部用 `manager.sendProactive`
    （不直接 import messaging，保持分层，避免 C 线触碰 messaging 红线）。
- 幂等键：`sourceKey = briefing:${task.id}:${YYYY-MM-DD}`（按触发日，天然每日唯一；ledger 幂等去重）。
- 失败处理：`sendProactive` 抛错 / 实例不可用 → `emitFailure('feishu_home_unavailable')` + warn 日志，
  不重试调度（次日再推），符合「降级不阻塞」。
- 会话回执：可选二期（不建 PC 会话，避免污染列表；如需审计，messaging ledger 已留痕）。

**优点：** 改动集中（auto_tasks 一处分支 + 一个新适配函数）；`TaskRecipient` 语义自然；
复用现成的幂等/重试/账本；调度 tick 不变。**代价：** 需要新增依赖方向
`auto_tasks → personal_context 适配层 → messaging.manager`（个人上下文框架的既有方向）。

### 方案 B：场景注册制外挂（不改 auto_tasks，新增独立调度）

按设计稿「场景注册制」思路，简报不走 auto_tasks 的 fire，而是新场景注册表自带 daily 调度，
直接调 sendProactive。**优点：** auto_tasks 零改动。**代价：** 与现有调度器（30s tick、claim、
boundary 语义、cloud 同步、UI 自动化页）完全平行，重复造一套调度；被 AGENTS.md
「Do Not: parallel group-chat dispatch paths」类原则否定精神。不推荐。

### 方案 C：任务内用 agent 技能触发推送

auto_task 保持 commander/agent 目标，由 agent 调用现有 `messaging_send` 类技能把简报发到主页会话。
**优点：** 零结构改动。**代价：** 依赖 LLM 行为正确性来保证每日投递（非确定性），
且 agent 会话会先建 PC 会话；简报是确定性场景，不该赌模型。不推荐。

## 4. 推荐实施要点（供阶段 3 排期）

1. **本次原型不做接线**（红线内）：C 线仅交付简报纯函数（`features/personal_context/briefing.ts`，
   已含 fixture 单测）；接线动作留在阶段 3 场景层实施时按方案 A 落地。
2. 接线时的最小改动清单（预估）：
   - `auto_tasks.ts`：`TaskRecipient` + 联合成员、`_fireTask` 分支（约 30 行）；
   - `features/personal_context/feishu-dispatch.ts`（新）：`dispatchToFeishuHome`（约 40 行，含
     listTargets 可用性门控 + sendProactive 调用 + sourceKey 构造）；
   - 测试：dispatch 适配层用 mock 的 manager/proactive 断言「可用→发送；不可用→失败事件」。
3. 配置面：任务创建表单增加「推送到飞书主页会话」目标选项（渲染层，阶段 3 一起做）。
4. 验证面：真实飞书实例端到端（设计稿 §8 测试策略），不依赖 mock 客户端断言投递行为。

## 5. 风险与边界

- **不碰 messaging/、不碰 personal_ontology_***：接线阶段由场景层（personal_context）调用
  messaging 的公开 API（sendProactive / listTargets），不改 messaging 内部任何文件。
- 归属人未配置（owner_missing）：listTargets 状态门控已覆盖，直接降级，不创建僵尸任务。
- 多实例：recipient 用 instanceId 精确定位，避免「有多个飞书机器人时发错实例」。
- 幂等键跨日唯一性：以「触发日」为键的语义依赖调度日边界（本地时区），与现有
  `isDue` boundary 语义（auto_tasks.test.ts 锁定的契约）一致。
