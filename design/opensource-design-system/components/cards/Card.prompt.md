# Card / ResourceCard / CardGrid

当前为设计预览，业务变体待确认，未接入正式 Renderer。

- Card：白底、圆角 12、内边距 16、细描边与轻阴影。tile 最大 400px；row 最大 800px。onClick 提供键盘 Enter / Space 操作，仅用于无嵌套操作的简单卡片。
- GroupHeading：action 只传文字，右侧统一呈现 Lucide chevron-right。
- CardFooter：分隔线 + 状态或辅助信息 + 主要操作。
- ResourceCard：淡蓝底图标、标题、两行说明、状态页脚。图标底色使用 --cs-accent-wash，所有变体共用。description 承载说明。能力与基础模板不展示额外业务摘要；工作空间和自动化通过下述专用字段展示用户已授权对齐的业务内容。variant 为 workspace / automation / capability / template；智能体、技能、连接共用 capability。状态与回调由调用方提供，不以 enabled 推断连接健康。
- control：独立头部操作。action：唯一主要动作。children：自动化展开记录等扩展内容。
- CardGrid：间距 16px，最大 1232px，最多三列；列宽不足 300px 时减列，受限窗口最小宽度不超过容器。少量卡片也不超过 400px。
- 禁用与处理中只阻止对应操作，保留可读原因。标题可换行；说明最多两行，完整说明应在详情中提供。
- 变体的外壳和结构来自共享组件；预览仅组织样例，不覆盖共享几何样式。

预览：cards.card.html。包括基础、业务变体、横向展开、异常、停用、处理中与长标题，以及 800px / 360px 受限内容区。

- menu：可选三点更多入口，靠卡片右上角；details 展示类型、角色模板、技能和智能体数量，groups 承载操作。工作空间示例提供重命名、删除空间，删除放最后一组。菜单向左展开，支持点击外部关闭与 Escape 关闭并回到触发按钮；类型和数量信息保留在菜单；工作空间角色、更新时间、最近任务使用专用内容字段。

当前契约：传 onClick 时自动启用悬停、手型和键盘动作。可点击 Card 内不得放按钮、链接或其他可聚焦控件；带多项操作时使用 ResourceCard，其外层保持普通容器。

## 工作空间内容契约

工作空间变体通过 `workspace` 接收更新时间、角色和最近任务。标题 `onOpen` 进入详情，主动作 `onAction` 继续最近任务（无任务时创建首个任务）。最近任务采用省略显示，标题允许换行。此内容字段仅用于工作空间，自动化、能力与模板变体沿用原契约。

自动化变体可提供 `automation={schedule,lastRun,device,runCount,expanded}`，设备位于标题下、计划和最近运行使用独立元数据区。`onToggleRuns` 展开/收起调用方提供的历史内容；「执行任务（n）」表达历史数量，不触发一次运行。缺少 automation 时保留旧调用方式。

自动化 `automation` 数据槽使用紧凑横行：执行数量、内容摘要、标题与设备、计划与最近运行、更多菜单。点击内容或执行数量都调用 `onToggleRuns` 展开历史，禁止将此动作解释为立即执行；`children` 承载引用与历史。
