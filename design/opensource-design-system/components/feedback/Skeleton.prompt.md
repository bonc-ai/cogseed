Skeleton — 条 h 10–13、r 4、1.4s 透明度呼吸。

```jsx
<Skeleton lines={[62,100,88,94]} withMedia />
```

只在首次加载出现；刷新已有内容时保留旧数据并在右上角转圈。与 EmptyState 共用同一容器高度，避免切换跳动。