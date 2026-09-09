# Agent 创建师选择性恢复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** 在当前 `local/creator-agent-builder-a2a` 分支恢复可发现、可治理创建 Agent 的完整“Agent 创建师”能力，不恢复独立 Creator 面板或旧分支无关改动。

**Architecture:** 以当前分支已有 Creator preset/store/lifecycle/materializer 为底座，选择性移植 backup 中的 Agent 创建师服务、只读工具、direct/governed Builder 和 IPC。共享文件按当前版本逐个接线；治理状态以 `(uid, cid)` 的持久化文件和现有 Creator lifecycle 证据为准。

**Tech Stack:** Electron main process, TypeScript, classic renderer IPC bridge, Vitest, JSON/JSONL storage, existing `chatWithModel` and Creator runtime.

---

## 文件地图

新增：`resources/builtin/marketplace/agents/287ce6012204/agent.json`；`src/main/features/creator/creator-agent-types.ts`、`creator-agent-service.ts`、`creator-agent-tools.ts`；`src/main/features/group_chat/agent-builder.ts`、`agent-builder-state.ts`、`agent-builder-governed-flow.ts`、`agent-smoke-run.ts`；`src/main/ipc/creator.ts`；`src/main/prompts/creator_agent.md`。

修改：`resources/builtin/_manifest.json`、`src/main/features/creator/index.ts`、`src/main/features/group_chat/agent-builder-governed.ts`、`src/main/features/group_chat/index.ts`、`src/main/features/group_chat/bus.ts`、`src/main/ipc/index.ts`、`src/main/preload.js`、必要时 `src/main/model/core-agent/runner.ts`。

测试：对应 Creator、Builder、IPC 和静态安全测试；保留当前工作区已有未提交改动。

## Task 1: Restore discoverable Agent resource

**Files:** Create `resources/builtin/marketplace/agents/287ce6012204/agent.json`; modify `resources/builtin/_manifest.json`; test `test/static/creator-security-boundary.test.ts`.

- [ ] **Step 1: Restore the exact definition.** Use `git show backup/creator-agent-builder-a2a-wip-20260901:resources/builtin/marketplace/agents/287ce6012204/agent.json`; preserve id `287ce6012204`, name `Agent 创建师`, `category=creation`, `interactive=true`, and create-only direct/governed workflow.
- [ ] **Step 2: Restore one manifest entry.** Add its path, byte count, SHA-256, and metadata in the same order as adjacent agents. Do not add old backup-only resources.
- [ ] **Step 3: Test discovery and safety.** Load JSON and manifest; assert id/name/category, both modes, and no direct-mode tools or existing-Agent edit path.
- [ ] **Step 4: Verify.** Run `npm test -- --run test/static/creator-security-boundary.test.ts`; expect zero failures.
- [ ] **Step 5: Commit.** `git add resources/builtin/marketplace/agents/287ce6012204/agent.json resources/builtin/_manifest.json test/static/creator-security-boundary.test.ts && git commit -m "feat(creator): restore agent creator builtin"`.

## Task 2: Restore Creator Agent service, types, tools, and prompt

**Files:** Create `src/main/features/creator/creator-agent-types.ts`, `creator-agent-service.ts`, `creator-agent-tools.ts`, `src/main/prompts/creator_agent.md`; modify `src/main/features/creator/index.ts` and only the current runner seam if required; test `test/main/features/creator/creator-agent-types.test.ts`, `creator-agent-service.test.ts`.

- [ ] **Step 1: Port output contracts.** Restore `CreatorAgentTurn`, capability-plan/check/inspection types and sanitizers while using current `CreatorPresetManifestV1` as the sole manifest type.
- [ ] **Step 2: Port `runCreatorAgent`.** Keep signature `(userId, input, deps?) -> Promise<CreatorAgentTurn>`. Call `chatWithModel` with ephemeral session, empty skills, `toolAccess: "creator-read-only"`, bounded idle/stream timeouts, and current user/project scope. Parse one JSON object, reject unsafe values, overwrite trusted provenance, validate schema/catalog, and save only a draft.
- [ ] **Step 3: Port read-only tools.** Restore `CREATOR_AGENT_TOOL_NAMES` and `createCreatorAgentTools`; permit only read/search/KB tools and Creator inspect/list/read/validation/simulation/verification. Bound JSON results and propagate abort signals.
- [ ] **Step 4: Restore prompt/exports.** Add the single-object `creator_agent.md` contract and export the modules. Do not add `creator-mode.js` or a Creator page.
- [ ] **Step 5: Add tests.** Cover draft/clarification/blocked envelopes, fenced/second-object parsing, URL/secret/path/command rejection, catalog mismatch, persistence, tool allow-list, bounded output, and no lifecycle side effects. Inject model/catalog/store; never call a real provider.
- [ ] **Step 6: Verify.** Run `npm test -- --run test/main/features/creator/creator-agent-types.test.ts test/main/features/creator/creator-agent-service.test.ts`; expect all pass.
- [ ] **Step 7: Commit.** `git add src/main/features/creator/creator-agent-types.ts src/main/features/creator/creator-agent-service.ts src/main/features/creator/creator-agent-tools.ts src/main/prompts/creator_agent.md src/main/features/creator/index.ts test/main/features/creator/creator-agent-types.test.ts test/main/features/creator/creator-agent-service.test.ts && git commit -m "feat(creator): restore creator agent service"`.

## Task 3: Restore direct and governed Agent Builder

**Files:** Create `src/main/features/group_chat/agent-builder.ts`, `agent-builder-state.ts`, `agent-builder-governed-flow.ts`, `agent-smoke-run.ts`; modify `agent-builder-governed.ts`, `group_chat/index.ts`, `group_chat/bus.ts`; test the corresponding Builder and smoke-run suites.

- [ ] **Step 1: Port direct builder.** Restore `applyAgentBuilderFields`/`applyAgentBuilderContainers` using current `agents.ts`; reject `agent_id` with `agent_builder_edit_not_supported`; direct mode rejects tools/skills and requires explicit confirmation.
- [ ] **Step 2: Port governed mapping.** Restore `containerToCreatorDraft(userId, fields, ctx, deps)`, map current `ExtractedFields`, canonicalize catalog ids, use current default model and `creator-read-only-v1`, validate before save, and fail closed for unavailable capabilities.
- [ ] **Step 3: Port state storage.** Restore `BuilderFlowState`, read/write/clear/lock/expiry helpers at `groupChatBuilderFlowFile(userId,cid)` with per-user/per-cid mutex; malformed or expired state cannot remain active.
- [ ] **Step 4: Port state machine.** Restore `startGovernedAgentBuilderFlow` and `continueGovernedAgentBuilderFlow` with `awaiting_confirm -> verifying -> awaiting_final_confirm -> materializing -> done`. Bind confirmations to draft digest and verification run; cancellation, abort, expiry, verify/smoke failure preserves draft and blocks materialization.
- [ ] **Step 5: Port smoke run.** Use temporary directory, `ephemeralSession`, `disableTools`, empty skills, abort propagation, bounded output, and unconditional cleanup.
- [ ] **Step 6: Wire existing dispatch seam.** Preserve KSTAR projection, P3394 admission, group abort, actor visibility, and single queue path.
- [ ] **Step 7: Add tests.** Cover direct create/edit rejection, governed confirmations, cancel/expiry/malformed state, verify/smoke failures, final confirmation, idempotent materialization, and abort.
- [ ] **Step 8: Verify.** Run `npm test -- --run test/main/features/group_chat/agent-builder.test.ts test/main/features/group_chat/agent-builder-governed.test.ts test/main/features/group_chat/agent-builder-governed-flow.test.ts test/main/features/group_chat/agent-smoke-run.test.ts`.
- [ ] **Step 9: Commit.** `git add src/main/features/group_chat/agent-builder.ts src/main/features/group_chat/agent-builder-state.ts src/main/features/group_chat/agent-builder-governed-flow.ts src/main/features/group_chat/agent-smoke-run.ts src/main/features/group_chat/agent-builder-governed.ts src/main/features/group_chat/index.ts src/main/features/group_chat/bus.ts test/main/features/group_chat/agent-builder*.test.ts test/main/features/group_chat/agent-smoke-run.test.ts && git commit -m "feat(creator): restore governed agent builder"`.

## Task 4: Restore Creator IPC boundary

**Files:** Create `src/main/ipc/creator.ts`; modify `src/main/ipc/index.ts`, `src/main/preload.js`; test `test/main/ipc/creator.test.ts`, `test/renderer/creator-ipc-wiring.test.ts`.

- [ ] **Step 1: Port handlers.** Restore `createCreatorIpcHandlers` and dynamic `runCreatorAgent` import for inspect, agent run, draft propose/read/simulate/verify, preset list/publish/activate/disable/rollback. Keep user scope, identifier, digest, confirmation, safe-summary, and output-redaction checks.
- [ ] **Step 2: Register current dispatcher.** Route only `creator.*` through the existing IPC dispatcher; keep business logic in features.
- [ ] **Step 3: Extend preload allow-list.** Add exact existing Creator channels only; no panel/navigation/module.
- [ ] **Step 4: Test.** Cover invalid payloads, flags, scope mismatch, digest/confirmation errors, safe filtering, successful injected forwarding, and preload channel contract.
- [ ] **Step 5: Verify.** Run `npm test -- --run test/main/ipc/creator.test.ts test/renderer/creator-ipc-wiring.test.ts`.
- [ ] **Step 6: Commit.** `git add src/main/ipc/creator.ts src/main/ipc/index.ts src/main/preload.js test/main/ipc/creator.test.ts test/renderer/creator-ipc-wiring.test.ts && git commit -m "feat(creator): restore creator ipc boundary"`.

## Task 5: Cross-layer verification and compatibility

- [ ] **Step 1: Run `npm run typecheck`; expect exit 0.** Fix only current-API mismatches introduced by this selective port.
- [ ] **Step 2: Run `npm test -- --run test/main/features/creator test/main/features/group_chat test/main/ipc/creator.test.ts test/static/creator-security-boundary.test.ts`; expect zero failures.**
- [ ] **Step 3: Run `npm test`; record exact exit code and counts.** Do not mask product failures as environment failures.
- [ ] **Step 4: Audit `git diff origin/develop...HEAD --stat` and `git diff --name-only HEAD~5..HEAD`.** Changed paths must be limited to this recovery, tests, and committed docs; no independent Creator panel or remote A2A protocol.

## Task 6: Electron runtime verification

- [ ] **Step 1: Run `scripts/restart-cogseed.sh`; inspect `/tmp/cogseed-agent-cogseed-run.log` and runtime data logs.**
- [ ] **Step 2: Confirm builtin marketplace discovery contains Agent `287ce6012204`.**
- [ ] **Step 3: Run one pure-text governed flow: config sheet -> confirmation -> schema/catalog verification -> no-tool smoke -> final confirmation -> materialize.** Confirm Creator provenance/binding/dispatch policy and absence of a Creator panel.
- [ ] **Step 4: Commit only recovery compatibility fixes and verification notes.** Use `git add <explicit recovery files>`; never stage the user's unrelated worktree changes.

## Final verification gate

Before claiming completion, rerun fresh `npm run typecheck`, `npm test`, and Electron restart/discovery checks. Report exact evidence and explicitly identify any unverified real-provider or platform-specific paths.
