Button — 动宾短语的动作按钮；一屏最多一个 primary，侧栏里没有主按钮。

```jsx
<Button variant="primary" icon={<Icon name="plus" size={14} />}>新建空间</Button>
<Button>搜索空间</Button>
<Button variant="ghost">查看全部</Button>
<Button variant="danger">删除任务…</Button>
```

变体：primary / secondary / ghost / danger / dangerSolid / ink。尺寸 sm 28 · md 32 · lg 36。loading 保持原宽度并禁用；文案用「允许一次」「存入空间」这类动宾短语，不用「确定」。

首页建议项使用 `variant="suggestion"`；登录使用 `variant="primary" size="login"`，保留 56px 高度特例。


默认、悬停、focus-visible、disabled、loading 使用共享 actions.css；loading 设置 disabled 与 aria-busy，spinner 绝对定位不改变按钮宽度。
