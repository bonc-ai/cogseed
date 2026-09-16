NavItem — h 36（紧凑列表项 34）、r 8、项间距 2px。

```jsx
<NavItem icon={<Icon name="space" />} label="工作空间" selected />
<NavItem icon={<Icon name="automation" />} label="自动化" count={3} />
<NavItem size="sm" label="项目里程碑与提醒" />
```

它标示位置，不争夺注意力：hover 用中性 ink 4.5%，避免蓝色闪烁。

完整导航示例复用 `ui_kits/enterprise-app/Sidebar.jsx`，与默认首页的内容、顺序和展开状态一致。「置顶」「最近」「空间」的标题和内容属于同一个滚动区；顶部入口及底部账户区固定。

空间树分组复用 `NavItem`，通过 `expanded` 显示展开箭头和辅助技术状态；点击由 `onClick` 处理。
