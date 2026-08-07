# Meta Agent 主动飞书消息能力设计

- 日期：2026-08-07
- 状态：已确认，待实现
- 范围：桌面 Meta Agent 识别已配置的飞书/Lark 机器人，并经用户确认给配置中的本人发送文本

## 1. 目标与边界

- 仅顶层 Commander 可使用 `messaging_list_targets` 和 `messaging_send`。
- 首版仅支持飞书/Lark、文本、`target: "self"`。
- 不接受模型传入任意 `open_id`、`chat_id`、联系人、群、token 或 secret。
- 默认一次性人工确认；拒绝、超时、无 renderer、会话中止均不得发送。
- 确认后复用现有 adapter、delivery ledger、幂等键和最多三次重试。
- 不改变普通回复、审批卡片、reaction 和 streaming card 的既有 `chat_id` 语义。

## 2. 本人身份

`MessagingInstanceDisk` 保存以下主进程私有字段：

- `ownerExternalUserId?: string`：飞书/Lark 本人 `open_id`，只在主进程使用。
- `ownerExternalUserName?: string`：确认界面和工具返回的可读标签。
- `ownerIdentitySource?: 'qr' | 'manual'`：诊断字段，不参与授权判断。

本人身份与 `policy.allowUserIds` 独立。旧配置没有 owner 字段时保持为空，不从白名单推断。

QR 注册成功后写入扫码人的 owner 身份，并保留现有 allowlist 授权；取消、过期、失败和补偿不得留下 owner。手动配置支持设置、更新和清除 `open_id`，保存时校验长度、空白和结构。

### 2.1 自动绑定（无需手动填 ID）

手动输入 `open_id` 是高级选项；主路径为自动绑定：

- 凭据写入、实例启用或应用启动时，对**已启用但无 owner 的飞书实例**自动开启 5 分钟绑定窗口（内存态，重启后对无 owner 实例自动重开）。
- 窗口内收到的**第一条私聊消息**自动把发送者绑定为 owner，`ownerIdentitySource` 记为 `auto`；绑定成功后窗口立即关闭。
- 绑定判断在入站 policy 过滤**之前**执行——手动配置默认白名单为空（deny-all），否则消息无法进入系统。
- 群聊消息、窗口外消息、已有 owner 的实例均不触发绑定，防止机器人被公开后他人抢先认领。
- 设置页在窗口开启期间展示"等待绑定中：请在飞书向机器人发送消息"提示，并随窗口过期隐藏。

`MessagingInstanceClient` 只暴露 `ownerConfigured`、`ownerLabel` 和 `ownerIdentitySource`，不得携带原始 owner id。模型工具结果同样只返回脱敏状态。

## 3. 收件人感知的投递账本

普通回复使用入站上下文中的 `externalChatId`。主动发送没有 chat 上下文，使用独立的：

- `recipientId: string`
- `recipientIdType: 'chat_id' | 'open_id'`
- `externalChatId?: string`：仅用于普通聊天上下文和 reaction 反查

旧 ledger 读取时默认将旧 `externalChatId` 迁移为 `recipientId`，类型为 `chat_id`。主动投递始终持久化 `open_id` 类型，首次发送、timer 重试和进程恢复不得退化成 `chat_id`。

Feishu fresh send 从受信任的内部发送上下文读取 `recipientIdType`；reply API 和卡片 API 保持现有行为。模型不能设置 recipient type。

## 4. 终态与确认

新增按 delivery key 的终态 waiter：首次读取、注册 waiter、再次读取，避免状态竞态；`finishDelivery`、精确取消和实例批量取消统一唤醒。`sent`、`failed`、`cancelled` 为终态。AbortSignal 或主动发送超时取消对应 delivery，并阻止后续 retry timer/restart recovery。

共享 proactive service 负责：目标发现、固定 `self` 解析、多机器人消歧、实例和 owner 二次检查、确认、主动投递和稳定结果映射。确认前不创建 ledger、不调用 adapter。工具只有在平台成功回执后才能返回 `sent`。

确认使用独立 `messaging:send-confirm` push 和 `messaging.send_confirm_response` IPC，复用已有 pending request + renderer `uiConfirm` 模式，但不复用 connector 安装确认语义。按 cid/AbortSignal 取消时返回 `not_sent`。

## 5. 两套 Agent 接入

Core Agent 在 `gconv` Commander runner 中注入两个专用工具；worker、agent/skill edit、CLI、反思、记忆提取和匿名会话不注入。工具 catalog 必须登记，schema 只允许 instance id、固定 target 和 text。

Mate Runtime 通过 host-tool choke point 接入。canonical catalog 增加两个 host tool，但每次 run 的工具子集由主进程根据持久化 task/session 派生 capability。host router 再次读取 task/session，要求：

- `sessionKind === 'commander'`
- `actorRole === 'commander'`
- `actorId === 'commander'`
- owner、runtime session 和 lifecycle 均匹配

不能根据模型参数、`agent_id` 是否存在或 worker 自报的 capability 推断权限。

## 6. 错误与安全

稳定错误包括：

- `E_MESSAGING_TARGET_UNAVAILABLE`
- `E_MESSAGING_TARGET_AMBIGUOUS`
- `E_MESSAGING_OWNER_MISSING`
- `E_MESSAGING_INSTANCE_UNAVAILABLE`
- `E_MESSAGING_DELIVERY_FAILED`

拒绝/超时返回 `not_sent`；失败重试耗尽明确返回失败，不能声称已发送。原始 secret、owner `open_id`、chat id 不进入 renderer client DTO、模型上下文、日志或 telemetry。

## 7. 测试与验证

覆盖 owner 配置迁移、QR 写入、手动设置/清除、recipient type 初次发送与恢复重试、旧 ledger 兼容、终态 waiter、确认拒绝/超时/中止、Core Commander gate、Runtime catalog/runner/host router 双门禁，以及普通飞书回复/卡片/reaction 回归。

完成后运行仓库标准 `npm test`，按要求执行 `scripts/restart-mate.sh`，检查 messaging runtime 日志，并在存在真实飞书配置时验证目标发现、确认、本人收信和成功回执。
