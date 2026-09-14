SegmentedControl — ink 6% 轨道 + 白色选中片（阴影 sm）。

```jsx
<SegmentedControl items={['全部','我负责','已归档']} value={seg} onChange={setSeg} />
```

右侧常配一句「当前筛选：… · n 条」的 caption。

使用原生按钮与 aria-pressed 表达筛选，保留每项 Tab 访问。认知资产、工作空间和自动化复用同一组件；数量可以拼入对应标签。
