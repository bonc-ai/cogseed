Pagination — 页码使用系统非衬线、选中 accent 9% 底；右侧恒显总量与每页条数。

```jsx
<Pagination page={p} pageCount={9} total={1842} pageSize={200} onChange={setP} />
```

当前契约：使用 nav 和原生按钮，当前页以 aria-current="page" 标识；首尾按钮按边界禁用，中间页始终可见。locale 默认 zh-CN，可覆盖为消费方语言。
