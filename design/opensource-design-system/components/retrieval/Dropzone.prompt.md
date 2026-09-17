Dropzone / FileRow — 拖入区 h 104（1.5px accent 虚线），文件行 h 48。

```jsx
<Dropzone />
<FileRow name="项目台账_2026Q3.xlsx" meta="1.2MB · 已就绪 · 只读" />
<FileRow name="团队项目报告汇总.pdf" state="uploading" progress={62} />
<FileRow name="客户联系表.csv" state="blocked" action="申请授权"
  meta="含个人联系信息，需在任务内单次授权后才能解析。" />
```

合规拦截不说「上传失败」，直说拦下的原因与下一步动作。上传中用行内 3px 进度条，不用转圈。