IconButton — 28/32/36 的方形图标钮，圆角 7px。

```jsx
<IconButton variant="quiet" size="sm"><Icon name="plus" size={15} strokeWidth={1.5} /></IconButton>
<IconButton variant="accent"><Icon name="send" size={15} strokeWidth={1.6} /></IconButton>
```

发送键无内容时用 `disabled`（降为 ink 8% 底 + ink-32 图标）。


尺寸统一为 sm 28 / md 32 / lg 36；title 提供默认可访问名称，也可显式设置 aria-label。悬停与 focus-visible 复用共享操作样式。
