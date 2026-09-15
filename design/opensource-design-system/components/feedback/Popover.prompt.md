Popover 是共享弹出面板，承载选择列表、搜索分类或复合设置，不限定为 Dropdown Menu。

不传 open 时保留静态展示；传 open/onOpenChange 时启用锚定模式。面板优先向上弹出，距入口 6px，可 start/end 对齐；空间不足时自动翻转。anchorRef 指向入口区域，点击面板与入口以外收起；Escape 收起并聚焦 returnFocusRef 或入口。定位通过 portal 脱离滚动容器，限制在可用视口内。

锚定模式统一内边距 10px 12px、页脚 8px 12px，沿用圆角、边框与阴影 token。标题、徽标、页脚按需提供。输入台使用宽度档位：权限 180px、执行配置 300px、@ 选择 360px。@ 与权限省略标题；执行配置保留「执行配置（本次任务）」。

PopoverItem 统一图标 14px、单行最小 32px、含说明最小 44px、内边距 5px 8px，以及 hover 和键盘焦点的浅灰底反馈，静态不加边框，键盘 focus-visible 使用统一焦点环。不传 selected 是点击添加动作，无选中底色、勾选或按下语义；传 selected 是单选项，只用勾选标识当前值。trailing 支持当前模型标记等辅助内容。

```jsx
<div ref={anchorRef} style={{position:'relative'}}>
  <Button onClick={() => setOpen(!open)}>请求批准</Button>
  <Popover open={open} onOpenChange={setOpen} anchorRef={anchorRef} label="访问权限" width={180}>
    <PopoverItem label="请求批准" selected onClick={() => setOpen(false)} />
  </Popover>
</div>
```

输入台的 @、权限和执行配置均以各自入口容器为锚点，复用此结构；搜索、Tabs、推理强度由内部组合提供。静态与交互样例见反馈组件卡片，三种业务组合见输入台卡片。当前仅为设计预览，不代表正式客户端接入。

持续状态浮层可传 dismissible=false，禁用外部点击和 Escape 收起；宿主必须提供明确的结束／取消操作。用于麦克风录音状态，其他选择面板仍沿用默认收起行为。


锚定浮层通过 FloatingPanel 统一 portal、边界翻转和宽高限制。Tooltip 支持悬停与键盘焦点显示，Escape 隐藏；不占用文档流。
