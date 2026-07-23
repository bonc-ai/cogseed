# Companion Research Repro 正式入口实施计划

日期：2026-07-23  
Spec：`/Users/sudai/Documents/Mate Agent/docs/superpowers/specs/2026-07-23-companion-research-repro-entry-design.md`

## Goal

实现一个正式、可复用但固定于 `Paper + GitHub 论文复现` 场景的 Companion Research Repro 入口，串起导入、ReferenceManifest、ProjectContext、TaskContract、确认门槛、执行启动和 Evidence 最小链路。

## Key changes

1. 新增 main feature：`/Users/sudai/Documents/Mate Agent/src/main/features/companion_repro.ts`。
2. 新增 IPC handlers：`companionRepro.*`。
3. 新增 renderer module：`/Users/sudai/Documents/Mate Agent/src/renderer/modules/companion-repro.js`。
4. 在 conversation 页面挂载 Research Repro 卡片。
5. 新增样式和 i18n。
6. 新增 main + renderer 测试。

## Task list

### Task 1：Main feature 数据模型与存储

- 新增 `src/main/features/companion_repro.ts`。
- 使用 `conversationLayout(uid, cid).groupDir` 下的 `companion_repro/state.json` 和 `evidence.jsonl`。
- 实现：
  - `companionReproPaths(uid, cid)`
  - `readCompanionReproState(uid, cid)`
  - `saveDraft(uid, cid, draft)`
  - `readEvidence(uid, cid, limit)`

### Task 2：ReferenceManifest 与 ProjectContext

- 在 `saveDraft` 中扫描 `workspace_path`。
- included files 限制为最多 40 个、单文件元数据不读正文。
- 跳过 `.git`、`node_modules`、`dist`、`build`、`.env*`、大于 256KB 的文件。
- 实现 `generateProjectContext(uid, cid)`。
- 从文件名推断 tech stack 和 key files。
- uncertainties 至少包含一条。

### Task 3：ProjectContext 修正与 TaskContract

- 实现 `applyProjectContextRevision(uid, cid, { before, after, reason })`。
- 实现 `generateTaskContract(uid, cid)`。
- TaskContract 必须包含 goal、success_criteria、context_refs、plan、risks。
- `confirmed_at` 初始为 null。

### Task 4：确认门槛与执行启动

- 实现 `confirmTaskContract(uid, cid, confirmedBy)`。
- 实现 `startExecution(uid, cid, sendAdapter?)`。
- 未确认时必须拒绝。
- 确认后通过注入的 send adapter 调用现有 group chat send；生产 handler 使用 `groupChat.send`。
- Evidence 记录 execution_started 或 execution_start_failed。

### Task 5：IPC wiring

- 在 `src/main/ipc/index.ts` 注册：
  - `companionRepro.getState`
  - `companionRepro.saveDraft`
  - `companionRepro.generateProjectContext`
  - `companionRepro.applyProjectContextRevision`
  - `companionRepro.generateTaskContract`
  - `companionRepro.confirmTaskContract`
  - `companionRepro.startExecution`
  - `companionRepro.readEvidence`

### Task 6：Renderer 卡片

- 新增 `src/renderer/modules/companion-repro.js`。
- 在 `src/renderer/index.html` 添加 classic script。
- 在 conversation header 或 history 顶部挂载 Research Repro 卡片。
- 卡片显示四区：导入、ReferenceManifest、ProjectContext、TaskContract。
- 执行按钮确认前 disabled。

### Task 7：样式与 i18n

- 更新 `src/renderer/style.css`。
- 更新 `src/renderer/locales/en.json` 和 `src/renderer/locales/zh.json`。

### Task 8：测试与验证

- 新增 `test/main/features/companion_repro.test.ts`。
- 新增 `test/renderer/companion-repro.test.ts`。
- 运行：
  - `npm run test:js -- test/main/features/companion_repro.test.ts test/renderer/companion-repro.test.ts`
  - `npm run typecheck`
  - `npm run test:js -- test/main/features/group_chat/collaboration.test.ts test/main/features/group_chat/bus.test.ts test/renderer/conversation-collaboration-status.test.ts`

## Verification

完成后必须证明：

1. 未确认 TaskContract 时 `startExecution` 不调用 send adapter。
2. 确认后 `startExecution` 调用 send adapter。
3. State 和 Evidence 落在 conversation group dir 下。
4. Renderer 确认前按钮 disabled，确认后 enabled。
5. Existing group_chat collaboration tests 不回归。

## Next skill

`$superpower-executing-plans`
