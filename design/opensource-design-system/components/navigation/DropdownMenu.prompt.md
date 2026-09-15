DropdownMenu — w 200–248、项 h 34、r 11、阴影 md、120ms 淡入 + 4px 上移。

```jsx
<DropdownMenu trigger={<IconButton variant="quiet"><Icon name="dots" size={15} strokeWidth={1.6} /></IconButton>}
  groups={[
    { items: [{ label: '存入空间', icon: 'file', shortcut: '⌘S' }, { label: '导出 PDF', icon: 'export', submenu: true }] },
    { label: '危险操作', danger: true, items: [{ label: '删除任务与产物', icon: 'trash' }] }
  ]} />
```
可选 header 用于只读信息；align="end" 用于卡片右上角入口，面板右边缘与入口对齐。支持外部点击关闭、Escape 关闭并返回入口，以及操作项 Enter / Space 激活。

side="top" 用于侧边栏底部入口，向上弹出，距入口 6px；默认 bottom 保留向下展开。用户菜单组合见 UserMenu。


原生按钮触发，方向键移动菜单项，Home/End 定位首尾，Escape 关闭并返回触发器；外部点击关闭。浮层通过 portal 避免滚动裁切，按可用空间翻转。
