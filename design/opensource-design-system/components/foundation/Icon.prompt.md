Icon — CogSeed 开源版唯一图标来源：本地 Lucide 官方 SVG，统一线性、24px 画板、2px 描边、单色。

```jsx
<Icon name="space" size={16} />
<Icon name="check" color="var(--cs-success)" strokeWidth={1.8} />
```

界面内显示 13–16px，规范示意 20px。**不使用填充图标、彩色图标或 emoji**；勾选类图标可把 strokeWidth 提到 1.6–2.2。

设置使用 `settings` 齿轮图标（轮齿与中心圆孔），退出登录使用 `logout`（门框与向外箭头）。用户菜单两项统一显示为 14px，沿用默认 2px 描边。

当前契约：默认尺寸与描边读取 --cs-icon-size / --cs-icon-stroke。静态名称由 verify-source.cjs 校验；预览开发时设置 window.COGSEED_DESIGN_DEBUG=true，动态未知名称会警告并省略图标。
