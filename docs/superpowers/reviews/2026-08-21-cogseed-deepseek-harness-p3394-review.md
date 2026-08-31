# CogSeed Creator Mode + P3394 交互设计复审说明

日期：2026-08-21  
基线：当前本地 `develop`，`defcd5f55aa7bd9fa2749fe80818eb9cf597a54b`  
范围：重新审查 DeepSeek Harness 的 Agent 创建/组合思想，以及它如何映射到 CogSeed 现有 Agent 与 P3394 Bridge。

关联设计：

- `docs/superpowers/specs/2026-08-21-cogseed-creator-mode-p3394-agent-to-agent-design.md`
- `docs/superpowers/plans/2026-08-21-cogseed-creator-mode-p3394-agent-to-agent-implementation.md`

上游参考：

- [DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md)
- [DeepSeek Harness Core subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md)
- [DeepSeek Harness Subagent subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md)
- [DeepSeek Harness Extensions subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/extensions.md)
- [DeepSeek Harness Agent Teams subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/agent-team.md)

---

## 1. 复审结论

原设计的方向是正确的，但对 DeepSeek Harness 的借鉴需要收紧：

> 我们要借鉴的是 **Agent 的组合、作用域、生命周期、事件事实源和可扩展边界**，不是把 DeepSeek Harness 搬进 CogSeed，也不是把 Creator Mode 做成一个可以动态安装和执行插件的系统。

本项目的正确落地方式应当是：

```text
Creator Mode = Agent 设计/验证控制面
CogSeed Agent = 现有 Agent 运行面
P3394 Bridge = 跨进程/跨主机传输与安全裁决面
```

三者不能合并成一个新运行时。

### 复审后的核心决策

1. **Creator Mode 不直接创建第二套 Agent Runtime。**
   它负责生成、验证和发布一个可审阅的配置/策略版本，最终通过现有 Agent 创建和更新能力 materialize。

2. **DeepSeek 的“Agent 创建”应理解为受作用域管理的运行时组合。**
   重点不是保存一份 JSON，而是创建一个拥有 session、prompt、tools、skills、policy 和 teardown 责任的 Agent 实例。

3. **P3394 不是 Creator 的插件，也不是普通 subagent。**
   P3394 是有身份、关系、能力、会话、epoch、重放和上下文边界的远程传输协议。Creator 只声明“允许调用哪个 peer 的哪个 capability”，不能直接控制网络连接。

4. **首版只做本地 Creator + 一对一远程请求。**
   不把 A→B→C、多方协作、动态远端插件、远程私有能力复制混入第一版。

5. **所有扩充继续建立在当前技术栈和当前代码边界之上。**
   新增模块和 IPC 可以有，但不引入新的 Agent 框架、新 P3394 协议栈、新数据库或新的 renderer 技术栈。

---

## 2. DeepSeek Harness 实际值得借鉴的部分

### 2.1 不是“创建一个配置”，而是“创建一个有所有权的 Agent”

DeepSeek Harness 的 core 设计把 Agent 创建与以下对象绑定：

```text
Agent
 ├─ session
 ├─ agent loop
 ├─ system prompt assembly
 ├─ scoped tool registry
 ├─ model/LLM seam
 ├─ initiator/owner scope
 └─ dispose / cancellation / teardown
```

它的关键思想是：

- 新 Agent 创建时就确定其作用域和依赖；
- setup 在 Agent 对外发布前完成；
- setup 失败时回滚，不发布半成品 Agent；
- 创建者持有 dispose 能力；
- provider 或 owner 卸载时，必须停止并清理它创建的 Agent；
- resume 不是重新拼一份配置，而是从持久化 session 恢复 Agent 身份和运行上下文。

这对 CogSeed 的直接启发是：

```text
Creator draft
  → scoped simulation
  → verification
  → approved materialization
  → existing Agent/session runtime
```

而不是：

```text
模型生成 JSON
  → 直接把 JSON 当作新 Agent 执行
```

### 2.2 “一切皆插件”不是“模型可以下载任意插件”

DeepSeek Harness 的“一切皆插件”指的是：模型适配器、工具注册表、session、agent loop、sandbox、approval、UI 等都通过宿主运行时的扩展点组合。

它不等于：

- 模型可以写任意 TypeScript；
- 模型可以执行任意 `import`；
- 模型可以从 URL 下载代码；
- renderer 可以加载远端 JavaScript；
- 任意插件都能获得文件系统、网络和凭证。

因此 CogSeed 只应允许 Creator 组合**已注册、已安装、可审计的能力引用**：

```text
capabilityId + version + configRef
```

其中 `configRef` 也必须是受控引用，不能是 URL、shell、import path 或 secret。

### 2.3 事件事实源和运行生命周期比 UI 更重要

DeepSeek Harness 的 session log、agent event 和 scoped services 说明：

- UI 不是运行事实源；
- 当前状态应从事件或持久化记录派生；
- resume、fork、dispose、cancel 都要有明确语义；
- 一个 Agent 的工具、prompt 和运行策略必须能追溯到其创建时的版本。

CogSeed 已有可复用基础：

- Agent JSON 持久化；
- session/session-store；
- skill registry；
- quality validation；
- P3394 protocol events；
- P3394 bridge session/task lifecycle；
- outbox、replay protection、event cursor 和 audit journal。

Creator 不应另起一套内存 Agent 管理器，而应把草案、验证和运行 receipt 作为现有运行面的补充事实记录。

---

## 3. CogSeed 当前实现与目标的关系

### 3.1 当前 Agent 创建路径

当前 CogSeed 已存在一条稳定的自定义 Agent 路径：

```text
renderer agent creation/edit UI
  → existing IPC
  → src/main/features/agents.ts
  → createCustomAgent / updateCustomAgent
  → <uid>/cloud/agents/<agentId>/agent.json
  → existing Agent dispatch/session runtime
```

当前 Agent 结构已经包含或支持：

- `agent_id`；
- `name`、双语 description；
- `workflow`；
- skills 引用；
- profile/knowhow/standards；
- runtime 配置；
- output format；
- interface contract；
- quality validation；
- enable/disable；
- runtime stats。

因此 Creator Mode 不应在运行期绕过 `src/main/features/agents.ts`，直接自己生成一个平行 Agent 数据格式并自行启动。

### 3.2 推荐的双层数据模型

Creator 可以新增自己的设计数据，但必须把它和现有 Agent 数据分层：

```text
CreatorDraft / CreatorPresetVersion
  ├─ 用户意图
  ├─ capability refs
  ├─ policy/approval
  ├─ P3394 peer/capability allow-list
  ├─ verification digest
  └─ provenance/audit

Materialized Agent
  ├─ agent.json
  ├─ workflow/skills/runtime
  └─ 由现有 agents.ts 负责读取和运行
```

推荐关系：

```text
CreatorPresetVersion
  ──materialize──> AgentRaw / existing custom agent
       └─ metadata: creatorPresetId, creatorVersion, manifestDigest
```

这样可以同时满足：

- Creator 有不可变版本、审批和回滚；
- 旧 Agent runtime 不被替换；
- 普通 Agent 继续使用原有路径；
- rollback 可以切换 Creator 的 active version，再决定是否更新对应 Agent spec；
- 已运行的 session 使用创建时 snapshot，不被新版本原地改变。

### 3.3 不建议让 Creator Manifest 取代 AgentRaw

`CreatorPresetManifestV1` 可以作为**创作和治理模型**，但不应成为第二个长期并行的运行 schema。

必须明确一个 materializer：

```ts
materializeCreatorPreset(
  userId: string,
  presetVersion: CreatorPresetVersion,
): Promise<{ agentId: string; manifestDigest: string }>;
```

materializer 负责：

1. 从 Creator store 读取 immutable version；
2. 重新解析 model、skills、tools、runtime 和 P3394 peer；
3. 调用现有 Agent schema/quality gate；
4. 写入已有 custom agent 路径；
5. 记录 `presetId/version/digest -> agentId` 的绑定；
6. 失败时不产生半成品 Agent；
7. 重新 materialize 时使用显式版本，不覆盖运行中的 session。

---

## 4. Creator Mode 与 P3394 的正确交互模型

### 4.1 Creator 创建的是“远程能力策略”，不是“远程 Agent 实例”

用户在 Creator 中输入：

> 创建一个只读研究 Agent，可以调用已批准的远程研究 Agent，预算 20 分钟，不允许写文件。

Creator 的输出应是：

```text
本地 Agent preset
  ├─ model: 已配置模型
  ├─ skills: 已安装研究 Skill
  ├─ tools: 已登记只读工具
  ├─ files: 只读 grant
  ├─ remote peers: [peer-researcher]
  ├─ remote capabilities: [handle_message / declared capability]
  ├─ speech acts: [query/request]
  ├─ max depth: 1
  ├─ max fan-out: 1
  ├─ approval: required
  └─ budget/timeout
```

它不输出：

- endpoint；
- bearer token；
- node key；
- 远程 Agent 的私有 skill 内容；
- 可执行代码；
- 任意网络地址。

### 4.2 P3394 交互链路

推荐链路如下：

```text
┌──────────────────────────────┐
│ Renderer                      │
│ Creator UI / Remote task UI   │
└──────────────┬───────────────┘
               │ typed IPC
┌──────────────▼───────────────┐
│ Main: Creator service         │
│ draft / verify / approval     │
│ materialized Agent policy     │
└──────────────┬───────────────┘
               │ internal service call
┌──────────────▼───────────────┐
│ Main: P3394 controller        │
│ relationship/capability       │
│ speech-act/context/epoch      │
└──────────────┬───────────────┘
               │ existing bridge APIs
┌──────────────▼───────────────┐
│ P3394 Bridge                  │
│ registry/session/task/outbox │
│ channel adapter/replay/audit  │
└──────────────┬───────────────┘
               │ approved channel
        Remote Agent B
```

### 4.3 发送前的固定裁决顺序

远程任务不能由 renderer 直接组装 P3394 envelope，也不能只因为用户选了 peer 就发送。

main 内部的固定顺序应为：

```text
feature flag
  → active Creator preset/version
  → manifest digest
  → local Agent policy
  → peer registry / identity
  → declared capability
  → relationship
  → speech act
  → context scope
  → budget / timeout / payload limit
  → approval binding
  → idempotency key / replay admission
  → P3394 session/task submit
```

任一环节失败都必须在产生网络副作用前失败。

### 4.4 P3394 入站请求不是首版 Creator 的必要闭环

设计文档原来同时讨论：

- 本地 Agent A 调远程 Agent B；
- 远程 Agent B 调本地 Agent A；
- A→B→C 多级委派；
- 双向流式恢复。

这些属于不同交付阶段：

| 能力 | 首版是否纳入 |
|---|---:|
| Creator 生成本地 Agent preset | 是 |
| 本地 Agent A → 远程 B 一对一请求 | 是 |
| 远程 B → 本地 A 入站执行 | 否，先保持现有 bridge 语义 |
| A→B→C 多级委派 | 否 |
| fan-out | 否 |
| 双向流式/断线 resume | 后续 P2 |
| 远程私有 Skill 复制 | 否 |

这样可以避免把“Agent 创建”和“远程入站执行”同时开放，降低权限升级和循环委派风险。

---

## 5. 现有 P3394 能力应如何复用

当前 P3394 实现已经具备多层约束，新增 Creator 交互不应另造同名概念。

### 5.1 协议层

复用：

- `P3394LiteManifest`；
- `P3394LiteMessage`；
- `P3394Relationship`；
- `P3394SpeechAct`；
- capability declaration；
- semantic block policy；
- delegation context；
- collaboration context；
- protocol normalization；
- `unknown_capability`、`speech_act_denied`、`semantic_block_violation` 等错误。

Creator 的 `allowedCapabilities` 必须映射到现有 capability declaration，而不是新增一套 `research.answer` 私有协议后绕过 `handle_message`。

### 5.2 Controller 层

复用 `P3394Controller` 的：

- session resolution；
- epoch 水位；
- replay detection；
- context scope check；
- message normalization。

Creator 只做调用前的 policy preflight；协议裁决仍由 P3394 controller 负责。

### 5.3 Bridge 层

复用现有：

- peer registry；
- identity/security；
- session manager；
- task manager；
- outbound hub/outbox；
- recovery controller；
- event cursor；
- channel adapters；
- audit journal；
- redaction/security boundary。

新增 remote task service 只能负责编排：

```text
Creator policy → P3394 request mapping → existing bridge → result/receipt projection
```

它不能重复实现：

- HTTP/WebSocket 拨号；
- endpoint 解析；
- token 管理；
- message authentication；
- replay protection；
- session state machine；
- task state machine。

### 5.4 状态映射

本地 Creator UI 可以提供更适合用户的状态，但必须映射到已有 P3394 生命周期：

| UI 状态 | P3394/本地含义 |
|---|---|
| `pending` | 请求已进入本地运行记录，尚未完成提交 |
| `accepted` | 远端任务被承接 |
| `working` | 远端任务执行中 |
| `input-required` | 远端要求补充输入 |
| `recoverable` | 传输中断，但任务可恢复 |
| `persisted` | 本地已经落盘结果或事件 |
| `completed` | 远程终态为 completed，且本地结果已保存 |
| `rejected` | 远程或本地 policy 拒绝 |
| `cancelled` | 取消已被本地/远程确认 |
| `failed` | 不可恢复失败 |

`transport connected` 不能显示成 `completed`。

---

## 6. 需要修改原实施方案的地方

### P0：增加“现有 Agent materializer”任务

在 schema/store 之后增加：

```text
Creator preset version
  → validate existing Agent compatibility
  → materialize through agents.ts
  → record binding and digest
```

建议文件：

```text
src/main/features/creator/materializer.ts
src/main/features/creator/agent-binding-store.ts
test/main/features/creator/materializer.test.ts
```

### P0：将 Creator 解释为控制面

`proposal-service.ts` 只生成 draft；
`simulation-service.ts` 只运行 mock/registered executors；
`lifecycle-service.ts` 只改变 Creator 版本状态；
`materializer.ts` 才能把批准版本写入现有 Agent 存储。

任何 Creator service 都不能自己启动一套长期 Agent loop。

### P1：将 P3394 adapter 改成现有协议映射

remote service 的输入应包含：

```ts
interface CreatorRemoteRequest {
  userId: string;
  presetId: string;
  presetVersion: string;
  agentId: string;
  peerId: string;
  capability: string;
  speechAct: 'request' | 'query';
  collaboration?: P3394CollaborationRef;
  contextSummary?: string;
  approvalRef: string;
  idempotencyKey: string;
}
```

service 内部生成的是现有 P3394 message/envelope，不向 renderer 暴露 envelope。

首版不把 `connect`、`createSession`、`resume` 设计成 renderer 直接控制的独立能力；由 main service 根据 registry 和运行策略完成。

### P2：流式恢复建立在现有 event cursor/outbox 上

不要新建第二套 `remote-agent-stream` 协议。使用现有：

- `event-cursor-store`；
- `outbound-outbox`；
- `recovery-controller`；
- `task-manager` recoverable 状态；
- channel adapter 的事件能力。

新增内容只应是 Creator remote run 的 projection、去重和 UI 适配。

### 安全：修正 peer 投影

继续保留原方案中的 endpoint 脱敏修复：

- main 保留 endpoint/token/identity 解析能力；
- renderer 只得到 peer id、显示名、能力摘要和连接状态；
- Creator manifest 只保存 peer id 和 capability id。

---

## 7. 复审后的端到端流程

### 7.1 创建本地远程研究 Agent

```text
1. 用户在 Creator UI 输入自然语言目标。
2. main inspect 读取已登记 model/skill/tool/peer 的脱敏元数据。
3. Creator model 只输出结构化 draft，不输出代码和网络地址。
4. schema 校验 draft：字段 allow-list、能力 registry、权限、预算、P3394 peer/capability。
5. simulation 在 disposable scope 运行注册能力/mock peer。
6. verification 生成 manifest digest 和报告。
7. 用户确认模型、skills、tools、peer、capability、预算、side effects。
8. lifecycle publish/activate Creator version。
9. materializer 通过现有 agents.ts 创建或更新 custom Agent。
10. 写入 preset-agent binding、audit 和 verification receipt。
```

### 7.2 本地 Agent 调用远程 Agent

```text
1. renderer 发起 creator.remote.send，只有 presetId、task、peerId/capability 选择和 approvalRef。
2. main 读取 active immutable preset，不信任 renderer 传来的 manifest。
3. main 检查 flag、preset digest、Agent binding 和 remote policy。
4. main 检查 peer identity、capability、relationship、speech act 和 context。
5. main 生成 idempotency key，建立/复用 P3394 session/task。
6. existing bridge 负责认证、通道、outbox、重放和恢复。
7. remote Agent B 的本地 bridge 执行自己的入站 policy 和 Agent runtime。
8. 本地 bridge 接收结果，先落盘再向上投影 completed。
9. Creator remote run 保存 receipt：preset、agent、peer、task、trace、digest、终态。
10. renderer 只看到脱敏状态和结果摘要。
```

### 7.3 远程 Agent B 的责任

远端不能因为收到一个 capability ref 就自动获得本地资源。远端 B 必须：

- 用自己的 Agent Card/manifest 声明能力；
- 用自己的 bridge 验证 sender identity；
- 按 relationship 和 speech act 检查请求；
- 按自己的本地工具、文件、网络和预算 policy 执行；
- 返回结构化 accepted/result/error；
- 不把 A 的权限当作 B 的权限。

---

## 8. 复审后的验收门槛

### Creator

- Creator 只生成受约束的 draft/manifest，不生成可执行代码；
- draft 必须通过现有 registry 和 Agent quality gate；
- approved version 才能 materialize 成现有 Agent；
- materialize 失败不产生半成品 Agent；
- Agent 运行时可以追溯到 preset/version/digest；
- dispose、cancel、rollback 不遗留 session、timer、listener 或临时 scope；
- 旧 Agent 创建、编辑、运行路径无回归。

### P3394

- Creator 不直接组装 renderer 可发送的 envelope；
- `allowedCapabilities` 必须映射到 P3394 capability declaration；
- relationship、speech act、semantic block、context scope、epoch 和 replay 检查仍由现有 P3394 层执行；
- session/task/outbox/recovery 不重复实现；
- 一对一请求中明确区分 accepted、working、persisted、completed、rejected、recoverable；
- endpoint/token/header 不出 main；
- 远程结果有 preset/agent/peer/task/trace/digest 绑定；
- feature flag 关闭时旧 `p3394.external.*` 与普通 Agent 继续工作。

### 技术栈

- 不替换 Electron、TypeScript main、vanilla JS renderer、IPC/preload、JSON/JSONL、现有模型客户端和 P3394 Bridge；
- 允许新增 service、storage、IPC、UI 和 tests；
- 不新增另一套 Agent runtime、另一套 P3394 protocol 或新网络服务。

---

## 9. 最终判断

这项功能可以做，但正确的实现顺序不是“把 DeepSeek Harness 搬进 CogSeed”。正确顺序是：

```text
先利用 DeepSeek 的组合/作用域/生命周期思想
  → 再使用 CogSeed 现有 Agent schema/runtime
  → 最后把远程能力接到现有 P3394 Bridge
```

最重要的工程约束是：

> Creator 负责设计和批准；CogSeed Agent 负责执行；P3394 Bridge 负责远程传输和安全裁决。任何一层都不越权替代另一层。

