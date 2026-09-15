# 能力市场

`CapabilityMarketplace.jsx` 导出 `window.CapabilityMarketplace`。在 CapabilitySkills / CapabilitiesScreen 之前加载，共享 bundle 之后加载。不读写真实服务。顶部「更多」共用此业务组件，不分别维护智能体市场和技能市场样例。

## API

- `kind='agent' | 'skill'`：进入市场时的默认类型，默认 agent。内部提供智能体、技能、开源项目三个标签。
- `onBack()`：列表页返回调用方。
- `selectedId?: string | null`：可选受控详情 id。省略时内部维护；传 null 表示列表。
- `onSelect?(id: string | null)`：打开详情/返回列表时通知调用方；如传入 selectedId，调用方需同步更新它。
- `onKindChange?(kind: 'agent' | 'skill' | 'open')`：用户切市场标签时通知，可用于调用方 URL。详情 id 能自行恢复所属类型。

技能现有路由保持 `skill=market` / `skill=market:<id>`，跨类型市场详情仍通过此参数保留来源页。智能体调用方可以使用独立参数，只需将 id 传入 selectedId。不匹配的 id 显示资源不存在空态，不冒充列表或错误映射到其他项。

安装版来源：`skills-bindings.js` 的顶部更多进入 `openMarketplace('skill')`，`marketplace.js` 的类型/分类/列表/详情。所有数据是合成业务材料；安装按服务未连接处理，保留当前详情并显示可重试错误，不假报真实成功，不执行外部代码或安装。

复用 ResourceCard/CardGrid/Tabs/Input/Select/EmptyState/Button，无新 CSS 和通用组件变化。内存 esbuild transformSync 语法检查通过，统一构建与浏览器检查由统筹负责。
