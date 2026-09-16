ProgressBar / Spinner — 进度条固定 3px、无渐变动画；转圈使用本地 Lucide loader-circle、默认 2px 描边（24px 画板）、900ms 线性（当前步骤 1.1s 琥珀）。

```jsx
<ProgressBar value={4} max={7} maxWidth={280} />
<Spinner size={16} />
```

转圈永不铺满全屏、永不写「加载中…」——写正在做的那件事；超过 8 秒必须给出可取消入口。