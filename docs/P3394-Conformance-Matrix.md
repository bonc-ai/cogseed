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
| M-01 | Envelope 携带 `spec_version`、稳定 `message_id`、`session_id`、可选 `task_id` | `src/main/features/p3394_bridge/envelope.ts`；`test/main/features/p3394_bridge/envelope.test.ts`；`test/main/features/p3394_bridge/fixtures/umf-envelopes.ts`、`legacy-adapter.ts`；`http-channel.test.ts`；`http-fixtures.test.ts` | 已符合 | 主校验路径对缺失版本 fail-closed（HTTP 422）；已提供显式、可审计的 Legacy Adapter（缺失/旧版本归一化为 p3394/1.0 并产出审计事实，其余字段仍由正式校验器把关、适配后发现缺陷仍 fail-closed），主通道保持严格不放开；Channel 级 rejected fixtures 已覆盖缺失版本/非法 kind 等场景。 |
| M-02 | `kind` / `performative` 有固定集合，不支持值返回机器可读错误 | `envelope.ts`；`conformance.test.ts` | 已符合 | 增加跨通道 rejected fixtures。 |
| M-03 | `reply_to` 指向语义消息，传输 Frame/Chunk/Retry 不生成新 Message | `envelope.ts`、`executor.ts`、`outbound.ts`、`outbound-outbox.ts`；`executor-autoreply.test.ts`；`outbound-outbox.test.ts`；`interop.test.ts` | 已符合 | 自动回发 ID 已按入站消息和 performative 稳定派生；outbox 重放快照已验证与原始信封完全一致（message_id/idempotency_key/reply_to 原值保留，重试不产生新语义消息）；真实 Channel 恢复场景已验证（断线恢复前后事件/artifact 只送达一次、无重复语义消息）。 |
| M-04 | `idempotency_key`、重复和 replay protection | `idempotency.ts`、`replay-protection.ts`、`epoch-store.ts`；`executor-replay-epoch.test.ts`；bridge/security tests | 已符合 | 入站 `extensions.epoch` 已接入内核 per-sender replay protector（重复/倒退 epoch 拒绝、畸形 epoch 忽略、无 epoch 保持幂等语义）；仍需真实 Unix/WS 断线恢复场景证据。 |
| M-05 | payload、metadata、artifact、recipients 有资源上限 | `envelope.ts`、`artifact-parts.ts`、`runtime-controller.ts`、`executor.ts`、`channel-limits.ts`、`object-store.ts`、`http-channel.ts`；artifact-parts/runtime-controller/executor tests；`channel-limits.test.ts`；`artifact-budget.test.ts`；`http-artifact-loop.test.ts` | 已符合 | 已验证 artifact digest、路径、inline/object-store 大小边界、Runtime → Event Store 字段白名单，以及自动回发对非法 digest 的 fail-closed；已增加 artifact 自动回发的按会话数量/字节预算（fail-closed + 审计）；HTTP 入站并发上限（503 channel_busy）已接入；跨 Channel artifact 总量闭环已补：对象引用自动回发 → 对端经认证资源端点（/p3394/objects）拉取真实字节 → sha256 校验一致、无认证 401；同时修复 §12 内容寻址引用入站校验：引用 URI 不再被当作内容字符串哈希（否则真实对象引用必然 422），embedded digest 与 part.digest 一致且本地有对象时取回真实字节校验、对象不在本地（跨机器）时信任引用由资源端点校验、不一致时保持 fail-closed。 |
| M-06 | secret、token、credential、完整上下文不得进入 payload、metadata、审计 | `security-boundaries.test.ts`、`audit-journal.ts`、`outbound-outbox.ts`、`kstar-episodes.ts`、`redaction.test.ts`、`executor-leak.test.ts`、`http-leak-boundary.test.ts`、logger redaction | 已符合 | audit journal、outbox error 与 KSTAR episode 落盘均已统一到 canonical logger 脱敏（secret 键掩码 + Bearer/key=value/JWT/provider token/邮箱/手机号/绝对路径扫描，附 accepted/rejected fixture 集）；executor 异常路径（deliver 抛错 → episode、onEvent 抛错 → stream.pause 审计）已验证 token 不泄漏、关联 id 保持可追溯；跨 Channel 泄漏 fixture 已补：真实 HTTP 入站全链路（listener → 内核 → 审计）中 Authorization token、payload metadata 里的 token/api_key、reply_token 均不进入 audit journal，401 路径审计只含 path 不含 token。 |
| M-07 | Agent、Alias、Channel Instance、Session、Task、Message、Native Session 不混用 | `identity.ts`、`registry.ts`、`session-manager.ts`、`runtime-adapter.ts` | 已符合 | 增加跨重启映射和错误引用测试。 |
| M-08 | Manifest 声明 identity、role、runtime、capability、channel、policy、conformance | `manifest.ts`、`capability-profile.ts`；identity-manifest tests；`sender-admission.test.ts`；`http-identity-binding.test.ts` | 已符合 | 外部节点的 node_kind（hello 自报 + 注册表真实记录）已用于发送/接收双向准入：capability/model_runtime 不得发起也不得接收自主 task/message，disabled 节点解析即拒绝；per-peer 身份通道绑定已补：配置 expected_identity 的通道必须协商成功（token→peer identity 绑定），身份不符即使 token 有效也 fail-closed（negotiate 拒绝 + send 拒绝裸发），failover 绑定可达端点身份。 |
| M-09 | Capability Discovery 不等于 Authorization | `registry.ts`、`bridge.ts`、`reduced-profiles.ts`；`bridge.test.ts` 授权负例；`sender-admission.test.ts`；`http-identity-binding.test.ts`；`external-gateways.test.ts` | 已符合 | BridgeKernel 已对 task/message 的发送方与接收方双向执行 handle_message、performative 和 node kind fail-closed 检查（capability/model_runtime 双端拒绝 + 审计 sender.authorize/capability.authorize）；同一授权决策已接入真实外部节点：注册表真实 node_kind/Manifest（hello 自报）驱动准入，HTTP 通道 expected_identity 校验远端身份，受管 gateway 真实 Bearer 自注册边界已验证。 |
| M-10 | Registry 区分 agent、sub_agent、task_agent、capability、model_runtime | `registry.ts`；registry/reduced profile tests | 已符合 | 接入真实 trust/data/cost policy 决策。 |

## 2. Session 与 Runtime

| ID | 要求 | 代码/证据 | 状态 | 下一步 |
|---|---|---|---|---|
| R-01 | 显式 `session_id` 优先恢复，Goal 不替代 Session ID | `session-manager.ts`、`conversation-runtime.ts`、`session-state-machine.test.ts`、`session-routing.test.ts`、`conversation-runtime.test.ts` | 已符合 | 已集成验证：同一 session_id 复用同一 Work Session 且不同 Goal 不覆盖；不同 session_id 即使 Goal 相同也不合并；重复信封按 idempotency 拒绝执行；Channel Thread 绑定已验证（stableCid 确定性：同一 session 跨实例/跨消息映射同一 conversation，不同 session 互不串扰）；权限集成已验证：未授权 sender/recipient 的 task 在内核准入即拒绝，不创建 Session/Task、无执行副作用、审计留痕，授权对照正常创建并进入 active。 |
| R-02 | Session 内可关联多个 Task，Task 有独立生命周期 | `session-manager.ts`、`task-manager.ts`；session-task-lifecycle tests | 已符合 | 接入真实 Runtime 的多 Task 恢复场景。 |
| R-03 | `openSession` 接真实 Backend session store | `cogseed-runtime-adapter.ts`、`cogseed_backend/session-store.ts`；adapter tests | 已符合 | 增加跨进程重启和数据根恢复证据。 |
| R-04 | `deliver` 接真实 admission/task store | `cogseed-runtime-adapter.ts`、`runtime-controller.ts`、`task-store.ts`；`cogseed-runtime-adapter.test.ts` R-04 | 部分符合 | 已验证多 Agent 任务账本隔离：同一会话不同 Agent 的任务记录各自保留 agentId（身份来自信封 recipient）；一个 Agent 的 admission 失败零残留、不影响另一 Agent 的账本；仍需权限（信任策略）维度的失败路径证据。 |
| R-05 | `stream` 接 event store/runtime controller | `cogseed-runtime-adapter.ts`、`event-store.ts`、`runtime-controller.ts`；`runtime-adapter.test.ts`；`cogseed-runtime-adapter.test.ts`；`runtime-controller.test.ts`；`interop.test.ts`；`dual-bridge-process.test.ts` | 已符合 | 已支持并验证 `afterSequence` 断点消费、artifact 事件映射和受限字段续读，恢复时不重放已确认 P3394 事件；live 断线恢复已验证 artifact 事件在中断前后只送达一次（不因恢复重发）；长任务跨进程证据已补：真实子进程多轮 delta（3 段文本）完整送达终态 episode，且重启后同 session 的长任务事件流同样完整（文本单调收敛）。 |
| R-06 | `resume` / `cancel` / `snapshot` / `closeSession` 接真实控制器和事实来源 | `cogseed-runtime-adapter.ts`；`executor.ts::resumeForward`；`task-manager.ts`；`recovery-controller.ts`；`event-cursor-store.ts`；adapter tests；Interop tests；`outbound-hub.ts`；`dual-bridge-process.test.ts` | 部分符合 | 已有真实控制器基础集成、取消/恢复/快照/close、不重新 deliver 的事件续读入口、transport sink 失败转 recoverable，以及 Outbox 暂时 peer outage 后保留 submitted/sent 的恢复语义；live Channel 联合恢复已稳定（断线 → recoverable → resumeForward 游标续读），自动恢复已接入 app-wiring（持久化游标 + 30s sweep + maxAttempts 封顶）；跨进程恢复已补：真实子进程内事件外发失败注入（R-08）→ 恢复控制器 sweep → resumeForward 游标续读 → 终态 episode 落盘（恢复闭环同样产出 KSTAR episode，不重新 deliver）；Outbox 跨进程已补：真实子进程 reverse 出站事务闭环（submitted → sent → completed）经 per-peer 认证出站；仍需 cursor 三方同框的更深联合（live 断线中 outbox 重放与游标续读同一场景）。 |
| R-07 | Session close 进入 canonical KSTAR/Recall | `kstar-close-hook.ts`、`kstar-episodes.ts`、`recall-bridge.ts`、`executor.ts::closeSession`；`executor-episode.test.ts`；`cogseed-runtime-adapter.test.ts` R-07 | 已符合 | 已验证 completed / failed / cancelled 终态 episode、重复 close 只触发一次 runtime close 且 KSTAR 记录唯一、runtime close 失败写入 close_error 不抛出；真实 Recall 执行账本联合验证已补：失败任务 close 写入 status=failed 的执行记录，重复 close 幂等不重复写；取消任务 close 写入 status=cancelled 的执行记录且会话映射随后释放（cancelled 不污染其他任务）。 |
| R-08 | Runtime failure 不修改 active recipient、orchestration ledger、handoff 状态 | `cogseed-runtime-adapter.ts` 失败纪律 + `readEvents` 注入点；`cogseed-runtime-adapter.test.ts` R-08 失败注入；`dual-bridge-process.test.ts`（P3394_CHILD_FAIL_DELIVERY） | 部分符合 | 已注入 start/resume/cancel/event-store 读取失败并绑定真实 ledger 断言：admission 失败不产生任务记录/映射/活跃运行，resume 失败保持 recoverable 且不新增事件，cancel 失败不改变任务状态、不留 cancelled 事件，event-store 读取失败只传播错误、后端任务保持 running 且不落 task.failed；跨进程恢复注入已补：真实子进程事件外发失败（模拟对端断线）→ 任务转 recoverable（不 settle failed、不重新 deliver）→ 恢复控制器 sweep 续读完成，终态 episode 落盘、事件流完整。 |
| R-09 | P3394 Session/Task 映射跨重启恢复 | `cogseed-runtime-adapter.ts` state file（损坏恢复加固）；`cogseed-runtime-adapter.test.ts` 跨实例恢复 + R-09 损坏恢复测试；`dual-bridge-process.test.ts` 真实进程重启恢复（child 退出后同 Agent Home + 同一 stateFile 重启，同 session 继续执行 task2 并自动回发） | 已符合 | 同一 Agent Home + 持久化 stateFile 的真实子进程（完整 Kernel/Executor/Adapter/HTTP）退出后重启，恢复 session/task 映射并继续同 session 任务；损坏 JSON / 不支持 schema / 畸形条目：空映射启动、自愈重写有效状态文件、跳过幽灵条目。 |

## 3. Bridge、Channel 与互操作

| ID | 要求 | 代码/证据 | 状态 | 下一步 |
|---|---|---|---|---|
| C-01 | Agent、Bridge、Channel 分离；Channel 不拥有业务 Session Store | `bridge.ts`、`channel-adapter.ts`、`session-store.ts` | 已符合 | 保持架构边界回归测试。 |
| C-02 | 本地 InProcess Channel 双向基础闭环 | `in-process-channel.ts`；in-process/interop tests | 已符合 | 仅作为 contract fixture，不宣称跨进程生产互操作。 |
| C-03 | 同机 Unix Socket/Loopback framing、auth、reconnect、backpressure、shutdown | `unix-socket-channel.ts`；`unix-socket-channel.test.ts`；`interop.test.ts`；`executor.ts`；`task-manager.ts`；`recovery-controller.ts` | 部分符合 | 已完成同进程和独立 Node 进程的 Unix Socket fixture、认证、分帧、重连、关闭、单连接 pending 背压、listener 重启重投递去重；修复 dialer 关闭时不误删 peer listener socket 文件与 flush 失败误删未确认缓存；live 断线恢复已稳定（断线 → recoverable → 游标续读不重发、断线前完整重放且任务只执行一次），自动恢复控制器已接管（app-wiring 定时 sweep + 持久化游标）；仍缺 WS 与其余 Channel 的统一限制接入。 |
| C-04 | HTTP loopback channel 有认证和 endpoint 边界 | `http-channel.ts`、`app-wiring.ts`；`http-channel.test.ts`；`http-auth-audit.test.ts`；http/security tests | 已符合 | 已验证真实 HTTP/HTTPS loopback negotiation、Bearer auth、expected_identity、Envelope delivery、统一入站速率（429 + retry_after）与认证失败审计（401 → http.auth.reject 进入内核审计，health 豁免）；listener 生命周期由 close/重启测试覆盖。 |
| C-05 | WebSocket listener/dialer、TLS、身份认证、failover | `websocket-channel.ts`（真实 WS：listener/dialer、握手 Bearer 认证、expected_identity 绑定、wss TLS、failover、统一速率/并发限制、消息上限）；`websocket-channel.test.ts`（7 tests） | 已符合 | 真实 WebSocket 实现（`ws@8.21.3`，用户已批准依赖）：在 HTTP(S) server 上挂 WebSocketServer，HTTP 端点（manifest/health/objects）复用 http-channel 实现；握手层 Bearer 认证（401 审计）与并发上限（503 拒绝 upgrade）；dial 先 HTTP 拉 manifest 校验 expected_identity（token→peer identity 绑定，身份不符 fail-closed）与 capability；endpoint failover 身份一致；消息级统一速率限制（429 语义带 retry_after_ms 与 message_id）；测试覆盖真实 WS 双向闭环、错误 token 拒连、identity 绑定、wss（自签 TLS）round trip、failover、速率/并发限制（7/7 通过）。 |
| C-06 | 两个独立 Local Bridge 各自拥有 Agent Home、Identity、Session Authority、Runtime Adapter | `agent-home.ts`、`app-wiring.ts`、`interop.test.ts`、`external-gateways.test.ts`、`unix-socket-channel.test.ts` 独立进程 fixture、`dual-bridge-process.test.ts` + `fixtures/bridge-node-child.ts` | 已符合 | 已完成两个完整独立 Bridge Kernel/Agent Home/Runtime Authority 的进程级验收：Node B 子进程使用真实 `P3394CogseedRuntimeAdapter`（接 CogSeed Backend 会话/任务/事件存储 + 运行控制器），A→B task→真实执行→episode 落盘→自动回发→对端闭环，子进程干净退出；非 Hermes 双 Bridge fixture（C-09）与受管 Hermes gateway 进程级互操作（V-03/V-04：task→CLI→response、双向 reverse 闭环、失败显式回信）均已验收。 |
| C-07 | 入站任务完成后自动回发 response/event/artifact | `executor.ts`、`outbound-hub.ts`、`outbound-outbox.ts`、`runtime-controller.ts`、`p3394-gateway/gateway.cjs`；`executor-autoreply.test.ts`；`interop.test.ts`；`external-gateways.test.ts`；`outbound-hub.test.ts`；`runtime-controller.test.ts`；`cogseed-runtime-adapter.test.ts`；`dual-bridge-process.test.ts` | 部分符合 | 已验证双节点 event/artifact 回传、独立 `kind=artifact` 自动回发、真实 HTTP reply endpoint、Bearer token、稳定 message/idempotency key、敏感字段过滤、managed Hermes gateway 真实 task→CLI→response 回传、submitted replay 和暂时 peer outage 后延迟重放、完成后断线重投递去重、transport sink 断线转 recoverable 及不重新 deliver 的事件续读入口；artifact 与事件流中断恢复的联合证据已补（artifact 在断线恢复前后只送达一次）；response 恢复 + Outbox 跨进程联合已补：真实子进程 reverse 出站走事务 outbox（submitted → sent → completed + 信封快照 peer 正确），经 per-peer 认证出站（dial_token）送达父进程并完成回复闭环；仍需 cursor 三方同框的更深联合（live 断线中 outbox 重放与游标续读同一场景）。 |
| C-08 | 外部 Adapter 明确 reduced profile，不冒充完整 Agent | `reduced-profiles.ts`、`mcp-runtime-adapter.ts`、`model-runtime-adapter.ts` | 已符合 | 增加 Capability Node 与 Model Runtime 的授权负例。 |
| C-09 | 至少一个非 Hermes peer 或等价 fixture | `channel-testkit.ts`、`interop.test.ts`；`external-gateways.test.ts`；`dual-bridge-process.test.ts` + `fixtures/bridge-node-child.ts` | 已符合 | 已固化 Node A/Node B 等价双 Bridge fixture（独立进程、真实 Runtime Adapter），完成非 Hermes 双向任务闭环：A→B task→执行→自动回发→A，且 B 完成后主动发起 reverse task→A 执行→自动回发→B 落盘（双向，连续 3 次全过）；受管 Hermes gateway 自注册/任务回传与 Hermes 主动任务入口（V-04）亦已验证。 |

## 4. 本地优先、安全与审计

| ID | 要求 | 代码/证据 | 状态 | 下一步 |
|---|---|---|---|---|
| S-01 | Agent Home、状态和凭据边界在本地用户数据根 | `agent-home.ts`、`runtime-paths.ts`、`app-wiring.ts`；`agent-home.test.ts`（S-01）；`dual-bridge-process.test.ts` | 已符合 | 已验证全部派生路径（manifest/identity/peers/policy/consent/audit/journal/session/workspace/artifacts/checkpoints/trace/kstar）落在 Agent home 根内；同一 uid 不同 agent 根隔离且凭据/状态文件（identity/peers/session）跨 agent 不可达；create 只建目录骨架、不预生成凭据文件（凭据只由授权流程显式写入）；逃逸型 session id（路径穿越/反斜杠/编码点）一律拒绝；数据根由本地 `uid/local/p3394/agents/<id>` 限定；真实进程重启证据由 dual-bridge 验收提供（完整子进程 + 独立 Agent Home 重启后同 session 继续）。 |
| S-02 | 默认 loopback，公网监听默认关闭 | `app-wiring.ts`、`http-channel.ts`；security tests | 已符合 | 对生产配置和打包入口增加 fail-closed 验证。 |
| S-03 | 未认证 endpoint、错误身份、未授权 capability fail closed | `http-channel.ts`、`bridge.ts`、`security-boundaries.test.ts`、`bridge.test.ts`、`external-gateways.test.ts`、`sender-admission.test.ts`、`http-identity-binding.test.ts` | 已符合 | 已覆盖本地 BridgeKernel 的未授权 task 发送/接收双方、reduced node 和 performative fail-closed，以及受管 gateway 的真实 Bearer hello 自注册边界；token→per-peer identity 绑定已补：expected_identity 不匹配时 negotiate 拒绝（p3394_identity_mismatch）且 send 拒绝裸发（p3394_identity_not_negotiated，信封不泄漏到身份不符端点），failover 绑定可达端点身份。 |
| S-04 | Audit Journal 记录可追溯事件但不泄露敏感数据 | `audit-journal.ts`、`outbound-outbox.ts`、`kstar-episodes.ts`、`executor.ts`；`redaction.test.ts`；`executor-leak.test.ts`；`http-leak-boundary.test.ts`；audit/security/auto-reply tests | 已符合 | 已验证 artifact 自动回发审计包含 endpoint/kind/reply_to 而不写入 artifact secret；audit、outbox error 与 episode 落盘统一 canonical 脱敏并附 fixture 集；executor 异常/重试路径泄漏已封堵（deliver/onEvent 抛错带 token → episode/审计均脱敏、关联 id 可追溯）；跨 Channel 泄漏 fixture 已补（HTTP 入站全链路 secret 不进入审计，401 审计只含 path）。 |
| S-05 | replay、duplicate、断线恢复不重复执行 | `replay-protection.ts`、`outbound-outbox.ts`、`outbound-hub.ts`、`executor.ts`、`task-manager.ts`、`unix-socket-channel.ts`、`recovery-controller.ts`、`event-cursor-store.ts`；`outbound-hub.test.ts`；`outbound-outbox.test.ts`；`interop.test.ts`；`unix-socket-channel.test.ts`；`runtime-adapter.test.ts`；`executor-autoreply.test.ts`；`cogseed-runtime-adapter.test.ts`；`dual-bridge-process.test.ts` | 部分符合 | 已验证 HTTP Outbox 重放、Unix Socket listener 重启后的 Envelope 去重、Channel 未 flush cache/reconnect 实现、Runtime Adapter `afterSequence` 续读、artifact 事件持久化/HTTP 回发、Executor 不重新 deliver、transport sink 失败转 recoverable，以及 replay 暂时失败后保持 submitted/sent 并可在 peer 恢复后重放；live 断线恢复已稳定（断线前事件前缀不重发、游标续读无重复、断线前完整重放、任务只执行一次），自动恢复已接管（持久化游标 + sweep + 尝试封顶）；跨进程恢复注入已验证不重复执行（子进程事件外发失败 → recoverable → sweep 续读 → 单次终态 episode、不重新 deliver、事件流完整）；Outbox 跨进程事务闭环已补（submitted → sent → completed，信封快照唯一，peer 目标正确）；仍待 live 断线中 outbox 重放与游标续读同框的三方联合场景。 |
| S-06 | backpressure、rate、concurrency、payload/artifact limits | `envelope.ts`；`unix-socket-channel.ts`；`unix-socket-channel.test.ts`；`channel-limits.ts`；`http-channel.ts`；`http-rate-limit.test.ts`；`http-concurrency.test.ts`；`executor.ts` artifact 预算 | 部分符合 | 已建立统一 limits 原语（token bucket 速率器 + 字节预算）并接入：Unix Socket 单连接 pending frame fail-fast + frame 上限，HTTP listener 统一入站速率（429 + retry_after_ms、health 豁免、可关闭）与并发上限（超限 503 channel_busy、响应完成即释放、可关闭），artifact 自动回发按会话数量/字节预算 fail-closed；仍需 WS 接入与跨 Channel 队列语义统一。 |
| S-07 | 高风险操作保留人工确认 | `docs/P3394-人工确认与授权矩阵.md`；CogSeed 现有 approval / policy choke points；`control-operations.test.ts` | 已符合 | 已建立认证≠授权≠人工确认的映射矩阵：peer 自注册、KSTAR/Recall 治理、信任升级保留人工确认；跨节点 cancel 已加固认证准入 + 审计；resume 为内部恢复控制器动作（maxAttempts + 持久化游标、不重新 deliver，无需人工确认）；控制操作集合严格枚举已复核：非 cancel 的 control 信封（含无 task_id 的 cancel）零副作用（不调 runtime、不建会话、无控制审计、无拒绝记录）。 |

## 5. Doctor、Conformance 与发布

| ID | 要求 | 代码/证据 | 状态 | 下一步 |
|---|---|---|---|---|
| V-01 | Doctor 检查 Manifest、Identity、Registry、UMF、Session、审计、认证和资源限制 | `doctor.ts`（`buildP3394WiringDoctorInput`）；`app-wiring.ts::runP3394WiringDoctor`；`scripts/p3394-doctor.ts`（绑定 flags）；`wiring-doctor.test.ts`；`persistence.test.ts`；`conformance.test.ts` | 部分符合 | Doctor 已覆盖 Manifest/Identity、Registry、Agent Home、Runtime Adapter、Channel、Object Store、Auto Reply、Replay、Idempotency、Audit、Policy 和资源限制输入；app-wiring 自动注入真实 listener/binding 状态（桥未启动全 warn 不虚报）；CLI 已接入同一装配（P3394_REPLAY_BOUND 等绑定 flags，全绑定→全 pass，未上报→warn）；仍需生产打包中的 doctor 输出证据。 |
| V-02 | 标准 accepted/rejected fixtures | `test/main/features/p3394_bridge/fixtures/umf-envelopes.ts`；`umf-envelope-fixtures.test.ts`；`fixtures/http-channel-fixtures.ts`；`http-fixtures.test.ts` | 已符合 | envelope 层已统一 fixtures 目录与矩阵 ID（7 accepted + 27 rejected，按 `P3394EnvelopeValidationReason` 编译期穷尽）；Channel 级已纳入同一目录与 ID 约定（2 accepted + 7 rejected，覆盖 401/422/400/413/429 全部拒绝错误码，穷尽断言 + 矩阵 ID 合法性断言）。 |
| V-03 | `CogSeed → Hermes → CogSeed` 双向闭环 | `external-gateways.ts`、`outbound-hub.ts`、`p3394-gateway/gateway.cjs`、`external-gateways.test.ts` | 部分符合 | 已验证 CogSeed HTTP dialer 向真实 managed Hermes gateway 发送 task，gateway 使用 CLI 执行并向 CogSeed reply endpoint 回传 response（成功路径）；真实失败路径已补：CLI 以非零码退出 → gateway 显式回传 `[p3394_gateway_error] agent exited <code>`（任务 id 回显、不静默吞掉）→ CogSeed 感知失败；仍需真实 Hermes artifact 与跨进程 Outbox/cursor 联合证据。 |
| V-04 | `Hermes → CogSeed → Hermes` 自动结果闭环 | `executor.ts`、auto-reply wiring、`p3394-gateway/gateway.cjs`（P3394_SEND_TASK 反向入口 + 断线重试）、`hermes-reverse-loop.test.ts` | 已符合 | 反向入口已定义并验收：gateway 一次性任务模式携带 reply_endpoint/reply_token 主动发起 task，CogSeed 独立进程执行 → episode 落盘 → 自动回发结果，gateway 命中 reply_to waiter 打印并退出（真实进程级闭环，连续多次全过）；断线恢复已补：CogSeed 未起时首次发送失败（ECONNREFUSED）→ 退避重试（P3394_SEND_TASK_RETRIES，1.2s×attempt）→ 重试送达 → 闭环完成并 exit 0，失败路径显式打印重试计数；总等待由 SEND_TASK_TIMEOUT_MS 封顶。 |
| V-05 | Electron、打包、外部 Agent、安全审查有证据 | `app-wiring.ts`、runtime launcher；`package:dev:mac` + `verify:package:dev:mac` | 部分符合 | 修复 resources/builtin `_manifest.json` 排序后 macOS 开发打包成功：dist-dev/mac-arm64/CogSeed Dev.app 产出、native-deps gate passed、adhoc 签名，`verify:package:dev:mac` smoke ready（appIsPackaged/appAsar/preload/renderer/ipcPing=pong）；仍有真实 HTTPS/TLS、WSS、生产 CA、外部 Agent 双向互操作和安全审查签名。 |
| V-06 | 旧 P3394 KSTAR 路径删除证明 | `test/static/kstar-single-core.test.ts`；`test/main/ipc/p3394-contract.test.ts`；`src/main/features/recall/forecast-model.ts`；`kstar-close-hook.ts` | 已符合 | 静态证明旧 `kstar-runtime.ts`/`kstar-engine.ts`、旧 intent router 和独立 runner 路径不存在；KSTAR forecast 的受限模型调用已移至通用 Recall feature choke point，KSTAR 只负责业务解析/持久化；IPC contract 继续验证 legacy removal 后的通用 P3394 wake/protocol 通道。 |
| V-07 | Dashboard 统一展示 Agent/Channel/Session/Task | 规划文档；当前无统一 P3394 运行态视图 | 未实现 | 核心 Bridge Runtime 完成后另立产品化任务，不纳入当前完成定义。 |

## 当前推进顺序

1. 完善本矩阵和 accepted/rejected fixtures，作为每次实施提交的证据索引；（本轮已完成 envelope 层 fixture 目录统一、矩阵 ID 标注与逐 reason 穷尽覆盖。）
2. 完成模型纠偏：生产 `spec_version`、`reply_to`、错误语义、Manifest/Capability 授权和统一资源限制；（已完成缺失 `spec_version` 的主校验 fail-closed、HTTP 422 负例、Kernel 准入授权、以及统一 limits 原语接入 HTTP 速率与 artifact 预算。）
3. 完成真实 Runtime Adapter 的失败、恢复、跨重启证据；（本轮已完成 start/resume/cancel 失败注入与真实 ledger 断言。）
4. 建立两个独立 Local Bridge fixture，完成自动 response/event/artifact 回发；
5. 完成真实 Unix Socket/Loopback framing、认证、重连、backpressure 和恢复；
6. 再推进 HTTPS/WSS、外部 Adapter、Doctor 扩展和发布验收；
7. 核心闭环完成后，单独评审 P3394 Dashboard。

## 当前状态声明

当前准确表述：

> CogSeed 已具备 P3394 标准模型、Bridge 核心边界、部分真实 Runtime Adapter 和本地 Channel 基础，正在按 P3394 v1.1 收敛真实双 Bridge、同机 Channel、安全、恢复和 Conformance 证据；尚不能据此宣称生产级跨进程、跨机器或完整外部 Agent 互操作已经完成。
