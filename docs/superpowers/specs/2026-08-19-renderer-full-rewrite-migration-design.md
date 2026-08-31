# CogSeed 渲染层全量重写 · 迁移方案（vanilla → React 18 + Vite + TypeScript）

- 初稿日期：2026-08-19
- 修订日期：2026-08-20
- 基线：`defcd5f5`（develop）
- 修订时仓库状态：本地 `develop` 位于该基线，并落后 `origin/develop` 137 个提交；实施前必须明确继续冻结基线还是更新基线并重生成全部快照
- 状态：设计修订稿（Review；满足 §2.4 前不得开始框架接入）
- 决策：以 React 18 + Vite + TypeScript 重写渲染层，但必须先冻结 IPC、建立 legacy 行为基线并取得仓库架构例外
- 上游目标：渲染层全量组件化；当前迁移阶段保持 main/preload/既有 IPC 行为零变化；每个迁移切片可独立验收和回退
- 后续能力：通过 P3394 实现远程 Agent ↔ Agent 通信；该能力作为独立后续轨道，不与 renderer 重写混成一个不可回滚提交
- 目标读者：Tech Lead、前端负责人、参与迁移和验收的工程师
- 独立抽取设计：`docs/superpowers/specs/2026-08-21-cogseed-creator-mode-p3394-agent-to-agent-design.md`（Agent 创造模式 + P3394 远程 Agent ↔ Agent）

---

## 0. 摘要

CogSeed 当前 renderer 是经典 HTML/CSS/JavaScript：`src/renderer/` 下共有 95 个 JavaScript 文件，其中 89 个一方模块、6 个 vendor 文件；总计约 79,381 行，入口包含 68 个顺序敏感的 `<script>`，并有约 1,965 处直接 DOM 查询调用。

基线 `defcd5f5` 上，通过 TypeScript AST 可识别出 427 个 `window.cogseed.invoke/stream` 调用点：

- 398 个静态 channel 调用；
- 29 个动态 channel 调用；
- 分布在 51 个一方 renderer 模块；
- 273 个唯一静态 channel，其中 269 个 invoke、4 个 stream。

本次迁移只改变 renderer 的组织和消费方式，不改变：

- `src/main/**` 业务行为；
- `src/main/preload.js` 暴露的 `window.cogseed` API；
- channel 名称、payload、返回值、错误和 stream 生命周期语义；
- 用户数据格式和持久化路径。

迁移采用“同页并存、功能互斥”的模式：React 根与 legacy script 可以同时装载，但同一个功能在任意时刻只能由一个 runtime 拥有。所谓 A/B 或双跑，仅表示用相同 fixture 分别启动 legacy 与 React 路径进行比较，禁止两套实现同时处理同一个用户事件或订阅同一个 stream。

---

## 1. 目标、非目标与硬约束

### 1.1 目标

1. 将 renderer 重写为 React 18 + TypeScript `strict:true`。
2. 使用 Vite 管理 renderer 依赖图，最终移除 68 个手工排序的 script。
3. 冻结 IPC 行为契约，并以静态清单、手工类型和运行时 characterization 三层验证。
4. 先建立 legacy 行为基线，再按功能域逐块迁移。
5. 每次提交只迁移一个可独立验收、可独立回退的 feature slice。
6. macOS 和 Windows 的源码运行、生产构建、打包运行均可验证。

### 1.2 非目标

- 不修改 main 业务逻辑或 IPC handler。
- 不在本次 renderer 重写中直接实现远程 Agent ↔ Agent 通信；P3394 远程通信按第 6.5 节的独立能力轨道实施。
- 不让 renderer/React 直接建立 HTTP、WebSocket、A2A 或 P3394 网络连接。

- 不修改 `src/main/preload.js` 的 renderer-visible contract。
- 不借迁移顺便修复 legacy 行为；发现历史 bug 时单独立项。
- 不修改用户数据格式。
- 不在 React 组件里调用 legacy DOM 函数。
- 不引入 HTTP 服务或占用本地端口。
- 不在迁移提交里升级无关依赖、替换 vendor 或重做视觉设计。

### 1.3 “main 零改动”的精确定义

本方案中的 main 零改动是指：

- `src/main/**` 的运行时行为不改；
- `src/main/preload.js` 不改；
- main IPC channel、校验、返回和 stream 行为不改；
- Electron 继续通过 `win.loadFile(.../renderer/index.html)` 加载同一个入口。

允许修改 renderer 构建相关文件，如 `package.json` scripts、Vite 配置和打包前校验脚本，但不得改变 Electron 安全模型、preload 或 load target。

### 1.5 P3394 远程 Agent 通信的产品目标与边界

未来 CogSeed 需要支持本地 Agent 与远程 Agent 之间的可审计、可恢复通信：

```text
本地 Agent A / CogSeed
    ↓ typed IPC（renderer 只负责意图、状态和展示）
main: p3394.agent.*
    ↓ P3394 channel adapter（A2A / WebSocket / 其他已批准 binding）
远程 Agent B / 另一台 CogSeed
```

目标分三层交付，不把“远程调用”误认为“完整 Agent ↔ Agent 协作”：

1. **单 Agent 请求/响应**：A 创建会话并向 B 发送一条任务，B 返回结果。
2. **双向流式会话**：支持增量事件、完成、取消、断线重连、cursor/resume、幂等和 outbox。
3. **多 Agent 协作**：支持委派链、多个收件人、能力与权限、循环检测、预算和人工审批。

协议层必须保留并审计以下身份和关联字段：

- `spec_version`、`message_id`、`session_id`、`task_id`；
- `sender`、`recipients`、`reply_to`；
- `idempotency_key`、`traceparent`；
- payload parts、能力声明、错误/取消/完成状态。

硬边界：

- 远程网络、token、Agent Card、P3394 envelope、重试、恢复和进程生命周期全部属于 main/features，不属于 React 组件。
- renderer 只通过新增的具名 `p3394.agent.*` IPC 使用该能力；不得直接读取 bearer token 或拼接任意远程 URL。
- 本次 renderer 重写冻结现有 427 个 IPC 调用面；未来新增 P3394 IPC 必须显式更新契约、schema、preload allow-list 和测试，不能修改既有 channel 的语义。
- 默认采用“明确用户发起 + 明确目标 Agent + 可见权限/连接状态”；未经批准不得允许远程 Agent 隐式触发本地副作用。
- P3394 远程通信必须支持降级为不可达/拒绝/超时/取消等明确状态，不能把网络失败伪装成普通 Agent 回复。

### 1.4 每次提交的原则

每个迁移提交必须满足：

- 先有 legacy characterization test；
- 新旧实现由同一个 feature flag 互斥；
- React unmount 和 legacy dispose 都能清理 listener、timer、observer、stream 和第三方实例；
- IPC contract diff 为零，或只减少已迁移的 legacy 直调 allowlist；
- 开发构建和生产构建均通过；
- 纯函数迁移不夹带行为变化；
- 回退上一提交不需要数据迁移。

---

## 2. 技术与治理决策

### 2.1 技术栈

| 项 | 选择 | 约束 |
|---|---|---|
| 组件框架 | React 18 | 版本写入 lockfile；迁移期不跨 major 升级 |
| 构建 | Vite 6 | 使用 `vite build --watch`，不启动 dev server |
| 语言 | TypeScript | `src/renderer-app/` 独立 `strict:true` |
| 测试 | Vitest + Testing Library | 复用现有 Vitest；新增依赖须先审批 |
| E2E | Playwright Electron | Golden Path 为 Phase 1 前强制门槛，不再是可选项 |
| 状态 | React Context + 项目批准的轻量 store | 在 Phase 0 锁定，不允许各域自行选库 |
| 样式 | legacy CSS + CSS Modules | React 根命名空间、portal 和 z-index 必须统一 |
| vendor | 保持现有 DOMPurify/xterm/MathJax 等 | 迁移阶段不升级、不改逻辑 |

### 2.2 无 HTTP 开发模式

仓库边界明确“不使用 HTTP server、不占端口”，因此不采用 Vite dev server。开发路径为：

1. `vite build --watch --config vite.renderer.config.ts`；
2. 输出到 `src/renderer/generated/renderer-app/`；
3. `src/renderer/index.html` 以固定入口名加载 `renderer-app.js`；
4. Electron 仍然 `loadFile(src/renderer/index.html)`；
5. watcher 只负责增量构建，不提供 HMR。

生产和打包前必须执行一次非 watch 构建。不得出现“dev server 可用、file:// 打包失败”的双轨状态。

### 2.3 新旧 runtime 的边界

新旧实现可同时装载，但功能所有权必须互斥：

```text
flag=legacy
  legacy init
  React 不挂载该 feature

flag=react
  legacy 不 init，或先 dispose
  React mount 并独占 DOM、事件、状态订阅和 stream
```

每个 feature 在迁移矩阵中登记：

- legacy 模块；
- React owner；
- DOM root；
-全局事件；
- timer/observer；
- IPC channel；
- storage key；
- mount/dispose；
- feature flag；
- characterization test；
-回滚验证状态。

### 2.4 开工前架构例外门槛

当前 `AGENTS.md` 明确规定：renderer 不使用 TypeScript/JSX/bundler，新增 npm 依赖须先讨论。因此在任何 React/Vite 代码进入仓库前，必须由仓库负责人明确批准并更新该边界，至少写明：

- `src/renderer-app/**` 允许 TypeScript/TSX；
- renderer 允许 Vite 离线构建，但仍禁止 HTTP server；
- React/Vite/Testing Library/Playwright 依赖已批准；
- `src/main/preload.js` 必须保持 `.js` 且不进入 Vite；
- legacy `src/renderer/modules/**` 在迁移期继续使用 classic scripts；
-未批准前只能实施契约捕获、清单和测试基线，不得接入框架。

这是执行授权门，不是文档建议。

---

## 3. 目标目录与所有权

```text
src/renderer-app/
├── main.tsx
├── app/
│   ├── App.tsx
│   ├── RendererErrorBoundary.tsx
│   └── portals.ts
├── ipc/
│   ├── bridge.ts
│   ├── client.ts
│   ├── contract.generated.json
│   ├── channels.generated.ts
│   ├── dynamic-channels.ts
│   ├── schemas.ts
│   └── types.ts
├── migration/
│   ├── feature-flags.ts
│   ├── ownership.ts
│   └── inventory.generated.json
├── stores/
│   ├── conversation-store.ts
│   ├── user-store.ts
│   ├── settings-store.ts
│   └── ui-store.ts
├── components/
│   ├── chat/
│   ├── sidebar/
│   ├── cognition/
│   ├── settings/
│   ├── agents/
│   ├── marketplace/
│   ├── connectors/
│   ├── expense/
│   ├── onboarding/
│   ├── shared/
│   └── modal/
├── helpers/
├── styles/
└── test/

src/renderer/generated/renderer-app/   # Vite 输出，构建产生
scripts/
├── capture-ipc-contract.cjs
├── capture-renderer-inventory.cjs
├── check-renderer-boundaries.cjs
└── build-renderer.cjs
```

设计原则：

- `ipc/bridge.ts` 是 React 源码中唯一允许读取 `window.cogseed` 的文件；
-组件只能调用具名 client 方法，不允许传任意 channel string；
-store/service 可以订阅 stream，展示组件不得直接订阅；
-纯函数迁移到 `helpers/` 前必须先有原实现 characterization test；
-portal 只能挂到统一容器，禁止组件自行向 `document.body` 注入临时层。

---

## 4. IPC 契约冻结

### 4.1 三层契约

#### A. 静态调用面快照

`capture-ipc-contract.cjs` 使用现有 TypeScript compiler API 解析 JavaScript AST，不使用正则。输出应包含：

- schemaVersion、baseline commit；
- source file、line、column；
- kind：invoke/stream；
-静态 channel，动态调用则为 null；
-参数数量；
- payload 表达式类别；
-动态调用点标识。

基线断言：427 个调用点、398 个静态调用、29 个动态调用、273 个唯一静态 channel。脚本结果若与这些数字不一致，先更新并审批基线，不得静默覆盖 snapshot。

#### B. 手工类型契约

自动生成层只负责 channel 联合类型，不伪造 payload 类型。`schemas.ts` 手工维护：

- request；
- response；
- stream event；
- error/失败返回；
- cancel/unsubscribe 语义。

未完成收紧的 channel 使用 `unknown`，不能使用无约束的 `any`。每迁移一个 slice，先收紧该 slice 所需 channel。

#### C. 运行时行为契约

对同一 fixture 分别运行 legacy 和 React 路径，比较：

- IPC 调用顺序；
- channel；
- payload，包括缺省字段、null/undefined 差异；
-成功/失败返回处理；
-stream 事件、完成、取消和 handler 抛错行为；
-用户可见状态变化。

### 4.2 动态 channel

29 个动态调用点不得自动视为合法。每个调用点必须在 `dynamic-channels.ts` 中登记有限集合或映射来源。无法静态收敛的调用点在所属 feature 迁移前必须先重构为具名 adapter，但不得改变实际 channel。

### 4.3 CI ratchet

CI 必须同时执行：

1. contract snapshot `--check`；
2. React 源码仅 `ipc/bridge.ts` 可出现 `window.cogseed`；
3. legacy 直调必须出现在 baseline allowlist；
4. allowlist 只能随迁移减少，不得扩大；
5. channel 不得新增、删除或改变 invoke/stream kind；
6. snapshot 更新需要单独的显式命令和审阅，普通测试不得自动重写。

调用点总数可以因集中 adapter 而减少；验收冻结的是 channel 和行为，不是强制新实现仍有 427 个调用点。

### 4.4 stream 不变量

现有 preload 行为必须原样保留：

- `stream(channel, payload, onEvent)` 返回 `{ promise, cancel }`；
-完成事件移除 listener 并 resolve；
-cancel 最终以 `AbortError`/`stream cancelled` 语义结束；
-`onEvent` 抛错时取消 main stream、移除 listener 并 reject；
-重复 cancel 无副作用。

React adapter 只能封装该行为，不得新增隐式 timeout、重试或改变取消结果。

---

## 4.5 P3394 远程通信契约

### 4.5.1 已有基础与复用原则

当前仓库已经存在 P3394 bridge、A2A channel、envelope、outbound hub、session、outbox、idempotency、replay protection、peer registry 和 external gateway 等基础。实现远程 Agent 通信时优先复用这些现有边界，不在 renderer 中复制一套网络协议。

当前 A2A adapter 是 dialer-oriented 的任务通道；其能力描述仍为非流式、非多方会话。因此第一版产品目标应明确为“单远程 Agent 请求/响应”，不能宣称已经支持完整双向多 Agent 会话。

### 4.5.2 建议的新增 IPC 命名空间

在不改变现有 IPC 的前提下，未来增量增加具名通道，例如：

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

具体 channel、payload 和 preload allow-list 必须在 P3394 轨道的 Phase P0 单独审批并写入 contract snapshot；上面只是能力边界，不是已冻结的 API 承诺。

### 4.5.3 生命周期与安全不变量

必须覆盖：

- Agent Card/远程身份发现与 pinning；
- bearer token 或节点密钥安全存储，不进入 renderer 日志和持久化 UI state；
- 消息认证、重放防护、权限/能力检查和审计 journal；
- `message_id` / `idempotency_key` 去重；
- timeout、cancel、retry/backoff、outbox、ack 和 resume cursor；
- 远端不可达、认证失败、协议不兼容、远程拒绝、能力不足、结果超限等错误码；
- delegation 深度、循环检测、消息大小、成本/时间预算和人工审批；
- 退出或断线时清理 socket、timer、stream listener 和未完成任务句柄。

### 4.5.4 三个远程通信验收层级

| 层级 | 范围 | 必须通过 |
|---|---|---|
| P1 单 Agent 请求/响应 | 一个本地 Agent ↔ 一个远程 Agent | 成功、拒绝、认证失败、超时、重复提交、不可达、取消、结果持久化 |
| P2 双向流式会话 | 多轮消息、增量事件和恢复 | event cursor、ack、断线重连、resume、幂等、顺序和取消 |
| P3 多 Agent 协作 | 委派、多个收件人和协作链 | 能力/权限、循环/深度限制、预算、人工审批、全链路审计 |

## 5. Legacy 行为基线

Phase 0 前先为 legacy 建立 characterization suite，至少覆盖：

-启动、i18n 和首屏；
-会话列表加载、分页和切换；
-消息发送、optimistic 回显、失败重试；
-stream 增量、完成、取消、重复/迟到事件；
-markdown、附件、引用、artifact；
-use-selection、draft、queue、continue work；
-终端创建、resize、取消和销毁；
-context menu、modal、focus、keyboard 和滚动锚点；
-设置、认知、Agent、市场和连接器的主要保存路径；
-外部链接、本地文件、危险 HTML 和路径安全策略。

A/B 比较必须在两个独立运行实例中进行，禁止在同一页面同时触发新旧 handler。

---

## 6. 阶段里程碑

### Phase 0.0 — 治理、基线和契约

内容：

-批准并更新 renderer 架构边界；
-生成 IPC 静态快照和动态 channel 登记；
-生成 89 个一方模块的迁移矩阵；
-固化 legacy Golden Path；
-记录源码运行、打包运行、性能和内存基线。

验收：

-快照可重复生成且 `--check` 通过；
-所有动态 channel 有 owner；
-迁移矩阵无未登记一方模块；
-legacy Golden Path 全绿；
-main/preload 未改。

回滚：只新增脚本、测试和文档，可整提交回退。

### Phase 0 — 构建骨架和单个纵向切片

内容：

-接入 Vite 离线 build/watch；
-建立 React root、ErrorBoundary、portal、feature flag 和 ownership registry；
-先迁移纯 `icons`/avatar helper，再迁移一个隔离、只读且包含 IPC 的纵向 feature；
-验证 legacy/React 互斥和 dispose。

`context-menu`、`sidebar-resize` 不作为首个低风险示例；它们涉及全局事件，应在 ownership 模式验证后迁移。

验收：

-源码启动、生产 build、macOS/Windows 打包 smoke 均加载 React slice；
-关闭 flag 后完全回到 legacy；
-反复切换/挂载不增加 listener、timer 或 stream；
-CSS 不污染未迁移区域。

### Phase 1 — 对话主区

Phase 1 必须拆成独立 flag 的子阶段：

1. **1A 只读壳**：会话列表、历史读取、纯文本消息、选择和滚动。
2. **1B 富消息**：markdown、引用、附件、artifact、file viewer、lightbox、drawer。
3. **1C Composer**：输入、发送、use-selection、draft、快捷键、失败恢复。
4. **1D 实时流**：stream 订阅、增量、actor 状态、cid 切换、去重和迟到事件。
5. **1E 工作流挂件**：PlanRail、QueueDraft、ContinueWork。
6. **1F 高风险嵌入**：xterm、side browser、side host、aside。

不得以“拆成不超过 15 个组件”作为完成标准；边界按状态和行为责任划分。

会话 store 必须定义：

-当前 cid 和 subscription generation；
-optimistic message 与服务端回显合并；
-事件去重和 stale event 丢弃；
-cancel、unmount 和 cid switch cleanup；
-错误与重试状态；
-长列表性能策略。

### Phase 2 — 面板域迁移

按域、按 flag 迁移：

- cognition：skills、recall、memory、kb-picker、ontology、contexts；
- settings：settings tabs、security、messaging、model；
- agents：agents、local-agents、interactive-cli；
- marketplace；
- connectors/connections/p3394 observability；
- expense；
- onboarding 和其余共享 modal/工具面板。

每个域至少包含：读取、保存、错误、取消、键盘/焦点和回滚测试。

### Phase 3A — React 默认、legacy 保留

-所有 feature 默认指向 React；
-legacy script 和 flag 仍保留；
-执行至少一个明确发布观察周期；
-验证 crash、renderer error、内存、listener 和关键路径指标。

### Phase 3B — 删除 legacy

只有 Phase 3A 满足退出条件后才允许：

-删除 legacy feature 实现；
-删除对应 script tag；
-收敛所有 `window.cogseed` 到 `ipc/bridge.ts`；
-清理 feature flag、allowlist 和兼容 CSS；
-最终保留 Vite 单入口。

Phase 3B 仍可通过普通 git revert 回退，不得声明“一次性切换、不可回滚”。

---

## 6.5 P3394 远程 Agent 通信后续轨道

P3394 不作为 renderer 重写的隐式附带工作。它在 renderer 重写完成 Phase 0 的 typed IPC/ownership 基础后，作为独立 feature track 进入排期；允许与 Phase 1/2 并行，但必须使用独立提交、独立 feature flag、独立 contract diff 和独立回滚点。

### P0 协议、安全和运行边界

- 盘点并复用现有 `src/main/features/p3394/**` 与 `src/main/features/p3394_bridge/**`；确认 A2A、gateway、peer registry、outbox、session、idempotency 和 replay protection 的权威边界。
- 决定第一版远程对象是另一台 CogSeed、任意 A2A Agent，还是两者兼容；固定 endpoint/Agent Card、认证、密钥存储和能力 profile。
- 明确新增 `p3394.agent.*` IPC 的 request/response/event/error/cancel 结构；禁止修改既有 427 个调用点的语义。
- 建立 threat model、远程副作用审批、消息/附件大小限制、超时/预算和审计字段。

### P1 单 Agent 请求/响应

- 本地 Agent A 选择远程 Agent B，创建 session，发送一个 task，接收结果并写入本地 conversation。
- 覆盖成功、认证失败、不可达、协议不兼容、远程拒绝、超时、取消、重复发送和结果持久化。
- renderer 只显示状态并触发 typed IPC；网络和 token 仅存在 main/features。

### P2 双向流式和恢复

- 引入 stream event、ack、cursor、resume、outbox、retry/backoff 和断线恢复。
- 明确“消息至少一次传输 + effect 幂等”或其他可验证交付语义；不得口头宣称 exactly-once。
- 验证 late event、重复 event、重连期间的排序、取消和 session 关闭。

### P3 多 Agent 协作

- 支持 A→B→C 委派链和多方会话前，先加入 delegation chain、能力/权限、最大深度、循环检测、cost/time budget 和人工审批。
- 每条跨 Agent 消息可追溯到本地用户、origin session、parent task 和审计记录。

P3394 轨道的完成不等于 renderer 全量重写完成；反之 renderer Phase 3 也不能删除 P3394 所需的 legacy/main bridge。两者通过稳定的 typed IPC 边界集成。

## 7. 测试与验收

### 7.1 必须测试

-现有 `npm run typecheck`；
-现有 `npm test` 全绿，测试数量不得因迁移减少；
-renderer strict typecheck；
-contract/inventory `--check`；
-组件和 store 单测；
-真实 preload 形状的 IPC adapter test；
- P3394 远程 Agent：连接/身份、请求响应、流式恢复、取消、重试、幂等、权限和审计测试；
-Playwright Electron Golden Path；
-生产 build 和打包启动 smoke；
-macOS 与 Windows 平台验证。

### 7.2 性能和泄漏门槛

Phase 0.0 记录基线，后续不得无说明退化：

-首屏可交互时间；
-500/1000 条消息渲染和滚动；
-stream burst 处理；
-连续切换会话 20 次后的 listener/heap；
-终端反复 mount/unmount；
-modal/context menu 反复开关。

### 7.3 安全回归

必须覆盖：

-不可信 markdown/HTML；
-危险 URL scheme；
-外部链接策略；
-本地文件和路径沙箱；
-附件和 artifact 展示；
-CSP/file:// 资源加载；
-React 错误信息不得泄露私有路径或 token。

### 7.4 每个 slice 的 Definition of Done

1. legacy characterization test 已存在；
2. React 通过同一 fixture；
3. feature flag 两个方向均验证；
4. 新旧所有权互斥；
5. dispose/unmount 无泄漏；
6. IPC channel、payload、返回、错误和 stream 行为一致；
7. typecheck、单测、Golden Path 子集和 production build 通过；
8.迁移矩阵更新；
9.提交可独立 revert；
10.未修改 main/preload 或用户数据格式。

---

## 8. 排期与资源

原 50–80 人日仅可视为纯实现乐观值。修订估算：

| 阶段 | 内容 | 估算 |
|---|---|---:|
| 0.0 | 架构例外、契约、inventory、characterization | 6–10 人日 |
| 0 | 构建骨架、ownership、首个纵向切片 | 6–10 人日 |
| 1 | 对话主区六个可回退子阶段 | 28–42 人日 |
| 2 | 认知/设置/Agent/市场/连接器等 | 24–36 人日 |
| 3A/3B | 默认切换、观察、清理和打包锁定 | 6–12 人日 |
| P3394 P0–P1 | 协议/安全基线、单 Agent 请求/响应 | 12–20 人日 |
| P3394 P2–P3 | 双向流式恢复、多 Agent 协作 | 20–40 人日 |
| Renderer 重写合计 | 含测试和稳定工作；不含 P3394 后续轨道 | 70–110 人日 |
| 组合项目预算 | renderer 重写 + P3394 P0–P3 的初始预算 | 102–170 人日 |

Phase 0 完成后必须按真实吞吐重新估算。P3394 远程通信不计入 renderer rewrite total，应单独按 P0–P3 复估。多人并行不按人数线性压缩，因为 IPC adapter、store、CSS、入口和 conversation shell 是共享热点。

---

## 9. 执行授权

允许立即执行的工作：

-契约捕获脚本；
-迁移矩阵；
-legacy characterization tests；
-文档和基线校验。

以下工作必须等 §2.4 的架构例外明确批准：

-新增 React/Vite/Testing Library/Playwright 依赖；
-新增 TSX；
-修改 renderer 构建和打包入口；
-挂载 React root。

设计批准后，实施必须严格按 `docs/superpowers/plans/2026-08-19-renderer-full-rewrite-implementation.md` 的任务顺序执行。
