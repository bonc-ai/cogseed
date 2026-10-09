# CogSeed 开发指南

[English](./DEVELOPMENT.md) · 简体中文

> 本文是 `DEVELOPMENT.md` 的中文翻译。如中英文内容不一致，以英文版为准。
>
> **受众**：开发者和贡献者。用户入门请参阅 [README](../README.zh-CN.md)。
> **范围**：CogSeed 的架构、开发、测试和维护细节。

## 目录

- [架构](#架构)
- [执行边界](#执行边界)
- [Skills、连接器与资料库](#skills连接器与资料库)
- [认知与召回](#认知与召回)
- [数据与安全](#数据与安全)
- [运行时与依赖](#运行时与依赖)
- [仓库结构](#仓库结构)
- [开发环境配置](#开发环境配置)
- [开发](#开发)
- [打包](#打包)
- [故障排查](#故障排查)

---

## 架构

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
| Renderer | 使用经典脚本渲染桌面 UI，只调用对外暴露的 `window.cogseed` API。 |
| Preload | 维护明确的 contextBridge 允许列表，并将 invoke 或 stream 请求映射到 Electron IPC。 |
| IPC handlers | 校验请求参数并委托给功能模块；业务逻辑不放在处理器中。 |
| Feature layer | 负责会话、工作区、Agent、Skill、Recall、连接器、消息及其他业务流程。 |
| Core Agent | 通过动态加载的 `#core-agent` 在进程内运行模型会话和工具编排。 |
| CogSeed Runtime | 通过专用 Worker 进程和 JSONL 协议运行隔离的后端工作。 |
| Local Agent runner | 负责调用受支持 CLI Agent 的唯一获准子进程路径。 |
| MCP client | 负责 stdio 连接器进程，并通过连接器元工具暴露已连接操作。 |
| Storage and paths | 集中管理用户数据路径、路径沙箱、JSON/JSONL 存储和知识库向量数据库。 |

## Skills、连接器与资料库

### Skills 与 Agents

- 自定义 Agent 和 Skill 存放在用户范围的云端状态中。
- 平台 Agent 和 Skill 是已安装的市场内容，存放在本机层。
- 自定义 Skill 可以覆盖同名平台 Skill；平台中的重复项仍可通过内部 ID 访问。
- Skill 通过 `bin/run-skill.cjs` 和已安装的 Skill 层执行。
- 敏感 Skill 操作执行前，必须通过质量、信任和路径检查。

### 连接器

- 托管连接器授权从配置的账户服务发起，并通过应用协议回调（`cogseed://`
  深层链接）返回。
- 包含 Token 的授权和传输状态会先加密再在本地持久化。
- 模型只能看到当前已连接、已启用且符合会话范围的连接器。
- 使用 `list_connector_tools` 发现连接器操作，使用 `call_connector_tool`
  调用操作。

### 资料库与知识库

- 源文件由用户管理，可以具备同步资格。
- 派生出的分块、Embedding、模型配置和向量数据库保留在本机。
- Agent 通过专用知识库工具搜索和读取资料库内容。
- PDF 和 DOCX 遵循文件状态检查和有界读取路径，不进行附件的即时预提取。

## 认知与召回

CogSeed 将可复用经验作为受治理状态处理，不会自动把每次会话摘要提升为正式
资产。

| 阶段 | 含义 |
|---|---|
| 候选经验 | 等待评审的经验或可复用模式。 |
| 已确认资产 | 经用户批准、具有稳定标识、版本、范围和来源的能力资产。 |
| 投影 | 已准备好供后续任务使用的资产引用。 |
| 迁移证据 | 证明投影资产已经进入目标执行过程的证据。 |
| 有效性证据 | 用于判断复用是否有效的反馈或结果信息。 |

资产可以通过既有 Cognition 流程暂停、恢复、修订或回滚。个人本体用于组织已
确认的概念与关系，但不会因此授予 Agent 对私密数据目录的不受限访问权限。

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

`cloud` 和 `local` 表示是否具备同步资格，并不代表公开可见或已经上传。
本仓库的开源构建未接入多设备内容同步服务；会话、附件、认知资产和用户配置等
可同步数据在该构建中仍保存在本机，缓存、索引和设备状态属于机器私有域。

Hub 登录用于账户授权和设备绑定，会与账户服务交换必要的账户、安装及设备信息。
登录本身不等于启用内容同步；接入托管同步的构建还受服务配置和账户权益约束。

模型和连接器调用与同步是不同的数据流：任务执行和候选经验提取可能将必要上下文
发送给实际使用的服务。模型凭据通过本地凭据存储访问，并用于请求鉴权；本地 CLI
自行管理登录凭据。托管连接器 OAuth 由服务端发起，客户端收到的授权、Token 和
传输信息在保存前加密。

### 安全控制

| 控制项 | 强制方式 |
|---|---|
| Renderer 隔离 | Context isolation 和 Preload 允许列表阻止直接访问 Node.js。 |
| 无本地 Web 后端 | Main 进程不暴露 HTTP 服务器或本地认证入口。 |
| 路径沙箱 | 文件类工具在入口处校验工作区和附件路径。 |
| 进程收口点 | Runtime Worker、本地 CLI Agent 和 MCP stdio 连接器只能从获准模块启动。 |
| Artifact 隔离 | `chat-app://` 只向沙箱 iframe 提供经校验的 Artifact 文件，不暴露 IPC。 |
| 密钥处理 | 托管密钥和包含 Token 的连接器状态保留在加密的本地存储外观之后。 |
| 工具结果限制 | 大型结果统一经过容量限制和溢出处理。 |
| 用户确认 | 敏感操作必须经过明确授权和确认流程，不能静默提权。 |

## 运行时与依赖

| 组件 | 仓库基线 | 用途 |
|---|---|---|
| Electron | `^41.10.6` | 桌面外壳及 Main/Renderer 进程边界 |
| TypeScript | `^6.0.3` | Main 进程、功能、模型和测试代码 |
| Node.js runtime bundle | `24.17.0` | 基于 Node 的 Skill 和打包后的命令执行 |
| Python runtime bundle | `3.12.13` | Python Skill、包工具和资源测试 |
| uv | `0.11.21` | Python 环境和包管理 |
| SQLite 与 sqlite-vec | 仓库依赖 | 本地结构化存储和知识库向量检索 |
| OfficeCLI | 已准备的平台资源 | 支持文档和办公工作流 |

固定版本的运行时下载项及其校验和记录在
`resources/runtime/manifest.json` 中。

## 仓库结构

| 路径 | 用途 |
|---|---|
| `bootstrap.cjs` | Electron 入口垫片、运行时身份选择和 TypeScript 加载器注册 |
| `src/main/` | Main 进程、IPC、存储、模型适配器、工具函数和功能流程 |
| `src/renderer/` | 经典 HTML、CSS、JavaScript、本地化和桌面 UI |
| `src/core-agent/` | Core Agent 会话、Provider、工具编排和执行循环 |
| `src/main/features/group_chat/` | 会话总线、计划执行、Worker 调度和中止处理 |
| `src/main/features/local_agents/` | 支持的 CLI 检测、适配器、会话和集中运行器 |
| `src/main/features/recall/` | 候选捕获、正式资产、投影、证明和有效性反馈 |
| `src/main/features/connectors/` | 连接器元数据、授权状态、MCP Client 和工具暴露 |
| `resources/builtin/` | 平台 Agent、Skill 和市场种子内容 |
| `resources/runtime/` | 固定版本的运行时清单和平台资源 |
| `p3394-gateway/` | 本地 Bridge 网关、协议集成和发布说明 |
| `test/` | Main 进程、Renderer、资源、原生和跨层测试 |
| `scripts/` | 依赖准备、诊断、打包、审计和验证工具 |

## 开发环境配置

### 前置条件

CogSeed 主要面向 macOS 和 Windows 开发。请使用宿主平台的原生启动器；在
WSL 中会委托给 Windows 启动器，以便输入法和桌面集成运行在 Windows 环境。

配置仓库前，请安装以下宿主工具：

- Git；
- Node.js 24.x，与 CI 使用的版本一致；
- npm 11.11.0，与 `package.json` 中的 `packageManager` 字段一致；
- macOS 上安装 Xcode Command Line Tools，用于原生模块恢复或重建；
- Windows 上安装当前版本的 PowerShell；如果原生依赖没有可用的预构建二进制，
  还需安装 Visual C++ Build Tools。

[运行时与依赖](#运行时与依赖)中列出的 Node.js、Python 和 uv 版本是应用
运行时资源，不能替代正常执行 npm 开发命令所需的宿主 Node.js。

### 安装

体验发布版源码，请使用 [README](../README.zh-CN.md#从源码运行) 中指定版本的命令。
参与开发，请按照[贡献指南](../CONTRIBUTING.zh-CN.md)克隆你的 Fork，
从最新 `upstream/develop` 创建开发分支，然后运行：

```bash
npm ci
npm run test:resources:setup
```

使用 `npm ci` 根据 `package-lock.json` 执行可复现安装。`postinstall`
步骤会重建 Electron 原生模块，并下载开发和测试所需的 Embedding 与语音资源，
因此首次安装需要网络连接，可能耗时数分钟。不要提交下载或生成的运行时产物。

### 从源码运行

在 macOS 或 Linux 上：

```bash
./run.sh
```

在 Windows 上：

```bat
run.cmd
```

启动器会准备依赖，把开发数据隔离到当前 worktree，并以 CogSeed 开发身份启动
Electron。只有使用需要凭证的功能时才需要 API Key 和 Provider 凭证；请在应用
中配置密钥，不要写入仓库文件。

修改代码前，请先确认基线健康：

```bash
npm run typecheck
npm run lint
npm test
npm run readme:check
```

## 开发

### 常用命令

| 命令 | 用途 |
|---|---|
| `./run.sh` | 在 macOS 或 Linux 上启动源码版应用 |
| `run.cmd` | 在 Windows 上启动源码版应用 |
| `npm run typecheck` | 执行 TypeScript 类型检查，不生成文件 |
| `npm run lint` | 检查源代码、测试和脚本 |
| `npm test` | 运行 JavaScript 和资源测试，并管理原生 ABI |
| `npm run test:js -- <file>` | 通过仓库运行器执行单个 JavaScript/TypeScript 测试文件 |
| `npm run test:resources` | 运行 Python 资源测试 |
| `npm run test:coverage` | 运行带覆盖率统计的 JavaScript 测试 |
| `npm run test:platform-native` | 运行平台原生验证 |
| `npm run readme:check` | 校验 README 的本地链接和内置资源 |
| `npm run tokens:check` | 校验 Renderer 设计 Token 约束 |
| `npm run runtime:ensure` | 检查或准备固定版本的运行时包 |
| `npm run builtin:manifest:check` | 检查内置市场清单 |
| `npm run audit:workspace` | 审计本地工作区布局和约束 |
| `npm run diagnose:agents` | 诊断支持的本地 Agent 安装 |
| `npm run rebuild:sqlite:electron` | 修复 Electron SQLite 原生 ABI |
| `npm run rebuild:pty:electron` | 修复 Electron node-pty 原生 ABI |
| `scripts/restart-cogseed.sh` | 只重启当前 worktree 的 CogSeed 运行时 |

请使用 `npm test`，不要直接调用 Vitest。仓库测试运行器会管理 Electron 与
Node 原生 SQLite ABI 的切换和恢复。运行单个 JavaScript 或 TypeScript 测试时，
使用 `npm run test:js -- test/path/file.test.ts`；`npm test -- <file>`
不能可靠地只运行组合测试中的指定文件。

### Pull Request 验证

提交到 `develop` 的 Pull Request 会运行三个必需检查：

- `check-commit-emails`：校验完整提交记录；
- `static-gates`：运行类型检查、Lint、设计 Token、内置资源清单、README
  和跳过测试策略检查；
- `affected-tests`：通过模块依赖图选择相关测试。

Windows 测试分片也会运行。它们目前会报告真实失败，但不作为必需状态检查；
合并前仍应调查并解释红色分片。改动合入 `develop` 后，Nightly 工作流会针对
该分支的准确提交运行完整测试。从 `develop` 提升到 `cicd` 时，会运行完整
的发布验证和合规门禁。

### 开发规则

- IPC 处理器只负责校验和委托给功能层。
- Renderer 使用经典脚本；新文件必须注册到 `src/renderer/index.html`。
- 动态导入 `#core-agent`；静态导入可能破坏启动顺序和 ESM 解析。
- 用户私有数据必须通过当前用户 ID 和规范存储工具访问。
- 启动时异步工作通过 `util/boot_init.ts` 注册。
- 新增 Core Agent 工具时，同时注册到中央目录和运行器接线中。
- 合并涉及 Renderer 到 Main IPC 契约的改动后，运行 `npm run typecheck`。

## 打包

打包与平台相关。本地构建的产物只能作为开发或测试证据；除非已完成签名发布
工作流，否则不能视为官方发布。

### macOS 开发应用

创建未签名、可直接运行的开发应用，并验证其打包运行时：

```bash
npm run package:dev:mac
npm run verify:package:dev:mac
```

应用输出到 `dist-dev/`。代码修改后进行真实环境验证时，只重启当前 worktree：

```bash
scripts/restart-cogseed.sh
```

### 面向发布的构建

仓库提供 `npm run build:mac` 和 `npm run build:win`，用于平台构建诊断。
官方发布产物通过受保护的 `cicd` 和由标签触发的 GitHub 工作流生成，这些流程
会强制执行验证、签名、合规和发布门禁。不要把本地构建描述为已签名、已公证、
已验收或已发布。

## 故障排查

### 原生 SQLite 错误

```bash
npm run rebuild:sqlite:electron
```

### 终端或 node-pty ABI 错误

```bash
npm run rebuild:pty:electron
```

### 缺少内置运行时资源

```bash
npm run runtime:ensure
```

### 无法检测本地 Agent

```bash
npm run diagnose:agents
```

确认对应 CLI 已安装，并且启动 CogSeed 的 Shell 可以访问它。

### Windows 与 WSL

Windows 原生运行时请使用 `run.cmd`。如果 WSL 可以使用所需的 Windows Bridge
命令，Shell 启动器会委托给它。

### 模型连接问题

打开 **Connections → Models & Quota**，重新测试授权，并选择配置的 Provider
返回的模型。不要把 API Key 写入仓库文件或 README 示例。
