Select — 触发 h 36（紧凑 32）、菜单 r 11 阴影 md、项 h 32。

```jsx
<Select groupLabel="按分部" options={['华东团队','华北团队','总行风险条线']}
  disabledOptions={['同业与外部协作（无权限）']} value="华东团队" onChange={setV} />
```

选项超过 8 条改用 SearchableSelect。

展开后点击组件外部收起菜单；组件内部操作保持可用，选择选项后收起。


触发器为原生按钮；方向键打开并移动选项，Home/End 定位首尾，Enter/Space 选择，Escape 关闭并返回焦点；禁用项不参与键盘选择。通过 id / aria-label / aria-describedby 关联字段。
