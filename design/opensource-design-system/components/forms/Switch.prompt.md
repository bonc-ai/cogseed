Switch — 34×20（卡片内 32×18），拖柄 140ms cubic-bezier(.2,.8,.2,1)。

```jsx
<Switch checked={on} onChange={setOn} />
<Switch checked onColor="var(--cs-attention)" />
<Switch checked size="sm" onColor="var(--cs-success)" />
```
交互使用原生按钮与 role="switch"，支持 Enter / Space 切换；独立开关提供 aria-label，保留可见键盘焦点。
