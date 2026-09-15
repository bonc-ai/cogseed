Stepper — h 32、宽 132、数值 系统非衬线 500 居中，两侧 30×30 按钮。

```jsx
<Field label="单次导出上限" help="步长 100，上限由管理员策略决定。">
  <Stepper value={n} step={100} onChange={setN} />
</Field>
```