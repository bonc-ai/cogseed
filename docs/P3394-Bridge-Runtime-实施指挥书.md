# CogSeed P3394 Bridge Runtime 实施指挥书

版本：v1.0  
日期：2026-08-14  
适用仓库：CogSeed desktop mate-agent  运行分支：dev/p3394-bridge-runtime  
状态：实施基线，后续任务、代码评审和验收均以本文为准

## 0. 文档用途

本文用于指挥 CogSeed 后续 P3394 实施，不是 P3394 标准的重新定义，也不是新的 Agent Framework 设计。任何实现、重构、测试和产品声明都必须回答：

> 是否让 CogSeed 成为一个拥有本地 Agent Home、Runtime Authority 和 P3394 Bridge 的 Cognitive Cell，并能与另一个同样拥有本地 Bridge 的 Agent 进行可恢复、可审计的双向协作？

本文的判断优先级为：

1. P3394 正式实施指南及其作者后续澄清；
2. 本文的实施约束；
3. CogSeed 现有 Backend、Runtime、Storage、IPC、KSTAR/Recall 的事实来源；
4. 具体代码方案。

若实现与 P3394 原始指南冲突，必须暂停扩展并先完成差异确认。不得以“当前能跑”替代规范符合性。

## 1. 规范基线

当前采用的上位指南：

- 《P3394 LLM Agent Interface Standard 中文实施指南》v1.1，2026-08-12；
- 《P3394 Local Bridge SDK Design》；
- 《P3394 Bridge Runtime / Cognitive Cell 交接文档》；
- IEEE P3394 project scope 作为标准项目背景，不将网页概览替代正式实现语义。

指南给出的基本公式：

    任意本地 Agent Runtime
      + Runtime Adapter
      + P3394 Bridge Kernel
      + Agent Home
      + Channel Adapter
      = P3394 兼容 Agent Node / Cognitive Cell

强制架构：

    CogSeed Native Runtime
            ↕ Runtime Adapter
    CogSeed Local P3394 Bridge
            ↕ P3394 Channel
    Peer Local P3394 Bridge
            ↕ Runtime Adapter
    Peer Native Runtime

远程 Gateway、Relay 或转发服务可以提供发现、转发和联邦，但不能替代任一 Agent 的 Session Authority、Runtime Control、Credential Boundary、Agent Home、本地身份和权限边界。

## 2. 不可改变的架构边界

### 2.1 Agent、Bridge、Channel 必须分离

- Agent 是具有稳定身份、能力和行为边界的逻辑主体。
- Bridge 是本地标准协议边界，拥有 UMF、Session/Task/Message 映射、Policy、Audit、Recovery。
- Channel 是传输机制，不拥有业务 Session Store。
- Channel Instance 是具体监听端点或连接实例。
- Alias 是 Registry 中的人类可读寻址名称，不是 Identity 和认证凭据。

Hermes Gateway 的定位是 Hermes 侧 Local Bridge/Sidecar Adapter。目标链路必须是：

    CogSeed Runtime
      ↕ CogSeed P3394 Bridge
      ↕ P3394 Channel
    Hermes P3394 Bridge
      ↕ Hermes Runtime

不得把“CogSeed Gateway 直接调用 Hermes CLI”宣称为完整的双 Bridge P3394 互操作。

### 2.2 标识不得混用

| 标识 | 含义 | 规则 |
|---|---|---|
| agent_id | 稳定 Agent 身份 | 不能用 alias 或 model profile 代替 |
| alias | 人类可读寻址名 | 不能作为认证凭据 |
| channel_instance_id | 通道实例 | 不等于 Agent |
| session_id | 一个 Goal 驱动的 Work Session | 可跨多轮、Task、重启和 Channel |
| task_id | Session 内一次工作单元 | 有独立生命周期 |
| message_id | 不可变语义 Message | 不能被传输 Frame 或重试替代 |
| native_session_id | Agent 原生 Runtime 会话 | 只作为映射，不对外替代 P3394 Session |
| goal | Work Session 的目标描述 | 放在 payload metadata，不能替代 session_id |

### 2.3 每个 Agent 必须有本地 Bridge

P3394 互操作的最小单元不是“一个 CogSeed 加一个远程接口”，而是两个本地主权节点。每个节点必须拥有 Agent Identity 和 Manifest、Agent Home、Session Authority、Runtime Adapter、Channel Adapter、Credential/Policy 边界和可恢复的本地状态。

## 3. 标准模型实施要求

### 3.1 UMF Envelope

Envelope 必须遵循作者指南的参考模型：

    interface P3394MessageEnvelope {
      spec_version: 'p3394/1.0';
      message_id: string;
      session_id: string;
      task_id?: string;
      kind: 'message' | 'task' | 'event' | 'artifact' | 'control' | 'error';
      performative: 'request' | 'response' | 'inform' | 'accept'
        | 'reject' | 'cancel' | 'error' | 'negotiate';
      sender: P3394AgentAddress;
      recipients: P3394AgentAddress[];
      payload: { parts: PayloadPart[]; metadata?: Record<string, unknown> };
      reply_to?: string;
      idempotency_key: string;
      traceparent?: string;
      extensions?: Record<string, unknown>;
    }

必须落实：

- spec_version 位于 Envelope；Manifest 同时声明支持的 conformance version；
- 一个语义消息只有一个不可变 message_id；Frame、Token Chunk、重试不能产生新的语义 Message；
- reply_to 指向被回复的 message_id；transport endpoint/token 只能作为受控 Channel extension；
- session_id、task_id、message_id 关系可追溯；
- 不支持的 kind/performative 必须返回机器可读 error；
- payload、artifact、并发、速率和队列均有上限；
- secret、token、本地 Credential、未授权长期记忆和完整模型上下文不得进入 Metadata。

### 3.2 Manifest、Identity、Capability

Manifest 至少声明 identity、name、role、runtime kind、capability profile、channel declarations、session policy、inbound security mode、supported performatives 和 conformance version。

Renderer 只能请求操作，不能声明或覆盖 Manifest、Identity、Capability 或 user scope。

Capability Discovery 不等于 Authorization。发现某能力不代表远端 Agent 已获准调用该能力。

### 3.3 Node and Capability Registry

当前 Peer Registry 逐步演进为统一 Node and Capability Registry。至少区分：

    type P3394NodeKind =
      | 'agent' | 'sub_agent' | 'task_agent'
      | 'capability' | 'model_runtime';

注册记录应覆盖 alias、node_kind、expected_identity、endpoints、capabilities、supported_profiles、locality、preferred_channels、trust_policy、data_policy、cost_policy、last_seen_at 和 disabled/revoked 状态。

MCP Server 通常是 capability node；普通 OpenAI-compatible API 通常是 model_runtime。只有实现完整 Agent Manifest、Identity、Session 和 Runtime Contract 后，才能表现为完整 Agent Node。

## 4. Session 和 Runtime 规则

### 4.1 两层结构

    Companion Context
      身份、关系、偏好、长期记忆、统一入口
            ↓ 选择或创建
    P3394 Work Session
      Goal、参与者、Task、资源、权限、状态、结果

同一 Companion 对话不能因为来自同一个 Channel、同一个用户线程或同一个 peer，就自动合并所有工作。

### 4.2 Session 路由优先级

1. Envelope 明确提供 session_id：先尝试恢复并验证权限；
2. 当前 Channel Thread 已绑定 Work Session：验证 Goal 一致后继续；
3. 用户或 Agent 明确引用既有 Session/Task；
4. Goal 与已有 Session 高置信度匹配：按 Policy 要求确认后恢复；
5. 否则创建新的 Work Session。

当前 goal-isolated session 是合理的实现手段，但必须服从上述顺序。Goal 用于创建/路由，不得覆盖显式 P3394 Session。

### 4.3 Runtime Adapter 必须接真实事实来源

    openSession  → Backend session store
    deliver      → P3394 admission / Backend task admission
    stream       → event store / runtime controller
    resume       → recovery / runtime controller
    cancel       → runtime controller
    snapshot     → Backend checkpoint/recovery state
    closeSession → canonical KSTAR / Recall bridge

Bridge 不得为每个 Channel 建立另一套 Session Store，也不得绕过现有 Runtime、IPC、路径 sandbox 和执行 choke point。

## 5. 当前基线状态

### 已有基础

- UMF、Identity、Manifest、Capability Profile 基础模型；
- Peer/Alias Registry；
- Agent Home 逻辑路径边界；
- idempotency、replay protection、audit journal；
- Bridge Kernel、Inbound/Outbound API；
- Runtime Adapter contract；
- InProcess Channel contract；
- Hermes Gateway 基础互操作、heartbeat、artifact、outbox、goal isolation；
- KSTAR close hook 与 canonical Recall/KSTAR 方向；
- 基础 Doctor 和 Conformance smoke tests。

### 仍是 contract-first 或未完成生产化

- Runtime Adapter 尚未完整接入真实 Backend task/session/event；
- IPC/Unix Socket 仍需真实 transport、framing、auth、reconnect；
- WebSocket 仍需生产级 listener/dialer；
- 外部 peer 身份认证和 capability authorization 仍需完善；
- 双 Bridge 独立 Agent Home 的真实互操作 fixture 仍需建立；
- 远端 Session、stream、cancel、failure、artifact 闭环仍需验收；
- p3394 doctor 和完整 conformance suite 仍需扩展。

当前不得宣称已完成生产级跨进程 P3394、生产级跨机器 P3394、Hermes CLI Gateway 单独等于 Hermes Local Bridge，或本地 smoke 等于完整 Agent Interop Conformance。

## 6. 实施阶段和执行门槛

### Phase 0：规范冻结与差异矩阵

交付：固定指南版本和来源；建立逐条 Conformance Matrix；标记“符合 / 部分符合 / 未实现 / CogSeed 扩展 / 待作者确认”；锁定 Envelope、Session、Registry、Channel、Security 术语；整理需要向 P3394 作者确认的问题。

门槛：没有矩阵，不开始新增协议语义。

### Phase 1：标准模型纠偏

1. Envelope 补齐并校验 spec_version；
2. 正式采用 reply_to，保留 transport extension 但不替代消息关系；
3. 固化 performative/kind/error 语义；
4. Manifest/Identity/Capability 对齐；
5. Registry 增加 node_kind、expected_identity、profiles、policy；
6. 统一 Session/Task/Message correlation；
7. 增加标准 fixtures 和 rejected fixtures。

门槛：标准模型测试通过，旧 P3394 Lite 通过显式 Adapter 映射，不允许长期手工双写。

### Phase 2：真实 CogSeed Runtime Adapter

1. openSession 接 Backend session store；
2. deliver 接 admission/task store；
3. stream 接 event store/runtime controller；
4. 接通 resume/cancel/snapshot/close；
5. 失败时不修改 active recipient、orchestration ledger 或 handoff 状态；
6. Session close 进入 canonical KSTAR/Recall；
7. 用 InProcess Channel 完成单机双向闭环。

门槛：一个独立 Peer 可创建/恢复 Work Session、创建 Task、收到 response/event/error/artifact，并能取消和恢复。

### Phase 3：两个独立 Local Bridge

建立 CogSeed Bridge Fixture 和 Hermes Bridge Fixture。每个节点拥有独立 identity、Agent Home、Registry、Session Authority、Runtime Adapter 和 Channel。

先验证：

    CogSeed → Hermes → CogSeed
    Hermes → CogSeed → Hermes 自动结果回发

门槛：对端主动任务完成后，CogSeed 不依赖人工再次调用 p3394_send 才能回传最终结果。

### Phase 4：真实同机 Channel

顺序：Unix Socket 或 Loopback frame transport；本机 pairing/token authentication；listener/dialer、subscribe/unsubscribe；frame/payload/queue/concurrency/rate limits；reconnect、backpressure、slow peer、graceful shutdown；duplicate/replay/recovery 测试。

Electron IPC 只作为本地 UI 控制面，Renderer 不得成为 Agent Identity 或 Capability 来源。

门槛：两个独立进程可双向协作，断线恢复不重复执行。

### Phase 5：HTTPS/WebSocket 与外部 Adapter

在 Phase 4 通过后再做 HTTPS/WSS listener/dialer、TLS/身份认证、expected_identity、endpoint failover、remote disclosure policy、artifact integrity、A2A、MCP、Model Runtime capability-limited adapters 和企业内网/ECS discovery profile。

默认不得开放公网监听。未认证 endpoint 默认拒绝。

门槛：安全、资源限制、重连、远程 session 和 artifact conformance 通过。

### Phase 6：Doctor、Conformance 与发布验收

p3394 doctor 至少检查 Manifest、Identity、Alias 冲突、Registry、Channel listener/dialer、UMF、Session/Task/Message 映射、replay/idempotency、Agent Home、Runtime resume、KSTAR close hook、Audit journal、auth、policy 和 resource limits。

最终门槛：测试、真实 Electron、打包、至少一个外部 Agent 互操作和安全审查全部有证据。

## 7. 第一批实施任务

按以下顺序执行，禁止跳到公网和复杂外部 Adapter：

1. 生成并维护 P3394 Conformance Matrix；
2. 检查当前 Envelope，补 spec_version、reply_to 和正式错误语义；
3. 增加标准 UMF accepted/rejected fixtures；
4. 将 Registry 演进为 Node and Capability Registry；
5. 完成真实 CogSeed Runtime Adapter；
6. 实现 inbound task 的自动 response/event/artifact 回发；
7. 建立两个独立 Bridge Fixture；
8. 完成 Hermes Local Bridge/Sidecar 语义验证；
9. 实现真实 Unix Socket/Loopback framing、auth 和 recovery；
10. 扩展 Doctor 和 Conformance Suite。

每项任务必须同时提交代码或文档变更、focused tests、failure/recovery tests、conformance matrix 更新和不超出证据范围的状态说明。

## 8. 必须通过的验收场景

### 标识和协议

- Agent ID、Alias、Channel Instance、Session、Task、Message、Native Session 不混用；
- Envelope 有 spec_version、稳定 message_id、reply_to 和幂等键；
- unsupported semantic 返回明确 error；
- payload/artifact 有大小、digest 和访问边界。

### Session 和 Runtime

- 显式 session_id 优先恢复；
- 不同 Goal 不串上下文；
- Session 内多 Task 可关联；
- response/event/error/artifact 可回传；
- cancel、resume、close 语义可验证；
- close 触发 canonical KSTAR/Recall governance。

### 安全和可靠性

- 错误身份 fail closed；
- 未授权 capability fail closed；
- replay 和 duplicate 不重复执行；
- token、secret、credential 不进入日志或远端 payload；
- 断线恢复不改变 Agent Identity；
- backpressure、速率、并发、slow peer 有限制；
- 高风险操作保留人工确认。

### 互操作

- CogSeed → Hermes → CogSeed；
- Hermes → CogSeed → Hermes 自动结果闭环；
- 两个独立 Agent Home；
- 至少一个非 Hermes P3394 peer 或等价 fixture；
- 本地、同机、企业内网、外部节点按 locality/trust/data policy 路由。

## 9. 禁止事项

- 不把 P3394 重新设计成 CogSeed 私有协议；
- 不把 Gateway 直接调用 CLI 当成双 Bridge 完成；
- 不让 Channel Adapter 维护第二套业务 Session Store；
- 不让 Renderer 声明 Identity、Capability、uid 或权限；
- 不把 Alias 当成认证凭据；
- 不把 MCP、Model API 或普通 HTTP endpoint 伪装成完整 Agent；
- 不把 transport frame、stream chunk 或 retry 当作新语义 Message；
- 不把 Goal 当作 Session ID；
- 不恢复 legacy P3394 KSTAR Engine；
- 不将 transport event 自动升级为正式学习事实；
- 未完成认证、授权、资源限制和审计前，不开放公网端口；
- 不用本地 smoke、类型检查或 contract test 宣称生产级跨 Agent 互操作；
- 不绕过现有 Backend、Runtime、IPC、path sandbox、KSTAR/Recall choke point。

## 10. 交付和汇报格式

每个 P3394 实施任务完成后，必须按以下格式记录：

    任务：
    对应规范：
    改动范围：
    已符合：
    仍未符合：
    测试证据：
    真实互操作证据：
    安全/恢复证据：
    Conformance Matrix 状态：
    未解决问题：

状态汇报只能使用：已符合、部分符合、contract-first、未实现、CogSeed 扩展、待作者确认。

## 11. 完成定义

只有同时满足以下条件，才可以对外称为“CogSeed P3394 Bridge Runtime 已完成目标版本”：

1. 两个拥有本地 Bridge、Agent Home 和 Runtime Authority 的 Agent 可双向通信；
2. UMF、Identity、Manifest、Session、Task、Message、Capability 和 Error 语义符合规范；
3. 入站和出站都通过真实 Runtime Adapter；
4. response、event、artifact、cancel、resume、failure 可恢复且可追溯；
5. 重复、重放、错误身份和未授权能力 fail closed；
6. Channel 断开后恢复不重复执行；
7. Session close 进入 canonical KSTAR/Recall governance；
8. Doctor、Conformance、Electron、打包和外部互操作验收有证据；
9. Renderer 权限边界、Agent Home、Credential 和审计边界未被破坏；
10. 旧 P3394 KSTAR 路径删除证明继续通过。

在此之前，准确的产品表述是：

> CogSeed 已完成 P3394 Bridge Runtime 的标准模型、核心边界和部分本地互操作基础，正在按 P3394 v1.1 进入真实 Runtime、双 Bridge、Channel、安全和 Conformance 收敛阶段。

## 12. 后续产品化方向：P3394 Dashboard

在 Phase 2-6 的真实 Runtime、双 Local Bridge、Channel、安全和 Conformance 闭环完成后，可规划一个本地优先的 P3394 Dashboard，作为多 Agent 运行态的观察和受控操作面。该 Dashboard 用于管理和监控多个 Agent/Node、Channel Instance、Work Session 和 Task 状态，但不得取代各 Agent 的本地 Session Authority、Runtime Authority、Agent Home 或安全边界。

第一版候选能力：

- 查看 Agent/Node 身份、alias、node kind、locality、Manifest 摘要和在线状态；
- 查看 Channel Instance 的认证、连接、心跳、重连和故障状态；
- 查看 Work Session、Goal 摘要、参与者、Task、最近活动和恢复状态；
- 查看 response、event、error、artifact、cancel、resume 等可审计运行事件；
- 在既有权限、策略和人工确认约束下执行暂停、恢复、取消、重连和详情查看。

约束：

- Dashboard 不是新的 P3394 Session Store，展示数据必须来自 Backend、Runtime Controller、Event Store、Audit Journal 和 Registry 等事实来源；
- Renderer 不得声明或覆盖 Identity、Manifest、Capability、user scope 或权限；
- 不展示 token、secret、完整模型上下文或未授权长期记忆；
- Web Dashboard 只有在认证、授权、资源限制、审计和远程披露评审完成后才能规划实施，不默认开放公网。

Dashboard 不属于当前 Bridge Runtime 完成定义，也不改变现阶段先完成真实 Runtime Adapter、双 Bridge、同机 Channel 和 Conformance 的实施顺序。会议对照和候选范围见 `docs/P3394-会议对照与Dashboard后续事项-2026-08-16.md`。

## 13. 参考文件

- /Users/an/.dsh/uploads/P3394_Raymond_Hermes_Chinese_Implementation_Guide.md v1.1；
- /Users/an/.dsh/uploads/P3394_Local_Bridge_SDK_Design(1).md；
- docs/superpowers/specs/2026-08-13-p3394-bridge-runtime-design.md；
- docs/P3394-Conformance-Matrix.md（持续更新的规范符合性矩阵与证据索引）。
