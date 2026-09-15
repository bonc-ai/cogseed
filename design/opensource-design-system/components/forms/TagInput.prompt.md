TagInput — 回车添加、点 × 移除、退格删末项；标签为 h 22 中性实底。

```jsx
<Field label="收件项目组" help={`已选 ${tags.length} / 9，回车添加、点 × 移除。`}>
  <TagInput tags={tags} onChange={setTags} />
</Field>
```

标签输入关联 Field 的 id 与帮助文本；中文输入法组合期间 Enter / Backspace 不触发标签增删，移除操作使用有名称的原生按钮。
