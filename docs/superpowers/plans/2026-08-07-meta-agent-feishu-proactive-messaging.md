# Meta Agent 主动飞书消息能力 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让顶层 Commander 经一次人工确认后，通过已配置飞书机器人给配置中的本人发送文本，并保证 owner 身份、open_id 投递、重试恢复和 Runtime 权限边界正确。

**Architecture:** 在 messaging feature 层增加脱敏目标发现、确认和主动投递服务；Core Agent 与 Mate Runtime 都只通过受控工具调用该共享服务。delivery ledger 将收件人 id 与类型分离，并提供逐 delivery 终态 waiter。Mate Runtime 使用主进程派生的 capability 和 host router 持久化 actor 重验双门禁。

**Tech Stack:** Electron main process、vanilla renderer、TypeScript messaging feature、Core Agent AgentTool、Mate Runtime JSONL protocol、Vitest、现有 `npm test` 脚本。

## Global Constraints

- 仅 `target: "self"`，不开放任意联系人、群聊、附件、卡片或跨平台主动目标。
- `externalChatId` 不承载主动 `open_id`；主动 ledger 必须保存 `recipientIdType: "open_id"`。
- 旧 ledger 缺少 recipient 字段时默认迁移为 `chat_id`。
- 确认前零 adapter 调用、零可恢复 delivery；拒绝/超时/中止不得发送。
- 工具只在平台成功回执或明确终态失败后返回，不把 `retry_pending` 描述为成功。
- 不新增 npm 依赖，不新增 HTTP server；preload 保持 `.js`，Renderer 保持 classic scripts。
- 所有业务函数以 `userId` 为第一个参数；host router 和 IPC 不承载业务逻辑。

---

### Task 1: 同步规格并建立失败测试

**Files:**
- Create: `docs/superpowers/specs/2026-08-07-meta-agent-feishu-proactive-messaging-design.md`
- Create: `docs/superpowers/plans/2026-08-07-meta-agent-feishu-proactive-messaging.md`
- Test: `test/main/features/messaging.test.ts`

- [ ] 在现有 messaging 测试增加 owner 脱敏、旧配置不推断 owner、旧 ledger recipient 默认 `chat_id` 的失败断言。
- [ ] 运行 `npm test -- test/main/features/messaging.test.ts`，确认新增断言因字段/API 不存在而失败。
- [ ] 保持规格与计划中的 recipient waiter、双门禁和安全边界一致。

### Task 2: 实例 owner 身份、QR 注册和手动配置

**Files:**
- Modify: `src/main/features/messaging/types.ts`
- Modify: `src/main/features/messaging/registry.ts`
- Modify: `src/main/features/messaging/feishu-registration.ts`
- Modify: `src/main/ipc/messaging.ts`
- Modify: `src/renderer/modules/messaging-settings.js`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/pt.json`
- Test: `test/main/features/messaging.test.ts`
- Test: `test/main/features/feishu-registration.test.ts`

- [ ] 为 `MessagingInstanceDisk` 增加 owner 字段，为 client DTO 增加 `ownerConfigured/ownerLabel/ownerIdentitySource`，并实现 `normalizeInstance()` 的旧配置兼容。
- [ ] 为 `CreateMessagingInstanceInput`、`CreateFeishuDraftInput` 和 `UpdateMessagingInstanceInput` 增加仅 Feishu 可用的 owner 配置字段；验证 `open_id`，允许清除且不影响普通收发。
- [ ] 在 QR 的 `newInstanceActivation` 和 `draftActivation` 成功路径写 owner；只在 `canActivate()` 后提交；补偿清除 QR 写入的 owner。
- [ ] IPC 仅传递/验证 owner 的脱敏配置字段；不要把原始 owner id 放回 client DTO。
- [ ] Renderer 设置页添加本人 open_id/名称字段、保存/清除动作和本地化文案；不要展示 secret 或原始已保存 id。
- [ ] 先运行 owner/QR 聚焦测试，再运行现有 messaging/feishu-registration 测试。

### Task 3: recipient-aware delivery ledger 与 Feishu adapter

**Files:**
- Modify: `src/main/features/messaging/types.ts`
- Modify: `src/main/features/messaging/ledger.ts`
- Modify: `src/main/features/messaging/manager.ts`
- Modify: `src/main/features/messaging/adapters.ts`
- Test: `test/main/features/messaging.test.ts`
- Test: `test/main/features/feishu-adapter.test.ts`

- [ ] 为 `DeliveryLedgerEntry` 增加 `recipientId` 和 `recipientIdType`；normalize 旧记录时填 `externalChatId/chat_id`。
- [ ] 将普通 binding 回复的 begin/recover 路径统一写入 `recipientIdType: "chat_id"`，保留 `externalChatId` 给 reaction。
- [ ] 将 `MessagingSendContext` 扩展为受信任的 `recipientIdType`；只让 manager 设置它。
- [ ] Feishu text/post fresh create 按上下文设置 `receive_id_type`；reply 调用不改变；card/approval fresh create 保持 `chat_id`。
- [ ] 增加主动 open_id 初次、重试、重启恢复测试，确认普通回复回归。
- [ ] 运行 `npm test -- test/main/features/messaging.test.ts test/main/features/feishu-adapter.test.ts`。

### Task 4: delivery 终态 waiter 与精确取消

**Files:**
- Modify: `src/main/features/messaging/ledger.ts`
- Modify: `src/main/features/messaging/manager.ts`
- Test: `test/main/features/messaging.test.ts`

- [ ] 新增 `waitForDeliveryTerminal(uid, key, { signal, timeoutMs })`，实现首次读、注册、再次读并清理 listener/timer。
- [ ] 让 `finishDelivery()`、`cancelRecoverableDeliveriesForInstance()` 和精确取消函数唤醒 waiter。
- [ ] 为主动投递 timeout/AbortSignal 增加终态取消，不影响普通 instance stop 的既有清理。
- [ ] 覆盖注册竞态、重试成功、耗尽失败、取消唤醒和无悬挂 Promise。
- [ ] 运行 messaging 聚焦测试，确认旧 `waitForOutboundDeliveries()` 行为仍通过。

### Task 5: 共享 proactive 目标服务与确认 UI

**Files:**
- Create: `src/main/features/messaging/proactive-confirm.ts`
- Create: `src/main/features/messaging/proactive.ts`
- Modify: `src/main/features/messaging/manager.ts`
- Modify: `src/main/features/messaging/index.ts`
- Modify: `src/main/ipc/messaging.ts`
- Modify: `src/main/preload.js`
- Modify: `src/renderer/modules/messaging-settings.js`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/pt.json`
- Modify: `src/main/features/group_chat/bus.ts`
- Test: `test/main/features/messaging-proactive.test.ts`
- Test: `test/main/features/messaging-proactive-confirm.test.ts`

- [ ] 先写目标发现/确认/发送失败测试：零/多候选、owner missing、未连接、任意 id 注入、确认前零副作用。
- [ ] 实现 `listTargets(userId)`，返回所有 Feishu/Lark 实例状态和脱敏 owner label，仅把 enabled+connected+ownerConfigured 放入 `available_instance_ids`。
- [ ] 实现 `sendToSelf(userId, input, opts)`，校验 `target === "self"`、当前用户拥有 instance、文本长度、显式 instance 规则和二次状态检查。
- [ ] 实现独立确认 pending map、push、单次 respond、超时和按 cid/AbortSignal 取消；将 `messaging:` 加入 preload push allowlist。
- [ ] manager 提供稳定主动 source key 和 recipient open_id 的 ledger-backed send；proactive service 等待 terminal waiter 并返回 `sent/not_sent/E_MESSAGING_*`。
- [ ] 接入 `group_chat/bus.ts::abort`，让 cid abort 取消未回答确认和已创建主动 delivery。
- [ ] 运行 proactive 两个测试文件和现有 messaging/IPC 测试。

### Task 6: Core Agent Commander 工具

**Files:**
- Create: `src/main/model/core-agent/messaging-tools.ts`
- Modify: `src/main/model/core-agent/runner.ts`
- Modify: `src/main/model/core-agent/tool-catalog.ts`
- Test: `test/main/model/core-agent/messaging-tools.test.ts`
- Test: `test/main/model/runner.test.ts`
- Test: `test/main/model/core-agent/tool-catalog.test.ts`

- [ ] 先写工厂/参数/Commander gate 失败测试。
- [ ] 实现 `createMessagingTools({ userId, cid, turnId })`：list target 为只读，send 为 sequential，输入 schema 不允许额外字段，传递 `ToolContext.signal`。
- [ ] 在 runner 的 `gconv` 且 uid/cid 条件下注入；其他 session kind 不注入；最终 `visibleTools` 仍做 catalog gate。
- [ ] 将两个工具登记到 Core catalog，更新 anti-drift 测试。
- [ ] 运行 Core Agent 聚焦测试。

### Task 7: Mate Runtime capability 与 host-router 双门禁

**Files:**
- Create: `src/main/features/cogseed_backend/messaging-capability-policy.ts`
- Create: `src/main/features/cogseed_backend/messaging-host-adapter.ts`
- Modify: `src/main/features/cogseed_backend/runtime-controller.ts`
- Modify: `src/main/features/cogseed_backend/host-tool-router.ts`
- Modify: `src/main/features/cogseed_runtime/protocol.ts`
- Modify: `src/main/features/cogseed_runtime/index.ts`
- Modify: `src/main/features/cogseed_runtime/kernel/types.ts`
- Modify: `src/main/features/cogseed_runtime/runtime-executor.ts`
- Modify: `src/main/features/cogseed_runtime/kernel/tools/catalog.ts`
- Modify: `src/main/features/cogseed_runtime/kernel/tools/runner.ts`
- Test: `test/main/features/cogseed_backend/host-tool-router.test.ts`
- Test: `test/main/features/cogseed_backend/runtime-controller.test.ts`
- Test: `test/main/features/cogseed_runtime/protocol.test.ts`
- Test: `test/main/features/cogseed_runtime/runtime-executor.test.ts`
- Test: `test/main/features/cogseed_runtime/kernel/tool-runtime.test.ts`
- Test: `test/main/features/cogseed_runtime/kernel/execution-loop.test.ts`

- [ ] 先写 commander/member/generic catalog 和 host-router 负向测试。
- [ ] 扩展 protocol/runtime kernel request 传递主进程生成的 `capabilities`，并让 tool runner 按 capability 返回过滤后的 catalog。
- [ ] 登记两个 host tools；允许顶层 commander capability，默认 member/generic 无 capability。
- [ ] host router 按 request scope 回查 task claim 和 Mate session，严格验证 owner、runtime session、lifecycle、`sessionKind/actorRole/actorId`。
- [ ] messaging host adapter 只做参数校验并调用共享 service，领域错误交回模型，越权/伪造 scope 返回 `isError`。
- [ ] 传递 Runtime host call 的 AbortSignal，确保确认/投递中止可达共享服务。
- [ ] 运行 Runtime/backend 聚焦测试及既有 host/tool schema 回归。

### Task 8: 完整验证

- [ ] 运行所有聚焦测试，再运行完整 `npm test`，不使用 `npx vitest`。
- [ ] 运行 `git diff --check`，检查 `git status --short`，确认无 secret/open_id/chat_id 泄露。
- [ ] 执行 `scripts/restart-cogseed.sh`，检查 messaging runtime 日志和 `/tmp/cogseed-agent-messaging-run.log`。
- [ ] 在真实 Feishu 配置存在时验证目标发现、确认、本人收信、平台回执，以及拒绝/abort 不发送；缺少真实环境时明确报告。
