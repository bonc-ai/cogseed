# CogSeed 完整 P3394 Bridge Runtime / Cognitive Cell 设计

日期：2026-08-13
状态：已确认，进入实施计划阶段
适用指南：`P3394_Raymond_Hermes_Chinese_Implementation_Guide.md` v1.1

## 1. 目标与非目标

### 目标

将 CogSeed 从“内部具备 P3394 Lite、Wake 和 Backend 执行能力”扩展为完整的本机主权 P3394 Bridge Runtime / Cognitive Cell，覆盖：

- Universal Message Format（UMF）Envelope；
- Agent Manifest、稳定 Identity、Capability Profile；
- Agent Home 与用户隔离；
- Peer/Alias Registry；
- Session、Task、Message 生命周期映射；
- Runtime Adapter 与现有 CogSeed Backend/Runtime 的集成；
- In-process、同机 IPC/Unix Socket、后续 HTTPS/WebSocket Channel Adapter；
- Inbound Agent Server 与 Outbound Agent Client；
- Local-first Routing；
- Consent、Authorization、Replay Protection、Idempotency、Audit；
- Session Close → canonical KSTAR/Recall 治理闭环；
- `p3394 doctor` 与分层 Conformance Suite。

### 非目标

第一轮不做：

- 重写 CogSeed Agent Loop、Runtime、Skill、Tool 或 Group Chat；
- 恢复或新增旧 P3394 KSTAR Engine；
- 复制一套 Session/Task/KSTAR 存储；
- 将 Renderer 作为 Agent 身份或权限来源；
- 自动修改企业认知资产；
- 把 MCP、普通 Model API 或 HTTP Endpoint 伪装成完整 Agent；
- 在没有 Adapter Contract、认证、审计和资源限制前直接开放公网端口。

## 2. 现有能力复用边界

Bridge 是标准协议和互操作层，不是第二个业务执行引擎。现有模块继续作为事实来源：

```text
P3394 protocol/controller/epoch
    → 消息规范化、admission、replay watermark
CogSeed Backend session/task/event store
    → 本地 Session/Task/Event 生命周期
CogSeed Runtime controller
    → native/local-cli 执行、stream、resume、cancel
Group Chat projection
    → 用户可见消息和过程信息投影
features/kstar + Recall
    → Episode、Candidate、Ability Asset 和治理闭环
```

Bridge 只新增标准映射、契约和 Channel 边界；禁止让 Channel Adapter 各自维护一套 Session Store。

## 3. 分层架构

```text
Renderer / Human Channel / External Agent
                ↓
        Channel Adapter
                ↓
      P3394 Bridge Kernel
  Envelope · Identity · Registry · Policy
  Session/Task/Message · Audit · Recovery
                ↓
       CogSeed Runtime Adapter
                ↓
        CogSeed Backend Runtime
                ↓
  KSTAR Episode → Recall Governance
```

### 3.1 Bridge Kernel

建议目录：

```text
src/main/features/p3394_bridge/
├── bridge.ts
├── envelope.ts
├── identity.ts
├── manifest.ts
├── capability-profile.ts
├── registry.ts
├── session-manager.ts
├── task-manager.ts
├── message-store.ts
├── runtime-adapter.ts
├── channel-adapter.ts
├── authorization.ts
├── consent.ts
├── idempotency.ts
├── replay-protection.ts
├── audit-journal.ts
├── artifact-references.ts
├── routing.ts
└── doctor.ts
```

模块必须依赖现有 Backend service，而不是直接写 SQLite/JSON 私有副本。

## 4. 标准身份与标识模型

### Agent Address

```ts
interface P3394AgentAddress {
  agent_id: string;
  alias?: string;
  channel_instance_id?: string;
}
```

强制区分：

```text
agent_id       稳定身份
alias          人类可读别名
session_id     Goal 驱动的协作上下文
task_id        Session 内工作单元
message_id     不可变语义消息
native_session_id  底层 Runtime 会话
model_profile  模型配置，不得使用 agent_id
```

### Manifest

Manifest 至少描述：

- identity、name、role；
- runtime kind：`cogseed-native | local-cli`；
- capability profile；
- channel declarations；
- session policy；
- inbound security mode；
- supported performatives；
- conformance version。

Renderer 只能请求操作，不能声明或覆盖 Manifest、Identity、Capability、用户作用域。

## 5. UMF Envelope

```ts
interface P3394MessageEnvelope {
  spec_version: 'p3394/1.0';
  message_id: string;
  session_id: string;
  task_id?: string;
  kind: 'message' | 'task' | 'event' | 'artifact' | 'control' | 'error';
  performative:
    | 'request' | 'response' | 'inform' | 'accept'
    | 'reject' | 'cancel' | 'error' | 'negotiate';
  sender: P3394AgentAddress;
  recipients: P3394AgentAddress[];
  payload: {
    parts: Array<{
      type: 'text' | 'json' | 'resource' | 'artifact' | 'image' | 'audio' | 'control';
      text?: string;
      data?: unknown;
      uri?: string;
      media_type?: string;
      digest?: string;
    }>;
    metadata?: Record<string, unknown>;
  };
  reply_to?: string;
  idempotency_key: string;
  traceparent?: string;
  extensions?: Record<string, unknown>;
}
```

校验规则：

- 每个语义消息只有一个 Envelope；
- sender/recipient 必须通过 Registry/Policy 解析；
- `reply_to`、session/task 关系必须可追溯；
- payload 类型和大小有上限；
- unsupported semantic 明确返回 error；
- 不把内部 Group Chat message 或 Runtime event 直接当作 UMF。

## 6. Agent Home 与存储

Agent Home 是本机主权边界，根目录按用户和 Agent 隔离：

```text
<uid>/local/p3394/agents/<agent-id>/
├── manifest.json
├── identity.json
├── peers/registry.json
├── sessions/<session-id>/
│   ├── session.json
│   ├── artifacts/
│   ├── checkpoints/
│   ├── trace.jsonl
│   └── kstar/
│       ├── episode.json
│       ├── aar.json
│       ├── feedback.json
│       └── proposed-updates.json
├── policy/
├── consent/
├── audit/
└── journal/
```

实现可以映射到现有 Backend 存储，但必须提供稳定的逻辑视图、路径沙箱、锁、原子写和恢复策略。用户数据不能跨 uid 读取。

## 7. Runtime Adapter 与 Backend 映射

```ts
interface P3394RuntimeAdapter {
  openSession(input: OpenSessionInput): Promise<RuntimeSessionBinding>;
  deliver(envelope: P3394MessageEnvelope): Promise<void>;
  stream(taskId: string): AsyncIterable<P3394RuntimeEvent>;
  resume(sessionId: string): Promise<void>;
  cancel(taskId: string): Promise<void>;
  snapshot(sessionId: string): Promise<RuntimeSnapshot>;
  closeSession(sessionId: string): Promise<void>;
}
```

映射：

```text
P3394 session_id  ↔ Backend session id
P3394 task_id     ↔ Backend task id
P3394 message_id  ↔ message/event correlation
native_session_id ↔ Runtime session id
```

Admission 必须先解析正式 Agent、能力和用户作用域，再创建 Backend task。失败时不改变 active recipient、orchestration ledger 或用户可见 handoff 状态。

## 8. Registry、Routing 与 Channel

### Registry

首阶段提供本机 Peer/Alias Registry；每次 alias 解析必须获得真实 identity、Manifest 和 Capability Profile。撤销、冲突、identity mismatch 和审计必须是显式错误。

### Local-first Routing

```text
当前 Agent 能力
→ 同机已注册 Agent
→ 企业内授权 Agent
→ 外部 P3394/A2A/MCP/Model Adapter
```

每个非本地调用都经过 Registry Resolution、Capability Negotiation、Policy Authorization、Consent（必要时）和 Audit。

### Channel Adapter 分期

1. InProcess：契约和双向测试的最小基础；
2. 同机 IPC/Unix Socket：本机不同进程的完整 listener/dialer；
3. HTTPS/WebSocket：有认证、重连、背压、资源限制后再启用；
4. A2A/MCP/Model：通过 capability-limited Adapter 接入，不伪装成完整 Agent。

统一 Adapter 职责：listen、dial、negotiate、authenticate、send、subscribe、reconnect、close。Channel 不拥有业务 Session Store。

## 9. Inbound / Outbound

### Inbound

外部 Envelope 经过：

```text
Channel receive
→ Envelope validation
→ peer authentication
→ registry/identity resolution
→ capability/policy/consent
→ session restore/create
→ Backend task admission
→ runtime stream
→ UMF event/error
```

### Outbound

```text
alias resolve
→ peer manifest/capability
→ policy/consent
→ request Envelope
→ remote task/event stream
→ projection/artifact
→ cancel/reconnect/recovery
```

Remote endpoint failover 不得改变 Agent identity；MCP/Model endpoint 只能表现为受限 Capability Node 或 Model Runtime。

## 10. KSTAR / Recall 闭环

Session 完成或显式关闭时触发 canonical KSTAR Episode / AAR / feedback hook。学习建议先落 `proposed-updates`，再由现有 Recall/KSTAR 治理和人工确认升级为 Ability Asset。不得恢复 legacy P3394 KSTAR engine，也不得把 transport event 自动当成学习事实。

## 11. 安全与资源边界

必须覆盖：

- 本地/远程身份认证；
- capability authorization；
- consent/human approval；
- replay protection；
- idempotency；
- payload、artifact、并发和速率限制；
- backpressure、slow peer 和 graceful shutdown；
- secret/path/workspace 隔离；
- audit journal；
- remote disclosure policy；
- 不可信 endpoint 默认拒绝。

## 12. Doctor 与 Conformance

提供 `p3394 doctor`，至少检查：Manifest、Identity、Alias 冲突、Peer registry、Channel listener/dialer、UMF、Session/Task/Message 映射、replay/idempotency、Agent Home、Runtime resume、KSTAR close hook、Audit journal。

测试按层覆盖：

```text
envelope / identity / manifest / registry
session / task / message / runtime
local-channel / ipc-channel / unix-socket-channel
inbound / outbound / authorization / consent
replay / idempotency / artifact / recovery
kstar-close-hook / doctor / conformance
```

## 13. 实施阶段

### Phase 1：标准模型与本机 Bridge Kernel

UMF、Manifest、Identity、Registry、Agent Home、Session/Task/Message 映射、InProcess Channel、Doctor 基础版。

### Phase 2：CogSeed Runtime Adapter

接入 native/local-cli，统一 stream/resume/cancel/snapshot/close，并接 KSTAR close hook。

### Phase 3：同机双向 Channel

IPC/Unix Socket、Inbound/Outbound、认证、能力协商、重放保护、幂等、背压和恢复。

### Phase 4：网络与外部 Adapter

HTTPS/WebSocket、重连、failover、remote projection、artifact、A2A/MCP/Model capability profiles。

### Phase 5：治理与验收

Doctor、Conformance、真实 Electron 验收、安全/性能审查、互操作测试。

## 14. 验收标准

完成时必须满足：

- CogSeed 不再把内部 Backend 能力误称为完整 P3394 Bridge；
- 本机 Agent 可通过标准 Envelope 双向创建/恢复 Session 和 Task；
- Agent Identity、Alias、Session、Task、Message 不混用；
- 重复消息、重放、错误身份和未授权能力均 fail closed；
- Channel 断开后可恢复，不重复执行；
- Artifact 有 digest 和访问边界；
- Session close 可进入 canonical KSTAR/Recall 治理；
- `p3394 doctor` 和各阶段 Conformance tests 通过；
- 旧 P3394 KSTAR 路径仍保持删除证明通过；
- 不改变现有 Renderer 身份和权限边界。
