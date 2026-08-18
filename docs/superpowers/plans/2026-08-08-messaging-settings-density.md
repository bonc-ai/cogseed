# 消息平台设置页高密度布局实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变消息平台 IPC 与业务状态的前提下，将消息平台设置页调整为浅绿主题的高密度桌面双栏布局，使常用桌面窗口内的主要配置尽量完整可见。

**Architecture:** 保留 `messaging-settings.js` 当前动态 DOM 和所有 IPC 调用，仅通过消息平台命名空间 CSS 重排现有直接子节点。桌面端使用约 `224px` 的平台菜单加自适应详情区，详情卡片使用 CSS Grid 组织全宽区和两列配置区；窄窗口回退为单列布局并保留必要滚动。现有 `test/renderer/settings-tabs.test.ts` 扩展为结构与样式契约测试。

**Tech Stack:** Electron renderer、原生 HTML/CSS/JavaScript、Vitest（通过项目 `npm test` 脚本运行）。

## Global Constraints

- 不修改 `src/main/ipc/messaging.ts` 或 `src/main/features/messaging/**`。
- 不修改 `window.cogseed` IPC 名称、参数、消息平台状态机和频道顺序。
- 不引入 npm 依赖；渲染器继续使用 classic scripts。
- 全局 `:root` 主题变量保持不变；配色调整限定在 `.messaging-*` 命名空间。
- 只有二维码容器保留白色背景以维持扫描对比度，其他消息平台主体背景使用现有浅绿主题 token 或 `color-mix`。
- 动态二维码、错误提示、禁用状态和进行中状态不能被 `overflow: hidden` 截断。
- 代码和测试保持 ASCII；现有中文文案不改动。
- 测试使用 `npm test`，不直接运行 `npx vitest`；变更完成后按工作区约定重启当前 Mate 客户端并检查运行日志。

---

## 文件映射

- Modify: `test/renderer/settings-tabs.test.ts` — 增加消息平台高密度布局的 CSS 契约测试，不驱动 DOM 业务逻辑。
- Modify: `src/renderer/style.css:12214-12608` — 调整消息平台 shell、双栏、卡片密度、主题背景和响应式规则。
- No change: `src/renderer/modules/messaging-settings.js` — 当前直接子节点已经足够支持 CSS Grid，不增加无必要的 wrapper 或业务 class。

---

### Task 1: 锁定高密度布局契约并实现消息平台 CSS

**Files:**
- Modify: `test/renderer/settings-tabs.test.ts:103-144`
- Modify: `src/renderer/style.css:12214-12608`

**Interfaces:**
- Consumes: 设计文档 `docs/superpowers/specs/2026-08-08-messaging-settings-density-design.md`，以及现有消息平台直接子节点：`.messaging-instance-card`、`.messaging-association-card`、`.messaging-owner-card`、`.messaging-preferences-card`、`.messaging-delete-card`。
- Produces: CSS 结构契约：桌面菜单列为 `minmax(220px, 224px)`、详情区为 `minmax(0, 1fr)`；详情 body 使用两列 Grid；实例、偏好、删除和平台特定卡片的跨列规则明确；`760px` 以下回退单列；消息平台主体使用浅绿背景。

- [ ] **Step 1: 在现有 renderer 测试中写失败的布局契约测试**

在 `describe('settings tabs module', ...)` 的首个测试之后加入以下测试。它只读取消息平台 CSS，不要求引入 DOM 测试框架：

```ts
  it('defines a dense theme-compatible messaging layout with a narrow menu and mobile fallback', () => {
    const style = fs.readFileSync(path.join(root, 'src/renderer/style.css'), 'utf8');

    expect(style).toMatch(/\.messaging-layout\s*\{[\s\S]*?grid-template-columns:\s*minmax\(220px,\s*224px\)\s+minmax\(0,\s*1fr\);/);
    expect(style).toMatch(/\.messaging-panel-body\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
    expect(style).toMatch(/\.messaging-panel-body\s*>\s*\.messaging-instance-card,[\s\S]*?grid-column:\s*1\s*\/\s*-1;/);
    expect(style).toMatch(/\.messaging-settings-shell\s*\{[\s\S]*?background:\s*var\(--bg\);/);
    expect(style).toMatch(/\.messaging-config-card\s*\{[\s\S]*?background:\s*color-mix\(in srgb,\s*var\(--surface-2\)\s+62%,\s*var\(--bg\)\);/);
    expect(style).toMatch(/\.messaging-page\s*\{[\s\S]*?overflow:\s*auto;/);
    expect(style).toMatch(/@media\s*\(max-width:\s*760px\)[\s\S]*?\.messaging-panel-body\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
  });
```

- [ ] **Step 2: 运行定向测试，确认新契约在 CSS 实现前失败**

Run:

```bash
npm run test:js -- test/renderer/settings-tabs.test.ts
```

Expected: 现有消息平台相关测试通过，但新增测试失败，至少指出当前 `.messaging-layout` 仍为 `280px minmax(0, 1fr)` 或 `.messaging-panel-body` 尚未使用两列 Grid。

- [ ] **Step 3: 实现桌面高密度布局和主题背景**

在 `src/renderer/style.css` 的消息平台样式区段中，将 shell、page、layout、menu 和 panel body 调整为以下规则；保留未列出的现有交互态和图标规则：

```css
.messaging-settings-shell {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  width: 100%;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  background: var(--bg);
  overflow: hidden;
}
.messaging-page {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 10px;
  background: var(--bg);
}
.messaging-layout {
  display: grid;
  grid-template-columns: minmax(220px, 224px) minmax(0, 1fr);
  gap: 10px;
  align-items: stretch;
  min-height: 100%;
}
.messaging-menu {
  display: flex;
  flex-direction: column;
  gap: 3px;
  align-self: stretch;
  padding: 10px 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--surface-2) 76%, var(--bg));
}
.messaging-menu-title {
  margin: 0 6px 6px;
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
}
.messaging-menu-group-label {
  margin: 6px 6px 3px;
  font-size: 10px;
  font-weight: 650;
  letter-spacing: .45px;
  color: var(--text-2);
}
.messaging-menu-item {
  min-height: 34px;
  padding: 4px 6px;
  gap: 8px;
  border-radius: 7px;
}
.messaging-menu-item-glyph { width: 20px; height: 20px; }
.messaging-panel {
  min-width: 0;
  min-height: 100%;
}
.messaging-panel-body {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  align-items: stretch;
}
.messaging-panel-body > .messaging-instance-card,
.messaging-panel-body > .messaging-preferences-card,
.messaging-panel-body > .messaging-delete-card,
.messaging-panel-body > .messaging-telegram-card,
.messaging-panel-body > .messaging-wecom-card,
.messaging-panel-body > .messaging-empty-card {
  grid-column: 1 / -1;
}
.messaging-association-card,
.messaging-owner-card {
  height: 100%;
}
```

- [ ] **Step 4: 压缩详情头部、卡片和控件的垂直密度，并替换局部白色背景**

继续在同一消息平台 CSS 区段中应用以下规则；二维码容器的 `background: #fff` 保持不变：

```css
.messaging-detail-header {
  gap: 10px;
  padding: 4px 0 10px;
}
.messaging-brand-icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
}
.messaging-brand-glyph { width: 22px; height: 22px; }
.messaging-detail-title-wrap h2 { font-size: 17px; }
.messaging-config-card {
  margin-top: 6px;
  padding: 10px 12px;
  border-color: var(--border-strong);
  background: color-mix(in srgb, var(--surface-2) 62%, var(--bg));
}
.messaging-config-card-heading p {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.35;
}
.messaging-association-row,
.messaging-owner-bound-row,
.messaging-preference-row {
  gap: 10px;
}
.messaging-instance-row {
  padding: 6px 8px;
  border-color: var(--border);
  background: color-mix(in srgb, var(--surface-2) 46%, var(--bg));
}
.messaging-instance-row.is-selected {
  border-color: var(--primary);
  background: var(--primary-soft);
}
.messaging-scan-button,
.messaging-secondary-button {
  background: color-mix(in srgb, var(--surface-2) 52%, var(--bg));
}
.messaging-scan-button:hover:not(:disabled),
.messaging-secondary-button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--surface-3) 68%, var(--bg));
}
.messaging-page .form-input,
.messaging-detail-select {
  background: color-mix(in srgb, var(--surface-2) 42%, var(--bg));
}
.messaging-detail-select {
  width: min(280px, 46%);
  min-height: 32px;
  padding: 5px 30px 5px 10px;
}
.messaging-preferences-card { padding: 0; }
.messaging-preference-row {
  min-height: 58px;
  padding: 9px 12px;
}
.messaging-preference-row .messaging-config-card-heading { flex: 1 1 auto; }
.messaging-qr-panel {
  gap: 12px;
  margin-top: 10px;
  padding-top: 10px;
}
.messaging-qr-code {
  background: #fff;
}
```

这些规则只使用消息平台选择器，不能修改 `:root` 或其他设置页共用的 `.settings-*`、`.form-input` 基础规则。

- [ ] **Step 5: 增加窄窗口单列回退，并确保内容不被截断**

在现有 `@media (max-width: 760px)` 规则中加入以下声明；在 `@media (max-width: 560px)` 中保留现有纵向输入和二维码规则：

```css
@media (max-width: 760px) {
  .messaging-layout {
    grid-template-columns: 1fr;
  }
  .messaging-panel-body {
    grid-template-columns: 1fr;
  }
  .messaging-panel-body > .messaging-instance-card,
  .messaging-panel-body > .messaging-preferences-card,
  .messaging-panel-body > .messaging-delete-card,
  .messaging-panel-body > .messaging-telegram-card,
  .messaging-panel-body > .messaging-wecom-card,
  .messaging-panel-body > .messaging-empty-card {
    grid-column: auto;
  }
  .messaging-association-card,
  .messaging-owner-card {
    height: auto;
  }
}
```

不要给 `.messaging-panel`、`.messaging-panel-body` 或 `.messaging-config-card` 增加 `overflow: hidden`；只有现有 preferences 卡片的边界裁切规则可以保留，因为其内容是内部行分隔，不会裁切动态状态。

- [ ] **Step 6: 运行定向测试，确认布局契约通过且业务测试未受影响**

Run:

```bash
npm run test:js -- test/renderer/settings-tabs.test.ts
```

Expected: `settings-tabs.test.ts` 全部通过；新增布局测试验证菜单宽度、两列详情 Grid、主题背景、详情滚动兜底和 `760px` 单列回退。

- [ ] **Step 7: 检查样式 diff 和类型边界**

Run:

```bash
git diff --check
rg -n "messaging-(settings-shell|page|layout|menu|panel-body|config-card|preference-row)" src/renderer/style.css

git diff -- src/renderer/modules/messaging-settings.js src/main/ipc/messaging.ts src/main/features/messaging
```

Expected:

- `git diff --check` 无输出。
- 所有新规则均落在消息平台专属选择器或其媒体查询内。
- 最后一条命令无输出，证明本次没有修改消息平台 renderer 业务模块、IPC 或 main feature。

- [ ] **Step 8: 提交实现变更**

```bash
git add src/renderer/style.css test/renderer/settings-tabs.test.ts
git commit -m "fix: densify messaging settings layout"
```

Expected: 提交只包含消息平台 CSS 和对应 renderer 样式契约测试。

---

### Task 2: 完成全量测试和真实桌面验证

**Files:**
- No new files.
- Verify: `src/renderer/style.css`, `test/renderer/settings-tabs.test.ts`

**Interfaces:**
- Consumes: Task 1 已提交的 CSS 和测试契约。
- Produces: 通过自动测试和实际 Electron 界面检查的验证记录；如发现问题，只回到 Task 1 的对应 CSS 规则修复，不改变业务层。

- [ ] **Step 1: 运行项目全量 JavaScript 与资源测试**

```bash
npm test
```

Expected: `test:js` 和 `test:resources` 都以退出码 `0` 完成；若 sqlite ABI 失败，先按项目既有流程运行 `npm run rebuild:sqlite:electron`，再重新执行 `npm test`。

- [ ] **Step 2: 运行 TypeScript 类型检查**

```bash
npm run typecheck
```

Expected: `tsc --noEmit` 退出码 `0`；CSS-only 改动不应引入 TypeScript 错误。

- [ ] **Step 3: 重启当前工作树的 Mate 客户端**

```bash
scripts/restart-cogseed.sh
```

Expected: 当前 worktree 的 Mate 运行实例被重启；随后检查：

```bash
ls -t ~/.cogseed/runtime-variants/messaging/data/logs/*.log | head -1
rg -n "error|uncaught|messaging" /tmp/cogseed-agent-messaging-run.log ~/.cogseed/runtime-variants/messaging/data/logs/*.log
```

Expected: 启动日志存在，未出现本次改动引起的启动异常；仅将真实错误作为失败处理，不把正常消息平台状态日志误判为故障。

- [ ] **Step 4: 在桌面窗口中完成视觉与交互检查**

打开设置页的“消息平台”，使用常用桌面窗口尺寸检查以下结果：

1. 左侧消息平台菜单明显小于原 `280px`，目标接近 `224px`。
2. 右侧详情区域向左扩展并填满释放出的横向空间。
3. 已绑定飞书配置中，实例、关联机器人、机器人归属、回复颗粒度和工作区范围在常用窗口内主要内容可见，不出现无意义白色大块。
4. 关联机器人和机器人归属在桌面端并排；二维码出现时二维码可见且仍为高对比度背景。
5. Telegram、企业微信、未绑定频道仍可连接或进入其已有操作流程。
6. 启用开关、解绑、删除、选择器、错误提示和进行中状态没有被遮挡或截断。

- [ ] **Step 5: 验证窄窗口回退**

将 Electron 窗口缩窄到 `760px` 以下，再缩窄到 `560px` 以下，检查：

- 菜单与详情变为单列。
- 配置卡片不发生横向溢出。
- 输入框、按钮和选择器保持可用。
- 二维码区域按现有规则纵向排列。
- 内容过高时可以滚动，但没有固定高度造成的裁切。

- [ ] **Step 6: 汇总最终工作树状态**

```bash
git status --short
git log -2 --oneline
```

Expected: 工作树无未提交的实现变更；最近提交包含设计文档和消息平台高密度布局实现。最终报告明确列出 `npm test`、`npm run typecheck` 和真实桌面检查是否通过，不能用未执行的验证替代实际结果。
