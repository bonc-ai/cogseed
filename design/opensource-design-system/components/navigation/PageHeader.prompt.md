# PageHeader · 页面顶栏

顶部页面标题统一使用 `--cs-type-title`（15px、500 字重、1.5 行高），窄屏不改变字号。长标题单行省略，完整字符串通过 title 提示。

`title` 为页面名称；`leading` 放窗口控制、侧栏展开或返回操作；`status` 放标题旁状态；`actions` 放右侧操作；`children` 保留无标题顶栏的自定义内容。组件不持有业务状态，不自动添加描述。

首页问候语、登录品牌文字、正文分区标题不使用本组件。正式客户端接入须沿用 Renderer 的 uiPageHeader 入口；此 React 实现仅用于设计预览。
