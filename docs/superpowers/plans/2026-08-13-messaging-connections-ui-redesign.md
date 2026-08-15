# Messaging Connections UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the messaging connection-management surface into a clear channel overview, instance manager, and grouped settings workspace without changing existing messaging behavior.

**Architecture:** Keep the current classic-script renderer and existing state/event handlers. Reshape only the DOM produced by `messaging-settings.js`, add locale-backed section labels, and replace the current card-heavy CSS with a responsive workbench layout.

**Tech Stack:** Electron renderer, vanilla JavaScript, CSS, JSON locales, Vitest source-contract tests

---

### Task 1: Lock the user-visible structure

**Files:**
- Create: `test/renderer/messaging-settings-layout-contract.test.ts`

- [ ] Add assertions for the channel navigation heading, overview copy, grouped settings classes, one-switch instance rendering, and responsive CSS.
- [ ] Run `npm run test:js -- test/renderer/messaging-settings-layout-contract.test.ts` and verify it fails on the old surface.

### Task 2: Reshape the renderer DOM

**Files:**
- Modify: `src/renderer/modules/messaging-settings.js`

- [ ] Add a semantic channel overview header with status copy and a single enable control.
- [ ] Turn the instance card into a section with a compact toolbar and selectable rows without duplicate switches.
- [ ] Render association controls only for unbound instances.
- [ ] Group owner, response/workspace, and deletion controls with explicit section headings.
- [ ] Run the targeted contract test and `node --check src/renderer/modules/messaging-settings.js`.

### Task 3: Apply the visual system and locale copy

**Files:**
- Modify: `src/renderer/style.css`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/pt.json`

- [ ] Add locale strings for channel management, connection summary, instance count, and settings section headings.
- [ ] Replace the card stack with a bordered two-column workbench, compact list rows, open section bands, and responsive breakpoints.
- [ ] Run the targeted contract test, locale JSON parsing, renderer syntax check, and `npm run typecheck`.

### Task 4: Verify the real Electron surface

**Files:**
- No source changes unless visual QA finds a concrete defect.

- [ ] Run `scripts/restart-cogseed.sh`.
- [ ] Confirm startup in the dated CogSeed log and `/tmp/cogseed-agent-cogseed-run.log`.
- [ ] Open Settings > Touchpoints > Connection management in the real app.
- [ ] Capture the desktop window, inspect hierarchy, clipping, wrapping, spacing, icons, and interaction state.
- [ ] Fix any visible issue, repeat automated checks, restart, and capture the final state.
