UserMenu 是侧边栏底部的共享用户菜单，组合 Avatar 与 DropdownMenu，不读取账号或执行认证操作。

整行用户区域作为按钮，点击向上弹出，距入口 6px，宽度跟随入口。头部展示姓名与部门，操作分为「设置」与末组「退出登录」，两项分别使用 settings 与 logout 图标，统一为 14px、2px 描边，图标与文字间距 10px。点击外部或 Escape 关闭，Escape 将焦点还给入口；Enter / Space 激活入口及菜单项。

```jsx
<UserMenu name="陈昱" description="华东团队 · 项目一部"
  onSettings={openSettings} onSignOut={signOut} />
```

页面负责回调、退出确认与认证流程。页面样例的设置入口进入独立设置页，退出返回登录预览；不代表真实账户操作。导航组件卡片和全部带侧边栏的页面复用同一组件。
