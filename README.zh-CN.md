<p align="center">
  <img src="./assets/cogseed-icon.png" width="160" alt="CogSeed 产品图标">
</p>

<h1 align="center">CogSeed</h1>

<p align="center">一个本地优先的桌面工作台，用于协同多个 AI Agent，并把任务经验沉淀为可复用的个人能力资产。</p>

<p align="center">
  <a href="./README.md">English</a> | <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="./assets/cogseed-homepage-hero-agent-continuity.png" width="1000" alt="CogSeed 桌面工作台">
</p>

## 项目概览

CogSeed 将任务、空间、Agent、Skill、Connector、知识资料和可复用的认知资产整合到一个 Electron 桌面应用中。Commander 维护共享计划并通过结构化分派组织工作，每个 Agent 只接收其职责所需的上下文。

应用采用本地优先架构：renderer 只能通过明确的 preload 白名单访问 Node.js 主进程，本地 CLI Agent 由受控的子进程适配器运行，用户数据则被划分为可同步数据和机器本地数据。

## 核心亮点

| 能力 | 带来的价值 |
|---|---|
| 结构化多 Agent 协作 | 通过统一群聊执行链路规划、分派、观察、重试和终止任务。 |
| 本地 CLI Agent 接入 | 在同一工作台使用 Claude Code、Codex、OpenClaw、OpenCode、Hermes 或 WorkBuddy。 |
| 跨任务接续 | 导入受支持的本地会话，并携带工作空间上下文和执行证据继续工作。 |
| 可治理的认知资产 | 审核候选经验、提升已确认资产，并追踪复用与效果证据。 |
| 工具与知识连接 | 让受支持的 Agent 在受控范围内使用 Skill、MCP Connector 和资料库内容。 |
| 本地优先边界 | 将机器私有状态、索引、缓存和凭据置于明确的存储与安全边界之后。 |

## 架构

```text
┌─────────────────────────────────────────────────────────┐
│ Renderer: 原生 HTML / CSS / JavaScript                  │
│ 任务 · 空间 · 自动化 · 认知资产 · 连接                  │
└───────────────────────────┬─────────────────────────────┘
                            │ window.cogseed.invoke / stream
┌───────────────────────────▼─────────────────────────────┐
│ Preload: contextBridge 白名单                           │
└───────────────────────────┬─────────────────────────────┘
                            │ Electron IPC
┌───────────────────────────▼─────────────────────────────┐
│ 主进程: IPC 参数验证 → Feature 工作流                   │
│ 群聊调度 · Recall · 知识库 · Connector                  │
└──────────────┬────────────────┬────────────────┬────────┘
               │                │                │
               ▼                ▼                ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ Core Agent       │  │ Runtime Worker   │  │ 子进程           │
│ 进程内执行       │  │ JSONL 协议       │  │ 本地 CLI / MCP   │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

## 快速安装

克隆仓库并安装依赖：

```bash
git clone http://10.1.12.6:54170/lhcx/project-group/opensource/team-02/cog-seed
cd cog-seed
npm install
```

仓库锁定 `npm@11.11.0`。安装和开发启动流程会准备 Electron 原生依赖、嵌入模型以及所需的平台资源。macOS 和 Windows 是主要桌面目标平台。

## 快速开始

在 macOS 或 Linux 开发环境中启动：

```bash
./run.sh
```

在 Windows 中启动：

```bat
run.cmd
```

桌面工作台打开后：

1. 进入 **连接 → 模型与额度**。
2. 添加 API Key，或从 CC Switch 导入受支持的授权。
3. 测试连接并选择可用模型。
4. 新建任务，输入 `@` 选择 Agent、Skill、Connector 或资料库文件。

## 本地 Agent 支持

CogSeed 内置以下 CLI 的受控适配器：

- Claude Code
- Codex
- OpenClaw
- OpenCode
- Hermes
- WorkBuddy

每个 CLI 仍然是独立的本地工具。CogSeed 通过统一的本地 Agent runner 管理任务分派、工作目录上下文、会话接续、过程事件、取消操作和文件变更证据。

## Cognition 与 Recall

任务经验可以进入可审核的认知流程：

- 会话和 review 信号会产生候选经验。
- 候选在用户确认或拒绝前保持待处理状态。
- 已确认资产拥有稳定身份、版本、scope 和审计信息。
- 复用记录与效果证据用于说明资产是否进入后续工作。
- Personal Ontology 和工作空间引用用于组织已确认知识。

## 工具、知识与连接

- Skill 通过已安装的 Skill catalog 和专用 Runtime runner 执行。
- MCP Connector 通过 list-and-call meta-tools 暴露已连接服务，而不是平铺全部工具。
- 资料库保存用户管理的上下文源文件，派生索引和向量数据保留在机器本地。
- Agent 通过知识库工具访问资料库，不直接扫描上下文目录。
- 模型授权支持 API Key、受支持的 OAuth 流程、自定义端点，以及在已配置时从 CC Switch 导入。

## 数据与安全边界

用户数据按以下结构划分：

```text
<container>/data/<uid>/
├── cloud/   可同步的用户私有状态
└── local/   机器私有状态、缓存、索引和本地安装内容
```

主要边界：

- renderer 不能直接访问 Node.js。
- 应用通信通过 `window.cogseed` preload API 和 Electron IPC 完成。
- 主进程不暴露本地 HTTP 服务。
- 文件工具检查工作空间和附件路径边界。
- Runtime shell 与 Skill 执行经过专用工具入口。
- 包含 token 的 Connector 和账户数据由本地 secret-storage facade 管理。

## 仓库结构

| 路径 | 作用 |
|---|---|
| `src/main/` | Electron 主进程、IPC、存储、模型与业务工作流 |
| `src/renderer/` | 原生 HTML、CSS、JavaScript、本地化和桌面 UI |
| `src/core-agent/` | Core Agent 执行、模型 provider、会话和工具 |
| `resources/builtin/` | 平台 Agent、Skill 和 marketplace 种子内容 |
| `resources/runtime/` | 已校验的 Runtime 清单和平台资源 |
| `test/` | 主进程、renderer、资源和跨层测试 |
| `docs/` | 架构、实施、交接和集成文档 |

## 开发与验证

运行 TypeScript 检查：

```bash
npm run typecheck
```

运行完整测试：

```bash
npm test
```

请使用 `npm test`，不要直接调用 Vitest；仓库测试脚本会管理原生 SQLite ABI 的准备与恢复。

修改后重启开发应用：

```bash
scripts/restart-cogseed.sh
```

## 文档

| 主题 | 链接 |
|---|---|
| 工程边界与协作规则 | [AGENTS.md](./AGENTS.md) |
| Runtime variant 隔离 | [Runtime variants](./docs/runtime-variants.md) |
| 外部消息触点 | [Touchpoint v2 快速开始](./docs/touchpoint-v2-quickstart.md) |
| P3394 实施证据 | [P3394 符合性矩阵](./docs/P3394-Conformance-Matrix.md) |

## 许可证

CogSeed 使用 [MIT License](./LICENSE)。
