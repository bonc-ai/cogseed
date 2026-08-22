<p align="center">
  <img src="./assets/cogseed-icon.png" width="160" alt="CogSeed 产品图标">
</p>

<h1 align="center">CogSeed</h1>

<p align="center">一个本地优先的 AI Agent 协作桌面工作台，将任务经验沉淀为可复用的个人能力资产。</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/license/bonc-ai/cogseed" alt="License">
  <img src="https://img.shields.io/github/actions/workflow/status/bonc-ai/cogseed/ci.yml" alt="CI">
  <img src="https://img.shields.io/github/v/release/bonc-ai/cogseed" alt="Release">
  <img src="https://img.shields.io/github/downloads/bonc-ai/cogseed/total" alt="Downloads">
  <img src="https://img.shields.io/badge/platform-macOS%2012%2B-0071BC" alt="Platform">
</p>

<p align="center">
  <img src="./assets/cogseed-homepage-hero-agent-continuity.png" width="1000" alt="CogSeed 桌面工作台">
</p>

## 项目概览

CogSeed 将任务、工作空间、AI 团队、Skill、Connector、个人知识和可复用的 Cognitive Asset 整合进一个 Electron 桌面应用。它面向那些无法通过单轮对话完成的工作：规划、分派、工具调用、本地项目访问、跨会话延续、可审查的执行证据，以及经验的长期复用。

Commander 维护共享计划，并通过结构化调度分派工作。内置 Agent 和受支持的本地 CLI Agent 都在受控执行路径中运行，每个 worker 只获得其职责所需的上下文。执行结果可以保留为对话输出，也可以成为工作空间文件或 Artifact，还可以进入 Cognition 与 Recall 流程，经用户审查后沉淀为能力资产。

CogSeed 坚持本地优先。Renderer 不能直接访问 Node.js，本地工具必须通过明确的网关运行，用户数据则被划分为可同步的私有状态和仅保留在当前设备上的本地状态。

## 核心亮点

| 能力 | 用途 |
|---|---|
| 结构化多 Agent 协作 | 通过统一的 group-chat 执行路径规划、分派、观察、重试、跳过和停止任务。 |
| 本地 CLI Agent 集成 | 在同一个工作空间中使用 Claude Code、Codex、OpenClaw、OpenCode、Hermes 或 WorkBuddy。 |
| 跨任务连续性 | 导入受支持的会话，并携带工作空间上下文、当前进度、已知约束和执行证据继续工作。 |
| 受治理的 Cognitive Asset | 审查候选经验、确认正式资产、管理版本，并跟踪复用和效果证据。 |
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



## 快速安装

### 环境要求

- Git
- 开发 shell 中可用的 Node.js 和 npm
- 首次安装时可访问网络，用于获取 npm package 和固定版本的运行时资源
- macOS 或 Windows，二者是主要桌面目标平台

克隆仓库并安装依赖：

```bash
git clone https://github.com/bonc-ai/cogseed.git
cd cogseed
npm install
```

仓库锁定使用 `npm@11.11.0`。安装过程会准备 Electron 原生依赖和 embedding 模型。开发环境启动时还会校验或下载已启用功能所需的平台运行时和 OfficeCLI 资源。

## 快速开始

在 macOS 或 Linux 开发环境中启动 CogSeed：

```bash
./run.sh
```

Windows 环境：

```bat
./run.cmd
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

## 架构与数据

CogSeed 是单进程 Electron 应用，桌面后端与界面之间具有明确边界：

- `src/main/` 包含 TypeScript 后端、业务工作流、存储、模型适配器和受控工具执行逻辑。
- `src/renderer/` 使用原生 HTML、CSS 和 JavaScript，不直接访问 Node.js。
- `src/main/preload.js` 只暴露白名单内的 `window.cogseed` Bridge；Renderer 与 Main 之间统一通过规范的 IPC invoke 和 stream 通道通信。
- 本地 CLI Agent 由单一 Runner 作为受管子进程启动；MCP stdio Connector 和隔离运行时 Worker 分别使用各自的专用进程网关。

应用容器内的用户数据按作用域分离。可同步的用户私有数据位于 `data/<uid>/cloud/`，索引、缓存、凭据、本地安装内容及其他机器相关状态位于 `data/<uid>/local/`。开发启动器使用隔离的 `.cogseed` 数据根目录，避免源码开发环境与已安装应用共用状态。

`cogseed://` 协议用于处理经过校验的应用深链接。会话 Artifact 与 Saved App 使用独立解析器和沙箱展示路径，Artifact 内容不能访问 `window.cogseed`。附件保存时不做预处理；图片、音频、文档和普通视频附件可以在会话中展示，其中视频附件仅用于展示，不会作为模型输入。

## 开发与验证

| 命令 | 用途 |
|---|---|
| `npm run typecheck` | 运行 TypeScript 编译检查，不生成构建产物 |
| `npm run lint` | 对源码、测试和脚本运行静态检查 |
| `npm test` | 运行完整 JavaScript 与内置资源测试套件 |
| `npm run readme:check` | 校验两份 README 引用的本地链接和随仓库提供的资源 |
| `npm run builtin:manifest:check` | 校验内置 Marketplace 资源与生成清单是否一致 |
| `./run.sh` | 准备依赖并启动开发版应用 |

贡献流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)，运行时、打包和平台相关说明见 [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)。

## Cognition 与 Recall

Cognition 将经过审阅的工作经验转化为可复用能力资产，而不是默认把每次对话都作为永久记忆。候选经验可以来自会话采集、复盘信号和用户主动教学；正式晋升前需要用户确认，并记录来源、版本、适用范围和审计历史。

Recall 在后续任务中检索已批准的资产并记录复用证据，同时保持不同用户、会话和项目作用域的隔离。可同步的源文件保存在用户私有 cloud 域，派生索引与向量数据只保存在本机。

## 上游署名

CogSeed 基于 [Orkas](https://github.com/Orkas-AI/Orkas) 二次开发，延续并改造了其本地优先的多 Agent 协作与工具链实现。桌面端 `core-agent` 组件源自 [OpenClaw](https://github.com/openclaw/openclaw)。CogSeed 同时参考了 [Hermes-Agent](https://github.com/NousResearch/hermes-agent) 的规划与运行时适配模式。

上游版权和许可证信息见 [`NOTICE`](./NOTICE)，第三方组件声明见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

## 相关文档

| 主题 | 链接 |
|---|---|
| 工程边界和仓库规则 | [AGENTS.md](./AGENTS.md) |
| 贡献指南 | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| 安全策略与漏洞上报 | [SECURITY.md](./SECURITY.md) |
| 源码包内容和启动命令 | [源码包说明](./README-源码包说明.txt) |
| P3394 bridge 网关 *（进阶：跨机器 Agent 协作）* | [Gateway README](./p3394-gateway/README.md) |

## 标准

CogSeed 实现 **IEEE P3394** 智能体互操作标准。代码中以 `p3394` 为前缀的协议字段（例如 `p3394-gateway`、`p3394_bridge` 和 `P3394_*` 环境变量）均指该标准。CogSeed 是独立的开源产品；IEEE P3394 标准归其各自的标准机构所有。

## 许可证

CogSeed 基于 [MIT License](./LICENSE) 发布。
