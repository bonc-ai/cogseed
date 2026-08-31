# CogSeed Agent 创造模式与 P3394 远程 Agent ↔ Agent 设计

**状态：** 提取版设计草案（待评审）  
**日期：** 2026-08-21  
**范围：** 从 renderer 重写设计中抽取 Agent 创造模式和 P3394 远程通信设计，形成可独立评审、排期和回滚的产品/架构文档。  
**关联文档：**

- `docs/superpowers/specs/2026-08-19-renderer-full-rewrite-migration-design.md`
- `docs/superpowers/plans/2026-08-19-renderer-full-rewrite-implementation.md`
- `p3394-gateway/docs/P3394_Local_Bridge_SDK_Design(1).md`

**外部借鉴：** DeepSeek Harness 官方开发者预览及其公开的 core/agent、plan 文档。本文只借鉴可验证的架构思想，不复制实现、品牌、源码或未批准的 API。

---

## 1. 决策摘要

CogSeed 增加一个独立的 **Agent 创造模式（Creator Mode）**，让用户通过自然语言描述目标，由一个受约束的 Creator Agent 检查当前运行时和能力目录，在隔离环境中组合能力，并生成可审阅、可测试、可版本化的 Agent preset。

Creator Mode 不直接修改生产中的 Agent，也不允许模型任意改写主进程或实时注入未批准的工具。它产出的是一个可回滚的 **Preset Manifest + 验证报告 + 审计轨迹**。

P3394 负责把本地 Agent A 与远程 Agent B 连接起来。它采用 locality-first 的 Bridge Runtime：每个 Agent 的会话、身份、凭证、资源和策略仍由其所在主机上的本地 bridge 掌管，网络层只负责经批准的消息传递和路由。

两者的关系是：

```text
Creator Mode
    ├─ 组合本地能力，生成 Agent preset
    ├─ 选择允许的远程能力/Peer policy
    └─ 通过 P3394 调用或委派给远程 Agent

本地 Agent A
    ↓ typed IPC（仅 renderer → main）
main / P3394 Bridge Runtime
    ↓ approved channel adapter
远程 Agent B / 另一台 CogSeed
```

本设计不把 Creator Mode 或 P3394 偷渡进 renderer 全量重写；二者都有独立的 feature flag、契约快照、测试和回滚点。

---

## 2. 借鉴 DeepSeek Harness 的原则

### 2.1 借鉴范围

DeepSeek Harness 对 CogSeed 最有价值的不是某个 UI，而是以下可迁移的设计原则：

| DeepSeek Harness 的原则 | CogSeed 的采用方式 |
|---|---|
| Agent = Model + Harness | 把 CogSeed Agent 定义为模型、能力包、会话/记忆、工具策略、运行循环和资源边界的组合，而不是只有一个模型配置 |
| 一切皆插件 | 将模型适配器、工具、Skill、上下文、记忆、会话、沙箱、循环、调度、UI 投影和 P3394 connector 视为可组合能力；保持现有 main/features 的权威边界 |
| 配置层组合 | 用不可变的 `PresetManifest` 选择、替换和扩展能力，不要求用户先修改核心代码 |
| 运行时可检查 | Creator Agent 可以读取已注册能力的元数据、依赖、版本、权限和健康状态，但不得读取秘密值 |
| 内存中试验 | 新组合先在 disposable scope / sandbox 中装载和验证，未发布前不影响运行中的 Agent |
| 运行可追踪 | 以 append-only trajectory/session event 作为运行事实源，恢复、分叉、回放、审计和 UI 投影都从事件流派生 |
| Agent 生命周期有 owner | 创建、resume、dispose、取消和 provider unload 都要有明确的所有权和终止语义 |
| 委派不塞进核心 Agent 方法 | 远程委派由 P3394 transport/provider 负责；本地 Agent 核心只暴露受约束的任务/消息入口 |

DeepSeek Harness 官方描述了“模型、工具、技能、会话、沙箱、存储、循环、调度、UI 均由插件组合”的方向，并把创造模式定义为运行时检查、插件实验和自定义 preset 创作能力。CogSeed 采用这些原则，但会把权限、用户确认、审计和远程副作用审批做成强制边界，而不是依赖模型自律。

### 2.2 不照搬的部分

以下内容明确不直接照搬：

- 不把 CogSeed 的 Electron `main/preload` 改为 DeepSeek Harness 的插件运行时。
- 不在 renderer 中加载任意第三方插件或执行远程下载的代码。
- 不允许 Creator Mode 直接取得 bearer token、node key、文件系统根目录或任意网络出口。
- 不把“能生成 preset”解释为“能生成任意可执行程序”。
- 不用一次性的内存状态替代 CogSeed 的 durable session、asset、audit 和 approval 记录。
- 不把 P3394 的多 Agent 协作误认为普通 subagent 调用；跨进程、跨主机必须显式建模身份、会话、权限和交付语义。

---

## 3. Agent 创造模式

### 3.1 产品目标

用户可以这样描述目标：

> 创建一个只读研究 Agent：使用指定模型和研究 Skill，可以检索本地知识库和已批准的远程 Agent；禁止修改文件，单次预算 20 分钟；输出带来源的研究报告。

Creator Mode 应完成：

1. 解释目标和缺失约束；
2. 检查当前可用能力、版本、依赖和权限；
3. 提出一个 preset 草案；
4. 在隔离 scope 中装载并试运行；
5. 用 fixtures / golden tasks 验证行为；
6. 展示权限、成本、远程副作用和降级路径；
7. 经用户批准后生成不可变版本；
8. 支持启用、停用、回滚、复制和继续编辑。

### 3.2 Creator Mode 的五个子阶段

```text
Inspect → Compose → Simulate → Verify → Publish
```

#### Inspect

读取：

- 已安装能力和 provider；
- capability pack / Skill / tool manifest；
- 依赖关系和兼容矩阵；
- 沙箱、文件、网络、模型和预算策略；
- P3394 peer 的 Agent Card 摘要和当前连接状态。

不读取：

- API key、bearer token、node key；
- 未授权文件内容；
- 远程 Agent 的私有 session；
- 任何未通过权限检查的秘密或个人数据。

#### Compose

Creator Agent 将用户意图转为 `PresetManifest`。每个能力必须通过 registry 解析，禁止在 manifest 中写入任意 import 路径、shell 字符串或未注册 URL。

#### Simulate

在一次性 scope 中：

- 装载候选插件/能力；
- 运行最小 smoke task；
- 观察工具调用、上下文注入、预算消耗和错误；
- 允许失败后卸载并重新组合；
- 不写入生产 session，不修改全局 registry。

#### Verify

使用固定 fixtures、golden tasks 和 policy tests 检查：

- 工具白名单是否生效；
- 不允许的文件、网络和副作用是否被拒绝；
- 输出格式和来源是否符合要求；
- 预算、超时和取消是否可控；
- 远程调用是否只访问声明的 peer/capability；
- 恢复、重放和审计记录是否完整。

#### Publish

发布不是覆盖更新，而是创建新版本：

```text
Draft → Sandboxed → Verified → Approved → Published → Active
                                      ↘ Rejected
Published / Active → Disabled / RolledBack
```

`Active` 切换必须是原子的；运行中的 Agent 保持旧版本的 snapshot，下一次新建或显式 reload 才采用新版本。

### 3.3 Preset Manifest

以下是逻辑模型，实际 schema 需在 Creator Mode P0 冻结：

```ts
interface PresetManifest {
  presetId: string
  version: string
  parentVersion?: string
  displayName: string
  description: string

  model: {
    providerId: string
    modelId: string
    reasoningProfile?: string
  }

  capabilities: Array<{
    capabilityId: string
    version: string
    configRef?: string
  }>

  prompt: {
    systemSections: string[]
    locale?: string
  }

  runtime: {
    sessionPolicy: string
    memoryPolicy: string
    loopPolicy: string
    sandboxProfile: string
    timeoutMs: number
    budget: { maxCost?: number; maxTokens?: number }
  }

  permissions: {
    tools: string[]
    files: string[]
    networkPeers: string[]
    sideEffects: string[]
    approvalMode: 'always' | 'on-risk' | 'preapproved'
  }

  remote?: {
    allowedPeers: string[]
    allowedCapabilities: string[]
    delegation: {
      maxDepth: number
      maxFanout: number
      requireApproval: boolean
    }
  }

  provenance: {
    createdBy: 'user' | 'creator-agent'
    sourceSessionId: string
    sourceAssetRefs: string[]
    verificationRunId?: string
  }
}
```

约束：

- manifest 只保存引用、声明和受控配置，不保存秘密；
- `capabilityId + version` 必须可解析且可审计；
- `networkPeers` 必须是已登记 peer id，不接受任意 URL；
- `sideEffects` 和 `approvalMode` 必须显式存在；
- preset 版本发布后不可原地修改；
- 删除/停用不删除历史轨迹和审计记录。

### 3.4 Creator Agent 的能力面

Creator Agent 自身应是一个受限 preset，而不是系统超级用户。建议能力分为：

| 能力 | 作用 | 默认权限 |
|---|---|---|
| `creator.runtime.inspect` | 查看运行时和能力目录 | 允许，脱敏 |
| `creator.capability.search` | 查找 Skill、工具、资产和 connector | 允许，按 registry |
| `creator.preset.propose` | 生成 manifest 草案 | 允许，不发布 |
| `creator.plugin.simulate` | 在 disposable scope 试验组合 | 允许，隔离 |
| `creator.fixture.run` | 执行验证任务 | 允许，预算限制 |
| `creator.preset.publish` | 创建版本并请求启用 | 必须用户确认 |
| `creator.preset.rollback` | 回滚到已验证版本 | 必须用户确认或管理员策略 |
| `creator.remote.request` | 访问 P3394 远程 Agent | 默认关闭，显式授权 |

### 3.5 与 CogSeed 资产体系的关系

Creator Mode 不重新发明 Skill、memory、knowledge base 和 capability-pack：

- preset 通过 `asset_id + version` 引用已确认资产；
- capability-pack 仍采用“引用优先”，不复制私有内容；
- verification run 生成 `ContextReuseReceipt` / audit receipt 等传递和验证证明；
- 远程 Agent 只接收获准的 capability reference、任务和上下文摘要；
- 远程执行结果回写本地时，保留来源 Agent、session、task、版本和证明链。

---

## 4. P3394 远程 Agent ↔ Agent

### 4.1 运行边界

P3394 Bridge Runtime 与本地 Agent 组成一个 Agent Execution Boundary：

- 本地 bridge 是身份、会话、资源和策略的权威；
- outbound adapter 负责连接远程 peer；
- inbound listener 负责接收经过认证的远程请求；
- gateway 可以转发、路由和发现，但不能代替远程 Agent 所在主机的本地 bridge；
- renderer 只能调用 typed IPC，不能接触网络凭证或协议细节。

### 4.2 远程对象和能力模型

第一版支持两类远程对象：

1. 另一台 CogSeed 上的已登记 Agent；
2. 具备兼容 P3394/A2A binding 的外部 Agent。

每个 peer 必须有可验证的 Agent Card 摘要：

```ts
interface PeerDescriptor {
  peerId: string
  displayName: string
  endpointRef: string
  identity: { method: string; fingerprint: string }
  capabilities: string[]
  protocolVersions: string[]
  features: {
    streaming: boolean
    resume: boolean
    artifacts: boolean
    multiParty: boolean
  }
  policy: {
    acceptsDelegation: boolean
    requiresConsent: boolean
    maxPayloadBytes: number
  }
}
```

`endpointRef` 只能由 main/features 解析，renderer 和 preset manifest 不直接保存可拨号秘密 URL。

### 4.3 P3394 消息包络

```ts
interface P3394Message {
  specVersion: string
  messageId: string
  sessionId: string
  taskId?: string
  sender: { peerId: string; agentId: string }
  recipients: Array<{ peerId: string; agentId: string }>
  replyTo?: string
  parentTaskId?: string
  idempotencyKey: string
  traceparent?: string

  kind: 'request' | 'event' | 'ack' | 'cancel' | 'result' | 'error'
  sequence?: number
  cursor?: string
  payload: Array<{
    type: 'text' | 'json' | 'artifact-ref' | 'capability-ref'
    value: unknown
  }>

  policy: {
    delegatedBy?: string
    expiresAt?: string
    maxCost?: number
    maxDurationMs?: number
    approvalRef?: string
  }
}
```

不承诺 exactly-once。默认采用“至少一次传输 + 接收端幂等 effect”语义；每个 effect 必须使用 `idempotencyKey` 或等价的去重键。

### 4.4 会话和任务生命周期

```text
Peer discovered
  → Identity verified
  → Session created
  → Task submitted
  → Accepted / Rejected
  → Events or Result
  → Ack / Persist
  → Completed / Cancelled / Failed
  → Session resumed or closed
```

必须区分：

- transport connected：网络连接存在；
- session open：双方已建立会话；
- task accepted：远程 Agent 已承接任务；
- result persisted：本地已持久化结果；
- task completed：远程已声明终态。

网络连接成功不能被当作任务成功，远程拒绝不能伪装成普通文本回复。

### 4.5 三阶段交付

| 阶段 | 目标 | 验收范围 |
|---|---|---|
| P0 | 协议、身份和 threat model | envelope、Agent Card、凭证边界、错误码、审计和权限 |
| P1 | 单 Agent 请求/响应 | A 选择 B、建 session、发送 task、接收结果、持久化、取消和失败 |
| P2 | 双向流式与恢复 | event、ack、cursor、resume、outbox、retry、顺序和幂等 |
| P3 | 多 Agent 委派与协作 | A→B→C、fan-out、循环/深度限制、预算、审批和全链路审计 |

P1 不能宣称“完整 Agent ↔ Agent 协作”；它只是可靠的一对一远程任务通道。

### 4.6 Renderer IPC 边界

新增 IPC 必须是增量命名空间，建议能力名如下：

```text
p3394.agent.listPeers
p3394.agent.connect
p3394.agent.disconnect
p3394.agent.createSession
p3394.agent.send
p3394.agent.cancel
p3394.agent.resume
p3394.agent.subscribe
```

确切 channel、payload、preload allow-list 和 contract snapshot 必须由 P3394 P0 单独审批。不得修改既有 427 个 renderer IPC channel 的语义。

renderer 允许看到：

- peer 的脱敏显示信息和连接状态；
- session/task 状态；
- 事件流和结果摘要；
- 需要用户确认的权限提示。

renderer 不允许看到：

- bearer token、node key、私钥；
- 任意 endpoint；
- 原始认证 header；
- 未脱敏审计细节；
- 可绕过 main 的网络控制句柄。

---

## 5. Creator Mode 与 P3394 的联合场景

### 5.1 创建“远程研究协作者” preset

1. 用户在 Creator Mode 描述目标、模型、Skill、预算和远程协作要求。
2. Creator Agent 检查本地能力目录和已登记 P3394 peers。
3. 系统生成 preset manifest：只允许 `peer-researcher`，只允许 `research.answer`，最大委派深度 1，必须用户确认。
4. 在 sandbox 中用 mock peer 验证：拒绝未声明能力、超时、重复提交、取消和结果落盘。
5. 用户查看 capability、数据范围、费用和副作用后批准。
6. 系统发布 `preset@version`，但不自动启用远程网络权限。
7. 用户首次调用时确认远程 Agent B；main 通过 P3394 创建 session 并发送 task。
8. 结果写入本地 conversation projection，并附带 peer、task、preset、trace 和 audit receipt。

### 5.2 远程 Agent 请求本地 Agent

入站请求必须先经过：

```text
P3394 bridge
  → identity/authentication
  → peer and capability policy
  → consent/approval policy
  → budget and rate limit
  → local Agent session
  → result envelope
```

远程 Agent 不能通过 P3394 直接命令 renderer、访问任意本地文件或启动未声明的副作用。

### 5.3 跨 Agent 能力传递

Creator Mode 生成的能力包可以通过 P3394 传递给远程 Agent，但只传递：

- `asset_id + version`；
- 允许的 capability refs；
- 最小上下文摘要；
- 适用范围和过期时间；
- `ContextReuseReceipt` / audit receipt 引用。

默认不复制私有 Skill 内容、API key、完整聊天历史或本地知识库。远程 Agent 是否能解析这些引用，由它自己的 registry 和策略决定。

---

## 6. 安全与治理不变量

### 6.1 Creator Mode

- 创建和发布分离；
- sandbox 与生产运行时分离；
- preset 版本不可变；
- 任何网络、文件写入、外部发送和付费操作都必须显式声明；
- Creator Agent 无法授予自己新的权限；
- 插件来源、版本和依赖必须可追踪；
- 所有验证失败、用户拒绝和回滚都保留审计记录。

### 6.2 P3394

- peer identity pinning 和 Agent Card 能力校验；
- 凭证仅存在 main/features 或 bridge secure store；
- message authentication、replay protection、idempotency；
- timeout、cancel、retry/backoff、outbox、ack 和 resume；
- payload、附件、成本、时间、fan-out 和 delegation depth 限制；
- 循环检测和人工审批；
- 断线/退出时清理 socket、timer、listener 和未完成句柄；
- 原始网络错误、认证失败、协议不兼容和远程拒绝必须有独立错误状态。

---

## 7. 验收门槛

### Creator Mode

- 能从自然语言目标生成合法 `PresetManifest`；
- 未注册能力、任意 URL、秘密和越权权限会被拒绝；
- sandbox 试验不会污染生产 session/registry；
- fixture/golden task 能验证工具、预算、超时、取消和副作用策略；
- preset 发布、启用、停用、复制和回滚可审计；
- 同一 preset 版本在恢复和重启后行为一致。

### P3394

- P0：协议和安全 schema 有评审记录；
- P1：一对一远程 Golden Path 通过，并覆盖拒绝、认证失败、超时、不可达、取消和重复提交；
- P2：流式事件可 ack、恢复、去重和重排验证；
- P3：委派链、循环检测、预算、权限和审计通过故障注入；
- 现有 427 个 IPC channel 无语义变化；新增 P3394 IPC 有独立 contract diff；
- renderer 不直接访问网络或秘密；
- P3394 可独立关闭，关闭后本地 Agent 和旧 external-agent 路径仍可用。

---

## 8. 与 renderer 重写的关系

本设计只依赖 renderer 重写建立的 typed IPC/ownership 基础，不依赖 React 组件直接实现网络能力。

- Creator Mode UI 可以在 Phase 2/3 迁移，但 Creator runtime 仍属于 main/features；
- P3394 可以与 renderer Phase 1/2 并行，但使用独立提交和 flag；
- renderer Phase 3 清理 legacy 时不得删除 P3394 所需的 main bridge；
- P3394 新 IPC 必须增量加入 contract snapshot，不得修改现有 427 个调用点；
- Creator Mode、P3394 和 renderer rewrite 各自具备独立回滚门。

---

## 9. 设计取舍

| 选项 | 决策 | 原因 |
|---|---|---|
| 让 Creator Agent 直接修改生产插件 | 不采用 | 不可审计、不可回滚，且容易形成权限升级通道 |
| 只保存当前 preset JSON，不保存运行轨迹 | 不采用 | 无法解释、恢复、分叉或审计 Agent 行为 |
| renderer 直连 P3394 | 不采用 | 暴露凭证和网络边界，绕过 main 的权限与审计 |
| P3394 先做完整多 Agent 图 | 不采用 | 先验证 P1 请求/响应，再逐步加入流式和协作语义 |
| 复制全部 Skill/知识库到远端 | 默认不采用 | 数据泄露和版本漂移；优先传引用和最小上下文 |
| exactly-once 作为协议承诺 | 不采用 | 跨网络难以保证；采用至少一次传输 + 幂等 effect |

---

## 10. 待评审问题

1. Creator Mode 首个可发布的 preset 类型是“研究 Agent”、 “工作流 Agent”还是“远程协作 Agent”？
2. CogSeed 的 plugin/capability registry 是否允许第三方动态安装，还是只允许签名 marketplace 包？
3. P3394 首版远程对象是否只支持另一台 CogSeed，再扩展到外部 A2A Agent？
4. 远程 Agent 入站任务的默认审批策略是每次确认、按 peer 预批准，还是按 preset policy？
5. `PresetManifest` 是直接复用现有 agent marketplace schema，还是增加独立的 preset schema？
6. 是否要求所有远程结果必须生成 `ContextReuseReceipt` 和 `audit-receipt`？

---

## 11. 外部参考

- DeepSeek Harness 官方介绍：`https://deepseek.com/harness/`
- DeepSeek Harness core/agent 设计：`https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/core.md`
- DeepSeek Harness plan mode 设计：`https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/plan.md`
- CogSeed P3394 Local Bridge SDK 设计：`p3394-gateway/docs/P3394_Local_Bridge_SDK_Design(1).md`
