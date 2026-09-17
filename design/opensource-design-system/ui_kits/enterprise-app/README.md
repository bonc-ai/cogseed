# CogSeed 开源版 · UI Kit

自适应窗口的桌面端页面样例（参考画布 1440×900），可点击穿越：**登录 → 首页 → 工作空间 → 空间详情 → 任务视图**，Ctrl+K / ⌘K 打开全局内容搜索。

> 当前为开源适配稿，待用户确认。企业来源记录保留历史语境，不作为当前品牌要求。

## 独立页面入口

导航页左侧逐项列出以下页面，也可直接打开对应链接：

| 页面 | 入口 |
| --- | --- |
| 登录 | [打开登录页](index.html?page=login) |
| 默认页面（首页） | [打开默认页面](index.html?page=home) |
| 工作空间 | [打开工作空间](index.html?page=spaces) |
| 工作空间详情 | [打开空间详情](index.html?page=space&space=space-0) |
| 认知资产 | [打开认知资产](cognition.html) |
| 自动化 | [打开自动化](index.html?page=automation) |
| 智能体 / 技能 / 连接 | [打开能力管理](index.html?page=capabilities) |
| 智能体管理工作台 | [打开管理工作台](index.html?page=capabilities&tab=agents&agent=credit) |
| 智能体编辑 | [打开编辑页](index.html?page=capabilities&tab=agents&agent=credit&edit=1) |
| 设置 | [打开设置页](index.html?page=settings) |
| 任务页 | [打开对话详情设计](task.html) |

入口共用现有组件和页面模板。`page` 参数决定初始页面；通用入口缺省或未知值进入登录页，独立 `task.html` 缺省直接进入任务对话详情。内部页面跳转同步更新地址，刷新保留当前页面，并支持浏览器前进、后退。`task.html` 由构建脚本复用通用入口生成，共用页面脚本与样式。任务页直达时使用已有示例任务，刷新后恢复示例数据，不持久化临时输入。页面样例均无需先完成登录或其他前置操作。

工作空间的任务、产物、资产与设置见 [工作空间详情说明](SpaceDetailScreen.md)；智能体类型差异、管理与编辑边界见 [智能体管理工作台说明](AgentWorkbench.md)。

认知资产覆盖一级任务视图与二级工作页。独立入口、源码映射和交互边界见 [认知资产样例说明](CognitionScreen.md)。默认显示正常页面；示例数据仅保存在本次预览内，未接入 IPC。

页面主导航由 `PageLayout.jsx` 的 `PageTabs` 统一组合，认知资产与能力管理共用内容边距、单行滚动与右侧操作区；基础交互见 [Tabs 规范](../../components/navigation/Tabs.prompt.md)。

## 文件

| 文件 | 内容 | 源设计稿 |
| --- | --- | --- |
| `index.html` / `App.jsx` / `app.css` | 本地资源入口、自适应外壳与路由（登录 / 首页 / 工作空间 / 自动化 / 能力管理 / 任务 / 设置），⌘K 全局内容搜索、右下角通知 | 全部 |
| `Sidebar.jsx` | 280px 侧栏（展开宽度及最小宽度一致，窄窗口可收起）：macOS 窗口区、字标、一级导航、置顶 / 最近 / 空间二级树共用滚动区、固定用户页脚 | `CogSeed 企业版 侧边栏` 2a |
| `LoginScreen.jsx` | 登录页：纯色背景 + 现有 Logo 与名称 + 共享 56px 登录按钮 | `CogSeed 企业版 登录页` |
| `HomeScreen.jsx` | 首页：时间问候、输入台、七快捷、工具接入与历史接续 | `CogSeed 企业版 主框架+主视觉` 01 / 02 |
| `SpaceHubScreen.jsx` | 工作空间：标题栏、搜索、空间卡片 ×4、模板卡片 ×3、空状态 | `CogSeed 企业版 空间中心` |
| `SpaceDetailScreen.jsx` / `space-detail.css` | 空间详情的任务、产物、资产与设置，保留任务返回空间上下文 | 当前客户端工作空间 |
| `AgentWorkbench.jsx` / `agent-workbench.css` | 智能体管理与编辑，按自定义、平台、外接及主智能体区分 | 当前客户端智能体管理 |
| `ResourcePage.jsx` | 三个资源页面共用的标题栏、检索布局和名称编辑区 | 本轮页面组合 |
| `AutomationScreen.jsx` | 自动化管理、启停、运行记录与模板 | 共享卡片变体 |
| `CognitionData.jsx` / `CognitionPanels.jsx` / `CognitionScreen.jsx` / `cognition.css` | 认知树、待办、复用与治理，以及资产、候选、个人本体、来源、沉淀、版本和复用记录二级页 | 当前 `skills.js` / `personal-ontology.js` |
| `CapabilitiesScreen.jsx` | 同页五个 tab：智能体、MCP 与工具、技能、资料库、IM | 共享能力卡片 |
| `MemorySettings.jsx` | 数据设置内的记忆详情：偏好、全局共享记忆与分组，支持样例新增、编辑和删除；无独立目录入口 | `src/renderer/modules/memory.js` |
| `MemoryTransfer.jsx` | 记忆导入审核与导出内容，复用设置组件 | `modules/memory.js` |
| `SettingsPanels.jsx` | 五个设置菜单的内容与预览状态；入口与边界见 [设置说明](SettingsScreen.md) | 设置、账号、安全与更新源码 |
| `SettingsScreen.jsx` | 六个设置菜单与稳定 section 路由；功能来源及边界见 [设置样例说明](SettingsScreen.md) | 当前 Renderer 设置源码 |
| `TaskScreen.jsx` | 任务视图：760px 正文 + 308px 信息面板 | 见下方说明 |

## 复用约定

- `PageLayout.jsx` 统一页面外壳、标题栏和滚动边界；页面只传内容和布局差异。仅默认首页启用渐变雾，其余页面与侧栏使用纯色背景。
- `PreviewData.jsx` 统一任务、空间、模板和表格示例；侧栏和工作空间从同一份空间记录生成，数量随数据同步。
- 工作空间、自动化、能力及模板复用 `ResourceCard` / `CardGrid`，普通卡上限 400px、网格上限 1232px；建议项和登录操作使用共享 `Button`；侧栏任务复用 `SidebarTasks`，基础导航使用 `NavItem`，操作使用 `IconButton`。
- 组件 JSX 改动后统一运行构建，导航卡片与页面样例加载同一份生成组件。

## 交互

- 用户菜单「设置」进入独立设置页；包含数据、账号、账号与用量、通用、安全与信任、关于我们；目录只保留一个「设置」入口，进入后通过左侧菜单切换；`section` 参数保留当前菜单并支持刷新恢复；返回应用恢复进入前的页面，独立打开时返回首页。「管理记忆」进入设置内部的记忆详情，支持返回数据设置；其他数据管理按钮仅展示入口反馈。其余菜单支持本次预览内的配置、授权、检查与更新流程，均不接入真实服务。
- 登录页点「登录」进入首页
- 侧栏收起按钮隐藏整个侧栏；默认页、工作空间页与任务页的主区标题栏复用同一组红绿灯与展开按钮，点击展开按钮恢复侧栏（对应源稿 02）
- 首页输入台输入内容后发送键点亮，发送后进入任务视图
- 点侧栏任务或空间「继续工作」进入对应任务，保留空间上下文
- 任务视图：过程展开、消息引用与编辑、排队与停止、详情页签切换、产物排序
- 工作空间支持搜索、新建与模板预填；一级页面统一列出空间，不提供全部 / 我负责 / 已归档分类筛选；三点菜单支持重命名、归档、恢复及删除确认，侧栏空间数据同步。
- 自动化支持搜索、启停、展开运行记录与创建暂停状态的模板实例；能力页在同一入口中切换五个 tab；支持资源检索与启停、插件管理、资料文件预览、IM 机器人连接与身份绑定管理。
- 新页面是独立可访问的设计预览；不会执行调度或真实授权，刷新恢复示例数据。
- ⌘K / Ctrl+K 打开全局内容搜索，Esc 关闭

能力页参考 `src/renderer/index.html` 及对应模块，当前保留智能体、MCP 与工具、技能、资料库、IM 五个页签；资料库保留文件树与内容区，IM 默认直接展示含消息渠道、当前账号、机器人关联、身份与投递及消息行为的完整连接管理页，账号与用量沿用设置入口。新增、导入、连接和插件更新仅操作内置示例，不读取本地资源或执行安装授权。

## 说明与缺口

- **任务视图**在源设计稿中没有完整页面稿。它按第一册《基础规范》给出的框架尺寸（标题栏 52 · 对话正文 760 · 右侧信息面板 308）与构件规格（执行步骤组、内联授权条、数据表、输入台、折叠面板、滚动区）拼装，未新增任何未在源稿出现的视觉语言。
- 本 UI Kit 使用 CogSeed 品牌，复用现有组件；来源文件名保留历史名称。
- 侧栏与导航组件卡片复用同一实现及默认数据；置顶、最近任务、空间单列排列，置顶去重，顶部入口和底部账户区固定；任务状态及操作规则见 [任务侧栏契约](../../components/navigation/SidebarTasks.prompt.md)。

## Windows 与内网

- 全界面使用系统默认非衬线字体，不指定字体名称，也不包含字体资源。React 18.3.1 与预编译页面脚本从包内读取。组件 `.jsx` 保留为源文件，浏览器加载对应生成的 `.js`。
- UI Kit 统一采用 macOS 窗体与快捷键；Windows 原生窗体和快捷键由客户端构建适配。预览中的三色窗口按钮只表达布局。
- 在已有 esbuild 环境运行 `node tools/build.cjs`（从设计系统根目录）；或通过 `COGSEED_ESBUILD_PATH` 指定已有模块。
- 详细基线见 [Windows 与内网规范](../../guidelines/windows-intranet.md)，本轮检查见 [验证记录](../../verification.md)。

## 任务对话样例

[打开任务页](task.html)：24 个场景按对话内容、执行状态、详情面板分组，支持上一页 / 下一页、单页浏览 / 全部平铺和 `scene` 直达。差异、场景地址与模拟边界见 [对话详情说明](TaskScreen.md)。导航位于客户端画板外；页面继续复用共享输入台、按钮、菜单、字段、状态、步骤与表格，不修改正式 Renderer。

## 一致性核验

与安装版 CogSeed 的页面及主要动作对照见 [页面差异记录](PageComparison-2026-09-05.md)（保留比较时的观察；本轮已确认项见 [实施记录](Alignment-2026-09-05.md)）。

页面与组件加载同一生成 bundle；组件目录由源注册表统一生成。运行 `node tools/build.cjs` 和 `node tools/verify.cjs`（设计系统根目录）重建并核验。工作空间与设置共用 InlineConfirm，认知资产共用 StatusPill 与 SegmentedControl。当前检查结果与浏览器缺口见 [验证记录](../../verification.md)。

已确认范围的实施与复用关系见 [安装版对齐实施记录](Alignment-2026-09-05.md)，能力模块详见 [能力页实施记录](CapabilitiesAlignment.md)。
