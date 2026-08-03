# P3394 强制准入与发送方 Epoch 设计

**日期：** 2026-07-30

## 目标

把当前 Group Chat 中的 P3394 检查从“生成 process event 后继续执行”升级为真正的准入门，并让消息携带可持久化、可复用的发送方 epoch，使重复投递能够在启动 in-process Agent、Codex 或 Hermes 前被拒绝。

## 当前问题

1. `p3394ProtocolProcessItem` 把 `P3394Controller.admitMessage` 的结果转换成 process event；调用方无论 `ok` 是否为 `false` 都继续进入 Agent 执行。
2. `QueueItem` 不携带 `incomingEpoch`，controller 每次只能让接收方水位自动 `+1`。重复投递同一消息也会获得新水位，无法识别重放。
3. 当前接收方水位只按目标 session 标识。若直接接入多个发送者各自从 1 开始的 epoch，不同发送者会互相碰撞。
4. 出站序列和入站水位不能共用同一个计数键；否则发送端分配 epoch 后，接收端会立即把该值视为已经见过。

## 范围

本轮只覆盖 Group Chat bus 中已经调用 P3394 的普通 Agent 和 CLI Agent 路径，包括 Codex 与 Hermes。

本轮不把 P3394 扩展为 one-shot、skill-edit、agent-edit、reflection 或其他 session kind 的全局拦截器。这些路径需要独立梳理其错误呈现、生命周期和兼容要求。

## 决策一：P3394 结果成为强制门禁

`p3394ProtocolProcessItem` 不再只返回 `ProcessItem`，而是返回一个包含以下字段的结构：

```typescript
interface P3394AdmissionOutcome {
  processItem: ProcessItem;
  admitted: boolean;
  reasonCode?: P3394AgentError['body']['reason_code'];
  detail?: string;
}
```

调用方总是先把 `processItem` 追加到 process rail，以保留审计信息。若 `admitted === false`：

1. 不构建模型 system prompt。
2. 不调用 `streamChatWithModel`。
3. 不调用 `features/local_agents/runner.ts`，因此不启动 Codex 或 Hermes。
4. 通过现有 end-of-turn enqueue 机制写入本地化的失败气泡，使用 `failure_kind: "validation"` 和稳定的 P3394 reason code。
5. 清理 in-flight 状态、发出 `state_changed`，并从 `runTurn` 返回 `{ kind: "early" }`。

基础设施故障仍遵循既有设计：session、epoch 或 context 存储读取失败时由 controller 标记 degraded 并放行。只有 controller 明确返回协议、安全或作用域违规时才阻断执行。

## 决策二：发送 epoch 按发送者到接收 session 分流

epoch 流的逻辑标识为：

```text
[senderActorId, recipientSessionId]
```

实现使用结构化序列化生成 map key，不依赖容易碰撞的字符串分隔符。这样：

- 用户到 Commander 与 Agent 到 Commander 使用不同水位。
- Commander 到不同 Agent session 使用不同水位。
- 同一发送者向多个接收者广播时，各接收者不会因消息缺口或调度差异互相影响。

controller 的入站水位键也使用同一逻辑流标识，而不是只使用目标 session。

## 决策三：出站序列与入站水位分开存储

保留现有接收方水位文件：

```text
<uid>/local/kstar/p3394-epochs.json
```

新增发送方序列文件：

```text
<uid>/local/kstar/p3394-sender-epochs.json
```

两个文件都使用 uid 级 mutex、原子临时文件加 rename，并且只吞 `ENOENT`。发送方存储提供：

```typescript
next(uid, senderActorId, recipientSessionId): Promise<number>
```

接收方 `EpochStore.admit` 接收 sender-scoped stream key。旧文件中的 session-only 键保留但不参与新的 sender-scoped 判定，相当于部署后为每个发送流建立新水位，避免把旧的聚合水位错误应用到新流。

## 决策四：epoch 随持久化消息保存

`GroupMessage` 增加 host-owned 的可选 P3394 投递元数据：

```typescript
p3394?: {
  recipient_epochs: Record<string, number>;
}
```

key 为 recipient actor id，value 为该 sender 到 recipient session 的发送 epoch。

enqueue 在完成路由、拿到接收 actor 和真实 `actorSessionId` 后，为每个非用户 recipient 分配 epoch，并在消息写入 JSONL 前保存这张 map。随后构造 `QueueItem` 时复制当前 recipient 的 epoch 到：

```typescript
incomingEpoch?: number;
```

`p3394ProtocolProcessItem` 将其传给 `P3394Controller.admitMessage`。

持久化 epoch 的目的不是让相同文本共享 epoch，而是让同一个已持久化 `GroupMessage` 在恢复、重派或重复传输时继续使用原 epoch。一次新的用户发送或 Agent 回复会创建新 message id，并获得新 epoch。

## 数据流

```text
enqueue
  -> router 解析 recipients
  -> 为每个 sender -> recipient session 分配发送 epoch
  -> 将 recipient_epochs 写入 GroupMessage
  -> QueueItem.incomingEpoch = 当前 recipient 的 epoch
  -> worker claim turn
  -> P3394Controller.admitMessage(incomingEpoch)
  -> 入站 sender-scoped 水位判定
       -> 新 epoch：推进水位并继续
       -> 旧/相同 epoch：返回 replay_detected
  -> bus 强制门禁
       -> admitted：启动 in-process Agent / Codex / Hermes
       -> rejected：写失败气泡并 early return
```

## 错误与兼容

- 老消息没有 `p3394` 字段时保持兼容：`QueueItem.incomingEpoch` 缺失，controller 使用现有自动递增行为。
- 新消息生成发送 epoch 失败时不阻断 enqueue；记录 warn，该 recipient 退回无 `incomingEpoch` 的降级路径。
- 接收水位 IO 失败继续使用现有 `epoch_degraded:true` 放行策略。
- P3394 违规错误正文必须通过 main locale 生成；日志只记录 uid、cid、actor id、reason code 等低敏字段。
- `p3394.recipient_epochs` 是 host-owned 协议元数据，不加入 LLM prompt，也不作为 renderer 路由输入。

## 测试策略

1. Controller 单测：不同 sender 对同一 recipient session 的相同 epoch 不互相碰撞；同一流重复 epoch 被拒。
2. SenderEpochStore 单测：单调递增、流隔离、并发不丢更新、原子写、非 `ENOENT` 错误传播。
3. Bus 单测：生成的 GroupMessage 持久化 recipient epoch，QueueItem 收到对应值。
4. Bus 强制门禁单测：controller 返回 `replay_detected` 时，模型 stream 和 local-agent runner 均未调用，turn 正常结束。
5. CLI 定向测试：Codex 与 Hermes Agent 的拒绝路径均不 spawn CLI。
6. 兼容测试：没有 epoch 的旧消息继续运行。
7. 回归：P3394 focused tests、group-chat tests、typecheck、完整 `npm test`。

## 安全与边界

- 不新增 HTTP 服务、监听端口或认证层。
- 不新增 npm 依赖。
- 不在 IPC handler 中加入业务逻辑。
- CLI 仍只能由 `features/local_agents/runner.ts` 启动。
- epoch 数据只落用户 `local/kstar`；消息上的 epoch map 随现有 conversation JSONL 保存。
- 不把 uid 写入 session id、message id 或 epoch stream id。

## 验收标准

- `replay_detected`、`context_scope_violation`、委托或其他 P3394 拒绝会在模型/CLI 启动前终止 turn。
- 被拒 turn 有稳定 process event、用户可见失败结果和正确的状态清理。
- 新 GroupMessage 为每个非用户 recipient 持久化发送 epoch。
- 重复投递同一持久化消息时复用 epoch，并被同一 sender-recipient stream 的水位拒绝。
- 多发送者、多接收者不会互相误判。
- 旧消息和基础设施降级语义不变。
- Codex/Hermes 的 MCP bridge、session resume 和事件流行为不受影响。
