DateRangePicker 使用受控 `{ start, end }` ISO 日期范围与 `onChange`，空字符串表示不限制该端，支持清空单端或整个范围。无效日期或开始晚于结束时保留草稿并显示关联错误，不向宿主发送无效范围；修正后恢复筛选。原生日期字段与组件共同校验日期有效性，组件不转换时区。旧 string 值仅作兼容只读展示。

```jsx
<DateRangePicker value={range} onChange={setRange} preset={preset} onPreset={setPreset}
  presetRanges={{'本季度': {start:'2026-07-01',end:'2026-09-30'}}} />
<Calendar month="2026 年 9 月" days={30} rangeStart={1} rangeEnd={day} onSelect={setDay} />
```

快捷区间由宿主按实际业务日历提供，组件不假设自然季度。Calendar 是固定月份的受控日期选择面板，缺少 onSelect 时禁用日期按钮；不展示无行为的翻月或应用入口。
