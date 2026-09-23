<p align="center">
  <img src="./assets/cogseed-icon.png" width="150" alt="CogSeed">
</p>

<h1 align="center">CogSeed</h1>

<p align="center">
  <strong>让 AI 越用越懂你</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/bonc-ai/cogseed/releases"><img src="https://img.shields.io/badge/Release-v1.2.0-blue" alt="Release v1.2.0"></a>
  <a href="https://github.com/bonc-ai/cogseed/releases"><img src="https://img.shields.io/github/downloads/bonc-ai/cogseed/total?label=Downloads" alt="Downloads"></a>
  <a href="https://github.com/bonc-ai/cogseed/stargazers"><img src="https://img.shields.io/github/stars/bonc-ai/cogseed?style=flat" alt="GitHub Stars"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/bonc-ai/cogseed" alt="License"></a>
  <img src="https://img.shields.io/badge/macOS-12%2B-black?logo=apple" alt="macOS">
  <img src="https://img.shields.io/badge/Windows-x64-0078D4?logo=windows" alt="Windows">
</p>

**CogSeed 是你的个人伴侣智能体。**
它把工作中被验证过的偏好、项目约束和有效做法，沉淀为由你确认、可追溯、可撤销的**认知资产**，在下一次任务中按需复用。

即使你从 Codex 换到 Claude Code 或其他已支持的 Agent，CogSeed 也能在适用范围内带着任务进度和认知资产，继续把工作做完。

<p align="center">
  <a href="https://github.com/bonc-ai/cogseed/releases"><strong>⬇️ 下载 CogSeed</strong></a>
  ·
  <a href="#-快速开始"><strong>快速开始</strong></a>
  ·
  <a href="#-基于-cogseed-构建什么"><strong>开发扩展</strong></a>
  ·
  <a href="#-常见问题"><strong>常见问题</strong></a>
</p>

<p align="center">
  <img src="./assets/cogseed-asset-reuse.gif" width="800" alt="认知资产复用演示：已确认的经验在后续相关任务中按需复用">
</p>

认知资产复用演示：查看已确认的经验如何在后续相关任务中被带入和使用。

---

## 一次确认，让下一次工作少从头开始

你不必每次都重新向 Agent 解释"这个项目怎样写代码""哪些规则不能碰""我偏好怎样协作"。

任务结束或导入历史会话后，CogSeed 会从中提炼值得保留的偏好、约束和有效做法，作为候选经验交给你审核。经你确认后，这些经验将成为认知资产，在后续相关任务中按需复用。

**CogSeed 不会把对话悄悄变成长期记忆。** 候选经验需要你确认；每条资产都保留来源、版本和适用范围，并可随时编辑、暂停或撤销。

```text
完成一次任务
  → 生成候选经验（偏好、约束、有效做法）
  → 你确认、修改或拒绝
  → 形成带来源与范围的认知资产
  → 下一个任务或切换已支持 Agent 时按需复用
  → 你可以随时查看效果、编辑、暂停或撤销
```

---

## 你将得到什么

| 你的结果 | 一句话说明 |
|---|---|
| **不必反复解释自己和项目** | 已确认的偏好、规则和约束，在合适的任务中按需出现，并标明来源 |
| **换 Agent 也能接着做** | 在已支持的 Agent 之间带着任务目标、进度、工作空间和可用资产继续工作 |
| **经验始终由你掌控** | 先候选、后确认；每条资产可以查看来源、编辑、暂停、撤销 |

<p align="center">
  <img src="./assets/cogseed-asset-detail.png" width="800" alt="认知资产详情：来源、版本、使用记录，以及暂停使用、归档、撤回使用等操作">
</p>

在资产详情中查看来源、版本和使用记录，管理这条经验的适用范围与使用状态。

<p align="center">
  <img src="./assets/cogseed-session-continuity.png" width="800" alt="导入历史会话后，查看接续快照与建议计划，点击“带着这些继续”">
</p>

---

## 🚀 快速开始

已有本地 Agent：先确认安装、登录和额度可用。

没有本地 Agent：先在「模型与额度」配置并测试模型。

候选经验提取的模型选择与 Key 要求，见[内置能力与 Key](#内置能力与-key)。

<p align="center">
  <img src="./assets/cogseed-demo.gif" width="800" alt="CogSeed 操作演示">
</p>

### 我已经在用 Claude Code / Codex 等 Agent

前提：本机已安装并登录你正在使用的 Agent（见下方[支持范围](#-支持范围与数据边界)），并且有一段可继续的历史会话。

1. 从 [发布页面](https://github.com/bonc-ai/cogseed/releases) 下载并启动 CogSeed，按引导检测本机 Agent。
2. 在"从哪里继续？"中选择推荐的最近任务，或点"选择其他会话"找到想接续的历史会话。读取会话内容前，由你确认授权。
3. 查看将被导入的目标、进度和工作空间信息。CogSeed 只读取，不会写回原 Agent 的会话。
4. 点击"带着这些继续"，让 Agent 从已有进度开始执行；你也可以在对话中补充新的要求。
5. 任务完成后，在「任务结果确认」卡片中给出判断；有候选经验产生时，在「认知资产 → 待我处理」中核对内容、来源和适用范围，再确认保留。
6. 新建一个相关任务，在相同项目或适用范围内继续工作。打开任务信息中的「本次携带」，查看带入内容及来源；再到「认知资产」打开对应资产详情，检查「使用记录」是否关联这次任务，并对照输出检查约束是否生效。

判断复用时，请结合目标任务的带入记录和实际输出；创建、版本变更记录只说明资产发生了保存或修改。

### 还没有历史任务？

先配置模型 Key，再新建任务，由指挥官和内置 Task Agent 执行。可以按下面的两次任务示例体验：

1. **第一次任务**：提供本周进展，并说明「请整理项目周报，以后这个项目的周报都按成果、风险、下一步组织」。任务结束后，如生成了对应候选，在「待我处理」中核对并确认，检查适用范围是否包含该项目或报告任务。
2. **第二次任务**：在同一项目中新建任务，提供新的进展，只要求「整理本周周报」，不重复格式偏好。按第 6 步检查带入记录，再看输出是否按上述结构组织。

如果没有出现候选，先检查提取所用的模型或 Agent 是否可用；如果第二次任务未带入资产，检查资产是否已确认、处于启用状态，以及适用范围是否匹配。

---

## 📋 支持范围与数据边界

### 本地 Agent

| Agent | CogSeed 版本 | 导入历史会话 | 接续执行 |
|---|---|---|---|
| Claude Code | v1.2.0 | ✅ | ✅ |
| Codex | v1.2.0 | ✅ | ✅ |
| OpenCode | v1.2.0 | ✅ | ✅ |
| WorkBuddy | v1.2.0 | ✅ | ✅ |

本地 Agent 需在本机安装并完成登录。兼容性取决于 CogSeed 与 CLI 的版本组合；导入或执行遇到问题时，请在反馈中注明双方版本和操作系统。

更多 Agent Adapter 在持续增加，欢迎在 [Issues](https://github.com/bonc-ai/cogseed/issues) 提出你希望接入的 Agent。

### 内置能力与 Key

| 能力 | 是否需要配置模型 Key | 数据去向 |
|---|---|---|
| 接续本地 Agent 的任务 | 否，沿用各 Agent 自己的登录状态 | 发送给对应 Agent 及其背后的模型服务 |
| 指挥官、Task Agent 的内置模型执行 | 在 **模型与额度** 中配置可用模型；使用自有 API 时需 Key（BYOK） | 发送给所配置的模型服务商 |
| 导入历史会话、任务结束后的候选经验提取 | 可使用已配置模型；未配置模型时可调用可用的本地 CLI Agent，无需额外 Key。仍需有效登录与可用额度 | 发送给所配置模型服务商，或实际承担提取的本地 Agent 及其模型服务 |
| 从消息生成认知草稿等其他模型入口 | 按入口要求配置可用模型 | 发送给实际调用的模型服务 |
| MCP 连接器、外部服务 | 视服务而定 | 发送给你接入的对应第三方服务 |

### 数据与凭据

- **本地保存。** 本仓库的开源构建可不登录使用，未接入多设备数据同步服务；任务、附件和认知资产等保存在本机。
- **账户与同步。** Hub 登录用于账户授权和设备绑定，会与账户服务交换必要的账户、安装及设备信息。登录本身不等于启用内容同步；支持托管同步的构建还受服务配置和账户权益约束。
- **可同步数据的边界。** [开发指南](./docs/DEVELOPMENT.zh-CN.md#数据与安全)列出的可同步域包括会话、附件、产物、项目、记忆、认知资产及用户配置等；本地缓存、索引和设备状态属于机器私有域。可同步资格不等于当前构建已经同步，也不意味着工作空间里的代码文件会全部自动上传。
- **模型与外部服务。** 执行任务或提取候选经验时，必要的会话内容、文件片段及资产上下文可能发送给实际使用的 Agent、模型 API 或连接器服务。未启用 CogSeed 同步不代表这些调用离线完成。
- **凭据保护。** 模型凭据通过本地凭据存储访问，并在请求模型服务时用于鉴权。本地 CLI 使用自己的登录凭据。托管连接器 OAuth 由服务端发起，客户端收到的授权、Token 和传输信息以加密字段保存。

### 平台

| 平台 | 正式支持 |
|---|---|
| macOS 12+ | Apple Silicon 与 Intel |
| Windows | x64 |

### 能力与使用条件

本说明适用于 **v1.2.0**，安装包与发布历史见 [Releases 页面](https://github.com/bonc-ai/cogseed/releases)。

| 能力 | 使用条件与范围 |
|---|---|
| 认知资产沉淀与复用 | 提取需要可用的模型或 Agent；确认后的资产按任务需要、适用范围和启用状态参与复用 |
| 本地 Agent 导入与接续 | 需安装并登录受支持的 CLI；导入读取原会话，接续在 CogSeed 中执行 |
| 指挥官多 Agent 协作 | 需配置相应模型或执行 Agent；按任务需要分派工作 |
| Skills / MCP 连接器 / 知识库 | Skill 需安装；连接器需完成对应服务配置与授权；知识库需导入资料 |
| P3394 Gateway 互通 | 需配置双方端点、网络与鉴权；接入方式和实现范围见 Gateway 文档 |

---

## 🧠 CogSeed 如何工作

### 认知资产

认知资产是 CogSeed 从你的工作中提炼、由你确认的经验。它分为几类：

- **个人本体**：你的偏好、工作方式、规则和约束
- **Skills**：可复用、可安装的方法与流程

来源说明经验从哪里来，适用范围决定在哪些任务中参与检索，版本保留修改过程。确认一条资产并不意味着每次任务都带入它。

### KSTAR：从一次任务到一条资产

KSTAR 是 CogSeed 记录"任务预期 → 实际执行 → 结果反馈 → 经验沉淀"的学习闭环：

```text
任务执行前：记录预期结果
      │
      ▼
任务执行后：对照实际结果 vs 预期
      │        （你只需点一下：达到 / 部分 / 未达到，或补一句纠正）
      ▼
候选经验：偏好、约束、有效做法
      │
      ▼  你确认后
正式认知资产
      │
      ▼
后续任务：Recall 按需检索相关资产，提供给已支持 Agent，
          结合使用记录、任务输出和结果反馈判断是否帮上忙
```

### 任务接续：换 Agent 继续工作

CogSeed 保存任务目标、工作空间、已完成进度、已知约束和执行证据，也支持导入已支持 Agent 的历史会话：

```text
今天    Codex 完成代码分析
          ↓
明天    Claude Code 接手继续实现
          ↓
后续    其他已支持 Agent 继续测试与整理
```

接续任务时，CogSeed 按任务需要和适用范围带入已确认的认知资产，减少向新 Agent 重复说明项目规则的工作。

### 多 Agent 协作：复杂任务时按需协作

复杂任务需要时，指挥官会协调最小必要的 Agent 集合：

```text
你的目标
   │
   ▼
指挥官 ── 生成计划、分派、跟踪状态
   │
   ├──► Codex          代码分析 / 修改
   ├──► Claude Code    架构分析 / 实现
   └──► 其他已支持 Agent  调研 / 验证 / 工具调用
                │
                ▼
             汇总结果
```

每个 Agent 只拿到自己那部分需要的上下文。你能在一个界面看到计划、每个成员的状态、执行过程、文件变更和最终产物，而不是几个互不相干的黑盒终端。

### Skills / MCP / 连接器：扩展能力

可以为 Agent 安装 Skill、接入 MCP 连接器和外部服务、挂载知识库文件。安装 Skill 或连接 MCP 不需要改动 CogSeed 源码，在应用内完成即可。

---

## 🛠 基于 CogSeed 构建什么

CogSeed 是一个适合扩展的 Agent Workspace。按你想做的事选择入口：

| 方向 | 你能得到什么 | 从哪里开始 | 成熟度 |
|---|---|---|---|
| **Skill** | 提交可复用 Skill 候选 | [社区 Skill 最小试点](./community/skills/README.zh-CN.md)：目录模板、评测案例、提交流程 | 社区试点；仓库合并、应用导入与分发是独立环节 |
| **Agent Adapter** | 接入一种新的本地 Agent | `src/main/features/local_agents/backends/` 下的现有实现 | 源码扩展 |
| **MCP / 连接器** | 接入一个外部服务 | 应用内直接配置；源码扩展见 `src/main/features/connectors/` | 应用内接入 / 源码扩展 |
| **产品贡献** | 修复功能或补足体验 | [`good first issue`](https://github.com/bonc-ai/cogseed/labels/good%20first%20issue) · [`help wanted`](https://github.com/bonc-ai/cogseed/labels/help%20wanted) · [`documentation`](https://github.com/bonc-ai/cogseed/labels/documentation) | 持续维护 |

Skill 和 MCP 扩展不需要 Fork 主仓库；Fork 主要用于源码修改、Adapter 实现或定制内部版本。

### 从源码运行

以下命令用于运行 v1.2.0 发布版源码。

```bash
git clone --branch v1.2.0 https://github.com/bonc-ai/cogseed.git
cd cogseed
npm ci
./run.sh        # macOS / Linux
```

Windows 使用 `run.cmd`。环境要求（Node.js 24.x、npm 11.11.0）、开发命令和打包说明见[中文开发指南](./docs/DEVELOPMENT.zh-CN.md)，工程边界见 [AGENTS.md](./AGENTS.md)。

开发契约：Renderer 只能通过允许列表中的 `window.cogseed` 桥接访问主进程；开发启动器把源码版状态隔离在 `.cogseed` 根目录下；经过校验的应用深链使用 `cogseed://` 协议。提交源码改动前请运行 `npm test`，完整边界与验证命令见[中文开发指南](./docs/DEVELOPMENT.zh-CN.md)。

### 提交贡献

如需参与开发，请按[中文贡献指南](./CONTRIBUTING.zh-CN.md)从最新 `develop` 创建开发分支。

Pull Request 请提交到 `develop` 分支，使用 DCO 签署提交。详细流程、Git 身份要求和评审规则见[中文贡献指南](./CONTRIBUTING.zh-CN.md)；如中英文内容不一致，以英文版为准。

---

## ❓ 常见问题

**我的代码会被上传到 CogSeed 吗？**
本仓库的开源构建未接入多设备内容同步。任务执行与经验提取仍可能把所需上下文发送给实际使用的 Agent、模型或连接器服务。支持托管同步的构建还受服务配置和账户权益约束，详见[数据与凭据](#数据与凭据)。

**认知资产会不会把错误的经验也记下来？**
不会自动转正。所有候选经验都需要你确认；每条资产可以查看来源、编辑、暂停或撤销。

**需要自己的 API Key 吗？**
不一定。本地 Agent 执行沿用 CLI 登录；导入会话和任务结束后的候选提取，在未配置模型时也可调用可用的本地 CLI。使用内置模型执行或其他要求模型配置的入口时，需先配置可用模型；使用自有 API 时在「模型与额度」中填写并测试 Key。详见[内置能力与 Key](#内置能力与-key)。

**不装 Claude Code 或 Codex 能用吗？**
可以。CogSeed 内置了 Task Agent，配置模型 Key 后即可直接形成多 Agent 协作。

**和直接用 Claude Code / Codex 有什么区别？**
CogSeed 是与你持续协作的个人伴侣智能体。它把工作中经你确认的偏好、约束和方法沉淀为认知资产，在后续任务中按需复用，并协调 Claude Code、Codex 等已支持的 Agent 完成工作。

**支持 Skills、MCP、连接器吗？**
支持。可以为 Agent 安装 Skill、接入 MCP 连接器和外部服务、挂载知识库文件。

---

## 💬 社区与安全

- Bug 请提 [Issues](https://github.com/bonc-ai/cogseed/issues)
- 产品建议、使用经验和想法讨论请到 [Discussions](https://github.com/bonc-ai/cogseed/discussions)
- 安全问题请不要创建公开 Issue，通过 GitHub Private Vulnerability Reporting 私下提交，详见 [SECURITY.md](./SECURITY.md)

CogSeed 提供面向 Agent 互通的 P3394 Gateway；实现范围、接入方式和审查说明见 [p3394-gateway/README.md](./p3394-gateway/README.md)。

---

## 🙏 致谢

CogSeed 基于 [Orkas](https://github.com/Orkas-AI/Orkas) 二次开发，桌面端 `core-agent` 组件源自 [OpenClaw](https://github.com/openclaw/openclaw)，并参考了 [Hermes-Agent](https://github.com/NousResearch/hermes-agent) 的规划与运行时适配模式。

上游版权与第三方许可信息见 [NOTICE](./NOTICE) 和 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

---

## 📄 License

CogSeed 使用 [MIT License](./LICENSE) 开源。

---

<p align="center">
  <strong>如果你也希望自己的经验能被自己掌控地留下、并在下一次工作中真正帮上忙，欢迎点一个 ⭐ Star。</strong>
</p>

<p align="center">
  ⭐ <a href="https://github.com/bonc-ai/cogseed">Star</a>
  ·
  🍴 <a href="https://github.com/bonc-ai/cogseed/fork">Fork</a>
  ·
  🐛 <a href="https://github.com/bonc-ai/cogseed/issues">Issues</a>
  ·
  💬 <a href="https://github.com/bonc-ai/cogseed/discussions">Discussions</a>
</p>
