Breadcrumb — 12.5px ink-45，分隔符 ink-24 斜杠，末级 ink 500。

```jsx
<Breadcrumb items={['工作空间','华东团队空间','…','项目到期与提醒']} />
```

通过 onNavigate(item, index) 交给宿主路由；末级与省略段为非交互文本。未提供回调时不显示可点击光标。
