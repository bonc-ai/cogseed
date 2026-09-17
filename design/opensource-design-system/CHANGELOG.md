# 变更记录

## 开源适配草稿 · 2026-09-09

- 在现有 2.0.0 组件基础上适配 CogSeed 开源品牌色、Logo 与松鼠，保留布局、组件接口和交互契约。
- 页面样例调整为个人工作空间与通用工作场景；同步品牌规范、资源清单和交接范围。
- 当前仅供设计确认，不升级客户端版本；历史对齐记录保留。

## 2.0.0 · 2026-09-05

相对文档中的 v1.4 视觉基线，本版增加可执行契约；仅用于独立设计包，不表示客户端发布。

- 修复表格、单选、复选、分页、折叠、步进、任务行、提示和文件移除的原生控件语义；补充相应回调、边界和页面组合检查。
- Alert 正文去掉透明度；焦点统一到共享定义，增加 forced-colors 和减少动态效果适配；模态支持背景隔离、滚动锁定和嵌套恢复。
- 控件高度、导航行高、图标、动效和布局间距接入 token；清理 65 个无消费引用的 token。八阶间距与旧字体别名作为明确保留项维护在 tokens/reserved.json。
- 公共源码入口 index.js 与类型入口 index.d.ts 从注册表生成；manifest 增加版本。目录专属 CSS 从公共入口分离。
- 新增源码检查：点击语义、图标名称、颜色字面量、token 引用与未使用 token、CSS 语法；修复认知资产响应式 CSS 中原有的残缺选择器。

### 迁移

- DataTable 的 onSelect 通过“选择第 N 行”按钮触发，不再点击整行；仍回传原索引。可传 label 设置表格名称。
- Radio / RadioCard 的同组项传相同 name 和不同 value；保留原 checked / onChange 回调。RadioCard 可禁用。
- Pagination 可传 locale，默认 zh-CN；保留页码与 onChange 参数。
- 删除的 token 不再视为可用 API。颜色改用当前 colors.css 中的语义值；页面标题用 size-heading，卡片阴影用 shadow-sm；布局间距用 space 八阶。以 manifest 的 tokens 列表为当前清单。
- 普通按钮尺寸仍为 28/32/36；分段筛选为 24px 的明确紧凑变体；登录按钮为 56px，字号使用 16px。
- JSX 消费使用 index.js，需要 React 和 JSX 构建支持；本包浏览器样例继续使用 _ds_bundle.js。正式 Electron Renderer 仍须按仓库 classic-script 共享组件规范接入。
- adherence 配置仅提供导入/颜色提示；组件参数以 .d.ts 为准，去掉重复且过时的属性白名单。源码约束由 tools/verify-source.cjs 执行，不宣称运行了未安装的 oxlint。
