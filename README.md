# Mate Agent · Mate 智伴

**你的协作型智能体工作台**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)](https://github.com)
[![Node](https://img.shields.io/badge/Node-20%2B-brightgreen)](https://nodejs.org)

Mate Agent 是一个本地优先的 AI 协作工作台。一位**指挥官（Commander）**理解你的目标，拆解任务，调度多个**专业 Agent** 协同完成复杂工作。不写编排代码，不托管数据——对话、文件、API 密钥全部留在你的机器上。

---

## 核心特性

- **指挥官调度** — 指挥官自动分解目标，选择合适的 Agent、Skill、连接器和工具，通用地分析、写作、研究、文件处理和自动化工作。
- **多 Agent 协同** — Agent 可并行或串行执行，各自拥有独立技能、记忆和任务上下文，覆盖编码、调研、数据、视频、PPT 等场景。
- **本地优先** — 对话、文件、API 密钥、知识库和自定义 Agent 存储在本地磁盘，模型调用直连提供商，不经过任何中间服务器。
- **自带模型密钥** — 支持 Claude、OpenAI、Gemini、DeepSeek、Kimi、GLM、Qwen、MiniMax、豆包等，不同 Agent 可使用不同 Provider，无供应商锁定。
- **P3394 治理闭环** — 集成 Wake Gate、KSTAR 运行时和 Experience 闭环，让每个 Agent 具备自我进化能力。
- **可切换指挥官后端** — 默认使用 Orkas Core Agent，也可通过 Adapter 接入 Hermes CLI 等后端。

---

## 项目背景

Mate Agent 基于 [Orkas](https://github.com/Orkas-AI/Orkas) 开源基座构建，在保留其 Conversation / Agent Runtime 核心能力的基础上：

- 引入 P3394 的 Wake、KSTAR、Experience 治理链路
- 独立品牌身份（Mate Agent / Mate 智伴）
- 指挥官后端可配置切换
- 保持现有会话、配置、Agent、Skill 数据兼容

---

## 快速开始

**环境要求**：Node.js 20+ · Python 3 · macOS / Windows 10+ / Linux

```bash
# 克隆仓库
git clone http://10.1.12.6:54170/lhcx/project-group/opensource/team-02/mate-agent.git
cd mate-agent

# 启动（macOS / Linux）
./run.sh

# 启动（Windows）
run.cmd
```

首次启动会自动安装依赖并下载嵌入模型（约 95 MB）。工作区创建在 `~/.mate-agent/`（macOS/Linux）或最小非系统盘根目录（Windows）。

启动后进入 **设置 → AI Provider** 添加 API 密钥或 OAuth 授权。

---

## 技术架构

| 层级 | 说明 |
|---|---|
| `src/main/` | Electron 主进程 — Node.js 后端 |
| `src/renderer/` | 前端 UI — 纯 HTML/CSS/JS，无 bundler |
| `src/core-agent/` | 核心 Agent 引擎 |
| `src/main/features/p3394/` | Wake Gate / KSTAR / Experience 治理模块 |
| `src/main/features/local_agents/` | 本地 CLI Agent 集成 |
| `resources/builtin/` | 内置 Agent 和 Skill |
| `test/` | 测试套件 |

### 关键设计约束

- 单进程 Electron 应用，主进程是 Node 后端，渲染进程是原生 HTML/CSS/JS
- IPC 是唯一的通信路径，通过 `contextBridge` 暴露 `window.mate-agent.invoke/stream`
- 渲染进程不使用 TypeScript/JSX/打包器
- 用户数据以 JSON/JSONL 存储，KB 向量库使用 SQLite
- 新增 npm 依赖需要讨论；渲染进程第三方 JS/CSS 放在 `src/renderer/vendor/`

---

## 品牌规范

| 项目 | 值 |
|---|---|
| 英文名 | Mate Agent |
| 中文名 | Mate 智伴 |
| 定位语 | 你的协作型智能体工作台 |
| 应用 ID | `com.mateagent.desktop` |
| 协议 | `mateagent://` |
| 主色 | 智能紫 `#7C3AED` · 协作蓝 `#3B82F6` · 星际青 `#22D3EE` |

---

## 文档

- [文稿总目录](./docs/README.md) — 设计依据、规格文档、实施计划索引
- [品牌设计规范](./docs/superpowers/specs/2026-07-22-mate-agent-brand-design.md)
- [指挥官后端设计](./docs/superpowers/specs/2026-07-22-mate-agent-commander-backend-design.md)
- [项目约束](./CLAUDE.md) — 仓库级设计约束与工作规则

---

## 开源致谢

核心模块参考了以下开源项目：

- [Orkas](https://github.com/Orkas-AI/Orkas) — Agent Runtime 基座
- [Hermes-Agent](https://github.com/NousResearch/hermes-agent) — 可选指挥官后端

---

## 许可证

[MIT](./LICENSE)
