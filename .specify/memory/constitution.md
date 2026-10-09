# CogSeed Constitution

## Core Principles

### I. 保持桌面运行边界

必须沿用 Electron 主进程 TypeScript、渲染层原生 HTML/CSS/JavaScript 和 IPC 通信。
渲染层只能通过 `window.cogseed.{invoke, stream}` 的白名单访问应用能力。
不得在主进程引入 HTTP 服务、监听端口或本地认证层；不得向渲染层引入 TypeScript、JSX 或打包器。
`preload.js` 必须保持 JavaScript，`#core-agent` 必须动态导入，避免破坏启动和隔离边界。

### II. 遵守分层与统一执行入口

IPC 只校验参数并调用 features；业务流程属于 features，底层 util 不得反向依赖 features/model。
存储、路径校验、CLI/MCP 派生进程、隔离 worker 和群聊调度必须复用 AGENTS.md 规定的入口。
不得绕过路径沙箱、锁、索引器或同步传输；文件工具必须执行路径许可检查和结果大小限制。

### III. 保持用户数据隔离与隐私

用户私有数据必须位于当前用户的 cloud/local 数据域，分别承载可同步状态与机器私有状态。
用户 ID 是不透明路径段，不能解析或写入会话 ID，也不能把其派生路径缓存为模块常量。
凭据必须按现有加密边界保存；日志、遥测、规格和协作记录不得泄露密钥或用户私有内容。
附件、知识库、Artifact 和 Saved App 必须沿用各自的解析及访问边界。

### IV. 复用共享界面与国际化机制

渲染层必须使用现有共享控件、图标和层级 token。修改可见控件时必须遵循
`.agents/skills/cogseed-component-change/SKILL.md`，补充真实页面集成覆盖，不能提高旧控件基线绕过迁移。
UI 文案必须进入所属 main/renderer locales 并通过 `t(...)` 渲染。
输入快捷键必须忽略 IME 合成，耗时操作必须提供可见进度。

### V. 用实际证据验证改动

验证必须覆盖受影响的业务不变量、恢复路径、并发和跨层契约，不能只证明实现细节与自身一致。
涉及解析/清洗的改动必须覆盖真实合法形态与相似非法形态。
依照 AGENTS.md 使用 `npm run typecheck`、`npm test` 及对应真实环境检查；不得绕过项目测试入口。
macOS/Windows 的平台分支必须分别验证；未执行的检查必须明确记录。
检查通过、人工验收和上线必须分别陈述，不能互相替代。

## Architecture and Compatibility

具体执行入口、数据域与安全规则以根目录 AGENTS.md 为权威来源，本文件归纳其原则。
新增 npm 依赖必须事先讨论；渲染层第三方资源按仓库 vendor 规则管理。
LLM 提示词遵循既有内容及 Runtime injection 约束，用户终止不能作为临时网络错误重试。
平台内置 agents/skills 是产品内容，平台共享逻辑不得直接依赖其实现。

## Development Workflow and Quality Gates

明确需求按 `specify → plan → tasks → analyze → implement` 形成可追溯工件；
存在关键不确定性时，先用 AI Product 路由选择适当的证据收集或验证工作。
已有任务与规格必须增量维护，不能因初始化而覆盖。规格中的事实、假设和待确认事项必须区分。
改变已确认的用户流程、权限、数据对象或验收标准时必须先更新对应规格并记录变更依据。
实现细节更新 plan/tasks；产品定位变化返回需求发现阶段。
先检查工作区，保留既有和并发改动。从最新 `origin/develop` 建立功能分支，通过 MR 合入；
不得直接推送受保护主干。重启和真实环境验证按 AGENTS.md 执行。

## Governance

本文件将已有仓库规则整理为 1.0.0，采纳日期记录在下方版本行。
它不替代 AGENTS.md，也不授予提交、外部发送、生产写入、发布或权限变更等操作的额外授权。
修订必须在 MR 中说明理由、影响与验证：不兼容原则变化提升主版本，新增原则提升次版本，
文字澄清提升修订版本。发生规则冲突时先核实权威来源和当前任务授权，不能静默放宽边界。

**Version**: 1.0.0 | **Ratified**: 2026-09-19 | **Last Amended**: 2026-09-19

## AI Product Method Addendum

### Evidence and claim boundaries

- Separate fact, user quote/self-report, stakeholder view, hypothesis, proposal and decision.
- Preserve source type: real, desensitized, synthetic or stub.
- Keep Submitted, Verified and Accepted independent. Artifacts and passing tests do not prove acceptance or business value.
- Never invent Owner, date, approval, release, delivery or production result.

### Human authority

- Apply minimum AI authority A0–A4. A4 is disabled by default.
- A3/A4 require named human approval, confirmation points, audit evidence and rollback.
- A Workflow Gate is a review pause, not an operating-system permission sandbox.

### Discovery routing

- Experience uncertainty → lowest-cost prototype.
- Technical/integration uncertainty → Technical Spike.
- AI capability uncertainty → frozen evaluation contract and protection surfaces.
- Value uncertainty → user evidence or Wizard of Oz.
- Clear requirements and solution → native Spec Kit directly.

Substantive changes to user flow, authority, evidence, data objects or acceptance criteria update the
spec first; product-position changes return to Discovery; implementation changes update plan and tasks.
