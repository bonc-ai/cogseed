# CogSeed

**跨 Agent 的个人能力资产层 · 本地优先的多智能体协作工作台**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue)](#快速开始)
[![Electron](https://img.shields.io/badge/Electron-desktop-47848F)](https://www.electronjs.org/)

CogSeed 把指挥官、专业 Agent、本地 CLI Agent、Skill、Connector、知识上下文和 Cognition Assets 放进同一个桌面工作台。用户提出目标后，Commander 通过结构化计划和分派调度不同成员执行；任务过程中形成的经验可以进入 Recall / Cognition 治理链路，经过确认、复用与效果证明后沉淀为跨 Agent 的个人能力资产。

CogSeed 是本地优先的 Electron 应用。主进程承担 Node.js 后端职责，renderer 使用原生 HTML/CSS/JavaScript；应用内部通信只经过 preload 暴露的 `window.cogseed.{invoke, stream}` IPC API，不启动本地 HTTP 服务。

---

## 核心能力

### Commander 与多 Agent 协作

- Commander 理解目标、维护共享计划，并通过结构化 `dispatch_to` 分派任务。
- Agent 可以串行或并行工作，但每个 worker 只读取自己的可见性切片，而不是完整群聊记录。
- 计划、消息、过程事件和终止状态都经过统一 group-chat bus，避免重复调度路径。
- 用户可以在一个会话中观察成员状态、工具过程、产物和任务交接。

### 本地 CLI Agent

CogSeed 可以把本机已安装的编码 Agent 作为受控子进程接入协作流程，包括：

- Claude Code
- Codex
- OpenCode
- OpenClaw
- Hermes

CLI 调度集中经过 `src/main/features/local_agents/runner.ts`；不同 CLI 的会话恢复、工作目录、环境变量和文件变更证据由主进程统一管理。

### Cognition Assets / Recall

CogSeed 不只保存聊天记录，还维护可治理的个人能力资产：

- 从会话、教学信号和 KSTAR review 中产生候选经验。
- 只有用户确认后，候选才可提升为正式 Ability Asset。
- 资产拥有稳定 ID、版本、scope policy、审计记录和暂停/恢复/撤销状态。
- 已确认资产可投影到后续任务，并通过 Transfer Proof 证明是否实际进入执行。
- 用户反馈和 Effectiveness Proof 用于判断复用效果，并可触发暂停或 rework 建议。

### KSTAR 与 Personal Ontology

- KSTAR 记录需求、执行事实、review 与能力缺口。
- Recall bridge 把已确认投影和任务终止事实接回能力资产证明链路。
- Personal Ontology 用于组织用户确认的概念、规则和长期知识关系。
- 外部 KSTAR engine 只有在显式配置时才启用；未配置时应用保持降级可用。

### Context、Knowledge Base 与记忆

- 用户管理的 Context 源文件属于可同步的私有数据。
- 派生索引、向量数据库和模型缓存保留在本机。
- Agent 只能通过知识库工具访问 Context，不直接扫描 Context 数据目录。
- Commander、Agent、项目和会话记忆由明确的数据域和权限边界管理。

### Connectors、Messaging 与 CC Switch

- Connector 使用 OAuth 或 MCP stdio 接入外部服务，并通过 umbrella meta-tools 暴露给模型。
- Messaging 支持把外部消息接入正常群聊调度链路。
- 模型授权支持 API Key、OAuth 和自定义端点。
- 可从本机 CC Switch 数据库预览并导入支持的模型凭据；导入前会展示脱敏结果，原始 Key 不进入 renderer。
- Claude Code 与 Codex 的历史会话、技能和记忆可以在 onboarding / continue-work 流程中导入。

---

## 架构

```text
┌─────────────────────────────────────────────────────────────┐
│ Renderer: classic HTML / CSS / JavaScript                  │
│ Settings · Conversations · Agents · Skills · Cognition     │
└───────────────────────────┬─────────────────────────────────┘
                            │ window.cogseed.invoke / stream
┌───────────────────────────▼─────────────────────────────────┐
│ Preload contextBridge allow-list                            │
└───────────────────────────┬─────────────────────────────────┘
                            │ Electron IPC
┌───────────────────────────▼─────────────────────────────────┐
│ Main process: IPC validation → feature workflows            │
│ Storage · Group Chat · Recall · KSTAR · Connectors          │
├─────────────────────────────────────────────────────────────┤
│ In-process Core Agent       │ Isolated CogSeed Runtime      │
│ Local CLI Agent runners     │ MCP stdio connectors          │
└─────────────────────────────────────────────────────────────┘
```

主要目录：

| 路径 | 职责 |
|---|---|
| `src/main/` | Electron 主进程、IPC、存储、模型适配和业务 feature |
| `src/renderer/` | 原生 renderer UI、样式、本地化和交互逻辑 |
| `src/core-agent/` | Core Agent 会话、provider、工具和执行循环 |
| `src/main/features/cogseed_runtime/` | 隔离 Runtime host、worker 与 JSONL 协议 |
| `src/main/features/cogseed_backend/` | 任务、调度、能力和协作后端 |
| `src/main/features/recall/` | Cognition/Recall 捕获、候选、资产、投影和证明 |
| `src/main/features/local_agents/` | Claude/Codex/OpenCode/OpenClaw/Hermes 集成 |
| `resources/builtin/` | 平台 Agent、Skill 和 marketplace 种子内容 |
| `test/` | 主进程、renderer、资源和跨层契约测试 |

完整工程边界请阅读 [`AGENTS.md`](./AGENTS.md)。

---

## 快速开始

### 环境要求

- Node.js 20+
- npm（仓库锁定 `npm@11.11.0`）
- Python 3
- macOS 或 Windows 10+

Linux 可用于部分源码开发和测试，但 macOS、Windows 是主要桌面目标平台。

### 获取源码

```bash
git clone https://github.com/cogseed/cogseed.git
cd cogseed
npm install
```

`npm install` 会准备 Electron 原生依赖和嵌入模型。运行时、OfficeCLI、FFmpeg 和 Whisper 等资源由项目脚本按平台验证或准备。

### 启动

macOS / Linux shell：

```bash
./run.sh
```

Windows：

```bat
run.cmd
```

源码启动器锁定 `cogseed` runtime variant，并使用独立的 App ID、Electron userData、单实例锁和数据目录。

### 配置模型

启动后进入 **设置 → 模型授权**：

1. 选择 OAuth、手动 API Key 或 CC Switch 导入。
2. 测试授权并发现可用模型。
3. 选择模型并设置默认模型。
4. 按 Agent 或 Commander 需要绑定授权。

---

## 数据与隐私

macOS/Linux 的 canonical container 是：

```text
~/.cogseed/
```

源码 `cogseed` variant 使用：

```text
~/.cogseed/runtime-variants/cogseed/
├── data/
├── electron-user-data/
└── userWorkSpace/
```

用户数据位于：

```text
<data>/<uid>/
├── cloud/   # 可同步的用户私有状态
└── local/   # 机器私有状态、缓存、索引和本地安装内容
```

关键原则：

- API Key 和 token 通过本地 secret facade 加密保存。
- renderer 不能直接访问 Node API，只能使用 `window.cogseed` allow-list。
- CogSeed 不在主进程中启动本地 HTTP 服务。
- Artifact iframe 不暴露 IPC，通过受验证的 `postMessage` 合约与宿主通信。
- 模型调用使用用户选择的 provider/授权；不同 hosted 功能仍按账户和 entitlement 边界处理。

---

## 开发与测试

安装依赖：

```bash
npm install
```

类型检查：

```bash
npm run typecheck
```

完整测试：

```bash
npm test
```

请使用 `npm test`，不要直接运行 `npx vitest`；测试脚本会管理 Electron/Node 原生 SQLite ABI 的切换和恢复。

常用命令：

```bash
npm run rebuild:sqlite:electron
npm run rebuild:pty:electron
npm run test:platform-native
scripts/restart-cogseed.sh
```

分支协作：

- 功能工作使用 `dev/*` 分支。
- 所有改动通过 GitLab MR 进入受保护的 `develop`。
- `main` 是正式发布镜像，不承载独立开发提交。

---

## Mate Agent / CogSeed 迁移兼容

CogSeed 已经是当前正式产品身份。为保证已有安装、回调和本地数据平滑迁移，以下旧入口保留一个发布周期：

- `cogseed://` 与 `cogseed://` deep link 会归一化为 `cogseed://`。
- `COGSEED_*` 环境变量会映射到 canonical `COGSEED_*` 配置。
- `.cogseed` / `.cogseed-dev` 数据根会通过只复制、校验和 marker 机制迁移到 `.cogseed` / `.cogseed-dev`。
- `cogseed` runtime variant 仅作为 deprecated legacy identity。
- `bin/cogseed-bridge.cjs` 与 `bin/cogseed-runtime-worker.cjs` 仅是兼容 wrapper。

新代码、新文档和新生成的 URL 必须使用 CogSeed 标识。旧兼容入口将在迁移观察周期结束后单独删除。

---

## 文档

- [`docs/README.md`](./docs/README.md) — 当前文档索引与开发口径
- [`AGENTS.md`](./AGENTS.md) — 工程约束、数据边界和协作规则
- [`docs/superpowers/specs/2026-08-11-cogseed-official-cutover-design.md`](./docs/superpowers/specs/2026-08-11-cogseed-official-cutover-design.md) — 正式切换设计

---

## Attribution

CogSeed 延续并改造了既有开源 Agent Runtime、协作和工具链实现，也参考了 CogSeed、Hermes-Agent、OpenClaw 等项目。历史来源名称仅用于准确 attribution 和兼容迁移，不代表当前产品名称。

## License

[MIT](./LICENSE)
