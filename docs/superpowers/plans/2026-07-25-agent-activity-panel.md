# Agent Activity Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Add a conversation-scoped `Agent Activity` tab inside the existing conversation info drawer that unifies current agent status, compact recent activity, dispatch context, and observable processing trace for the current conversation.

**Architecture:** Reuse the existing conversation info drawer as the only user-facing surface for conversation-level agent activity. Build the tab from existing runtime-status, members, and conversation-history data already available through the renderer and IPC shim; keep the default presentation simple, and reveal technical protocol/status detail only behind expandable sections.

**Tech Stack:** Renderer classic JavaScript, existing Electron IPC shim, TypeScript-backed main features already exposed through `/api/conversations/:cid/runtime`, Vitest renderer/main tests, existing locale JSON files, no new dependencies.

---

## File Structure

- Modify `src/renderer/index.html`: add the `Agent Activity` tab to the existing conversation info drawer.
- Modify `src/renderer/modules/conversation-info.js`: add tab state, data loading, activity model derivation, rendering, and interaction handlers for the new tab.
- Modify `src/renderer/modules/conversation.js`: redirect the existing header status button into the drawer tab instead of the detached popover and reuse any status derivation helpers worth preserving.
- Modify `src/renderer/style.css`: add compact drawer-native styles for summary rail, activity rows, status pills, dispatch context, and processing trace.
- Modify `src/renderer/locales/en.json`, `src/renderer/locales/zh.json`, `src/renderer/locales/ja.json`, `src/renderer/locales/pt.json`: add user-facing strings for the new tab and its states.
- Modify `test/renderer/conversation-info.test.ts`: cover the new tab presence, counts, and empty/error rendering within the drawer.
- Modify `test/renderer/conversation-agent-status.test.ts`: preserve and adapt runtime-state semantics for the unified activity surface.
- Create `test/renderer/agent-activity-panel.test.ts`: focused unit tests for rendering activity rows, technical detail toggles, dispatch context, and processing trace.
- Modify `test/renderer/ipc-shim.test.ts` only if an additional route is genuinely needed; otherwise keep the existing runtime and history routes unchanged.

## Task 1: Add the Agent Activity Tab Shell

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `test/renderer/conversation-info.test.ts`

- [ ] **Step 1: Write the failing drawer-tab test**

Add a focused assertion in `test/renderer/conversation-info.test.ts` that expects the drawer to expose an `agent_activity` tab alongside the existing tabs.

```ts
it('renders an Agent Activity tab in the conversation info drawer', async () => {
  const html = readFileSync(resolve(__dirname, '../../src/renderer/index.html'), 'utf8');
  expect(html).toContain('data-info-tab="agent-activity"');
  expect(html).toContain('conversation_info.tab_agent_activity');
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
npm run test:js -- test/renderer/conversation-info.test.ts -t "Agent Activity tab"
```

Expected: FAIL because the new tab markup and locale key do not exist yet.

- [ ] **Step 3: Add the minimal drawer tab markup**

In `src/renderer/index.html`, add the fourth tab button inside `.conversation-info-tabs` after `attachments`.

```html
<button type="button" class="conversation-info-tab" data-info-tab="agent-activity">
  <span data-ui-icon="users" data-ui-icon-class="conversation-info-tab-icon"></span>
  <span class="conversation-info-tab-label" data-i18n="conversation_info.tab_agent_activity">Agent Activity</span>
  <span class="conversation-info-tab-count" id="conversation-info-tab-count-agent-activity"></span>
</button>
```

- [ ] **Step 4: Run the test to verify GREEN**

Run:

```bash
npm run test:js -- test/renderer/conversation-info.test.ts -t "Agent Activity tab"
```

Expected: PASS.

## Task 2: Add Locale Strings For Agent Activity

**Files:**
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/pt.json`
- Test: `test/renderer/agent-activity-panel.test.ts`

- [ ] **Step 1: Write the failing locale test**

Create `test/renderer/agent-activity-panel.test.ts` with a locale-presence test.

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function loadLocale(name: string) {
  return JSON.parse(readFileSync(resolve(__dirname, `../../src/renderer/locales/${name}.json`), 'utf8'));
}

describe('agent activity locales', () => {
  it('defines the core Agent Activity labels in all renderer locales', () => {
    for (const locale of ['en', 'zh', 'ja', 'pt']) {
      const data = loadLocale(locale);
      expect(data['conversation_info.tab_agent_activity']).toBeTruthy();
      expect(data['conversation_info.agent_activity.loading']).toBeTruthy();
      expect(data['conversation_info.agent_activity.empty']).toBeTruthy();
      expect(data['conversation_info.agent_activity.state.running']).toBeTruthy();
      expect(data['conversation_info.agent_activity.dispatch_context']).toBeTruthy();
      expect(data['conversation_info.agent_activity.processing_trace']).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
npm run test:js -- test/renderer/agent-activity-panel.test.ts -t "core Agent Activity labels"
```

Expected: FAIL because the new locale keys are missing.

- [ ] **Step 3: Add the minimal locale keys**

Add these keys to `en.json` and translated equivalents to `zh.json`, `ja.json`, and `pt.json`:

```json
{
  "conversation_info.tab_agent_activity": "Agent Activity",
  "conversation_info.agent_activity.loading": "Loading agent activity…",
  "conversation_info.agent_activity.empty": "No agents have joined this conversation yet.",
  "conversation_info.agent_activity.load_failed": "Could not load agent activity",
  "conversation_info.agent_activity.summary_agents": "Agents",
  "conversation_info.agent_activity.summary_running": "Running",
  "conversation_info.agent_activity.summary_processing": "Processing",
  "conversation_info.agent_activity.state.running": "Running",
  "conversation_info.agent_activity.state.current_recipient": "Current recipient",
  "conversation_info.agent_activity.state.joined": "Joined",
  "conversation_info.agent_activity.state.failed": "Failed",
  "conversation_info.agent_activity.state.completed": "Completed",
  "conversation_info.agent_activity.dispatch_context": "Dispatch Context",
  "conversation_info.agent_activity.processing_trace": "Processing Trace",
  "conversation_info.agent_activity.technical_detail": "Technical Detail"
}
```

- [ ] **Step 4: Run the test to verify GREEN**

Run:

```bash
npm run test:js -- test/renderer/agent-activity-panel.test.ts -t "core Agent Activity labels"
```

Expected: PASS.

## Task 3: Render The Empty, Loading, And Error Agent Activity Body

**Files:**
- Modify: `src/renderer/modules/conversation-info.js`
- Modify: `test/renderer/conversation-info.test.ts`

- [ ] **Step 1: Write the failing drawer-body test**

Add a test that executes the conversation-info renderer and expects the new tab to paint an empty-state message when there are no agents.

```ts
it('renders the Agent Activity empty state inside the drawer body', async () => {
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/conversation-info.js'), 'utf8');
  expect(source).toContain("agent_activity.empty");
  expect(source).toContain("agent-activity");
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
npm run test:js -- test/renderer/conversation-info.test.ts -t "Agent Activity empty state"
```

Expected: FAIL because the module has no `agent-activity` tab branch yet.

- [ ] **Step 3: Add the tab branch and minimal body rendering**

In `src/renderer/modules/conversation-info.js`, set the default tab map to recognize `agent-activity`, update tab-count handling, and add a body branch similar to the existing tabs.

```js
function _renderAgentActivityBody() {
  if (_loading && _loadingSource === 'agent-activity') {
    return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.agent_activity.loading', 'Loading agent activity…'))}</div>`;
  }
  if (_error && _activeTab === 'agent-activity') {
    return `<div class="conversation-info-empty is-error">${escapeHtml(_label('conversation_info.agent_activity.load_failed', 'Could not load agent activity'))}</div>`;
  }
  return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.agent_activity.empty', 'No agents have joined this conversation yet.'))}</div>`;
}
```

Wire that branch into the existing body render switch for `_activeTab`.

- [ ] **Step 4: Run the test to verify GREEN**

Run:

```bash
npm run test:js -- test/renderer/conversation-info.test.ts -t "Agent Activity empty state"
```

Expected: PASS.

## Task 4: Reuse Runtime Status Semantics For Activity Rows

**Files:**
- Modify: `src/renderer/modules/conversation-info.js`
- Modify: `test/renderer/conversation-agent-status.test.ts`
- Create/Modify: `test/renderer/agent-activity-panel.test.ts`

- [ ] **Step 1: Write the failing row-model test**

Add a focused renderer test that expects `Running`, `Current recipient`, and `Joined` row states to be derived from runtime status.

```ts
it('derives running, current recipient, and joined row states from runtime status', () => {
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/conversation-info.js'), 'utf8');
  expect(source).toContain('current_recipient');
  expect(source).toContain('in_flight');
  expect(source).toContain('active_turns');
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
npm run test:js -- test/renderer/agent-activity-panel.test.ts -t "row states"
```

Expected: FAIL because activity-row derivation is not implemented in `conversation-info.js`.

- [ ] **Step 3: Implement a shared activity model derivation helper**

In `src/renderer/modules/conversation-info.js`, add a helper that maps members + runtime into display rows.

```js
function _deriveAgentActivityRows(snapshot) {
  const runtime = snapshot.runtime || {};
  const running = new Set(Array.isArray(runtime.in_flight) ? runtime.in_flight.map((id) => String(id || '')) : []);
  const activeTurns = Array.isArray(runtime.active_turns) ? runtime.active_turns : [];
  for (const turn of activeTurns) running.add(String(turn.actor || ''));
  const activeRecipient = String(runtime.active_recipient || '');
  const actors = Array.isArray(snapshot.actors) ? snapshot.actors : [];
  return actors.map((actor) => {
    const id = String(actor.id || '');
    let state = 'joined';
    if (running.has(id)) state = 'running';
    else if (activeRecipient && activeRecipient === id) state = 'current_recipient';
    return {
      id,
      kind: actor.kind === 'commander' ? 'commander' : 'agent',
      name: String(actor.name || id || 'Agent'),
      state,
      turnId: String((activeTurns.find((turn) => String(turn.actor || '') === id) || {}).turn_id || ''),
    };
  });
}
```

- [ ] **Step 4: Run the test to verify GREEN**

Run:

```bash
npm run test:js -- test/renderer/agent-activity-panel.test.ts -t "row states"
```

Expected: PASS.

## Task 5: Render Simplified Activity Rows And Summary Rail

**Files:**
- Modify: `src/renderer/modules/conversation-info.js`
- Modify: `src/renderer/style.css`
- Modify: `test/renderer/agent-activity-panel.test.ts`

- [ ] **Step 1: Write the failing render test**

Add a test that expects a summary rail and a list row with user-facing state labels.

```ts
it('renders a compact summary rail and simplified activity rows', () => {
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/conversation-info.js'), 'utf8');
  expect(source).toContain('conversation-info-agent-activity-summary');
  expect(source).toContain('conversation-info-agent-activity-row');
  expect(source).toContain('conversation_info.agent_activity.summary_agents');
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
npm run test:js -- test/renderer/agent-activity-panel.test.ts -t "summary rail"
```

Expected: FAIL because the tab still renders only the empty state.

- [ ] **Step 3: Implement the summary rail and simplified rows**

In `src/renderer/modules/conversation-info.js`, render the tab body from `_deriveAgentActivityRows(snapshot)`.

```js
function _renderAgentActivitySummary(rows, runtime) {
  const running = rows.filter((row) => row.state === 'running').length;
  const processing = runtime && runtime.processing ? _label('common.yes', 'Yes') : _label('common.no', 'No');
  return `<div class="conversation-info-agent-activity-summary">
    <div class="conversation-info-agent-activity-stat"><span>${escapeHtml(_label('conversation_info.agent_activity.summary_agents', 'Agents'))}</span><strong>${rows.length}</strong></div>
    <div class="conversation-info-agent-activity-stat"><span>${escapeHtml(_label('conversation_info.agent_activity.summary_running', 'Running'))}</span><strong>${running}</strong></div>
    <div class="conversation-info-agent-activity-stat"><span>${escapeHtml(_label('conversation_info.agent_activity.summary_processing', 'Processing'))}</span><strong>${escapeHtml(processing)}</strong></div>
  </div>`;
}

function _renderAgentActivityRows(rows) {
  return rows.map((row) => `<details class="conversation-info-agent-activity-row is-${escapeHtml(row.state)}" data-agent-activity-id="${escapeHtml(row.id)}">
    <summary>
      <div class="conversation-info-agent-activity-name">${escapeHtml(row.name)}</div>
      <span class="conversation-info-agent-activity-pill is-${escapeHtml(row.state)}">${escapeHtml(_label(`conversation_info.agent_activity.state.${row.state}`, row.state))}</span>
    </summary>
  </details>`).join('');
}
```

Add minimal drawer-native CSS in `src/renderer/style.css` for:

```css
.conversation-info-agent-activity {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: 12px;
  padding: 14px 16px 16px;
}
.conversation-info-agent-activity-summary { display: grid; gap: 8px; }
.conversation-info-agent-activity-row { border: 1px solid var(--border); border-radius: 8px; background: var(--surface-1); }
.conversation-info-agent-activity-pill.is-running { background: rgba(34, 197, 94, 0.16); color: var(--success-text, #15803d); }
```

- [ ] **Step 4: Run the test to verify GREEN**

Run:

```bash
npm run test:js -- test/renderer/agent-activity-panel.test.ts -t "summary rail"
```

Expected: PASS.

## Task 6: Add Collapsible Technical Detail, Dispatch Context, And Processing Trace

**Files:**
- Modify: `src/renderer/modules/conversation-info.js`
- Modify: `src/renderer/style.css`
- Modify: `test/renderer/agent-activity-panel.test.ts`

- [ ] **Step 1: Write the failing detail-layer tests**

Add tests that expect the new blocks and ensure they are secondary to the row summary.

```ts
it('renders technical detail, dispatch context, and processing trace blocks inside expanded rows', () => {
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/conversation-info.js'), 'utf8');
  expect(source).toContain('conversation_info.agent_activity.technical_detail');
  expect(source).toContain('conversation_info.agent_activity.dispatch_context');
  expect(source).toContain('conversation_info.agent_activity.processing_trace');
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
npm run test:js -- test/renderer/agent-activity-panel.test.ts -t "technical detail"
```

Expected: FAIL because the rows do not yet render detail blocks.

- [ ] **Step 3: Implement detail rendering from observable data**

Extend the row model with optional technical, dispatch-context, and processing-trace payloads derived from current-conversation data.

```js
function _deriveDispatchContext(row, snapshot) {
  const last = row.lastMessage || null;
  if (!last) return null;
  return {
    task: _compactText(last.text || last.model_text || '', 96),
    source: last.from === 'user' ? 'user' : 'commander',
    attachments: Array.isArray(last.attachments) ? last.attachments.length : 0,
    runtime: row.runtimeKind || '',
    mateSkills: row.usesMateSkills === false ? 'disabled' : 'enabled',
  };
}

function _deriveProcessingTrace(row) {
  const trace = [];
  if (row.state === 'running') trace.push('currently running');
  if (row.turnId) trace.push(`turn ${row.turnId}`);
  if (row.errorDetail) trace.push(`failed: ${row.errorDetail}`);
  return trace;
}
```

Render these inside each expanded row:

```js
<div class="conversation-info-agent-activity-detail-block">
  <div class="conversation-info-agent-activity-detail-title">${escapeHtml(_label('conversation_info.agent_activity.technical_detail', 'Technical Detail'))}</div>
  ...
</div>
<div class="conversation-info-agent-activity-detail-block">
  <div class="conversation-info-agent-activity-detail-title">${escapeHtml(_label('conversation_info.agent_activity.dispatch_context', 'Dispatch Context'))}</div>
  ...
</div>
<div class="conversation-info-agent-activity-detail-block">
  <div class="conversation-info-agent-activity-detail-title">${escapeHtml(_label('conversation_info.agent_activity.processing_trace', 'Processing Trace'))}</div>
  ...
</div>
```

Keep the content omitted when the source data is absent.

- [ ] **Step 4: Run the test to verify GREEN**

Run:

```bash
npm run test:js -- test/renderer/agent-activity-panel.test.ts -t "technical detail"
```

Expected: PASS.

## Task 7: Route The Header Status Button Into The Drawer Tab

**Files:**
- Modify: `src/renderer/modules/conversation.js`
- Modify: `src/renderer/modules/conversation-info.js`
- Modify: `test/renderer/conversation-agent-status.test.ts`

- [ ] **Step 1: Write the failing interaction test**

Add a renderer test that expects the header agent-status button to open the drawer tab instead of the detached popover path.

```ts
it('routes the header agent status button into the Agent Activity tab', () => {
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
  expect(source).toContain('ConversationInfo');
  expect(source).toContain('agent-activity');
});
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```bash
npm run test:js -- test/renderer/conversation-agent-status.test.ts -t "header agent status button"
```

Expected: FAIL because the current button still toggles the popover.

- [ ] **Step 3: Replace the popover trigger with drawer-tab navigation**

In `src/renderer/modules/conversation-info.js`, expose a small method:

```js
function openAgentActivity(cid) {
  if (cid) _cid = cid;
  _activeTab = 'agent-activity';
  _open = true;
  _render();
  void _refresh();
}
```

In `src/renderer/modules/conversation.js`, replace the button click path with:

```js
if (agentStatusBtn && agentStatusBtn.dataset.bound !== '1') {
  agentStatusBtn.dataset.bound = '1';
  agentStatusBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!currentCid) return;
    if (window.ConversationInfo && typeof window.ConversationInfo.openAgentActivity === 'function') {
      window.ConversationInfo.openAgentActivity(currentCid);
    }
  });
}
```

Leave the old popover helpers removable after the new path is green, unless they are still needed by tests during migration.

- [ ] **Step 4: Run the test to verify GREEN**

Run:

```bash
npm run test:js -- test/renderer/conversation-agent-status.test.ts -t "header agent status button"
```

Expected: PASS.

## Task 8: Full Focused Verification

**Files:**
- Test only.

- [ ] **Step 1: Run the focused renderer test set**

Run:

```bash
npm run test:js -- test/renderer/conversation-info.test.ts test/renderer/conversation-agent-status.test.ts test/renderer/agent-activity-panel.test.ts test/renderer/ipc-shim.test.ts
```

Expected: PASS across all focused renderer tests.

- [ ] **Step 2: Run relevant main/runtime tests**

Run:

```bash
npm run test:js -- test/main/features/group_chat/state.test.ts test/main/features/group_chat/collaboration.test.ts
```

Expected: PASS, proving runtime-status behavior still matches renderer assumptions.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Diff sanity check**

Run:

```bash
git diff --check -- src/renderer/index.html src/renderer/modules/conversation-info.js src/renderer/modules/conversation.js src/renderer/style.css src/renderer/locales/en.json src/renderer/locales/zh.json src/renderer/locales/ja.json src/renderer/locales/pt.json test/renderer/conversation-info.test.ts test/renderer/conversation-agent-status.test.ts test/renderer/agent-activity-panel.test.ts
```

Expected: no whitespace or patch-format errors.

## Verification

- Drawer exposes an `Agent Activity` tab.
- Header status button opens the drawer tab instead of a detached popover.
- Activity rows reflect runtime-backed state reliably.
- Default row summaries remain easy to scan.
- Technical detail, dispatch context, and processing trace appear only when data exists and remain secondary.
- No external-agent private memory or hidden reasoning is surfaced.

## Next skill

`$superpower-subagents` or `$superpower-executing-plans`
