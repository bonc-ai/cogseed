# Touchpoint Template Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-scenario approval-card templates and explicit Feishu/Lark instance routing with a global default and scenario overrides.

**Architecture:** Keep IPC thin. Store validated user-scoped touchpoint configuration through a dedicated feature module, render templates before the existing signed card builder, and resolve the selected messaging instance immediately before delivery. Renderer settings expose list, edit, preview, and save through `window.cogseed.invoke`.

**Tech Stack:** Electron IPC, TypeScript main-process features, vanilla JavaScript renderer, JSON persistence, Vitest.

---

### Task 1: Configuration and template domain

**Files:**
- Create: `src/main/features/touchpoints/config.ts`
- Modify: `src/main/features/touchpoints/types.ts`
- Modify: `src/main/features/touchpoints/ledger.ts`
- Test: `test/main/features/touchpoints/config.test.ts`

- [x] Define versioned config, whitelist templates/actions, bounded text validation, atomic persistence, template fallback, variable substitution, and route lookup.
- [x] Preserve button action kinds while allowing display labels.
- [x] Run `npm run typecheck`.

### Task 2: Delivery integration

**Files:**
- Modify: `src/main/features/touchpoints/feishu/card.ts`
- Modify: `src/main/features/touchpoints/feishu/adapter.ts`
- Modify: `src/main/features/touchpoints/test-delivery.ts`
- Modify: `src/main/features/personal_context/application/index.ts`
- Test: `test/main/features/touchpoints/feishu-card.test.ts`
- Test: `test/main/features/touchpoints/test-delivery.test.ts`

- [ ] Apply the configured scene template immediately before building the card.
- [ ] Resolve task-approval and daily-briefing instance IDs from explicit input, scene override, then global default.
- [ ] Keep fail-closed live instance checks in the existing adapter.
- [ ] Add tests for custom labels, route precedence, and explicit instance propagation.

### Task 3: IPC configuration contract

**Files:**
- Modify: `src/main/ipc/touchpoints.ts`
- Test: `test/main/features/touchpoint-settings-renderer-contract.test.ts`

- [ ] Add `touchpoints.config.get` returning templates, routes, default instance, and safe instance metadata.
- [ ] Add `touchpoints.config.save` validating default/route IDs against current user instances and saving a complete config atomically.
- [ ] Add `touchpoints.config.preview` rendering a representative card without sending it.

### Task 4: Touchpoint settings UI

**Files:**
- Modify: `src/renderer/modules/touchpoint-settings.js`
- Modify: `src/renderer/style.css`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/pt.json`
- Test: `test/main/features/touchpoint-settings-renderer-contract.test.ts`

- [ ] Add scene tabs, title/body/button inputs, variable hints, live preview, default instance select, and per-scene override selects.
- [ ] Pass selected instance IDs to briefing and approval test delivery calls.
- [ ] Render disabled/deleted instance warnings and preserve unsaved edits on failed save.
- [ ] Add localized strings in all supported renderer locales.

### Task 5: Verification

**Files:**
- Modify: none beyond focused fixes.

- [ ] Run focused touchpoint/config/card/renderer tests through the repository test script.
- [ ] Run `npm run typecheck`.
- [ ] Restart the messaging worktree with `scripts/restart-cogseed.sh` and inspect startup logs.
- [ ] Exercise settings load, save, preview, and explicit test-card route in the running app.

