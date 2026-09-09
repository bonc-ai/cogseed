# Agent 创建师选择性恢复设计

## 目标

在当前 `local/creator-agent-builder-a2a` 分支恢复完整的“Agent 创建师”能力，同时保留当前分支的 KSTAR、Renderer 和 Creator runtime 改动。恢复后的能力通过现有 Agent 列表和聊天/群聊入口使用，不恢复已经取消的独立 Creator Mode 面板。

## 约束与非目标

- 不直接合并 `backup/creator-agent-builder-a2a-wip-20260901` 整个分支。该分支与当前 HEAD 没有共同 merge-base，会引入大量无关历史和文件差异。
- 不恢复 `creator-mode.js` 或独立 Creator 导航、页面和面板。
- 不新增 npm 依赖，不改变 P3394/Generic A2A 协议边界。
- Agent 创建只允许新建，不允许通过 Agent 创建师编辑已有 Agent、发布市场或读取凭证。

## 恢复范围

### 内置 Agent 资源

恢复 `resources/builtin/marketplace/agents/287ce6012204/agent.json`，名称为 `Agent 创建师`，并在 `resources/builtin/_manifest.json` 中恢复对应条目。Agent 使用现有 marketplace/builtin 加载链路，不增加 renderer 专用注册逻辑。

### Creator Agent 服务层

移植并适配以下模块：

- `src/main/features/creator/creator-agent-types.ts`
- `src/main/features/creator/creator-agent-service.ts`
- `src/main/features/creator/creator-agent-tools.ts`
- `src/main/prompts/creator_agent.md`

服务通过现有 `chatWithModel` 以 ephemeral、read-only、bounded 工具访问运行。模型输出必须是单一 JSON envelope；输出、manifest、能力引用和文本均经过当前 Creator schema/catalog 与安全过滤。服务只创建 draft，不直接 approve、publish、materialize 或 activate。

### Agent Builder

恢复并适配：

- `src/main/features/group_chat/agent-builder.ts`：用户确认后的 direct 创建路径。
- `src/main/features/group_chat/agent-builder-governed.ts`：将 `<agent>` 容器转换为 Creator draft。
- `src/main/features/group_chat/agent-builder-state.ts`：按 `(uid, cid)` 持久化治理状态和 24 小时过期。
- `src/main/features/group_chat/agent-builder-governed-flow.ts`：确认、验证、冒烟、二次确认、materialize 的状态机。
- `src/main/features/group_chat/agent-smoke-run.ts`：一次性、无工具、无文件副作用的 bounded smoke run。

治理路径的状态只允许沿以下方向推进：

```text
awaiting_confirm -> verifying -> awaiting_final_confirm -> materializing -> done
```

取消、过期、验证失败和 smoke 失败均保留草稿并阻断后续落地。状态写入使用现有路径和锁，恢复时以磁盘状态为准。

### IPC 与运行时接入

恢复 `src/main/ipc/creator.ts`，提供现有 Creator draft/lifecycle API 以及 `creator.agent.run`。在当前 `src/main/ipc/index.ts` 注册 handler，并复用当前 preload allow-list 约束；不新增 UI 面板。Creator feature flag、用户 scope、manifest digest、confirmation 和输出脱敏沿用当前实现。

`src/main/features/creator/index.ts` 仅增加恢复模块的 barrel exports。任何共享文件修改都按当前分支版本手工适配，不用旧分支整文件覆盖。

## 数据流

```text
Agent 列表中的 Agent 创建师
  -> 现有聊天/群聊 dispatch
  -> creator-agent-service 或 agent-builder governed flow
  -> Creator draft/store
  -> schema + catalog + policy + smoke verification
  -> 用户二次确认
  -> lifecycle approve/publish/materialize
  -> 现有 Agent runtime + creator binding policy
```

direct 路径只允许无工具、低风险配置；带工具、文件、网络、写入或外部委托的配置必须走 governed 路径。Creator 工具本身不能复制到新 Agent 的权限中。

## 错误与恢复

- 非法或危险模型输出：返回明确错误码，不保存不可信 manifest。
- 未知或不可用 capability：阻断 draft 或验证，不降级为未授权能力。
- schema/catalog/policy/smoke 任一失败：保留 draft，状态进入 failed 或等待修订，不 publish/materialize。
- 并发确认或 materialize：使用 per-conversation state lock 和现有 lifecycle/materializer 幂等约束。
- 进程中断：通过 builder-flow.json 和 Creator operation journal 恢复，不依赖内存状态。
- 任何用户取消/abort：停止流程并保留草稿。

## 测试与验收

恢复并适配旧实现的测试，至少覆盖：

- 内置 Agent 资源和 manifest 可发现、字段合法。
- Creator Agent 输出解析、单对象约束、危险值拒绝、clarification/blocked 分支。
- Creator 工具 allow-list、bounded 输出和只读限制。
- direct builder 新建与拒绝编辑已有 Agent。
- governed flow 的确认、取消、过期、验证失败、smoke 失败、二次确认和 materialize。
- builder 状态的原子写入、并发锁和重启恢复。
- Creator IPC 参数校验、用户 scope、digest/confirmation 校验和输出脱敏。
- 与当前 Creator materializer、binding、dispatch policy 的兼容性。

验证顺序：`npm run typecheck`，定向 Creator/Builder 测试，`npm test`；必要时重启 Electron 运行时并检查启动日志。

## 实施策略

1. 先恢复新增模块和 Agent 资源，再逐个适配当前共享文件。
2. 每一组共享文件修改后运行对应定向测试，避免一次性引入旧分支差异。
3. 保留当前工作树未提交的用户改动；只提交本恢复任务产生的文件。
4. 完成后做一次完整差异审计，确认没有恢复独立 Creator 面板、远程 A2A 越权或无关旧分支内容。
