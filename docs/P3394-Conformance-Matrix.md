# P3394 Conformance Matrix

版本：v0.1  
日期：2026-08-16  
适用仓库：CogSeed desktop `Myself`  
实施基线：`docs/P3394-Bridge-Runtime-实施指挥书.md` v1.0、P3394 v1.1 中文实施指南  
状态：持续更新；本矩阵不替代 P3394 正式规范

## 状态定义

- **已符合**：当前实现和针对性测试已覆盖该条要求，仍需保留回归验证。
- **部分符合**：已有实现，但覆盖范围、真实环境或安全证据不足。
- **contract-first**：接口、模型或测试桩已建立，尚未接通全部真实事实来源或生产通道。
- **未实现**：当前没有可验证的实现。
- **CogSeed 扩展**：属于 CogSeed 本地产品能力，不宣称为 P3394 标准语义。
- **待作者确认**：语义或规范解释需要 P3394 作者确认。

## 1. 规范与模型

| ID | 要求 | 代码/证据 | 状态 | 下一步 |
|---|---|---|---|---|
| M-01 | Envelope 携带 `spec_version`、稳定 `message_id`、`session_id`、可选 `task_id` | `src/main/features/p3394_bridge/envelope.ts`；`test/main/features/p3394_bridge/envelope.test.ts`；`http-channel.test.ts` | 部分符合 | 当前主校验路径已对缺失版本 fail-closed；仍需为确有需要的旧调用方建立可审计的显式 Legacy Adapter，并完成跨 Channel rejected fixtures。 |
| M-02 | `kind` / `performative` 有固定集合，不支持值返回机器可读错误 | `envelope.ts`；`conformance.test.ts` | 已符合 | 增加跨通道 rejected fixtures。 |
| M-03 | `reply_to` 指向语义消息，传输 Frame/Chunk/Retry 不生成新 Message | `envelope.ts`、`executor.ts`、`outbound.ts`；`executor-autoreply.test.ts` | 部分符合 | 自动回发 ID 已按入站消息和 performative 稳定派生；仍需在 outbox 重试和真实 Channel 恢复场景补证据。 |
| M-04 | `idempotency_key`、重复和 replay protection | `idempotency.ts`、`replay-protection.ts`、`epoch-store.ts`；bridge/security tests | 已符合 | 在真实 Unix/WS 断线恢复场景补证据。 |
| M-05 | payload、metadata、artifact、recipients 有资源上限 | `envelope.ts`、`artifact-parts.ts`、`runtime-controller.ts`、`executor.ts`；artifact-parts/runtime-controller/executor tests | 部分符合 | 已验证 artifact digest、路径、inline/object-store 大小边界、Runtime → Event Store 字段白名单，以及自动回发对非法 digest 的 fail-closed；仍需统一跨 Channel 队列、并发、速率和 artifact 总量限制。 |
| M-06 | secret、token、credential、完整上下文不得进入 payload、metadata、审计 | `security-boundaries.test.ts`、`audit-journal.ts`、logger redaction | 部分符合 | 补充跨通道和异常路径的泄漏 fixture。 |
| M-07 | Agent、Alias、Channel Instance、Session、Task、Message、Native Session 不混用 | `identity.ts`、`registry.ts`、`session-manager.ts`、`runtime-adapter.ts` | 已符合 | 增加跨重启映射和错误引用测试。 |
| M-08 | Manifest 声明 identity、role、runtime、capability、channel、policy、conformance | `manifest.ts`、`capability-profile.ts`；identity-manifest tests | 部分符合 | 对所有外部节点执行真实 Manifest/Identity 授权校验。 |
| M-09 | Capability Discovery 不等于 Authorization | `registry.ts`、`bridge.ts`、`reduced-profiles.ts`；`bridge.test.ts` 授权负例 | 部分符合 | BridgeKernel 已对 task/message recipient 执行 `handle_message`、performative 和 node kind fail-closed 检查；仍需把同一授权决策接入真实外部节点 Manifest/expected_identity 和 capability policy。 |
| M-10 | Registry 区分 agent、sub_agent、task_agent、capability、model_runtime | `registry.ts`；registry/reduced profile tests | 已符合 | 接入真实 trust/data/cost policy 决策。 |

## 2. Session 与 Runtime

| ID | 要求 | 代码/证据 | 状态 | 下一步 |
|---|---|---|---|---|
| R-01 | 显式 `session_id` 优先恢复，Goal 不替代 Session ID | `session-manager.ts`、`conversation-runtime.ts`、`session-state-machine.test.ts` | 部分符合 | 对 Channel Thread、Goal 匹配和权限校验补集成测试。 |
| R-02 | Session 内可关联多个 Task，Task 有独立生命周期 | `session-manager.ts`、`task-manager.ts`；session-task-lifecycle tests | 已符合 | 接入真实 Runtime 的多 Task 恢复场景。 |
| R-03 | `openSession` 接真实 Backend session store | `cogseed-runtime-adapter.ts`、`cogseed_backend/session-store.ts`；adapter tests | 已符合 | 增加跨进程重启和数据根恢复证据。 |
| R-04 | `deliver` 接真实 admission/task store | `cogseed-runtime-adapter.ts`、`runtime-controller.ts`、`task-store.ts` | 部分符合 | 验证不同 Agent/权限/失败路径不修改外部编排状态。 |
| R-05 | `stream` 接 event store/runtime controller | `cogseed-runtime-adapter.ts`、`event-store.ts`、`runtime-controller.ts`；`runtime-adapter.test.ts`；`cogseed-runtime-adapter.test.ts`；`runtime-controller.test.ts` | 部分符合 | 已支持并验证 `afterSequence` 断点消费、artifact 事件映射和受限字段续读，恢复时不重放已确认 P3394 事件；仍需长任务、事件流中断和终态竞态的跨进程证据。 |
| R-06 | `resume` / `cancel` / `snapshot` / `closeSession` 接真实控制器和事实来源 | `cogseed-runtime-adapter.ts`；`executor.ts::resumeForward`；`task-manager.ts`；adapter tests；Interop tests；`outbound-hub.ts` | 部分符合 | 已有真实控制器基础集成、取消/恢复/快照/close、不重新 deliver 的事件续读入口、transport sink 失败转 recoverable，以及 Outbox 暂时 peer outage 后保留 submitted/sent 的恢复语义；live Channel 联合恢复测试尚未形成稳定证据。 |
| R-07 | Session close 进入 canonical KSTAR/Recall | `kstar-close-hook.ts`、`kstar-episodes.ts`、`recall-bridge.ts` | 部分符合 | 验证失败任务、取消任务和重复 close 的治理结果。 |
| R-08 | Runtime failure 不修改 active recipient、orchestration ledger、handoff 状态 | `cogseed-runtime-adapter.ts` 注释约束；runtime/security tests | contract-first | 增加跨模块失败注入测试并绑定真实 ledger 断言。 |
| R-09 | P3394 Session/Task 映射跨重启恢复 | `cogseed-runtime-adapter.ts` state file；`cogseed-runtime-adapter.test.ts` 跨实例恢复测试；persistence tests | 部分符合 | 已覆盖同一 Agent Home 状态文件的跨 Adapter 实例恢复；仍需真实进程重启、状态迁移和损坏文件恢复证据。 |

## 3. Bridge、Channel 与互操作

| ID | 要求 | 代码/证据 | 状态 | 下一步 |
|---|---|---|---|---|
| C-01 | Agent、Bridge、Channel 分离；Channel 不拥有业务 Session Store | `bridge.ts`、`channel-adapter.ts`、`session-store.ts` | 已符合 | 保持架构边界回归测试。 |
| C-02 | 本地 InProcess Channel 双向基础闭环 | `in-process-channel.ts`；in-process/interop tests | 已符合 | 仅作为 contract fixture，不宣称跨进程生产互操作。 |
| C-03 | 同机 Unix Socket/Loopback framing、auth、reconnect、backpressure、shutdown | `unix-socket-channel.ts`；`unix-socket-channel.test.ts`；`interop.test.ts`；`executor.ts`；`task-manager.ts` | 部分符合 | 已完成同进程和独立 Node 进程的 Unix Socket fixture、认证、分帧、重连、关闭、单连接 pending 背压、listener 重启重投递去重；已修复 dialer 关闭时不误删 peer listener socket 文件，新增未 flush envelope 的内存缓存和重连重发，并将 transport sink 失败转为 recoverable/cursor 恢复。raw fault-injection 和实验性 live reconnect 联合 fixture 的时序证据仍未稳定，跨 Channel 统一限制也未完成。 |
| C-04 | HTTP loopback channel 有认证和 endpoint 边界 | `http-channel.ts`、`app-wiring.ts`；http/security tests | 部分符合 | 统一 listener 生命周期、速率和认证失败审计。 |
| C-05 | WebSocket listener/dialer、TLS、身份认证、failover | `websocket-channel.ts` | contract-first | 在 Unix Channel 验收后再进行生产化实现。 |
| C-06 | 两个独立 Local Bridge 各自拥有 Agent Home、Identity、Session Authority、Runtime Adapter | `agent-home.ts`、`app-wiring.ts`、`interop.test.ts`、`external-gateways.test.ts`、`unix-socket-channel.test.ts` 独立进程 fixture | 部分符合 | 已具备独立 Node 进程 Channel 边界证据，并验证受管 Hermes gateway 独立进程启动、自注册和真实任务回传；仍需两个完整独立 Bridge Kernel/Agent Home/Runtime Authority 的进程级验收。 |
| C-07 | 入站任务完成后自动回发 response/event/artifact | `executor.ts`、`outbound-hub.ts`、`outbound-outbox.ts`、`runtime-controller.ts`、`p3394-gateway/gateway.cjs`；`executor-autoreply.test.ts`；`interop.test.ts`；`external-gateways.test.ts`；`outbound-hub.test.ts`；`runtime-controller.test.ts`；`cogseed-runtime-adapter.test.ts` | 部分符合 | 已验证双节点 event/artifact 回传、独立 `kind=artifact` 自动回发、真实 HTTP reply endpoint、Bearer token、稳定 message/idempotency key、敏感字段过滤、managed Hermes gateway 真实 task→CLI→response 回传、submitted replay 和暂时 peer outage 后延迟重放、完成后断线重投递去重、transport sink 断线转 recoverable 及不重新 deliver 的事件续读入口；仍需 artifact/response 与事件流中断恢复的联合证据。 |
| C-08 | 外部 Adapter 明确 reduced profile，不冒充完整 Agent | `reduced-profiles.ts`、`mcp-runtime-adapter.ts`、`model-runtime-adapter.ts` | 已符合 | 增加 Capability Node 与 Model Runtime 的授权负例。 |
| C-09 | 至少一个非 Hermes peer 或等价 fixture | `channel-testkit.ts`、`interop.test.ts`；`external-gateways.test.ts` | 部分符合 | 已固化 Node A/Node B 等价双 Bridge fixture，并验证真实受管 Hermes gateway 启动、自注册、endpoint 写入 Registry、CogSeed task→gateway CLI→response 双向闭环、列表和停止；测试会清理同 CLI 残留进程以避免复用旧 bridge endpoint。仍需非 Hermes 外部 Agent 双向任务闭环和 Hermes 主动任务入口。 |

## 4. 本地优先、安全与审计

| ID | 要求 | 代码/证据 | 状态 | 下一步 |
|---|---|---|---|---|
| S-01 | Agent Home、状态和凭据边界在本地用户数据根 | `agent-home.ts`、`runtime-paths.ts`、`app-wiring.ts` | 部分符合 | 补数据根、权限、重启和变体隔离的真实检查。 |
| S-02 | 默认 loopback，公网监听默认关闭 | `app-wiring.ts`、`http-channel.ts`；security tests | 已符合 | 对生产配置和打包入口增加 fail-closed 验证。 |
| S-03 | 未认证 endpoint、错误身份、未授权 capability fail closed | `http-channel.ts`、`bridge.ts`、`security-boundaries.test.ts`、`bridge.test.ts`、`external-gateways.test.ts` | 部分符合 | 已覆盖本地 BridgeKernel 的未授权 task recipient、reduced node 和 performative fail-closed，以及受管 gateway 的真实 Bearer hello 自注册边界；仍需真实外部节点 expected_identity/capability authorization 的跨进程证据。 |
| S-04 | Audit Journal 记录可追溯事件但不泄露敏感数据 | `audit-journal.ts`、`executor.ts`；audit/security/auto-reply tests | 部分符合 | 已验证 artifact 自动回发审计包含 endpoint/kind/reply_to 而不写入 artifact secret；仍需补充 payload、异常和重试路径的统一脱敏测试。 |
| S-05 | replay、duplicate、断线恢复不重复执行 | `replay-protection.ts`、`outbound-outbox.ts`、`outbound-hub.ts`、`executor.ts`、`task-manager.ts`、`unix-socket-channel.ts`；`outbound-hub.test.ts`；`outbound-outbox.test.ts`；`interop.test.ts`；`unix-socket-channel.test.ts`；`runtime-adapter.test.ts`；`executor-autoreply.test.ts`；`cogseed-runtime-adapter.test.ts` | 部分符合 | 已验证 HTTP Outbox 重放、Unix Socket listener 重启后的 Envelope 去重、Channel 未 flush cache/reconnect 实现、Runtime Adapter `afterSequence` 续读、artifact 事件持久化/HTTP 回发、Executor 不重新 deliver、transport sink 失败转 recoverable，以及 replay 暂时失败后保持 submitted/sent 并可在 peer 恢复后重放；raw fault-injection 和稳定 live event stream + Channel reconnect + Outbox + cursor 联合证据仍待恢复控制器接管。 |
| S-06 | backpressure、rate、concurrency、payload/artifact limits | `envelope.ts`；`unix-socket-channel.ts`；`unix-socket-channel.test.ts` | 部分符合 | Unix Socket 已实现并验证单连接 pending frame fail-fast；仍需各 Channel 的统一 backpressure、rate/concurrency 和 artifact 总量限制。 |
| S-07 | 高风险操作保留人工确认 | CogSeed 现有 approval / policy choke points；相关 P3394 admission | 部分符合 | 明确 P3394 控制操作与现有人工确认的映射矩阵。 |

## 5. Doctor、Conformance 与发布

| ID | 要求 | 代码/证据 | 状态 | 下一步 |
|---|---|---|---|---|
| V-01 | Doctor 检查 Manifest、Identity、Registry、UMF、Session、审计、认证和资源限制 | `doctor.ts`；`persistence.test.ts`；`conformance.test.ts` | 部分符合 | Doctor 已覆盖 Manifest/Identity、Registry、Agent Home、Runtime Adapter、Channel、Object Store、Auto Reply、Replay、Idempotency、Audit、Policy 和资源限制输入；仍需把真实 app wiring/listener 状态自动注入 Doctor，并完成打包验收证据。 |
| V-02 | 标准 accepted/rejected fixtures | `test/main/features/p3394_bridge/*` | 部分符合 | 统一 fixture 目录和矩阵 ID，覆盖每个 rejection reason。 |
| V-03 | `CogSeed → Hermes → CogSeed` 双向闭环 | `external-gateways.ts`、`outbound-hub.ts`、`p3394-gateway/gateway.cjs`、`external-gateways.test.ts` | 部分符合 | 已验证 CogSeed HTTP dialer 向真实 managed Hermes gateway 发送 task，gateway 使用 `/bin/echo` CLI 执行并向 CogSeed reply endpoint 回传 response；仍需真实 Hermes Runtime failure/recovery、artifact 和跨进程 Outbox/cursor 联合证据。 |
| V-04 | `Hermes → CogSeed → Hermes` 自动结果闭环 | `executor.ts`、auto-reply wiring、`external-gateways.test.ts`、`interop.test.ts` | 部分符合 | 已有真实 gateway 自注册、被动接收入站 task 以及 CogSeed→gateway→CogSeed response 闭环；当前 gateway 只有 hello/heartbeat 主动控制帧，没有产品化的 Hermes 主动 task API，因此尚无真实 Hermes 主动 task→CogSeed→Hermes 证据；仍需先定义并验收该反向入口及失败恢复。 |
| V-05 | Electron、打包、外部 Agent、安全审查有证据 | `app-wiring.ts`、runtime launcher | 未实现 | 在本地同机和 Conformance 阶段完成后建立发布验收记录。 |
| V-06 | 旧 P3394 KSTAR 路径删除证明 | `kstar-close-hook.ts`、相关删除测试 | 部分符合 | 运行并补齐 legacy path negative proof。 |
| V-07 | Dashboard 统一展示 Agent/Channel/Session/Task | 规划文档；当前无统一 P3394 运行态视图 | 未实现 | 核心 Bridge Runtime 完成后另立产品化任务，不纳入当前完成定义。 |

## 当前推进顺序

1. 完善本矩阵和 accepted/rejected fixtures，作为每次实施提交的证据索引；
2. 完成模型纠偏：生产 `spec_version`、`reply_to`、错误语义、Manifest/Capability 授权和统一资源限制；（本轮已完成缺失 `spec_version` 的主校验 fail-closed 与 HTTP 422 负例。）
3. 完成真实 Runtime Adapter 的失败、恢复、跨重启证据；
4. 建立两个独立 Local Bridge fixture，完成自动 response/event/artifact 回发；
5. 完成真实 Unix Socket/Loopback framing、认证、重连、backpressure 和恢复；
6. 再推进 HTTPS/WSS、外部 Adapter、Doctor 扩展和发布验收；
7. 核心闭环完成后，单独评审 P3394 Dashboard。

## 当前状态声明

当前准确表述：

> CogSeed 已具备 P3394 标准模型、Bridge 核心边界、部分真实 Runtime Adapter 和本地 Channel 基础，正在按 P3394 v1.1 收敛真实双 Bridge、同机 Channel、安全、恢复和 Conformance 证据；尚不能据此宣称生产级跨进程、跨机器或完整外部 Agent 互操作已经完成。
