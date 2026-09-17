Radio / RadioCard — 授权范围、运行深度这类互斥选择。

```jsx
<Radio checked={v===0} label="仅本次任务" onChange={()=>setV(0)} />
<Radio disabled label="长期授权（需管理员）" />
<RadioCard checked title="均衡" help="约 1 分钟，覆盖主要口径" />
```

当前契约：同组 Radio / RadioCard 必须传相同 name 和不同 value。使用原生 radio 的 Tab、方向键和 Space 行为；RadioCard 支持 disabled，help 关联到输入控件。
