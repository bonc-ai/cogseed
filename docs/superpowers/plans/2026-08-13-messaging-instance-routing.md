# Messaging Instance Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one connected account per channel the normal UI, keep additional bots behind an advanced action, and make every multi-instance proactive/touchpoint delivery explicit through a default instance or scene override.

**Architecture:** Reuse `features/touchpoints/config.ts` as the sole persisted routing boundary. Add a resolver in the messaging proactive service that accepts an explicit instance first, then a scene route, then the global default, and fails closed when multiple available instances remain without an explicit choice. Keep inbound instance isolation and WeChat single-active registration semantics unchanged.

**Tech Stack:** Electron main-process TypeScript, vanilla classic-script renderer, JSON user-scoped storage, Vitest.

---

### Task 1: Lock routing invariants with failing tests

**Files:**
- Modify: `test/main/features/messaging-proactive.test.ts`
- Modify: `test/main/features/messaging-multi-instance.test.ts`

- [ ] Add a test proving two available bots without routing configuration return `E_MESSAGING_TARGET_AMBIGUOUS` and candidate IDs.
- [ ] Add a test proving the persisted global default is chosen when no explicit `instance_id` is provided.
- [ ] Add a test proving a scene route overrides the global default for approval/briefing delivery.
- [ ] Run the focused tests and confirm they fail because proactive resolution does not read touchpoint routing.

### Task 2: Implement fail-closed default and scene routing

**Files:**
- Modify: `src/main/features/messaging/proactive.ts`
- Modify: `src/main/features/touchpoints/config.ts`
- Test: `test/main/features/messaging-proactive.test.ts`

- [ ] Add an optional `scene` input to text and file self-send requests.
- [ ] Resolve in order: explicit instance ID, `routes[scene]`, `defaultInstanceId`, then the single available instance only when exactly one exists.
- [ ] Treat configured-but-deleted/disabled/disconnected/unbound routes as errors; never silently fall back to another bot.
- [ ] Preserve the existing confirmation and delivery ledger path after resolution.
- [ ] Run focused tests and typecheck.

### Task 3: Make the connection UI single-instance by default

**Files:**
- Modify: `src/renderer/modules/messaging-settings.js`
- Modify: `src/renderer/style.css`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/pt.json`
- Modify: `test/renderer/messaging-settings-layout-contract.test.ts`

- [ ] Render one primary connected instance for each channel in the normal view.
- [ ] Render “add another bot” only inside an advanced disclosure for Feishu/Lark, Telegram, and WeCom; do not render it for personal WeChat.
- [ ] Add default-instance and per-scene route selectors to the connected-channel settings surface, using the existing touchpoint config IPC.
- [ ] Show an explicit unresolved-routing warning when multiple instances exist without a default or scene route.
- [ ] Keep all existing bind, enable, owner, behavior, workspace, unbind, and delete actions wired to their current IPC handlers.
- [ ] Run renderer contract, syntax, locale parsing, and typecheck commands.

### Task 4: Verify the real application surface

**Files:**
- No source changes unless verification finds a concrete defect.

- [ ] Run `scripts/restart-cogseed.sh`.
- [ ] Confirm the dated runtime log and `/tmp/cogseed-agent-cogseed-run.log` show normal startup.
- [ ] Exercise the normal single-instance view, advanced add-bot disclosure, default/scene route selectors, and personal WeChat single-active wording in the running app.
- [ ] Run the full repository test command `npm test` and record any unrelated pre-existing failures separately.
