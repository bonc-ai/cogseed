# Tasks: 9.17 Bug 清单修复（第二批）

**Feature**: `002-sept17-bug-fixes`
**Spec**: `specs/002-sept17-bug-fixes/spec.md`
**Plan**: `specs/002-sept17-bug-fixes/plan.md`

## Phase 1: Setup

- [x] T001 建立 `specs/002-sept17-bug-fixes/` 规格工件（spec/plan/research/data-model/quickstart）
- [x] T002 逐条复核 4 个 bug 的真实代码入口与根因

## Phase 2: Foundational

- [x] T003 确认 `specs/001-reconcile-task-status` 对应测试文件与实现仍在仓库中

## Phase 3: User Story 1 — 连接测试正常时任务必须真正执行

- [x] T004 [US1] 在 `test/main/features/auth.test.ts` 增加「全部候选冷却 → 返回冷却兜底候选」失败用例
- [x] T005 [US1] 修改 `src/main/features/auth.ts::pickChatEntryGroup` 实现冷却兜底候选
- [x] T006 [US1] 确认既有「冷却 profile 被跳过（存在健康候选）」用例仍通过

## Phase 4: User Story 2 — 表单可以跳过不回答

- [x] T007 [US2] 在 `test/renderer/chat-input-form.test.ts` 增加跳过提交用例（含重复点击只提交一次）
- [x] T008 [US2] 在 `src/renderer/modules/chat-input-form.js` 增加跳过按钮与 `_dispatch` 共享提交路径
- [x] T009 [US2] 在 `src/renderer/locales/{zh,en,ja,pt}.json` 增加 `chat.form.skip`、`chat.form.skipped_note`

## Phase 5: User Story 3 — 知识库问答输入框自动扩容

- [x] T010 [US3] 在 `test/renderer/kb-workbench.test.ts` 增加扩容 / 封顶 / 复位用例
- [x] T011 [US3] 在 `src/renderer/modules/kb-workbench.js` 实现 `_autoGrowQaInput` 并接入 input 与发送复位
- [x] T012 [US3] 在 `src/renderer/style.css` 调整 `.kb-qa-input` 最小高度与默认溢出

## Phase 6: User Story 4 — 任务状态与重试回归

- [x] T013 [US4] 运行 001 的 3 个测试文件确认回归通过

## Phase 7: Polish

- [x] T014 运行 `npm run test:js -- <本批测试文件>`
- [x] T015 运行 `npm run typecheck`、`npm run lint`、`npm run tokens:check`
- [x] T016 运行 `git diff --check` 并复查 diff
