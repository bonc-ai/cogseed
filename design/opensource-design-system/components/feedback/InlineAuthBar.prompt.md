InlineAuthBar — r 11、描边 .14；授权后原地转为绿色回执。

```jsx
<InlineAuthBar state={s} time="14:04" onAllow={()=>setS('granted')} onDeny={()=>setS('denied')}
  message="需要访问「客户经理通讯录」才能填入收件人" />
```

按钮固定「拒绝 / 允许一次」，主按钮为近黑 ink 保持独立的操作层级。