Slider — 天数、深度这类有连续量纲的参数；精确数值一律用 Stepper。

```jsx
<Field label="到期提醒提前天数"><Slider value={d} min={15} max={120} ticks={[15,30,60,90,120]} onChange={setD} /></Field>
```

当前值用 系统非衬线 500 显示在标签行右端。