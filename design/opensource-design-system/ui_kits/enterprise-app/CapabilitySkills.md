# 技能能力页

`CapabilitySkills.jsx` 导出 `window.CapabilitySkills`，由能力页面技能标签渲染，接收 `onUse({title, skill:{id,name,source}})`。加载顺序：共享 bundle 后、CapabilitiesScreen 前。不新增公共样式或依赖；来源、筛选、文件浏览、编辑和安检为技能领域组合，复用共享 ResourceCard、CardGrid、DropdownMenu、Dialog、Field、Input、Textarea、Select、Tabs、EmptyState。

依据本地 `src/renderer/modules/skills.js` 的 `renderSkillsGrid`、`_openSkillsSectionHtml`、`_openSkillRowMenu`、`openSkillModal`：自定义/平台/外部包/全局文件夹独立来源；外部包作为包卡片；全局 report 前缀组可展开；简介与使用按钮；分类；安全汇总与单项结果；平台只读、自定义编辑删除、来源启停。创建包含手动/链接/文件夹方式。安装版实点由能力统筹任务补充，本文件不声称源码阅读等同安装版验证。

详情使用 `skill=<id>`，保留父级 page/tab 参数。浏览器后退恢复详情或列表；不存在的技能显示回退入口。记录为页面内 React 状态，刷新恢复预置数据，新建技能刷新后的地址因此显示不存在空态。父级切换能力标签需移除 skill 参数，避免跨标签残留。

安全结果与时间是固定合成材料；没有扫描器，不在点击重新检查后捏造通过结果。修改技能使安检回到待检查。阻止使用的技能不可发送。浏览器不连接真实导入/包管理服务；链接保留输入并显示服务不可用，文件夹方式提示通过客户端导入。没有读取私人目录、真实安装、网络调用、任务发送；使用只调用父级回调。创建仅生成本地使用说明，没有伪造 LLM 生成过程。

待统筹构建后验证：来源/分类/搜索空态、全局组展开启停、菜单键盘/Escape、禁用与安检阻断、自定义创建编辑删除、详情直达/后退/刷新、窄屏与长内容。组件 Dialog 提供遮罩隔离、焦点限制、Escape 与焦点返回。

顶部「更多」按 `skills-bindings.js:115` 打开技能市场列表，再进详情查看 SKILL.md 与安装操作，沿用同一卡片组件。市场使用 `skill=market` / `skill=market:<id>`，安装服务未连接时给出可恢复错误且不新增已安装项；创建的链接/文件夹方式保留在创建对话框。市场列表支持名称/简介与分类组合筛选。

已执行现有 esbuild 的内存 `transformSync` 检查 JSX 语法，通过；未写生成产物、未单独构建，避免并发覆盖。浏览器行为由统筹串行验证。

市场已抽到同级 `CapabilityMarketplace.jsx` 供智能体与技能共用。加载顺序需先市场后技能。`onUse` 另含 `content:'empty', initialMessage:'使用技能「名称」：'`，只预填任务草稿；技能引用仍通过 skill 字段传递。初始搜索与 popstate 读取 `query` 参数。模块级内存保存技能列表，能力标签卸载/重进保留创建编辑启停状态，整页刷新仍恢复预置数据。
