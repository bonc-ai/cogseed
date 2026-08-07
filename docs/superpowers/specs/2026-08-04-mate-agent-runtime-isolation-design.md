# Mate Agent Runtime 后端隔离设计

## 1. Goal

把当前 Mate Agent 内嵌调用的 Orkas/Core Agent 执行能力收归为 **Mate Agent Runtime**，保持现有 Mate Agent 表层体验不变，同时建立独立的后端会话、上下文、记忆和执行边界。

目标关系：

```text
Mate Agent renderer
    ↓ 现有 IPC
Mate Agent main process
    ↓ 明确的 runtime request（stdio/IPC）
Mate Agent Runtime worker
```

Mate Agent 的会话和 Runtime 的会话不再共享同一个 `cid`、`session_id`、group-chat bus 或完整会话文件。

## 2. Non-goals

- 不改 renderer 页面、@ Picker、用户操作流程或现有 IPC channel 名称。
- 不把 Mate Agent 的完整 conversation JSONL 自动传给 Runtime。
- 不让 Runtime 自动加入 `features/group_chat/bus.ts` 的 commander/worker 协作。
- 不在第一阶段引入 HTTP server、远程部署、账号体系或跨设备同步。
- 不迁移历史 Mate Agent 会话；如需使用历史内容，必须由调用方显式抽取并传入。

## 3. Ownership and naming

- 产品/UI 继续叫 **Mate Agent**。
- `Mate Agent Runtime` 是我们拥有的后端执行边界。
- 现有 `src/main/model/core-agent/` 可作为 Runtime 的内部执行实现，但业务层不再把它当作外部 Orkas agent 直接调用。
- 新增 `features/mate_agent_runtime/` facade，统一负责 worker 生命周期、协议、请求路由和 session 边界。
- 旧 `#core-agent` 动态 import 在迁移期间只允许出现在 Runtime adapter/worker 内；renderer、IPC 和业务 feature 不直接依赖它。

## 4. Runtime process boundary

### 4.1 Worker

新增一个受控的 Mate Agent Runtime worker 入口。main process 通过 stdio 请求/响应连接 worker：

- 启动时发送 protocol version + worker capabilities handshake。
- 每个请求有独立 `request_id`。
- 请求支持 `run`、`cancel`、`health`、`shutdown`。
- worker 只从 stdin 读取 JSONL，只向 stdout 写协议 JSONL；日志写 stderr/main logger，不污染协议流。
- worker 崩溃、协议解析失败或超时后，main 标记当前 runtime request failed，并允许重新启动 worker。

由于项目当前只允许特定 child-process spawn 路径，Runtime worker 必须新增唯一的受控 spawn choke point，并同步更新项目边界说明、进程清理和测试；不得从 IPC handler 或 renderer 直接 spawn。

### 4.2 Request protocol

最小请求形状：

```json
{
  "type": "run",
  "request_id": "req-...",
  "runtime_session_id": "mruntime-...",
  "task": "用户明确要求 Runtime 执行的任务",
  "context": [
    { "type": "text", "content": "显式传入的上下文" }
  ],
  "attachments": [],
  "agent_id": "our-agent-id",
  "model_profile": "optional-profile"
}
```

响应/事件至少包括：

```json
{
  "type": "event|result|error",
  "request_id": "req-...",
  "runtime_session_id": "mruntime-...",
  "status": "started|running|completed|failed|cancelled",
  "text": "增量或最终文本",
  "error": null
}
```

Runtime 不接受 `cid` 作为自己的 session id，也不接受未经筛选的 conversation file path。

## 5. Session and data isolation

### 5.1 Mate Agent domain

Mate Agent 继续使用现有数据域：

```text
<container>/data/<uid>/cloud/chats/
<container>/data/<uid>/cloud/sessions/
<container>/data/<uid>/cloud/chat_attachments/
```

### 5.2 Runtime domain

Runtime 使用独立的 machine-private 数据域：

```text
<container>/data/<uid>/local/mate_runtime/
├── sessions/
├── conversations/
├── memory/
├── contexts/
└── runs/
```

Runtime session id 使用独立 kind，例如：

```text
mruntime-<tail>
```

不复用：

```text
gconv-<cid>
gmember-<cid>-<agent_id>
```

Runtime 的路径只能通过 `paths.ts` helper 获取；不能在 feature 或 worker 中硬编码 data root 或 uid 路径。

### 5.3 Context policy

默认不传入任何 Mate Agent 历史上下文。调用方只能显式传入：

- 当前用户明确要求的 task 文本
- 用户明确选择的消息片段
- 用户明确选择的 Library 文件
- 用户明确选择的附件
- 明确允许的 memory/context 引用

Runtime 不读取：

```text
<uid>/cloud/chats/<cid>.jsonl
<uid>/cloud/sessions/*
```

## 6. Main-process integration

现有 renderer IPC channel 保持不变。main 中的业务 handler 继续负责参数校验，但发送/执行路径改为调用：

```text
features/mate_agent_runtime/client.ts
```

该 client 负责：

1. 将用户请求转换成 Runtime protocol request。
2. 创建或恢复独立 `runtime_session_id`。
3. 过滤 context/attachments，拒绝越界路径。
4. 转发 worker event 到现有 renderer stream/event 机制。
5. 将最终 Runtime result 作为普通 Mate Agent 消息显示/保存。
6. 不把 Mate Agent 的完整 transcript 回写到 Runtime。

“结果显示在 Mate Agent 会话中”是单向结果投影，不等于双向会话同步。

## 7. Error handling and lifecycle

- worker 启动失败：返回稳定的 runtime-unavailable 错误，不创建半成品 session。
- worker 中途退出：当前请求标记 failed，保留 Runtime run metadata，允许 retry。
- cancel：main 向 worker 发送同一 `request_id` 的 cancel；无法确认取消时标记 interrupted，不重复提交原始任务。
- 协议版本不兼容：handshake 阶段拒绝连接并记录 capability/version，不执行任务。
- main 退出：先发送 shutdown，超时后杀掉由 Runtime choke point 创建的 worker。
- Runtime result 写入 Mate Agent 会话失败：保留 Runtime result/reference，避免静默丢结果。

## 8. Security boundaries

- Runtime worker 不从环境变量推断 Mate Agent 当前 `cid`。
- 所有 attachment/context file path 必须通过现有 path sandbox 校验。
- worker stdin/stdout 只承载协议；不得把原始 prompt、secret 或完整 transcript 写入日志。
- Runtime session store 只能访问自己的 `local/mate_runtime` root。
- agent/tool 权限由 Runtime request 的 agent profile 决定；不能因调用来自 Mate Agent 就自动获得 group commander 权限。

## 9. Migration and compatibility

第一阶段不迁移历史 session。旧的 Mate Agent group-chat、`gconv`、`gmember` 流程继续工作，不接入新 Runtime worker。

新 Runtime 调用仅使用新 facade 和 `mruntime-*` session kind。待新 Runtime 稳定后，再按功能逐步迁移需要独立执行边界的调用方。

## 10. Testing

必须覆盖：

- worker handshake/version mismatch
- request/response correlation by `request_id`
- independent Runtime session ids
- Runtime cannot read Mate Agent conversation files
- context/attachment allowlist and path sandbox
- no group-chat bus enqueue from Runtime requests
- worker restart after crash
- cancel and retry behavior
- result projection back to Mate Agent without transcript back-sync
- per-user/per-runtime data isolation
- Windows/macOS process lifecycle behavior

验收标准：

1. Mate Agent 现有 renderer/UI 测试不需要改交互契约。
2. Mate Agent 会话不会自动出现在 Runtime session store。
3. Runtime 不读取 Mate Agent 完整 conversation JSONL。
4. Runtime 只处理显式传入的 task/context/attachments。
5. worker 重启后不会重复执行同一 `request_id`。
6. 全量 `npm test` 和平台相关 runtime/process 测试通过。
