# Changelog

All notable changes to CogSeed are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
