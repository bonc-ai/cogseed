# Changelog

All notable changes to CogSeed are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

(未发布内容待积累)

## [0.9.0] - 2026-09-04

### Fixed

- **对话长回合消息卡「待发送」** — 修复长回合后消息停在「待发送」的问题；课程
  提交流程改为按任务终态收尾。
- **麦克风/发送按钮对齐** — 模型徽章隐藏时，语音与发送按钮保持右对齐。

### Changed

- **内置课程客户端 0.4.2** — 内置包版本统一 0.4.1 → 0.4.2。

### Security

- **公开敏感内容收口定稿** — 清除 NSEAP 与 MeshSeed 残留引用；移除内部文档与
  本地开发路径；构建身份文件改为本地忽略状态，不再进入版本库。

## [0.8.0] - 2026-09-03

### Added

- **Windows 平台统一支持** — 同一套源码同时支持 macOS 与 Windows：纳入
  Windows CLI 发现与 `.cmd/.bat` 启动、Node shebang 解析、进程树回收、P3394
  网关、诊断脚本与弹窗关闭能力；平台差异由运行时判断、CI 构建矩阵和分别命名
  的产物表达，不再维护独立 Windows 业务分支。
- **共享知识库分享到飞书** — 空间内容一键发布为飞书公网文档：权限三档
  （互联网可读 / 组织内可读 / 关闭链接）、分享管理面板（复制链接 / 知识码 /
  更新内容 / 撤销）、独立分享应用配置（不依赖消息机器人绑定）。
- **问答会话分享（客户端联动）** — CogSeed 问答分享客户端联动方案，附带修复
  飞书租户域名识别。
- **外接智能体执行控制** — @外接智能体的统一模型与推理强度（effort）控制、
  真实 CLI 本地执行与状态回读、用量与费用指标（usage metrics）展示。
- **统一界面控件与操作审批** — 统一页面控件与页面框架（page chrome）；文件、
  Shell、Skill 等内核工具执行前接入操作审批（action approval）链。
- **安全 Skill 体系（guardrail）** — 新增 skill-declaration-core 声明核与
  skill-sentry 引擎（内置 vendor 形态），为 Skill 装载与执行提供声明与守门
  能力。
- **内置课程客户端种子机制** — 内置课程客户端新增种子（seed）机制，附插件
  面板授权状态修复。

### Fixed

- **运行中心（Run Center）** — 修复重启后死卡片、会话残留与重复扫描问题。
- **知识库问答** — 脑图生成超时自动降级、会话历史快照。
- **内置课程客户端加固** — 自动更新默认关闭、用户手册内置化、隐私匿名化。

### Changed

- **下线对话内生成速率显示** — 生成速率显示暂时下线待重做；统计计算与数据
  采集保留。

### Security

- **开源发布安全收口** — 清理内部工单号与私有网段测试地址、删除硬编码默认
  平台地址；SBOM 依赖清单门禁同步（626 组件）。

## [0.7.6] - 2026-08-31

### Added

- **In-app update reminders** — silent startup check plus a Settings › 通用 › 更新
  entry; once-per-day reminders with a "skip this version" option; in-app download
  with sha256 verification and OS installer hand-off (macOS dmg; zip-based
  automatic replacement is a planned phase 2). Server contract:
  `GET {COGSEED_API_BASE_URL}/updates/latest` — see `docs/design/updates-api.md`.
- **工作空间产物页 v0.1（原型 1:1 落地）** — 默认紧凑列表 + 卡片视图切换；
  搜索（名称/来源任务/Agent）、来源任务筛选、时间/任务分组、排序与类型筛选
  （带计数）可组合使用；每条产物展示来源任务、执行 Agent、更新时间、格式与
  文件大小；整行/「打开」弹出右侧预览抽屉（PDF/网页/图片走 `chat-media://`，
  Office 走服务端真预览，Markdown/文本走 `produced.readText`，其余提示暂不支持）；
  抽屉与「更多」菜单提供引用到新任务（自动建任务并带 taskRef）、在原任务中
  查看、在文件夹中显示与删除产物（二次确认，废纸篓）；产物聚合新增文件大小与
  Agent 归属（消息 `from` / artifact meta.agentId / 会话参与 Agent 回退），
  并新增 `spaces.artifacts.delete` IPC（按空间产物列表重新校验后删除）。
- **产物页大列表性能（大厂同款三件套）** — 列表视图改**虚拟滚动**（飞书/Notion
  式窗口化渲染：总高撑杆 + 可视窗口增量更新 + 浮动分组头吸附，千级产物滚动/搜索
  不卡）；卡片视图改**分批无限渲染**（每批 60 张 + 底部哨兵提前加载）；卡片缩略图
  **懒加载 + 全局预算 24**（Office 预览加进程内 LRU 缓存）。产物交互改 **document
  级事件委托**（capture），行级绑定清零。
- **产物搜索输入体验修复** — 输入改为**增量刷新**：只重建结果区与计数汇总，
  工具栏与输入框原地不动（修复逐字输入时焦点丢失/光标跳动/中文输入法被
  打断），并去掉 120ms 防抖改为即时过滤。
- **产物页字体与全站统一** — 产物行文字改用中文优先混排字体栈（PingFang SC
  优先），英文文件名不再被全局 Inter 渲染成异质风格；字号层级对齐任务页/
  空间卡（文件名 14px、描述 11px、徽章 10px/650）。
- **破坏性操作品牌化确认（去原生弹窗）** — 删除产物/删除空间改用
  `uiConfirmDanger`（红色主按钮、默认聚焦取消、Enter 不触发防误触）；
  移出任务/撤销资产改用 `uiConfirm`；重命名空间改用 `uiPrompt`（品牌化
  输入框）；全部保留原生回退兜底。
- **产物失效检测与行内标记** — 列表加载后后台并发 statPath 探测（限 8 并发），
  打开/定位失败即时标记；失效行标红 + 「文件已失效」标签，菜单「在文件夹中
  显示」自动变为「重新定位」，抽屉同步提示；修复失效标记后虚拟窗口因缓存
  命中留白的问题。
- **更多菜单键盘导航** — 打开即聚焦首项，↑↓ 循环、Home/End 跳转、Enter 执行、
  Esc 关闭；菜单/菜单项补 role="menu"/"menuitem"。
- **卡片真实预览补全与修复** — Office 卡片预览新增紧凑卡片版 HTML（小字号、
  去留白，修「大且不全」）；PDF 卡片改整页缩略（`view=Fit`）；Markdown/文本卡片
  新增迷你文本预览（前 7 行，带内存 memo）。

## [0.0.5] - 2026-08-19

CogSeed's first public release.

### Added

- **Continue existing work** — switch entry points without losing task
  context, requirements, or established decisions; resume prior work in a new
  conversation or with a supported Agent.
- **Durable cognition** — confirmed goals, boundaries, and working methods
  persist across conversations as personal working knowledge.
- **Visible usage** — see which content was brought into and actually used in
  new work; you decide what is worth keeping.
- **Local-first** — personal space, task state, and confirmed content are
  stored locally by default; first release supports Apple Silicon Macs.

### Standards

- Implements the IEEE P3394 standard for agent interoperability (see
  [README](./README.md#standards)).
