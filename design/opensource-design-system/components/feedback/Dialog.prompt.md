Dialog — w 420–520、r 14、阴影 window、遮罩 ink 28%。通过 portal 铺在视口上，避免父容器裁切。

```jsx
<Dialog danger title="删除任务与全部产物？" confirmLabel="删除"
  description="「项目里程碑与提醒」及其 3 份产物将被移出空间。审计留痕会保留 180 天，产物本身不可恢复。"
  extra={<Checkbox checked={cc} onChange={setCc} label="同时通知已抄送人" />} />
```

通过 portal 显示，使用 dialog / aria-modal 和标题关联；初始焦点为取消，Tab/Shift+Tab 在面板内循环，Escape 关闭后返回触发器。复用 Button，危险操作使用 dangerSolid。

当前契约：打开后锁定 body 滚动并隔离背景交互；嵌套对话框只允许最上层处理键盘。关闭后恢复此前 inert / overflow 和焦点；取消文案无额外空白。

表单使用 `children` 正文槽、`initialFocus="first"` 聚焦首个字段、`showClose` 标题栏关闭按钮、`confirmDisabled` 阻止无效提交。输入状态由宿主拥有；取消不保存。原确认对话框默认聚焦取消。模态内浮层挂在所属对话框下，参与焦点限制与背景隔离；Escape 优先收起浮层。
