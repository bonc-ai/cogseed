InlineConfirm — 对象相邻的页内确认，用于保留操作对象与当前页面上下文。

复用共享 Button；取消在左，具体动作在右。危险操作使用 danger，标题写问句，description 只描述已确定的影响与保留规则，不补写未确认的业务承诺。需要阻断跨区域操作时使用 Dialog。

```jsx
<InlineConfirm title="删除这项密钥配置？" confirmLabel="删除配置" onCancel={close} onConfirm={remove} />
```
