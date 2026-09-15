Field — 包裹任意控件，提供标签（13/500）、说明（12.5）与错误行，间距 7。

```jsx
<Field label="提醒抄送范围" optional help="抄送对象仅收到汇总口径，不含客户明细。">
  <Input defaultValue="团队行长 · 风险条线负责人" />
</Field>
<Field label="生效日期" error="日期不存在，请按 YYYY-MM-DD 填写。"><Input mono invalid /></Field>
```

直接包裹单个控件时自动关联 label、id 与帮助/错误文本；显式控件 id 优先，错误使用 aria-invalid 与关联提示。多个控件应分别提供可访问名称。
