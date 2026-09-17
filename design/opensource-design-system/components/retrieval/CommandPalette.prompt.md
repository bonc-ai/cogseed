CommandPalette — 全局内容搜索（保留导出名称），宽 640，上限跟随视口。

```jsx
<CommandPalette modal onClose={() => setSearchOpen(false)}
  groups={[
    { id: 'chat', label: '任务', items: [{ id: 'task-1-message-2', title: '项目到期清单', meta: '你 · 今天 11:20', snippet: '核对到期日期与贷款余额', taskId: 'task-1' }] },
    { id: 'agent', label: '智能体', items: [] },
    { id: 'skill', label: '技能', items: [] },
    { id: 'context', label: '资料库', items: [] }
  ]}
  history={history} onHistoryChange={setHistory}
  onSelect={(item, group) => { setSearchOpen(false); openSource(item, group.id); }} />
```

- 默认空查询，显示「输入关键词开始搜索」；有历史则显示历史和清空操作。输入框为「搜索任务、资料库内容…」。输入后展示全部及调用方提供的分类，按标题、元信息、摘要不区分大小写匹配；无匹配显示具体关键词。
- 全部页按 groups 顺序分组，每组最多 10 项，查看更多进入对应分类。不同消息可命中同名任务，须提供独立 id。每条显示类型、标题、元信息与命中摘要；点击和 Enter 传回原始 item，宿主负责打开任务消息或内容详情。
- query + onQueryChange 为受控用法；不传 query 时组件内部维护输入。history + onHistoryChange 由宿主维护，默认不读写存储；选择/关闭时记入最近 12 条，避免逐字记录。
- 上下方向键移动、Enter 打开；组合输入期间忽略动作快捷键。modal 模式自动输入聚焦、限制 Tab、Escape/遮罩关闭并返回触发器。普通组件卡片使用非模态实例，避免占用页面焦点。
- 仅对传入的本地集合做同步过滤，不接后端、不证明跨库查询或权限校验；调用方必须先过滤无权限内容。可选 footer 只用于确有对应权限语义的宿主，不预置命令、新标签打开或虚假操作。
