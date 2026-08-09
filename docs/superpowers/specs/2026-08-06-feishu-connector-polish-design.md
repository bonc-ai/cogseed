# 飞书连接器三项完善设计（reaction 合成 / 突发合并 / @all + 姓名解析）

- 日期：2026-08-06
- 分支：feature/messaging-connectors-develop
- 状态：approved（用户已确认）

## 背景与目标

当前飞书/Lark 连接器已完成注册、桥接、审批卡片、富文本 post 回复、工具调用展示等核心能力。对照 Hermes 参考实现（`/private/tmp/hermes-agent/plugins/platforms/feishu/`）差距分析后，选取三项低-中成本、高性价比的完善项：

1. **reaction 合成消息**：用户对 bot 消息的表情回应目前完全不可见，需作为反馈信号喂给 agent。
2. **入站突发合并**：飞书把长消息切成多片推送，当前每片各进一轮 agent，产生废对话；需防抖批量合并。
3. **@all 修复 + 姓名解析**：`@所有人` 消息被策略误杀（`@_all` 判空）；会话标题退化为 chatId，需填充可读名称。

## 已确认的设计决策

| 决策点 | 结论 |
|---|---|
| 权限策略 | 注册扩 scope + 运行时静默降级；存量实例不打扰 |
| reaction 触发范围 | 仅"我们发过的消息"（查投递账本 externalDeliveryId），且 `operator_type !== 'user'` 忽略 |
| 合并参数 | 照 Hermes：600ms 窗口 / 8 条 / 4000 字符 / ≥3500 字符自适应 2000ms |
| 合并层 | manager 层通用模块（三平台复用），不在 adapter 层 |
| @all 语义 | `all` / `@_all` 视为提及 → `mentionPresent = true` |

## 0. 权限扩展

`feishu-registration.ts` 的 `APP_ADDONS` 扩展：

```ts
const APP_ADDONS = {
  preset: false,
  scopes: {
    tenant: [
      'im:message:send_as_bot',
      'im:message:reaction:readonly',
      'contact:user.base:readonly',
      'im:chat:readonly',
    ],
  },
  events: {
    items: {
      tenant: ['im.message.receive_v1', 'im.message.reaction.created_v1'],
    },
  },
} satisfies lark.AppAddons;
```

- **新注册实例**：自动获得全部权限。
- **存量实例**：权限绑定在注册时的 app 上，不会自动升级。新 API 调用返回权限错误时静默跳过 + 日志 warn 一次，与现有处理中 reaction 的 best-effort 模式一致（adapters.ts `addProcessingReaction` 已有先例：`catch { /* optional capability; never fail the message flow */ }`）。
- 不引入"权限缺失提示重新绑定"的 UI 流程（YAGNI，等有真实存量用户反馈再考虑）。

## 1. reaction 合成消息

### 事件注册

`FeishuAdapter` 构造函数的 `eventDispatcher.register`（现 adapters.ts:578 注册 `im.message.receive_v1` 与 `card.action.trigger` 处）增加 `im.message.reaction.created_v1`。

### 过滤链（按序）

1. `operator_type !== 'user'` → 忽略。**必须**：bot 自己的处理中 reaction（`FEISHU_REACTION_IN_PROGRESS`）也会被推回本事件，不滤掉会死循环。
2. `message_id` 查投递账本（新增 `ledger.getDeliveryByExternalId`）→ 无条目忽略（用户 reaction 他人/无关消息不触发）。
3. 有条目 → 合成入站 envelope。

### 合成 envelope

| 字段 | 值 |
|---|---|
| `text` | `` `reaction:added:${emoji_type}` `` |
| `externalMessageId` | 事件 header 的 `event_id`（UUID，作为幂等键） |
| `externalChatId` | **账本条目里的 `externalChatId`**（reaction 事件 payload 本身不带 chat_id；已确认 DeliveryLedgerEntry 含该字段） |
| `externalUserId` / `externalTenantId` / `externalUnionId` | 事件 `operator_id`（open_id）等 |
| `mentionPresent` | `true`（对 bot 消息的 reaction = 交互意图，等价提及） |
| `receivedAt` | 事件时间 |

### 幂等与策略

- 合成 envelope 走现有 `handleInbound` 管线：`ledger.reserveInbound(event_id)` 幂等去重、per-chat 串行锁、policy 评估、绑定、群聊入队全复用。
- 策略交互：`mentionPresent=true` → `requireMentionInGroups` / `mentions_only` 放行（群聊点赞反馈不丢）；`commands_only` 仍拒绝（命令模式语义正确）；用户白名单照常生效。

### 新增账本 API

`ledger.getDeliveryByExternalId(uid, instanceId, externalDeliveryId)`：

- 扫描 `entries` 匹配 `externalDeliveryId`（投递完成条目不删除，已确认 `finishDelivery` 只改 status；条目规模可控，暂不做反向索引，YAGNI）。
- 返回匹配条目或 `null`。

## 2. 入站突发合并

### 新模块 `src/main/features/messaging/burst-merge.ts`

manager 层通用防抖合并器，挂在 `handleInbound` 入口前（manager.ts:910），三平台统一生效（飞书分片受益最大）。

### 参数（照 Hermes `_enqueue_text_event`）

| 参数 | 值 |
|---|---|
| 窗口 | 600ms |
| 每批条数上限 | 8 条 |
| 每批字符上限 | 4000 字符（达上限立即 flush） |
| 自适应 | 累计字符 ≥ 3500 时窗口延长至 2000ms |

### 分组与合并

- 分组键：`(instanceId, externalChatId)`。
- flush 时文本按 `\n` join 成一条。
- `externalMessageId` = 批次**第一条**消息 id（幂等键）；批次内其余消息 id 调用 `reserveInbound` 标记 seen（duplicate 语义），防飞书重推单独到达。
- **合成 reaction 消息跳过合并**直接入队（反馈即时性）；合并器只合并普通文本入站。
- per-chat 串行锁（manager.ts:873，LRU 1000）保持不变：合并器在锁外防抖，flush 时进锁处理。

### 边界

- 窗口期内新消息到达重置计时器；到达上限立即 flush，后续消息开新批次。
- 与现有 `reserveInbound` 幂等、回复目标/话题上下文（bindings）刷新逻辑互不冲突：合并发生在幂等与绑定之前的 adapter→manager 交界。

## 3. @all 修复 + 姓名解析

### @all（纯解析，零权限）

`normalizeFeishuEvent` 的提及检测（现 adapters.ts `feishuMentionOpenId` 对 `all` 返回空串）补 `all` / `@_all` 分支 → `mentionPresent = true`。覆盖两种入站格式：

- text 消息：`<at user_id="all">所有人</at>`。
- post 消息：`{"tag":"at","user_id":"all",...}`。

修复效果：`requireMentionInGroups` / `mentions_only` 模式下，群公告类 `@所有人` 消息不再被误拒（视 @all 为提及，与 Hermes `_mentions_self` 语义一致）。

### 姓名解析（FeishuAdapter 内，Hermes 模式）

| 能力 | API | 权限 | 填充字段 |
|---|---|---|---|
| 发送者姓名 | `contact.v3.user.get` | `contact:user.base:readonly` | `externalUserName` |
| 群名称 | `im.v1.chat.get`（仅群聊入站） | `im:chat:readonly` | `externalChatTitle` |

- 缓存：LRU 512 条 + 10min TTL（参照 Hermes `_resolve_sender_name_from_api` 10min 缓存）。
- 失败静默降级：API 错误/权限缺失 → 保持现状（chatId / 空名），日志 warn 一次。
- 缓存键：`externalUserId`（ou_ open_id）；群名缓存键：`externalChatId`。
- 效果：bindings.ts:223 已读 `externalChatTitle`（`chatLabel = externalChatTitle || externalChatId`），adapter 填充后会话标题自动可读，bindings 无需改动。

## 4. 测试策略

| 功能 | 用例 |
|---|---|
| reaction | app 操作者过滤；非本 bot 消息（账本 miss）过滤；合成字段断言（text/幂等键/chat/mentionPresent）；事件幂等（重复事件 reserveInbound duplicate）；getDeliveryByExternalId 命中/miss |
| 合并 | 分片合成（\n join）；8 条上限立即 flush；4000 字符上限；≥3500 自适应窗口；跨 chat 隔离；reaction 消息跳过 |
| @all | text `<at user_id="all">`、post at all 两种格式 → mentionPresent；`requireMentionInGroups` 策略放行 |
| 姓名 | 缓存命中不重复请求；未命中填充；API 失败降级（不阻塞入站）；群聊才查 chat.get |
| 注册 | APP_ADDONS 断言含新增 3 scope + 1 事件 |

测试文件：扩展现有 `test/main/features/messaging.test.ts` / `feishu-adapter.test.ts` / `feishu-registration.test.ts`，新增 `test/main/features/burst-merge.test.ts`（合并器纯逻辑，无需 SDK 依赖）。

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/main/features/messaging/feishu-registration.ts` | APP_ADDONS 扩 scope + 事件 |
| `src/main/features/messaging/adapters.ts` | reaction 事件注册 + 过滤 + 合成；@all 分支；user/chat 查询 + 缓存 |
| `src/main/features/messaging/ledger.ts` | 新增 `getDeliveryByExternalId` |
| `src/main/features/messaging/burst-merge.ts` | **新增**：防抖合并器 |
| `src/main/features/messaging/manager.ts` | handleInbound 入口挂接合并器 |
| 测试文件若干 | 见上节 |

不涉及：IPC、渲染层、types 契约变更（复用现有字段）、新 npm 依赖、架构改动。
