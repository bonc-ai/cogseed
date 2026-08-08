# 消息平台设置页微调设计（修订版）

> 修订说明：2026-08-08 实现反馈后，将原“高密度双栏重构”方案回退为**原案基础上的最小微调**。原版设计文档已被本修订版取代。最终实现保留原案全部卡片式纵向布局、控件配色与响应式断点，仅调整三处。

## 目标

在消息平台设置页原案（`6086108a` 之前的卡片式布局）基础上做最小改动：

1. 左侧平台菜单收窄，把释放的横向空间交给右侧配置区。
2. 右侧配置区所在的白色大框替换为与整体浅绿主题兼容的背景。
3. 轻微压缩垂直间距，使主要配置在常用桌面窗口内更紧凑、尽量单屏可见。

不改变业务逻辑、IPC 契约、频道顺序和渲染结构。

## 微调点

### 1. 双栏宽度

- `.messaging-layout`：`280px minmax(0, 1fr)` → `232px minmax(0, 1fr)`；`gap: 16px` → `12px`。
- 右侧 `.messaging-panel` 自动吃满剩余宽度。

### 2. 背景融入

- `.messaging-settings-shell`、`.messaging-page`：`background: var(--surface)` → `var(--bg)`，白色大框消失，与整体浅绿网格背景一致。
- 左侧菜单、全部配置卡片、按钮、输入框、选择器**保持原案的 `var(--surface)` 白色**，维持卡片层次。
- 二维码容器保持白色高对比度（功能性例外）。

### 3. 密度（只动间距，不动字号和控件尺寸）

- `.messaging-panel-body`：`gap: 10px` → `8px`。
- `.messaging-config-card`：`margin-top: 10px` → `8px`；`padding: 14px 16px` → `12px 14px`。
- `.messaging-config-card-heading p`：`margin-top: 4px` → `3px`。
- `.messaging-detail-header`：`padding: 8px 4px 16px` → `8px 4px 12px`。
- `.messaging-preference-row`：`min-height: 96px` → `72px`；`padding: 14px 16px` → `12px 14px`。
- `.messaging-instance-row`：`padding: 7px 10px` → `6px 10px`。

### 保持不变的（原案）

- 右侧配置区为纵向卡片流（flex column），不引入并排网格。
- 品牌图标 48px、标题 18px、菜单内部间距与行高、按钮/选择器/输入框配色。
- `max-width: 760px` 与 `max-width: 560px` 两个响应式断点全部保持原案行为。
- `.messaging-page` 保留 `overflow: auto` 作为窗口过矮时的兜底滚动。

## 数据流与错误处理

与修订前一致：不改 `messaging-settings.js` 渲染与 IPC；动态内容（二维码、错误提示、多实例）不被截断。

## 验证

- `test/renderer/settings-tabs.test.ts` 布局契约断言：菜单 `232px`、panel-body 保持 flex column、shell/page 背景 `var(--bg)`、卡片背景 `var(--surface)`、滚动兜底。
- 真实环境：独立变体实例启动后，菜单宽 232px、右侧 915px、`scrollH === clientH` 无滚动、shell 背景 `#FBFDFC`、卡片白色。
