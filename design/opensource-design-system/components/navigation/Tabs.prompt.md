Tabs — 下压线 1.5px ink，计数用 系统非衬线跟随标签，不做徽标气泡。

```jsx
<Tabs value={t} onChange={setT} items={['预览',{label:'变更',count:12},{label:'引用',count:6},{label:'审计（无权限）',disabled:true}]} />
```

同一屏内不与 SegmentedControl 共存。
页签使用原生按钮，Tab 进入当前选中项，左右方向键循环切换，Home / End 跳至首尾可用项，Enter 或空格激活；禁用项跳过，输入法组合期间不处理快捷键。焦点项自动滚动到可见区域。输入台选择器复用同一组件。

页面主导航统一通过 UI Kit 的 `PageTabs` 组合：内容区最大宽度沿用卡片网格变量，顶部距 Header 统一 12px，左右内边距桌面 32px、窄屏 16px；页签下方留白 24px。页签保持单行并横向滚动，右侧操作固定在滚动区外。搜索与筛选位于下方工具栏；二级筛选仍使用基础 Tabs。


选中下划线由共享 CSS 管理，不以内联 box-shadow 覆盖 focus-visible 的统一外环。支持 Home / End、左右方向键与单一 Tab 入口，焦点项滚动到可见位置。
