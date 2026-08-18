# P3394 Bridge Runtime / Cognitive Cell 交接文档

日期：2026-08-14
当前分支：`dev/p3394-bridge-runtime`
工作树：`/Users/sudai/Documents/CogSeed-Backend-P3394-Bridge`
基线：`origin/develop @ 01d6db5e`
当前状态：本地分支领先 `origin/develop` 12 个提交，工作区干净，尚未推送。

---

## 0. 交接结论

当前 CogSeed 已完成一套 **P3394 Bridge Runtime 的 contract-first 基础实现**，覆盖：

- P3394 UMF Envelope；
- Agent Identity、Manifest、Capability Profile；
- Peer/Alias Registry；
- Agent Home 逻辑路径边界；
- Idempotency、Replay Protection、Audit Journal；
- Bridge Kernel；
- Runtime Adapter contract；
- Session/Task/Message lifecycle；
- KSTAR close hook；
- In-process、IPC/Unix Socket contract、Inbound/Outbound API；
- WebSocket opt-in contract；
- A2A/MCP/Model capability profile 区分；
- P3394 Doctor 基础检查；
- Bridge Conformance smoke tests；
- Legacy P3394 KSTAR deletion proof 回归。

但是必须准确理解当前状态：

> 当前实现已经建立了 P3394 Bridge 的标准模型、边界和可测试基础，但 IPC/Unix Socket/WebSocket 仍主要是 contract-first 或安全默认实现，不应宣称已经完成生产级跨进程/跨机器 Agent 互操作。

完整生产化还需要继续完成真实 transport、认证、重连、背压、远程 peer、Runtime Backend 接线和真实 Electron/外部 Agent 互操作验收。

---

## 1. 外部指南与本项目背景

外部指南：

```text
/Users/sudai/Desktop/team2/P3394_Raymond_Hermes_Chinese_Implementation_Guide.md
```

指南名称：

```text
P3394 LLM Agent Interface Standard 中文实施指南
```

指南版本：1.1
指南日期：2026-08-12

指南的目标是让 Raymond、Forge、CogSeed、Hermes、Pydantic AI、LangChain/LangGraph、AG2 和第三方 Agent Framework 通过同一套 Bridge 互操作：

```text
任意 Agent Framework
        ↓ Runtime Adapter
P3394 Bridge Kernel
        ↓ Agent Home / Session Manager
Channel Adapter
        ↓
本地或远程 P3394 / A2A / MCP / Model Node
```

指南并不要求 Agent 重写原有 Agent Loop，而是要求在原有 Agent Runtime 旁边增加：

- P3394 Bridge Runtime；
- Agent Home；
- Session/Task/Message 语义；
- UMF Envelope；
- Identity / Manifest / Capability；
- Peer Registry / Alias；
- Channel Adapter；
- Inbound / Outbound Agent API；
- KSTAR Episode / AAR / Learn-What hook。

---

## 2. 我们当前的工作基础

本次实现建立在 CogSeed 已有的后端收敛工作上，而不是另起一套 Agent Framework。

### 2.1 CogSeed Backend

主要依靠：

```text
src/main/features/cogseed_backend/session-store.ts
src/main/features/cogseed_backend/task-store.ts
src/main/features/cogseed_backend/event-store.ts
src/main/features/cogseed_backend/runtime-controller.ts
src/main/features/cogseed_backend/recovery.ts
src/main/features/cogseed_backend/p3394-admission.ts
src/main/features/cogseed_backend/p3394-wake-dispatcher.ts
src/main/features/cogseed_backend/group-chat-projection.ts
```

这些模块是 CogSeed 本地 Session、Task、Event、Runtime、Recovery、Wake 和 Group Chat projection 的事实来源。

Bridge 不应重新实现这些业务状态，也不应让每个 Channel 自己建立 Session Store。

### 2.2 现有 P3394 Lite

主要依靠：

```text
src/main/features/p3394/protocol.ts
src/main/features/p3394/controller.ts
src/main/features/p3394/wake-controller.ts
src/main/features/p3394/epoch-store.ts
src/main/features/p3394/sender-epoch-store.ts
src/main/features/p3394/execution-boundary.ts
```

已有能力：

- P3394 Lite message normalization；
- service principal；
- relationship / speech act；
- semantic block policy；
- replay epoch；
- wake approval；
- wake recovery；
- execution boundary；
- P3394 process event 记录。

本次 Bridge 在其上增加完整 Envelope、Identity、Registry、Channel 和治理契约。

### 2.3 Canonical KSTAR 与 Recall

主要依靠：

```text
src/main/features/kstar/
src/main/features/cogseed_backend/recall-bridge.ts
src/main/features/recall/
```

KSTAR/Recall 继续是认知学习闭环的唯一业务归属：

```text
Session Close
→ canonical KSTAR Episode
→ Review / AAR / Feedback
→ Recall Candidate
→ Ability Asset
→ Governance / Human Confirmation
```

不允许恢复旧的 P3394 KSTAR Engine、旧 Experience Candidate 或旧 P3394 KSTAR storage。

### 2.4 安全和存储基础设施

依靠现有：

```text
src/main/features/cogseed_backend/paths.ts
src/main/paths.ts
src/main/storage.ts
src/main/util/
src/main/preload.js
src/main/ipc/index.ts
```

原则：

- 用户作用域由主进程决定；
- Renderer 不能声明 Agent identity、uid 或 capability；
- 路径必须走现有 sandbox/ID 校验；
- 不把 secret 写入日志、Audit 或远程 payload；
- 不新增绕过现有 IPC/Runtime choke point 的执行路径。

---

## 3. 当前代码实现情况

### 3.1 Bridge 代码目录

```text
src/main/features/p3394_bridge/
├── agent-home.ts
├── audit-journal.ts
├── bridge.ts
├── capability-profile.ts
├── channel-adapter.ts
├── doctor.ts
├── envelope.ts
├── external-adapters.ts
├── idempotency.ts
├── identity.ts
├── in-process-channel.ts
├── inbound.ts
├── ipc-channel.ts
├── kstar-close-hook.ts
├── manifest.ts
├── message-store.ts
├── outbound.ts
├── registry.ts
├── replay-protection.ts
├── runtime-adapter.ts
├── session-manager.ts
├── task-manager.ts
├── unix-socket-channel.ts
└── websocket-channel.ts
```

### 3.2 已实现能力矩阵

| 能力 | 状态 | 说明 |
|---|---|---|
| UMF Envelope | 已实现 | `envelope.ts` 提供 `p3394/1.0` 类型、payload parts/metadata、边界校验和机器可读错误 |
| Agent Identity | 已实现 | agent_id、alias、display_name；禁止 alias 等于 agent_id；禁止 agent_id 作为 model profile |
| Manifest | 已实现 | runtime、capability、local channel、session/security/conformance 字段 |
| Capability Profile | 已实现 | native/local-cli、handle_message、local-cli、cogseed-skill-scope |
| Peer Registry | 已实现 | 本地内存 registry、identity/alias resolve、冲突、disable/revoke、session alias 优先级 |
| Agent Home | 已实现 | uid/agent/session 路径逻辑边界、workspace/artifacts/checkpoints/kstar 路径 |
| Idempotency | 已实现 | sender + key 复合幂等边界 |
| Replay Protection | 已实现 | sender epoch watermark |
| Audit Journal | 已实现 | audit record 和 secret key redaction |
| Bridge Kernel | 已实现 | envelope → peer resolve → replay → idempotency → audit 流程 |
| Runtime Adapter Contract | 已实现 | open/deliver/stream/resume/cancel/snapshot/close 接口及内存测试实现 |
| Session/Task/Message lifecycle | 已实现 | 当前是 Bridge 逻辑生命周期管理器，后续需要接真实 Backend store |
| KSTAR close hook | 已实现 | close 幂等、只产生 proposed_updates，不自动 promotion |
| InProcess Channel | 已实现 | 本进程 listener/send/subscribe/close contract |
| IPC Channel | 部分实现 | 当前复用本机 channel contract，尚未接真实 Electron IPC transport |
| Unix Socket Channel | 部分实现 | 当前为同一 contract 的安全占位，尚未实现真实 socket framing/auth |
| Inbound API | 已实现 | Bridge receive 入口 |
| Outbound API | 已实现 | Channel send client |
| WebSocket Channel | 部分实现 | opt-in/auth gate contract，尚未生产级 websocket listener |
| External Adapter Profile | 已实现 | agent/capability/model-runtime 区分和授权/伪装拒绝 |
| p3394 doctor | 部分实现 | 已接真实 Bridge doctor，目前无 manifest 时输出 warn |
| Conformance Suite | 部分实现 | 已有本地 smoke/security/lifecycle tests，不等同完整跨 Agent conformance |

---

## 4. 当前验证结果

在当前 worktree 执行：

```bash
npm run test:js -- \
  test/main/features/p3394_bridge \
  test/static/p3394-kstar-deletion.test.ts \
  test/static/kstar-single-core.test.ts
```

结果：

```text
17 个测试文件通过
47 个测试通过
```

类型检查：

```bash
npm run typecheck
```

结果：通过。

Doctor：

```bash
npm run p3394:doctor -- --json
```

当前输出：

```json
{
  "ok": true,
  "checks": [
    {
      "name": "manifest",
      "status": "warn",
      "reason": "no manifest provided"
    }
  ]
}
```

差异检查：

```bash
git diff --check origin/develop...HEAD
```

结果：通过。

注意：当前分支完成 Bridge 专项验证和类型检查，但还没有在这 12 个新提交上重新跑完整 `npm test`、资源测试、macOS 打包和真实外部 Agent 互操作。后续必须补做并与纯 `origin/develop` 基线比较。

---

## 5. 当前提交链

```text
a45e73e5 fix(p3394): run doctor through bridge checks
3e354006 test(p3394): add bridge conformance suite
007ded47 feat(p3394): model network and external adapters
564c9873 feat(p3394): add local channel and inbound outbound APIs
964a7af5 feat(p3394): map bridge lifecycle to session tasks and kstar hook
0b2c1117 feat(p3394): define runtime adapter contract
35f6ddf7 feat(p3394): assemble bridge kernel and doctor
b57d89b6 feat(p3394): add bridge replay idempotency and audit primitives
90c9524e feat(p3394): add isolated agent home boundary
1fee06d2 feat(p3394): add local peer alias registry
42c878f5 feat(p3394): define bridge identity and manifest contracts
61508cd1 feat(p3394): add universal message envelope
```

这些提交都位于：

```text
dev/p3394-bridge-runtime
```

当前尚未 push 到远端。

---

## 6. 实施计划

### Phase 1：标准模型与 Bridge Kernel

已完成基础版：

1. UMF Envelope；
2. Identity / Manifest / Capability；
3. Peer/Alias Registry；
4. Agent Home；
5. Idempotency / Replay / Audit；
6. Bridge Kernel / Doctor。

后续要做的加固：

- 持久化 Registry；
- 持久化 Audit Journal；
- 原子写、锁、清理和恢复；
- schema/version migration；
- doctor 读取真实 Agent manifest、Registry、Agent Home 和 Runtime binding。

### Phase 2：真实 CogSeed Runtime Adapter

当前只完成 contract-first adapter 和 in-memory 测试实现。下一步：

- 将 `P3394RuntimeAdapter` 接到真实 `runtime-controller.ts`；
- 将 `openSession` 接到 Backend session store；
- 将 `deliver` 接到 Backend task admission；
- 将 `stream` 接到 event store / runtime event stream；
- 将 `resume/cancel/snapshot/close` 接到现有 recovery/controller；
- 将 Agent context、skill scope、model profile 分离贯穿到 Bridge；
- 将 Session close hook 接入 canonical KSTAR/Recall bridge；
- 验证失败时不修改 active recipient/orchestration ledger。

### Phase 3：真实同机双向 Channel

当前 IPC/Unix Socket 文件主要是 contract alias。下一步：

- Electron IPC adapter 接入 `src/main/ipc/index.ts` 和 preload allow-list；
- Renderer 只能发起操作，不能声明 Agent identity/capability；
- Unix Socket 使用明确 frame boundary；
- 添加本机 authentication token；
- 添加最大 frame、队列、并发、速率限制；
- 添加 listener/dialer、subscribe/unsubscribe、reconnect、graceful shutdown；
- 添加真实 disconnect/recovery 测试。

### Phase 4：真实网络与外部 Adapter

当前 WebSocket 只做 opt-in/auth contract。下一步：

- 实现真正 HTTPS/WebSocket listener/dialer；
- 默认不监听公网；
- TLS/auth/peer identity；
- capability negotiation；
- reconnect/backpressure/slow peer/resource exhaustion；
- artifact digest/integrity；
- endpoint failover 不改变 agent identity；
- A2A、MCP、OpenAI-compatible model API adapter；
- capability node 和 model runtime 不得伪装成 autonomous Agent。

### Phase 5：完整治理和互操作验收

- 完善 `p3394 doctor` JSON/human-readable 输出；
- 完整 UMF conformance suite；
- inbound/outbound 跨进程测试；
- session/task/message 映射测试；
- duplicate/replay/cancel/reconnect/artifact 测试；
- Session close → KSTAR Episode → Recall governance 测试；
- 与 Raymond、Hermes 或 Forge 至少一个 Agent 做互操作测试；
- 运行完整 `npm test`、资源测试、打包验证和真实 Electron 验收。

---

## 7. 与外部指南的差异

### 7.1 Python/Pydantic 参考实现改为 TypeScript/Electron 原生实现

指南默认栈是：

```text
Python + Pydantic + Pydantic AI + asyncio + FastAPI/ASGI + SQLite
```

CogSeed 实际栈是：

```text
TypeScript + Electron main process + classic renderer + Vitest
+ 现有 JSON/JSONL/storage/Backend/Runtime
```

原因：

- CogSeed 不是 Python Agent Framework；
- 现有 Agent Loop、Runtime、IPC 和 storage 都在 TypeScript/Electron；
- 引入 Python Bridge 会产生第二个 Runtime、第二套 Session Store、额外进程边界和身份同步风险；
- 指南明确允许 Embedded Bridge、Sidecar 或同机 Bridge，因此采用同一 Electron main process 内的 Bridge Kernel 更贴合 CogSeed。

### 7.2 先 contract-first，暂未直接实现生产网络

指南最终建议 Native HTTPS/WebSocket，但当前实现先提供：

```text
InProcess contract
IPC contract
Unix Socket contract
WebSocket opt-in/auth contract
```

原因：

- 先固定 UMF、Identity、Session、Task、Capability 和错误语义；
- 避免在协议未稳定前引入端口监听、认证、重连和背压复杂度；
- CogSeed 当前首先需要内部 Backend/Agent 语义统一，不是立即开放外部网络；
- 默认 Local-First 和 fail-closed 比快速暴露远程端口更安全。

### 7.3 先复用 CogSeed Backend，不复制 Agent Home 全部物理存储

指南建议 Agent Home 目录包含：

```text
sessions/<session-id>/workspace
artifacts
checkpoints
trace
kstar
```

当前实现先提供 Agent Home 的逻辑路径边界，Session/Task/Event 仍依靠：

```text
cogseed_backend/session-store.ts
task-store.ts
event-store.ts
runtime-controller.ts
```

原因：

- 这些已经是 CogSeed 的事实来源；
- 复制一套 Agent Home DB 会导致状态双写、恢复不一致和身份错位；
- Agent Home 应先成为标准视图和安全边界，再逐步接入持久 journal、artifact、checkpoint。

### 7.4 Peer Registry 先做本机内存实现

指南要求 Peer Registry、Alias、Manifest Cache 和审计。当前先实现本机 registry contract。

原因：

- 先固定 `alias → identity → manifest → capability` 解析语义；
- 真实持久化需要接入 CogSeed 用户路径、锁和原子写；
- 远程 peer registry 在身份认证和撤销机制成熟前不应提前开放。

### 7.5 P3394 Lite 与完整 UMF 并存

当前仓库已有：

```text
P3394LiteMessage
P3394LiteManifest
```

本次新增：

```text
P3394MessageEnvelope
P3394BridgeManifest
P3394CapabilityProfile
```

原因：

- 不能一次性删除现有 P3394 Lite，已有 wake/group-chat/tests 依赖它；
- Bridge 需要逐步将内部 Lite 语义映射到完整 Envelope；
- 迁移期间 Lite 继续用于既有内部协议，完整 UMF 作为新的 Bridge 边界；
- 后续必须补充 Lite → UMF 的显式 adapter，不能长期靠两套 schema 手工并存。

### 7.6 KSTAR 不放进 P3394 Bridge 作为第二套引擎

指南建议 Session Close 进入 KSTAR Episode / AAR / Learn-What。当前采用：

```text
Bridge close hook
→ canonical features/kstar
→ Recall governance
```

而不是恢复：

```text
legacy P3394 KSTAR Engine
legacy Experience Candidate
legacy snapshots/archive/migration
```

原因：仓库已经完成 legacy P3394 KSTAR 删除；旧系统会造成双重事实来源、双写、旧 IPC 和错误学习路径。

### 7.7 Inbound/Outbound 先是本地 API，不宣称外部互操作已完成

指南要求 CogSeed 同时作为 Agent Server 和 Agent Client。当前已有：

```text
P3394InboundServer
P3394OutboundClient
```

但它们目前主要是 Bridge Kernel/Channel contract，尚未完成真实外部 P3394 Node 互操作。

原因：必须先完成真实 Channel、认证、Capability Negotiation、Remote Session 和 Artifact 语义，不能把本地 in-process 测试误称为跨 Agent 网络互操作。

---

## 8. 后续执行顺序

下一位接手者应按以下顺序继续，不要跳过真实 Backend 接线：

1. 将 Runtime Adapter 接到真实 CogSeed Backend；
2. 将 Agent Home/Registry/Audit 接到现有用户安全存储；
3. 将 InProcess Channel 接到真实 Bridge Kernel send/receive path；
4. 实现 Electron IPC adapter；
5. 实现真实 Unix Socket frame/auth/reconnect；
6. 增加真实跨进程 Inbound/Outbound 测试；
7. 实现真实 WebSocket adapter，并保持默认关闭；
8. 实现外部 A2A/MCP/Model adapters；
9. 完善 doctor/conformance；
10. 运行全量测试、资源测试、打包测试、真实 Electron 和外部 Agent 互操作。

每一步都必须保持：

```text
Agent ID ≠ Alias
Agent ID ≠ Model Profile
Session ID ≠ Channel Thread ID
Task ID ≠ Message ID
Channel ≠ Session Store
MCP/Model ≠ Full Agent
P3394 Bridge ≠ Legacy KSTAR Engine
```

---

## 9. 交接验证命令

```bash
cd /Users/sudai/Documents/CogSeed-Backend-P3394-Bridge

npm run test:js -- \
  test/main/features/p3394_bridge \
  test/static/p3394-kstar-deletion.test.ts \
  test/static/kstar-single-core.test.ts

npm run p3394:doctor -- --json
npm run typecheck
git diff --check origin/develop...HEAD
git status --short --branch
```

预期当前结果：

```text
17 个测试文件通过
47 个测试通过
typecheck 通过
diff check 通过
工作区干净
```

完整验收还需补：

```bash
npm test
npm run test:resources
npm run package:dev:mac
npm run verify:package:dev:mac
```

---

## 10. 最终交接语句

当前 CogSeed 已经具备完整 P3394 Bridge 的**标准模型、核心边界和可测试基础**，并且保留了现有 CogSeed Backend、Runtime、Group Chat、canonical KSTAR 和 Recall 的事实来源。

下一阶段的核心不是继续增加抽象文件，而是把当前 contract-first 实现逐步接到真实：

- Backend task/session/event；
- Electron IPC；
- Unix Socket；
- HTTPS/WebSocket；
- Peer Authentication；
- Remote Session；
- Artifact Integrity；
- Raymond/Hermes/Forge 互操作。

任何后续实现都必须优先维护本地 Agent 的身份、Session、Runtime、Credential、Agent Home 和 KSTAR/Recall 治理边界。
