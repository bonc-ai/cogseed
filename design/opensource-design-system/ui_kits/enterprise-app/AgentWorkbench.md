# 智能体管理工作台样例

| 页面 | 稳定入口 |
| --- | --- |
| 管理工作台 | [项目分析师](index.html?page=capabilities&tab=0&agent=credit) |
| 智能体编辑 | [编辑项目分析师](index.html?page=capabilities&tab=0&agent=credit&edit=1) |
| 平台智能体 | [合规审阅员](index.html?page=capabilities&tab=0&agent=compliance) |
| 外接智能体 | [Codex](index.html?page=capabilities&tab=0&agent=codex) |
| 主智能体 | [cogseed](index.html?page=capabilities&tab=0&agent=commander) |
| 已停用与空工作流程 | [经营分析师](index.html?page=capabilities&tab=0&agent=report) |

`CapabilitiesScreen.jsx` 的智能体卡片及菜单进入工作台，`agent` 指定记录，`edit=1` 进入编辑。直接访问、刷新初始化和浏览器 popstate 共用相同实现；返回清除 agent/edit，离开能力页也清除这些参数。未知智能体显示返回列表入口。目录有工作台与编辑两个页面入口。

`AgentWorkbench.jsx` 和 `agent-workbench.css` 仅组合共享 PageFrame/PageHeader/PageScroll、Button、Input、Textarea、Field、Select、SettingsSection、StatusDot、InlineConfirm、EmptyState 与本地 Icon。没有修改 tokens、共享组件或正式客户端逻辑。

## 功能边界

- 自定义：默认提供方、模型与推理强度；简介、核心记忆、擅长能力、出生时继承、交付标准、输出格式、工作流程；名称和分类编辑、条目增删、启停与卸载确认。更改提供方时恢复模型默认值，避免保留不匹配的模型。
- 平台：定义只读、输出格式禁用；编辑页仅修改核心记忆，不显示编辑对话。
- 外接：P3394 标识、项目目录与更换入口；隐藏内部模型配置、输入输出、空工作流程与编辑对话。
- 主智能体：保留能力、交付标准与流程，只编辑记忆；隐藏启停、卸载、继承记录与输出偏好。
- 出生记录缺失与已知空继承分开表达。当前样例没有伪造继承版本或真实交付统计。
- 所有编辑、启停、卸载、目录和调整对话仅改变当前预览内存；刷新恢复初始数据。目录输入替代原生选择器，不访问文件系统；调整对话仅记录用户输入，不调用模型、不声称生成或应用修改。使用智能体进入既有任务样例，不执行真实业务。

## 观察与源码依据

2026-09-05 通过 Computer Use 只读查看 `/Applications/CogSeed.app`（`com.cogseed.desktop`）：连接 → Agent → 智能体卡片管理工作台。

| 代表 | 观察到的结构 |
| --- | --- |
| 讲笑话、自定义 prd审查助手 | 默认执行配置、简介、出生继承、输入输出、工作流程；PRD 智能体另有擅长能力与交付标准。编辑时有核心记忆和条目增删、工作流程文本区及右侧调整对话 |
| 外接 Codex | P3394 Gateway、简介、出生继承、项目目录；无自定义的默认执行配置与输出格式 |
| 平台测试运行Agent | 版本与分类、简介、继承记录、禁用的输出格式、工作流程；编辑入口可见，核心记忆添加入口可见 |
| 主智能体 cogseed | 使用、编辑、交付统计、擅长能力、交付标准、工作流程；无启停与卸载 |

本工作树源版本比原 checkout 旧，因此额外核对原 checkout 的 `src/renderer/modules/agents.js`：`_renderAgentDetailExecDefaults`（仅进程内自定义智能体），`_renderAgentDetail`、`_renderAgentOutputFormatSection`、`_canEditAgentDefinition` / `_canEditAgentMemory`、`_enterAgentEditMode`（外接与平台只改记忆模式无编辑对话）。平台客户端 AX 会把文本区报告为 settable，本次未试写；样例采用源码权限边界，不把 AX 可编辑外观等同于定义写入授权。

## 验证

以下为独立任务的交付检查；整合后的当前结果见 [验证记录](../../verification.md)。

- `COGSEED_ESBUILD_PATH=/path/to/cogseed-source/node_modules/esbuild node tools/build.cjs`：成功，复用已有依赖；58 个组件、33 个预览脚本、32 个元数据卡片。
- `node tools/verify.cjs`：13 项既有离线契约及 87 个源哈希通过。
- `node tools/verify-agents.cjs`：10 项工作台离线契约通过，覆盖类型权限、禁用态、模型关系、继承空状态、卸载确认、入口与返回及未知 ID 恢复。
- 生成 JS 语法、HTML 资源存在、工作台 CSS tokens、引用图标与文件空白检查通过。

浏览器预览未通过视觉或 DOM 验证：Computer Use 打开本工作树 `file://` 入口时，Browser Use 明确返回「The browser URL policy blocks this action」，并禁止 alternate browser surfaces、workaround 或间接执行。本次未绕过策略。

待浏览器可正常访问后验证：工作台与编辑直达、刷新、列表往返、浏览器前进后退、页签切换、字段和条目编辑、启停、卸载取消、键盘焦点与 Escape、1100/680px 受限布局。离线 hook 检查不是 DOM/浏览器验证；实际客户端观察不证明新样例布局。没有新增或运行正式客户端代码，不以客户端重启证明设计包接入，也未做业务执行、提交、推送或合并。
