# Model Configuration Reference UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现截图所示的直接模型授权页和可维护多模型的自定义供应商界面，同时保持凭据安全、优先级语义和真实运行链路。

**Architecture:** 恢复 `settings.js` 中仍保留的 provider/model picker 与 entry priority list，将 `model-authorization.js` 的分步向导退出主入口。扩展 `CustomProvider` 的启用状态与模型元数据，由 Main 提供原子模型管理和安全测试 IPC；Renderer 只接收脱敏凭据并通过现有 IPC 完成所有操作。

**Tech Stack:** Electron、TypeScript Main、vanilla HTML/CSS/JS Renderer、IPC、Vitest、JSON i18n。

---

### Task 1: 自定义供应商数据与 IPC 契约

**Files:** `src/main/features/auth.ts`, `src/main/features/custom_providers.ts`, `src/main/model/core-agent/custom_provider_runtime.ts`, `src/main/ipc/index.ts`, `test/main/features/custom_providers.test.ts`, `test/main/ipc/custom-providers.test.ts`

- [ ] 先写失败测试：多模型元数据、默认值/边界、启停、模型增删改与优先级条目联动、安全测试不回传密钥。
- [ ] 运行两个专项测试并确认因新契约缺失而失败。
- [ ] 扩展兼容旧 `models: string[]` 的存储结构和原子操作，接入 runtime 元数据与 IPC。
- [ ] 重跑专项测试和 `npm run typecheck`。

### Task 2: 主模型配置页

**Files:** `src/renderer/index.html`, `src/renderer/modules/settings.js`, `src/renderer/modules/model-authorization.js`, `src/renderer/style.css`, 四个 `src/renderer/locales/*.json`, `test/renderer/settings-add-account.test.ts`, `test/renderer/model-authorization-ui.test.ts`

- [ ] 先写失败测试：页面存在 provider/model picker、认证提示、添加账号、优先级列表与现有自定义供应商直接绑定。
- [ ] 运行专项测试并确认失败。
- [ ] 恢复直接选择器和 priority list 的初始化/刷新，移除主入口对分步向导的依赖，按截图调整布局和状态。
- [ ] 重跑专项测试。

### Task 3: 自定义供应商创建与详情

**Files:** `src/renderer/modules/settings.js`, `src/renderer/index.html`, `src/renderer/style.css`, 四个 `src/renderer/locales/*.json`, `test/renderer/settings-custom-providers.test.ts`

- [ ] 先写失败测试：创建字段、动态多模型、API 格式、首模型自动绑定、详情启停/编辑/删除、模型测试/编辑/删除。
- [ ] 运行专项测试并确认失败。
- [ ] 实现创建和详情两种 modal 状态，所有图标复用 `modules/icons.js`，所有异步动作有忙碌/失败/恢复状态。
- [ ] 重跑 Renderer 专项测试。

### Task 4: 集成验证

**Files:** 仅在验证发现缺陷时修改对应源文件与回归测试。

- [ ] 运行模型配置全部专项测试与 `npm run typecheck`。
- [ ] 运行 `npm test`。
- [ ] 执行 `scripts/restart-cogseed.sh`，核对 launcher 与当日日志。
- [ ] 在真实 Electron 中验证主选择器、自定义创建/详情、优先级列表与错误状态，并与五张参考图逐项对比。
