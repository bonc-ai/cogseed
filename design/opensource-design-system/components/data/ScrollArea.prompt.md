ScrollArea / AspectRatio — 滑块 6px ink 22%（hover 36%），覆盖在内容上不占布局宽度；表头始终吸顶。

```jsx
<ScrollArea header="运行留痕" height={206}>…时间轴行…</ScrollArea>
<AspectRatio ratio="16/9" />
```

比例容器内不放文字排版，内容一律 cover 居中裁切。