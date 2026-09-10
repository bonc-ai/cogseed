# Connections Agent Tab Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Connections > Agent inside the Connections page and restore its existing lazy Agent refresh.

**Architecture:** Exercise the classic renderer script in a VM-backed fake DOM, then remove only the Agent-to-Settings redirect while preserving the Touchpoints and Models redirects. Re-enable the pre-existing `loadAgents(false)` refresh when the Agent pane becomes active.

**Tech Stack:** Electron renderer classic JavaScript, Vitest, Node `vm`.

---

### Task 1: Add the navigation regression test

**Files:**
- Create: `test/renderer/connections-navigation.test.ts`

- [ ] **Step 1: Write the failing tests**

Create a VM harness with Agent and MCP tabs/panes. Load `src/renderer/modules/connections.js`, invoke `activateConnectionsTab('agents')`, and assert:

```ts
expect(setView).not.toHaveBeenCalled();
expect(tabs[0].classList.contains('is-active')).toBe(true);
expect(panes[0].hidden).toBe(false);
expect(panes[1].hidden).toBe(true);
expect(loadAgents).toHaveBeenCalledWith(false);
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
npm run test:js -- test/renderer/connections-navigation.test.ts
```

Expected: FAIL because current code calls `setView('settings', ...)`, leaves the Agent pane hidden, and does not call `loadAgents(false)`.

### Task 2: Restore Agent as a real Connections tab

**Files:**
- Modify: `src/renderer/modules/connections.js:55-80`
- Modify: `src/renderer/modules/connections.js:145-148`

- [ ] **Step 1: Remove Agent from the Settings redirect**

Keep only Touchpoints in the redirect conditions:

```js
function _connectionsOpenTarget(target) {
  if (target === 'touchpoints') {
    _connectionsOpenConfiguration('gateways');
    return;
  }
  if (target === 'models' && typeof setView === 'function') {
    _connectionsOpenConfiguration('models');
  }
}

// In activateConnectionsTab:
if (name === 'touchpoints') {
  _connectionsOpenTarget(name);
  return;
}
```

- [ ] **Step 2: Restore the Agent refresh on tab activation**

Before the Sources branch, restore:

```js
if (target === 'agents' && typeof loadAgents === 'function') {
  Promise.resolve(loadAgents(false)).catch(() => {});
}
```

- [ ] **Step 3: Run focused tests and verify GREEN**

Run:

```powershell
npm run test:js -- test/renderer/connections-navigation.test.ts test/renderer/settings-tabs.test.ts
```

Expected: both files pass.

- [ ] **Step 4: Run renderer safety and type gates**

Run:

```powershell
npm run test:js -- test/renderer/shared-ui-adoption-guard.test.ts test/renderer/top-drag-regions.test.ts
npm run typecheck
```

Expected: all tests and typecheck pass.

- [ ] **Step 5: Commit the fix**

```powershell
git add -- src/renderer/modules/connections.js test/renderer/connections-navigation.test.ts
git commit -m "fix(connections): keep Agent tab in connections"
```
