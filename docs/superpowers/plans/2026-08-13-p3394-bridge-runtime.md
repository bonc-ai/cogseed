# CogSeed P3394 Bridge Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** 将 CogSeed 从内部 P3394 Lite/Backend 执行能力扩展为完整、可验证的 P3394 Bridge Runtime / Cognitive Cell，支持标准 Envelope、身份、Registry、Agent Home、Runtime Adapter、同机双向 Channel、网络 Channel、Inbound/Outbound、治理与 Conformance。

**Architecture:** Bridge 只负责 P3394 标准语义、映射、权限和通道，不复制现有 Backend/KSTAR 存储。现有 `features/p3394` 负责协议/admission/replay，`cogseed_backend` 负责 Session/Task/Event/Runtime 事实来源，`features/kstar` 与 Recall 负责学习治理；Bridge 通过适配器把这些边界统一起来。

**Tech Stack:** TypeScript、Electron main process、classic renderer/IPC、Vitest、现有 JSONL/路径沙箱/锁、Node IPC/Unix Socket、后续 HTTPS/WebSocket。

---

## 实施前置：隔离工作树

当前工作树 `dev/fix-skill-audit-recursion` 有未提交技能审计修改，不能在其上直接实施。

- [ ] 保存当前分支修改清单，不修改其内容：

```bash
git status --short
```

- [ ] 从最新 `origin/develop` 创建独立工作树和分支；不要覆盖当前未提交修改：

```bash
git fetch origin develop
git worktree add -b dev/p3394-bridge-runtime ../Mate-Backend-P3394-Bridge origin/develop
cd ../Mate-Backend-P3394-Bridge
npm install
```

- [ ] 确认基线：

```bash
npm run typecheck
npm run test:js -- test/static/p3394-kstar-deletion.test.ts test/static/kstar-single-core.test.ts
```

预期：类型检查通过，两个旧 P3394 KSTAR 删除边界测试通过。

---

## Phase 1：标准模型与 Bridge Kernel

### Task 1：定义 UMF Envelope 与标准错误

**Files:**
- Create: `src/main/features/p3394_bridge/envelope.ts`
- Create: `test/main/features/p3394_bridge/envelope.test.ts`
- Modify: `src/main/features/p3394/index.ts`

- [ ] 写失败测试，覆盖：缺失 `message_id/session_id/idempotency_key`、空 recipients、非法 kind/performative、payload part 超限、合法 text/json/resource/artifact/control、`reply_to` 保留和错误 Envelope。

```ts
it('normalizes a valid request envelope without changing identity fields', () => {
  const result = normalizeEnvelope(validRequest);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.envelope.sender.agent_id).toBe('agent-a');
});

it('rejects an envelope with an unknown performative', () => {
  expect(() => normalizeEnvelope({ ...validRequest, performative: 'stream' })).toThrow('unsupported_performative');
});
```

- [ ] 运行：

```bash
npm run test:js -- test/main/features/p3394_bridge/envelope.test.ts
```

预期：因模块不存在或校验缺失失败。

- [ ] 实现 `P3394MessageEnvelope`、`P3394AgentAddress`、`P3394PayloadPart`、`normalizeEnvelope()`、`makeErrorEnvelope()`；复用现有 ID 校验和大小限制，不把内部 Group Chat message 直接当 Envelope。

- [ ] 运行测试并确认通过；导出类型和函数。

- [ ] 提交：

```bash
git add src/main/features/p3394_bridge/envelope.ts src/main/features/p3394/index.ts test/main/features/p3394_bridge/envelope.test.ts
git commit -m "feat(p3394): add universal message envelope"
```

### Task 2：定义 Agent Identity、Manifest、Capability Profile

**Files:**
- Create: `src/main/features/p3394_bridge/identity.ts`
- Create: `src/main/features/p3394_bridge/manifest.ts`
- Create: `src/main/features/p3394_bridge/capability-profile.ts`
- Create: `test/main/features/p3394_bridge/identity-manifest.test.ts`

- [ ] 先写测试：alias 与 `agent_id` 不相等；重复 alias/identity 拒绝；Agent id 不可作为 model profile；Manifest 缺 runtime/capability 拒绝；合法 `cogseed-native`/`local-cli` 通过。
- [ ] 运行测试确认红灯。
- [ ] 实现稳定 identity 解析、Manifest schema 和 capability profile；identity 来源必须是主进程/Agent 配置，不能信任 Renderer。
- [ ] 运行：

```bash
npm run test:js -- test/main/features/p3394_bridge/identity-manifest.test.ts
npm run typecheck
```

- [ ] 提交：`feat(p3394): define agent identity and manifest contracts`。

### Task 3：实现 Peer/Alias Registry

**Files:**
- Create: `src/main/features/p3394_bridge/registry.ts`
- Create: `test/main/features/p3394_bridge/registry.test.ts`
- Modify: `src/main/features/cogseed_backend/paths.ts` only for existing safe path helper reuse if required.

- [ ] 先写测试：register/resolve/revoke、alias 冲突、identity mismatch、session-scoped alias 优先级、disabled peer 拒绝、registry 读写原子性和用户隔离。
- [ ] 运行红灯。
- [ ] 实现内存接口和持久化接口，持久化落到 Agent Home peer registry；不新增第二套 DB；所有路径走现有沙箱/原子写/锁。
- [ ] 运行 registry 测试和 typecheck。
- [ ] 提交：`feat(p3394): add local peer and alias registry`。

### Task 4：实现 Agent Home 逻辑视图

**Files:**
- Create: `src/main/features/p3394_bridge/agent-home.ts`
- Create: `test/main/features/p3394_bridge/agent-home.test.ts`
- Modify: `src/main/features/cogseed_backend/paths.ts` only to expose existing user-safe root resolution.

- [ ] 先写测试：每 uid/agent 隔离；session/artifact/checkpoint/audit/journal 路径安全；目录创建幂等；路径穿越、绝对路径、跨 uid 拒绝。
- [ ] 运行红灯。
- [ ] 实现逻辑目录映射，不迁移已有数据；Bridge 通过逻辑路径映射现有 Backend store，新增文件只用于 manifest/registry/audit/journal 等 Bridge 状态。
- [ ] 运行测试、`npm run typecheck`、`git diff --check`。
- [ ] 提交：`feat(p3394): add isolated agent home boundary`。

### Task 5：实现 idempotency、replay、audit 基础服务

**Files:**
- Create: `src/main/features/p3394_bridge/idempotency.ts`
- Create: `src/main/features/p3394_bridge/replay-protection.ts`
- Create: `src/main/features/p3394_bridge/audit-journal.ts`
- Create: `test/main/features/p3394_bridge/security-primitives.test.ts`

- [ ] 先写测试：重复 idempotency key 返回原 delivery；低/重复 epoch 拒绝；不同 sender 的相同 key 不冲突；audit 不记录 payload secret；原子写失败 fail closed。
- [ ] 运行红灯。
- [ ] 复用 `epoch-store.ts`、`sender-epoch-store.ts` 和现有日志脱敏规则，不复制旧 KSTAR 状态；实现有界 journal 和清理策略。
- [ ] 运行测试和 typecheck。
- [ ] 提交：`feat(p3394): add replay idempotency and audit primitives`。

### Task 6：组装 Bridge Kernel 与基础 Doctor

**Files:**
- Create: `src/main/features/p3394_bridge/bridge.ts`
- Create: `src/main/features/p3394_bridge/doctor.ts`
- Create: `test/main/features/p3394_bridge/bridge.test.ts`
- Create: `scripts/p3394-doctor.mjs`
- Modify: `package.json`

- [ ] 先写集成测试：注册本地 Agent、解析 peer、校验 envelope、执行 policy/idempotency/replay/audit 顺序；任何失败不创建 task。
- [ ] 运行红灯。
- [ ] 实现 Bridge Kernel 依赖注入接口：registry、agentHome、policy、audit、runtime adapter、channel registry；`p3394:doctor` 只读检查。
- [ ] 运行：

```bash
npm run test:js -- test/main/features/p3394_bridge/bridge.test.ts
npm run p3394:doctor
```

- [ ] 提交：`feat(p3394): assemble bridge kernel and doctor`。

---

## Phase 2：CogSeed Runtime Adapter 与生命周期

### Task 7：定义 Runtime Adapter Contract

**Files:**
- Create: `src/main/features/p3394_bridge/runtime-adapter.ts`
- Create: `test/main/features/p3394_bridge/runtime-adapter.test.ts`
- Modify: `src/main/features/cogseed_backend/runtime-controller.ts` only through an adapter wrapper, not by moving business logic.

- [ ] 先写测试：open/deliver/stream/resume/cancel/snapshot/close；native 和 local-cli 执行 kind；runtime error 转 UMF error；不把 agent_id 当 model profile。
- [ ] 运行红灯。
- [ ] 实现适配器，内部委托现有 `runtime-controller`、`session-store`、`task-store`、`event-store`；Backend admission 失败不写 visible handoff state。
- [ ] 运行测试、既有 runtime-controller/session/task 测试、typecheck。
- [ ] 提交：`feat(p3394): adapt cogseed backend runtime to bridge contract`。

### Task 8：Session/Task/Message 映射与 KSTAR close hook

**Files:**
- Create: `src/main/features/p3394_bridge/session-manager.ts`
- Create: `src/main/features/p3394_bridge/task-manager.ts`
- Create: `src/main/features/p3394_bridge/message-store.ts`
- Create: `src/main/features/p3394_bridge/kstar-close-hook.ts`
- Create: `test/main/features/p3394_bridge/session-task-lifecycle.test.ts`

- [ ] 先写测试：同一 session 多 task；不同 goal 隔离；message→task→session 关联；重启恢复；close 一次只触发一个 canonical KSTAR/Recall hook；proposed update 不自动 promotion。
- [ ] 运行红灯。
- [ ] 实现映射层，Backend 仍是 task/session 事实来源；KSTAR hook 只调用 canonical `features/kstar`/Recall，不读取旧 `p3394/kstar-*`。
- [ ] 运行 bridge lifecycle、KSTAR/Recall bridge、recovery tests。
- [ ] 提交：`feat(p3394): map bridge lifecycle to backend and kstar governance`。

---

## Phase 3：同机双向 Channel

### Task 9：Channel Adapter Contract 与 InProcess Adapter

**Files:**
- Create: `src/main/features/p3394_bridge/channel-adapter.ts`
- Create: `src/main/features/p3394_bridge/in-process-channel.ts`
- Create: `test/main/features/p3394_bridge/in-process-channel.test.ts`

- [ ] 先写测试：listen/dial/register/send/subscribe/cancel/close；未知 peer、identity mismatch、未授权 capability、重复 envelope、事件顺序、unsubscribe 和 backpressure 拒绝。
- [ ] 运行红灯。
- [ ] 实现 Channel contract；Channel 不创建独立 Session Store，send 只经过 Bridge Kernel → Runtime Adapter。
- [ ] 运行测试和 typecheck。
- [ ] 提交：`feat(p3394): add in-process channel adapter`。

### Task 10：Electron IPC Channel

**Files:**
- Create: `src/main/features/p3394_bridge/ipc-channel.ts`
- Create: `test/main/features/p3394_bridge/ipc-channel.test.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `src/main/preload.js`

- [ ] 先写测试：main handler allow-list、payload size limit、sender identity不可信、subscribe/unsubscribe、task event stream、cancel、close cleanup。
- [ ] 运行红灯。
- [ ] 实现薄 IPC adapter；业务逻辑仍在 Bridge/Backend，不放进 IPC handler；Renderer 只能调用，不得声明 Agent/Capability/uid。
- [ ] 运行 IPC 和 renderer shim tests。
- [ ] 提交：`feat(p3394): expose local bridge through guarded ipc channel`。

### Task 11：Unix Socket Channel

**Files:**
- Create: `src/main/features/p3394_bridge/unix-socket-channel.ts`
- Create: `test/main/features/p3394_bridge/unix-socket-channel.test.ts`
- Modify: `src/main/features/p3394_bridge/agent-home.ts` for socket path.

- [ ] 先写测试：同机 listener/dialer、frame boundary、authentication token、replay protection、disconnect/reconnect、slow peer、graceful close、socket path sandbox。
- [ ] 运行红灯。
- [ ] 实现 newline-delimited or length-prefixed JSON Envelope framing，明确最大 frame、queue 上限、超限关闭连接；复用 Bridge Kernel，不直接执行 Backend。
- [ ] 运行测试和 typecheck。
- [ ] 提交：`feat(p3394): add authenticated unix socket channel`。

### Task 12：Inbound/Outbound Agent APIs

**Files:**
- Create: `src/main/features/p3394_bridge/inbound.ts`
- Create: `src/main/features/p3394_bridge/outbound.ts`
- Create: `test/main/features/p3394_bridge/inbound-outbound.test.ts`

- [ ] 先写测试：外部 request 创建 session/task；已有 session resume；response/event/error；outbound alias resolution；remote cancel/reconnect；unsupported capability 拒绝。
- [ ] 运行红灯。
- [ ] 实现 Inbound Server 与 Outbound Client，所有调用都经过 registry/capability/policy/consent/audit；远程 identity 不因 endpoint failover 改变。
- [ ] 运行本机 InProcess/Unix Socket 双向集成测试。
- [ ] 提交：`feat(p3394): add inbound and outbound bridge APIs`。

---

## Phase 4：网络 Channel 与外部 Adapter

### Task 13：HTTPS/WebSocket Channel

**Files:**
- Create: `src/main/features/p3394_bridge/websocket-channel.ts`
- Create: `test/main/features/p3394_bridge/websocket-channel.test.ts`
- Modify: `src/main/features/p3394_bridge/channel-adapter.ts`

- [ ] 先写测试：TLS/auth、capability negotiation、reconnect、backpressure、artifact digest、remote error、graceful shutdown；默认未配置时不监听端口。
- [ ] 运行红灯。
- [ ] 实现显式 opt-in 的网络 Channel；默认 bind localhost/配置地址，认证失败 fail closed，限制 frame/queue/concurrency，保留 Agent identity。
- [ ] 运行测试和 typecheck。
- [ ] 提交：`feat(p3394): add opt-in websocket channel`。

### Task 14：A2A/MCP/Model Capability Adapters

**Files:**
- Create: `src/main/features/p3394_bridge/external-adapters.ts`
- Create: `test/main/features/p3394_bridge/external-adapters.test.ts`
- Modify: `src/main/features/cogseed_backend/messaging-capability-policy.ts` only for shared capability policy reuse.

- [ ] 先写测试：完整 Agent、Capability Node、Model Runtime 三种 profile 不混淆；未授权 endpoint 拒绝；MCP tool 不能伪装自治 Agent；remote disclosure policy 生效。
- [ ] 运行红灯。
- [ ] 实现 Adapter descriptor 和受限投影；不在本阶段引入任意远程 server/install UI。
- [ ] 运行测试、security tests、typecheck。
- [ ] 提交：`feat(p3394): model external capability adapters explicitly`。

---

## Phase 5：治理、Doctor、Conformance 与真实验收

### Task 15：扩展 `p3394 doctor`

**Files:**
- Modify: `src/main/features/p3394_bridge/doctor.ts`
- Modify: `scripts/p3394-doctor.mjs`
- Create: `test/main/features/p3394_bridge/doctor.test.ts`

- [ ] 先写测试：manifest/identity/alias/channel/UMF/session mapping/replay/idempotency/Agent Home/runtime resume/KSTAR hook/audit journal 每项输出 pass/fail/warn 和可操作 reason。
- [ ] 运行红灯。
- [ ] 实现稳定 JSON 和 human-readable 两种输出，失败退出码非 0，禁止 doctor 修改业务数据。
- [ ] 运行：`npm run p3394:doctor -- --json` 和普通模式。
- [ ] 提交：`feat(p3394): add bridge conformance doctor checks`。

### Task 16：完整 Conformance Suite 与删除证明回归

**Files:**
- Create: `test/main/features/p3394_bridge/conformance.test.ts`
- Create: `test/main/features/p3394_bridge/security-boundaries.test.ts`
- Modify: `test/static/p3394-kstar-deletion.test.ts` only if a new bridge path must be explicitly allowed.

- [ ] 先写端到端测试：Agent A→B request、同 session continuation、多 task、duplicate/replay、cancel/reconnect、artifact digest、approval、session close/KSTAR hook。
- [ ] 运行红灯。
- [ ] 实现最小缺口并确保 legacy P3394 KSTAR deletion proof 仍通过。
- [ ] 运行：

```bash
npm run test:js -- test/main/features/p3394_bridge
npm run test:js -- test/static/p3394-kstar-deletion.test.ts test/static/kstar-single-core.test.ts
```

- [ ] 提交：`test(p3394): add bridge conformance suite`。

### Task 17：完整验证与真实环境验收

**Files:**
- Update: `docs/superpowers/specs/2026-08-13-p3394-bridge-runtime-design.md`
- Create: `docs/research/2026-08-13-p3394-bridge-conformance.md`

- [ ] 运行：

```bash
git diff --check origin/develop...HEAD
npm run typecheck
npm test
npm run test:resources
npm run p3394:doctor -- --json
```

- [ ] 运行涉及 Runtime/打包时的验证：

```bash
npm run package:dev:mac
npm run verify:package:dev:mac
```

- [ ] 使用真实 Electron/CogSeed 验收：
  - 本机 Agent A 调用 Agent B；
  - 无 `@` follow-up 继续原 session；
  - 重复 envelope 不重复执行；
  - 取消和断线恢复不重放原请求；
  - artifact 只能按 digest/scope 访问；
  - session close 只生成一个 canonical KSTAR/Recall 治理入口；
  - 旧 P3394 KSTAR 运行路径没有重新出现。

- [ ] 记录已实现/部分实现/未实现/不适用矩阵和已知 develop 基线失败；不把未通过的全量测试写成通过。
- [ ] 提交：`docs(p3394): document bridge conformance and verification`。

---

## 全量验证命令

```bash
npm run typecheck
npm test
npm run test:resources
npm run p3394:doctor -- --json
npm run test:js -- test/main/features/p3394_bridge
npm run test:js -- test/static/p3394-kstar-deletion.test.ts test/static/kstar-single-core.test.ts
git diff --check origin/develop...HEAD
```

## 风险控制

- 不在当前带未提交技能审计修改的分支上实施；先使用独立 worktree。
- 每个 Task 先写红灯测试，再写最小实现。
- 所有 Channel 复用 Bridge/Backend，不复制业务存储。
- 网络 Channel 默认关闭，显式 opt-in。
- 远程 Adapter 默认最小权限，MCP/Model 不伪装成完整 Agent。
- 不恢复旧 P3394 KSTAR Engine，不新增旧兼容路由。
- 全量测试失败必须与纯 `origin/develop` 基线对比后归因。
