DataTable — 表头 h 34（surface-subtle + 系统非衬线 500）、行最小高 44。

```jsx
<DataTable sortKey="due" sortDir={1} onSort={sort}
  columns={[
    { key:'name', label:'客户名称', width:'1.5fr', primary:true },
    { key:'branch', label:'项目组' },
    { key:'due', label:'到期日', width:'.9fr', mono:true, sortable:true },
    { key:'amt', label:'预算/万', width:'.8fr', mono:true, align:'right', sortable:true }
  ]}
  rows={[{name:'华越精密制造',branch:'静安小组',due:'09-18',amt:'3,200'}]} />
```

排序方向使用共享 Icon 的 arrowUp / arrowDown，保持列对齐。

生成中的行用 opacity 递减表示流式写入。

当前契约：使用原生 table / thead / tbody / th scope="col"，sortable 表头使用按钮并暴露 aria-sort。传入 onSelect 时追加带行号名称的选择按钮；行本身不绑定点击。label 默认“数据表”，可提供业务名称。
