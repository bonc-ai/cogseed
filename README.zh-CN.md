<p align="center">
  <img src="./assets/cogseed-icon.png" width="160" alt="CogSeed 产品图标">
</p>

<h1 align="center">CogSeed</h1>

<p align="center">一个本地优先的 AI Agent 协作桌面工作台，将任务经验沉淀为可复用的个人能力资产。</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="./assets/cogseed-homepage-hero-agent-continuity.png" width="1000" alt="CogSeed 桌面工作台">
</p>

## 项目概览

CogSeed 将任务、工作空间、AI 团队、Skill、Connector、个人知识和可复用的 Cognition Asset 整合进一个 Electron 桌面应用。它面向那些无法通过单轮对话完成的工作：规划、分派、工具调用、本地项目访问、跨会话延续、可审查的执行证据，以及经验的长期复用。

Commander 维护共享计划，并通过结构化调度分派工作。内置 Agent 和受支持的本地 CLI Agent 都在受控执行路径中运行，每个 worker 只获得其职责所需的上下文。执行结果可以保留为对话输出，也可以成为工作空间文件或 Artifact，还可以进入 Cognition 与 Recall 流程，经用户审查后沉淀为能力资产。

CogSeed 坚持本地优先。Renderer 不能直接访问 Node.js，本地工具必须通过明确的网关运行，用户数据则被划分为可同步的私有状态和仅保留在当前设备上的本地状态。

## 核心亮点

| 能力 | 用途 |
|---|---|
| 结构化多 Agent 协作 | 通过统一的 group-chat 执行路径规划、分派、观察、重试、跳过和停止任务。 |
| 本地 CLI Agent 集成 | 在同一个工作空间中使用 Claude Code、Codex、OpenClaw、OpenCode、Hermes 或 WorkBuddy。 |
| 跨任务连续性 | 导入受支持的会话，并携带工作空间上下文、当前进度、已知约束和执行证据继续工作。 |
| 受治理的 Cognition Asset | 审查候选经验、确认正式资产、管理版本，并跟踪复用和效果证据。 |
| 工具与知识连接 | 让受支持的 Agent 受控访问 Skill、MCP Connector、消息触点和已建立索引的 Library 内容。 |
| 本地优先的安全边界 | 将凭据、索引、缓存、工具结果和本地安装内容置于明确的存储与执行边界之后。 |

## 核心工作流

### Task 与 Space

- 创建一个聚焦的 Task，或使用 Space 组织相关工作。
- 在任务输入框中通过 `@` 选择 Agent、Skill、Connector 和 Library 文件。
- 将会话关联到工作空间目录，同时避免把项目身份编码进文件路径或 session ID。
- 在一个界面中查看计划、成员状态、过程事件、生成文件、Artifact 和对话历史。

### Commander 与 AI Team

- Commander 将用户目标转化为共享计划。
- 通过结构化 `dispatch_to` 操作把工作分派给指定成员。
- `plan_set` 负责计划状态，包括重试、跳过和状态校准。
- 每个 worker 读取自己的可见性切片，而不是完整对话记录。
- Group abort 是停止所有活跃成员的唯一入口。

### 继续已有工作

- 从本地编码 Agent 环境导入受支持的历史记录。
- 继承工作目录、当前进度、已知约束和可用证据。
- 将导入的源会话与 CogSeed 的对话和执行状态分开保存。
- 通过标准任务调度继续执行，而不是绕过协作管线。

### Skill、Connection 与 Library

- 安装或创建 Agent 和 Skill，并控制每个 Agent 可以使用哪些 Skill。
- 通过 OAuth 或 MCP transport 连接受支持的外部服务。
- 使用“列出并调用”的 meta-tool 暴露 Connector 操作，避免把所有远程操作都注入模型上下文。
- 在 Library 中保存用户管理的源材料，同时让派生索引和向量数据仅保留在本机。

### Cognition 与 Recall

- 从会话、review 信号和教学交互中捕获候选经验。
- 候选经验必须经过用户确认，才能成为正式的能力资产。
- 保留稳定 ID、版本、scope policy、来源和审计历史。
- 当资产在后续任务中复用时，记录 transfer evidence 和 effectiveness evidence。

### Automation、消息触点与 Artifact

- 通过同一套受保护的执行界面运行已保存的自动化任务。
- 在完成配置后连接受支持的消息触点，包括飞书和微信集成。
- 在会话级存储中生成聊天 Artifact，并通过经过校验的 Artifact resolver 展示。
- 单独保存可复用应用；编辑已保存应用时创建分叉会话，而不是直接修改原会话。

## 任务生命周期

```text
┌───────────┐   goal    ┌────────────┐   plan    ┌──────────────┐
│   User    │──────────▶│ Commander  │──────────▶│ Shared Plan  │
└───────────┘           └─────┬──────┘           └──────┬───────┘
                              │ dispatch_to              │ plan state
                              ▼                          │
                       ┌────────────┐                    │
                       │ Agent / CLI│◀───────────────────┘
                       └─────┬──────┘
                             │ tools, files, connectors, Library
                             ▼
                       ┌────────────┐
                       │ Result and │
                       │ Evidence   │
                       └─────┬──────┘
                             │ optional review and confirmation
                             ▼
                       ┌────────────┐
                       │ Cognition  │
                       │ Asset      │
                       └────────────┘
```

## 系统架构

```text
┌─────────────────────────────────────────────────────────┐
│ Renderer: classic HTML / CSS / JavaScript               │
│ Tasks · Spaces · Automation · Assets · Connections      │
└───────────────────────────┬─────────────────────────────┘
                            │ window.cogseed.invoke / stream
┌───────────────────────────▼─────────────────────────────┐
│ Preload: contextBridge allow-list                       │
└───────────────────────────┬─────────────────────────────┘
                            │ Electron IPC
┌───────────────────────────▼─────────────────────────────┐
│ Main process: IPC validation → feature workflows        │
│ Group Chat · Recall · Knowledge Base · Connectors       │
└──────────────┬────────────────┬────────────────┬────────┘
               │                │                │
               ▼                ▼                ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ Core Agent       │  │ Runtime worker   │  │ Child processes  │
│ In-process       │  │ JSONL protocol   │  │ Local CLI / MCP  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

### 执行边界

| 边界 | 职责 |
|---|---|
| Renderer | 使用 classic scripts 渲染桌面 UI，并且只调用显式暴露的 `window.cogseed` API。 |
| Preload | 维护明确的 contextBridge allow-list，并把 invoke 或 stream 请求映射到 Electron IPC。 |
| IPC handlers | 校验请求参数并委托给 feature module；handler 中不承载业务逻辑。 |
| Feature layer | 管理会话、工作空间、Agent、Skill、Recall、Connector、消息和其他业务流程。 |
| Core Agent | 通过动态加载的 `#core-agent` 在进程内运行模型会话和工具编排。 |
| CogSeed Runtime | 通过独立 worker 进程和 JSONL 协议运行隔离的后端任务。 |
| Local Agent runner | 负责受支持 CLI Agent 的统一、受控子进程执行路径。 |
| MCP client | 管理 stdio Connector 进程，并通过 Connector meta-tool 暴露已连接操作。 |
| Storage and paths | 集中管理用户数据路径、路径沙箱、JSON/JSONL 存储和知识库向量数据库。 |

## 快速安装

### 环境要求

- Git
- 开发 shell 中可用的 Node.js 和 npm
- 首次安装时可访问网络，用于获取 npm package 和固定版本的运行时资源
- macOS 或 Windows，二者是主要桌面目标平台

克隆仓库并安装依赖：

```bash
git clone https://github.com/cogseed/cogseed.git
cd cogseed
npm install
```

仓库锁定使用 `npm@11.11.0`。安装过程会准备 Electron 原生依赖和 embedding 模型。开发环境启动时还会校验或下载已启用功能所需的平台运行时、OfficeCLI、FFmpeg 和 Whisper 资源。

## 快速开始

在 macOS 或 Linux 开发环境中启动 CogSeed：

```bash
./run.sh
```

Windows 环境：

```bat
run.cmd
```

源码启动器会校验依赖、准备 `cogseed` runtime variant，并使用隔离的数据根目录和应用身份启动 Electron。

### 首次运行配置

1. 打开 **Connections → Models & Quota**。
2. 添加 API Key、配置受支持的 OAuth 授权，或从 CC Switch 导入兼容授权。
3. 测试连接并选择一个或多个返回的模型。
4. 创建任务，在输入框中键入 `@` 选择 Agent、Skill、Connector 或 Library 文件。
5. 当任务需要受控访问本地项目文件时，选择一个工作空间。

## 本地 Agent 支持

CogSeed 使用以下 CLI 前，需要在本机安装或配置相应命令行工具。

| CLI | 主要用途 | CogSeed 集成方式 |
|---|---|---|
| Claude Code | 端到端编码任务 | 受管进程、工作空间上下文、会话恢复、事件映射和受支持的 Bridge 注入 |
| Codex | 编码、补丁、调试和重构 | 受管进程、app-server 支持、工作空间证据和受支持的 Bridge 注入 |
| OpenClaw | 通用编排和轻量自动化 | 受管进程，以及针对后端的进度和空闲状态处理 |
| OpenCode | 使用可选 provider 进行编码，包括本地模型 | 受管进程、终端活动和受支持的会话导入 |
| Hermes | 多步骤任务和工具驱动工作流 | 受管进程、会话级恢复和受支持的 Bridge 注入 |
| WorkBuddy | 通过 CodeBuddy CLI 执行端到端编码 | 受管进程、工作空间上下文、会话恢复和文件变更证据 |

本地 CLI 执行统一集中在 `src/main/features/local_agents/runner.ts`。Runner 管理后端选择、工作目录、环境变量覆盖、取消操作、事件映射、空闲检测和结果证据。

## Skill、Connector 与 Library

### Skill 与 Agent

- 自定义 Agent 和 Skill 存放在用户级 cloud state 中。
- Platform Agent 和 Platform Skill 是已安装的 marketplace 内容，存放于 machine-local tier。
- 自定义 Skill 可以覆盖同名 Platform Skill；重复的 Platform Skill 仍可通过内部 ID 访问。
- Skill 通过 `bin/run-skill.cjs` 和已安装的 Skill tier 执行。
- 敏感 Skill 操作被准入前，会经过质量、信任和路径检查。

### Connector

- Hosted Connector 授权通过配置的账户服务发起，并通过应用协议 callback 返回（`cogseed://` deep link）。
- 包含 token 的授权和 transport 状态会在本地持久化前进行加密。
- 模型只能获得当前已连接、已启用且符合会话准入条件的 Connector。
- 通过 `list_connector_tools` 发现 Connector 操作，通过 `call_connector_tool` 调用。

### Library 与知识库

- 源文件由用户管理，并可具备同步资格。
- 派生 chunk、embedding、模型配置和向量数据库只保留在本机。
- Agent 通过专用知识库工具搜索和读取 Library 内容。
- PDF 和 DOCX 访问遵循文件状态检查和有界读取路径，不在附件阶段预先提取全部内容。

## Cognition 与 Recall

CogSeed 将可复用经验视为需要治理的状态，而不是自动把每段对话摘要都提升为正式资产。

| 阶段 | 含义 |
|---|---|
| Candidate | 等待审查的经验记录或可复用模式。 |
| Confirmed asset | 经用户批准、具有稳定身份、版本、scope 和来源的能力资产。 |
| Projection | 为后续任务准备并提供的资产引用。 |
| Transfer evidence | 证明投影资产已进入目标执行过程的证据。 |
| Effectiveness evidence | 用于判断复用是否有效的反馈或结果信息。 |

资产可以通过既有 Cognition 工作流暂停、恢复、修订或回滚。Personal Ontology 用于组织已确认的概念和关系，但不会因此向 Agent 开放对私有数据目录的无限制访问。

## 数据与安全

### 用户数据域

```text
<container>/data/<uid>/
├── cloud/
│   ├── conversations, sessions, attachments, and artifacts
│   ├── projects, automations, contexts, memory, agents, and skills
│   └── saved apps, marketplace manifests, and user configuration
└── local/
    ├── account and session cache
    ├── marketplace installations and local-agent archives
    ├── indexes, vector database, model caches, and tool-result spills
    └── workspace selection and other machine-private state
```

`cloud` 和 `local` 表示同步资格，而不是公开可见性。Cloud state 始终是用户私有数据，仅在配置的 hosted account 和 entitlement 支持时同步。模型凭据保留在本地 secret-storage facade 之后。

### 安全控制

| 控制项 | 执行方式 |
|---|---|
| Renderer 隔离 | Context isolation 和 preload allow-list 阻止 renderer 直接访问 Node.js。 |
| 无本地 Web 后端 | 主进程不暴露 HTTP server 或本地认证接口。 |
| 路径沙箱 | 文件类工具在入口处校验工作空间和附件路径。 |
| 进程收口 | Runtime worker、本地 CLI Agent 和 MCP stdio Connector 只能通过批准的模块启动。 |
| Artifact 隔离 | `chat-app://` 向 sandboxed iframe 提供经过校验的 Artifact 文件，同时不暴露 IPC。 |
| Secret 处理 | Hosted secret 和包含 token 的 Connector 状态保留在加密的本地存储 facade 之后。 |
| 工具结果限制 | 大型结果统一经过容量限制和 spill 处理。 |
| 用户确认 | 敏感操作使用明确的权限和确认流程，而不是静默提权。 |

## 运行时与依赖

| 组件 | 仓库基线 | 用途 |
|---|---|---|
| Electron | `^41.7.1` | 桌面 shell，以及 main/renderer 进程边界 |
| TypeScript | `^6.0.3` | 主进程、feature、model 和测试代码 |
| Node.js runtime bundle | `24.17.0` | 基于 Node.js 的 Skill 和打包命令执行 |
| Python runtime bundle | `3.12.13` | Python Skill、package 工具和资源测试 |
| uv | `0.11.21` | Python 环境和 package 管理 |
| SQLite 与 sqlite-vec | 仓库依赖 | 本地结构化存储和知识库向量检索 |
| FFmpeg 与 Whisper | 预置的平台资源 | 媒体检查和已启用的转录工作流 |
| OfficeCLI | 预置的平台资源 | 已启用的文档和 Office 工作流 |

固定版本运行时的下载信息和 checksum 位于 `resources/runtime/manifest.json`。

## 仓库结构

| 路径 | 用途 |
|---|---|
| `bootstrap.cjs` | Electron 入口 shim、运行时身份选择和 TypeScript loader 注册 |
| `src/main/` | 主进程、IPC、存储、model adapter、工具和 feature 工作流 |
| `src/renderer/` | Classic HTML、CSS、JavaScript、本地化和桌面 UI |
| `src/core-agent/` | Core Agent session、provider、工具编排和执行循环 |
| `src/main/features/group_chat/` | 会话 bus、计划执行、worker 调度和 abort 处理 |
| `src/main/features/local_agents/` | 受支持 CLI 的检测、adapter、session 和集中式 runner |
| `src/main/features/recall/` | 候选捕获、正式资产、projection、proof 和效果反馈 |
| `src/main/features/connectors/` | Connector metadata、授权状态、MCP client 和工具暴露 |
| `resources/builtin/` | Platform Agent、Skill 和 marketplace seed 内容 |
| `resources/runtime/` | 固定版本的运行时 manifest 和平台资源 |
| `p3394-gateway/` | Local Bridge gateway、协议集成和发布说明 |
| `test/` | 主进程、renderer、资源、native 和跨层测试 |
| `scripts/` | 依赖准备、诊断、打包、审计和验证工具 |

## 开发指南

### 常用命令

| 命令 | 用途 |
|---|---|
| `npm run typecheck` | 运行 TypeScript 检查，不生成文件 |
| `npm test` | 运行 JavaScript 和资源测试套件，并管理 native ABI |
| `npm run test:coverage` | 运行带 coverage 的 JavaScript 测试套件 |
| `npm run test:platform-native` | 运行平台原生验证 |
| `npm run runtime:ensure` | 校验或准备固定版本的运行时 bundle |
| `npm run builtin:manifest:check` | 校验内置 marketplace manifest |
| `npm run audit:workspace` | 审计本地工作空间布局和约束 |
| `npm run diagnose:agents` | 诊断受支持的本地 Agent 安装 |
| `npm run rebuild:sqlite:electron` | 修复 Electron SQLite native ABI |
| `npm run rebuild:pty:electron` | 修复 Electron node-pty native ABI |
| `scripts/restart-cogseed.sh` | 仅重启当前 worktree 的 CogSeed runtime |

请使用 `npm test`，不要直接调用 Vitest。仓库测试 runner 会管理 Electron 与 Node 原生 SQLite ABI 的切换和恢复。

### 开发规则

- IPC handler 只负责校验和 feature delegation。
- Renderer 代码保持 classic scripts，并在 `src/renderer/index.html` 中注册新文件。
- 动态导入 `#core-agent`；静态导入可能破坏启动顺序和 ESM resolution。
- 通过当前用户 ID 和标准 storage helper 访问用户私有数据。
- 通过 `util/boot_init.ts` 注册启动阶段的异步任务。
- 在 central catalog 和 runner wiring 中注册新的 Core Agent 工具。
- 合并涉及 renderer-to-main IPC contract 的改动后，运行 `npm run typecheck`。

## 故障排查

### Native SQLite 错误

```bash
npm run rebuild:sqlite:electron
```

### Terminal 或 node-pty ABI 错误

```bash
npm run rebuild:pty:electron
```

### 缺少 bundled runtime 资源

```bash
npm run runtime:ensure
```

### 无法检测本地 Agent

```bash
npm run diagnose:agents
```

确认对应 CLI 已安装，并且启动 CogSeed 的 shell 可以找到该命令。

### Windows 与 WSL

Windows 原生运行时请使用 `run.cmd`。在 WSL 和所需 Windows bridge command 可用时，shell 启动器会委托给该脚本。

### 模型连接问题

打开 **Connections → Models & Quota**，重新测试授权，然后选择配置的 provider 返回的模型。不要把 API Key 写入仓库文件或 README 示例。

## 相关文档

| 主题 | 链接 |
|---|---|
| 工程边界和仓库规则 | [AGENTS.md](./AGENTS.md) |
| 源码包内容和启动命令 | [源码包说明](./README-源码包说明.txt) |
| Bundled runtime 布局和版本策略 | [Runtime 文档](./resources/runtime/README.md) |
| P3394 gateway 概览 | [Gateway README](./p3394-gateway/README.md) |
| Gateway 启动配置 | [Gateway bootstrap 指南](./p3394-gateway/BOOTSTRAP.md) |
| Gateway 发布 | [Gateway publication 指南](./p3394-gateway/PUBLISH.md) |
| Cognition asset 规范 | [Cognition assets](./specs/cognition-assets/spec.md) |

## 许可证

CogSeed 基于 [MIT License](./LICENSE) 发布。
