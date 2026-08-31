# CogSeed Renderer Full Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `$superpower-subagents` (recommended) or `$superpower-executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via `update_plan`.

**Goal:** Replace CogSeed's classic-script renderer with a React 18 + Vite + strict TypeScript renderer while preserving the existing `window.cogseed` contract, main/preload behavior, user data, and a tested per-feature rollback path.

**Architecture:** Vite performs offline build/watch into `src/renderer/generated/renderer-app/`; Electron continues loading `src/renderer/index.html` through `loadFile`, so no HTTP server or main change is required. Legacy scripts and React can be loaded together, but a feature ownership registry guarantees that only one implementation owns a feature's DOM, global events, timers, observers, storage synchronization, and IPC subscriptions. IPC compatibility is protected by an AST-generated call-surface snapshot, manually reviewed TypeScript schemas, and legacy-vs-React characterization tests.

**Tech Stack:** Electron 41, React 18, Vite 6, TypeScript 6 with renderer `strict:true`, Vitest 4, Testing Library, Playwright Electron, existing DOMPurify/xterm/MathJax vendor assets.

**Spec:** `docs/superpowers/specs/2026-08-19-renderer-full-rewrite-migration-design.md`
**Extracted companion plan:** `docs/superpowers/plans/2026-08-21-cogseed-creator-mode-p3394-agent-to-agent-implementation.md`（Agent 创造模式 + P3394 远程 Agent ↔ Agent）

**Baseline:** `defcd5f55aa7bd9fa2749fe80818eb9cf597a54b`

**Checkout note (2026-08-20):** local `develop` is 137 commits behind `origin/develop`. Before Task 2, the owner must either keep the frozen baseline or update the base and regenerate/review every count, snapshot, fixture, and file reference in this plan.

---

## 0. Execution rules

1. Do not begin Task 4 or later until Task 1's architecture exception is explicitly approved.
2. Do not modify `src/main/**`, including `src/main/preload.js`, during this migration.
3. Do not modify an IPC channel, payload, return, error, stream event, cancel, or completion behavior.
4. Do not run legacy and React owners for the same feature simultaneously.
5. Every feature migration is a separate commit and retains a working legacy fallback until Phase 3B.
6. Pure helper migration and behavior fixes must be separate commits.
7. If a historical bug is discovered, first capture current behavior; fix it in a separate non-migration change.
8. All paths and counts in this plan are relative to baseline `defcd5f5`; regenerate and review them if the base commit changes.
9. P3394 remote communication is a separate track: it may add new IPC only through an explicit P0 review; it must not alter the existing 427-call contract or be hidden inside a renderer migration commit.

---

## 1. Planned file map

### Governance and generated baselines

- Modify: `AGENTS.md` — approve the renderer-only TSX/Vite exception while retaining no-server and preload boundaries.
- Create: `docs/superpowers/migrations/renderer-rewrite-inventory.md` — human-owned migration/ownership matrix.
- Create: `scripts/capture-ipc-contract.cjs` — AST scanner for invoke/stream call sites.
- Create: `scripts/capture-renderer-inventory.cjs` — module/script/CSS/DOM ownership inventory.
- Create: `scripts/check-renderer-boundaries.cjs` — CI ratchet for direct bridge access and generated snapshots.
- Create: `test/renderer/renderer-contract-capture.test.ts` — scanner behavior and baseline tests.
- Create: `test/renderer/renderer-boundaries.test.ts` — source-boundary tests.

### Build and runtime shell

- Modify: `package.json` and `package-lock.json` — approved dependencies and renderer scripts.
- Create: `vite.renderer.config.ts` — fixed file://-safe renderer output.
- Create: `tsconfig.renderer.json` — strict renderer typecheck.
- Create: `scripts/build-renderer.cjs` — one-shot/watch build wrapper.
- Create: `scripts/before-pack.cjs` — run renderer build and existing runtime prepack checks.
- Modify: `src/renderer/index.html` — add React root, portal root, feature bootstrap, and fixed module entry.
- Create: `src/renderer-app/main.tsx` — React root bootstrap.
- Create: `src/renderer-app/app/App.tsx` — feature mount shell.
- Create: `src/renderer-app/app/RendererErrorBoundary.tsx` — renderer failure isolation.
- Create: `src/renderer-app/app/portals.ts` — shared overlay containers.
- Create: `src/renderer-app/styles/root.module.css` — namespaced React root styles.
- Create: `test/renderer/renderer-build.test.ts` — output and file:// assumptions.

### Migration and IPC infrastructure

- Create: `src/renderer-app/migration/feature-flags.ts` — versioned local feature flags.
- Create: `src/renderer-app/migration/ownership.ts` — exclusive owner lifecycle.
- Create: `src/renderer-app/migration/inventory.generated.json` — generated module inventory.
- Create: `src/renderer-app/ipc/bridge.ts` — only React source allowed to read `window.cogseed`.
- Create: `src/renderer-app/ipc/client.ts` — named typed IPC methods.
- Create: `src/renderer-app/ipc/types.ts` — bridge, stream, error, and result primitives.
- Create: `src/renderer-app/ipc/schemas.ts` — hand-reviewed channel request/response/event map.
- Create: `src/renderer-app/ipc/channels.generated.ts` — generated static channel unions.
- Create: `src/renderer-app/ipc/contract.generated.json` — generated call-surface baseline.
- Create: `src/renderer-app/ipc/dynamic-channels.ts` — finite mappings for 29 dynamic call sites.
- Create: `src/renderer-app/global.d.ts` — renderer-visible preload declarations.
- Create: `test/renderer-app/ipc/*.test.ts` — contract and stream lifecycle tests.

### P3394 remote Agent communication track (existing main-side foundation)

- Reuse: `src/main/features/p3394/**` — protocol, controller, session, wake, receipt, and execution boundaries.
- Reuse: `src/main/features/p3394_bridge/**` — A2A, gateway, outbound, outbox, idempotency, replay protection, peer registry, and channel adapters.
- Modify only in the separate P3394 track: `src/main/ipc/p3394_external.ts` or a new `src/main/ipc/p3394_agent.ts` after P0 approval; never as an incidental renderer migration change.
- Create when approved: `src/renderer-app/ipc/p3394-client.ts`, `src/renderer-app/ipc/p3394-types.ts`, and focused remote-agent UI/store tests.
- Create when approved: `test/p3394/` fixtures for identity, request/response, stream resume, cancellation, idempotency, permissions, and audit.

### Characterization and E2E

- Create: `test/renderer-characterization/` — shared fixtures and legacy behavior assertions.
- Create: `test/renderer-app/` — React component/store tests.
- Create: `playwright.renderer.config.ts` — Electron launch config.
- Create: `test/e2e/renderer-golden-path.spec.ts` — mandatory Golden Path.
- Create: `test/e2e/renderer-package-smoke.spec.ts` — packaged file:// smoke.

---

## 2. Phase 0.0 — authorization, inventory, and contract lock

### Task 1: Approve the repository architecture exception

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-08-19-renderer-full-rewrite-migration-design.md`

- [ ] **Step 1: Record explicit owner approval before changing the boundary**

Approval must cover all of the following as one decision:

```text
src/renderer-app/** may use TypeScript/TSX and React.
Vite may build renderer assets offline; Vite dev server remains forbidden.
React/Vite/Testing Library/Playwright npm dependencies are approved.
src/main/preload.js remains classic JavaScript and is not bundled.
Legacy src/renderer/modules/** remains classic scripts during migration.
```

Expected: approval is attached to the design review or change request; without it, stop after Task 3.

- [ ] **Step 2: Update the renderer boundary in `AGENTS.md`**

Replace only the conflicting renderer bullets with rules equivalent to:

```markdown
- Legacy renderer modules under `src/renderer/modules/` remain classic scripts during migration.
- New renderer code under `src/renderer-app/` may use React, TypeScript/TSX, and the approved Vite offline build.
- Renderer development must not start an HTTP server or occupy a port; use Vite build/watch output loaded through the existing `src/renderer/index.html` file entry.
- `src/main/preload.js` remains `.js`, is not bundled, and its `window.cogseed` contract is frozen during the rewrite.
- New renderer npm dependencies require explicit architecture approval and lockfile review.
```

- [ ] **Step 3: Verify no unrelated repository rules changed**

Run:

```bash
git diff -- AGENTS.md
```

Expected: only renderer framework/build rules differ.

- [ ] **Step 4: Commit the authorization boundary**

```bash
git add AGENTS.md docs/superpowers/specs/2026-08-19-renderer-full-rewrite-migration-design.md
git commit -m "docs(renderer): authorize staged React migration boundary"
```

---

### Task 2: Capture the renderer inventory and IPC call surface

**Files:**
- Create: `scripts/capture-ipc-contract.cjs`
- Create: `scripts/capture-renderer-inventory.cjs`
- Create: `src/renderer-app/ipc/contract.generated.json`
- Create: `src/renderer-app/migration/inventory.generated.json`
- Create: `docs/superpowers/migrations/renderer-rewrite-inventory.md`
- Create: `test/renderer/renderer-contract-capture.test.ts`

- [ ] **Step 1: Write scanner tests using temporary JavaScript fixtures**

Tests must prove that the scanner recognizes:

```js
window.cogseed.invoke('literal.channel', { id: 1 });
window.cogseed.stream('stream.channel', {}, onEvent);
window.cogseed.invoke(channelName, payload);
window.cogseed?.invoke?.('optional.channel', {});
```

Assertions must include file, line, column, kind, static channel or `null`, argument count, and dynamic-call classification.

- [ ] **Step 2: Run the focused test and verify failure**

```bash
npm run test:js -- test/renderer/renderer-contract-capture.test.ts
```

Expected: FAIL because the capture scripts do not exist.

- [ ] **Step 3: Implement both scanners with the installed TypeScript compiler API**

`capture-ipc-contract.cjs` output schema:

```ts
type ContractSnapshot = {
  schemaVersion: 1;
  baselineCommit: string;
  totals: {
    calls: number;
    staticCalls: number;
    dynamicCalls: number;
    uniqueStaticChannels: number;
    invokeChannels: number;
    streamChannels: number;
  };
  callsites: Array<{
    file: string;
    line: number;
    column: number;
    kind: 'invoke' | 'stream';
    channel: string | null;
    argumentCount: number;
    payloadNodeKind: string | null;
  }>;
};
```

`capture-renderer-inventory.cjs` must record all 89 first-party modules, 6 vendor JS files, 68 script tags, 6 CSS files, module LOC, direct DOM call count, global event registrations, timers, observers, and direct IPC call counts.

Both scripts support:

```text
--write   write canonical generated JSON
--check   compare current output with committed JSON and exit non-zero on drift
```

- [ ] **Step 4: Generate the baseline**

```bash
node scripts/capture-ipc-contract.cjs --write
node scripts/capture-renderer-inventory.cjs --write
```

Expected IPC totals at `defcd5f5`:

```text
calls=427
staticCalls=398
dynamicCalls=29
uniqueStaticChannels=273
invokeChannels=269
streamChannels=4
```

Expected renderer inventory:

```text
firstPartyModules=89
vendorJavaScriptFiles=6
scriptTags=68
cssFiles=6
```

- [ ] **Step 5: Generate the human migration matrix**

For every first-party module, add one row with these columns:

```text
Legacy module | Domain | DOM root | Global events | Timers/observers |
IPC channels | Storage keys | React owner | Feature flag |
Legacy dispose | Characterization test | Status
```

No first-party module may be represented only by an ellipsis or wildcard row.

- [ ] **Step 6: Run scanner tests and check mode**

```bash
npm run test:js -- test/renderer/renderer-contract-capture.test.ts
node scripts/capture-ipc-contract.cjs --check
node scripts/capture-renderer-inventory.cjs --check
```

Expected: PASS and no generated diff.

- [ ] **Step 7: Commit the reproducible baseline**

```bash
git add scripts/capture-ipc-contract.cjs scripts/capture-renderer-inventory.cjs \
  src/renderer-app/ipc/contract.generated.json \
  src/renderer-app/migration/inventory.generated.json \
  docs/superpowers/migrations/renderer-rewrite-inventory.md \
  test/renderer/renderer-contract-capture.test.ts
git commit -m "test(renderer): freeze renderer inventory and IPC surface"
```

---

### Task 3: Add legacy characterization fixtures before framework work

**Files:**
- Create: `test/renderer-characterization/fixtures/`
- Create: `test/renderer-characterization/ipc-recorder.ts`
- Create: `test/renderer-characterization/conversation.fixture.ts`
- Create: `test/renderer-characterization/conversation-legacy.test.ts`
- Create: `test/renderer-characterization/panels-legacy.test.ts`
- Create: `docs/superpowers/migrations/renderer-golden-path.md`

- [ ] **Step 1: Build an IPC recorder with the exact preload stream shape**

The recorder must expose:

```ts
type StreamHandle = { promise: Promise<void>; cancel(): void };

type RecordedCall = {
  kind: 'invoke' | 'stream';
  channel: string;
  payload: unknown;
  sequence: number;
};
```

It must model completion, cancel-to-`AbortError`, event-handler failure, and repeated cancel behavior from `src/main/preload.js` without importing or modifying preload.

- [ ] **Step 2: Capture conversation fixtures**

Include deterministic fixtures for:

- conversation list and pagination;
- plain/markdown/attachment/quote/artifact messages;
- composer submit and `use-selection`;
- optimistic send, server echo, failed retry;
- stream delta, done, cancel, duplicate, and late event;
- cid switch during an active stream;
- queue draft, continue work, plan rail, terminal lifecycle.

- [ ] **Step 3: Write legacy tests before changing legacy code**

Each test asserts both user-visible state and the exact ordered IPC recorder output. Do not use broad snapshots for payloads; assert object keys and absent fields explicitly.

- [ ] **Step 4: Document the manual Golden Path**

`renderer-golden-path.md` must contain numbered steps, expected UI, expected IPC, rollback procedure, and macOS/Windows status for:

1. launch and i18n;
2. open/switch conversation;
3. send/receive/cancel/retry;
4. attachments/quotes/artifacts;
5. terminal and side tools;
6. settings save;
7. cognition asset flow;
8. Agent/marketplace/connector flow.

- [ ] **Step 5: Run the characterization suite**

```bash
npm run test:js -- test/renderer-characterization
```

Expected: PASS against unchanged legacy code.

- [ ] **Step 6: Commit the behavior baseline**

```bash
git add test/renderer-characterization docs/superpowers/migrations/renderer-golden-path.md
git commit -m "test(renderer): capture legacy behavior baseline"
```

---

## 3. Phase 0 — offline build, ownership, and first vertical slice

### Task 4: Add the offline Vite renderer build

**Gate:** Task 1 must be approved and merged.

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.gitignore`
- Create: `vite.renderer.config.ts`
- Create: `tsconfig.renderer.json`
- Create: `scripts/build-renderer.cjs`
- Create: `scripts/before-pack.cjs`
- Modify: `src/renderer/index.html`
- Create: `src/renderer-app/main.tsx`
- Create: `src/renderer-app/app/App.tsx`
- Create: `src/renderer-app/app/RendererErrorBoundary.tsx`
- Create: `src/renderer-app/app/portals.ts`
- Create: `src/renderer-app/styles/root.module.css`
- Create: `test/renderer/renderer-build.test.ts`

- [ ] **Step 1: Add approved dependencies with exact major versions**

```bash
npm install react@18 react-dom@18
npm install --save-dev vite@6 @vitejs/plugin-react@4 \
  @types/react@18 @types/react-dom@18 \
  @testing-library/react@16 @testing-library/user-event@14 jsdom@26
```

Expected: only approved renderer dependencies and transitive lockfile entries change.

- [ ] **Step 2: Write failing build-boundary tests**

Tests assert:

- Vite output root is `src/renderer/generated/renderer-app/`;
- entry filename is fixed as `renderer-app.js`;
- asset URLs are relative and file:// safe;
- no dev-server URL appears in source or generated HTML;
- `src/main/index.ts` still loads `renderer/index.html`;
- `src/main/preload.js` is excluded from the renderer build.

- [ ] **Step 3: Run the focused test and verify failure**

```bash
npm run test:js -- test/renderer/renderer-build.test.ts
```

Expected: FAIL because the Vite config and renderer entry do not exist.

- [ ] **Step 4: Configure file://-safe Vite output**

`vite.renderer.config.ts` must set:

```ts
base: './'
build.outDir: 'src/renderer/generated/renderer-app'
build.emptyOutDir: true
build.rollupOptions.output.entryFileNames: 'renderer-app.js'
build.rollupOptions.output.chunkFileNames: 'chunks/[name]-[hash].js'
build.rollupOptions.output.assetFileNames: 'assets/[name]-[hash][extname]'
```

The entry is `src/renderer-app/main.tsx`. Do not configure a dev server.

- [ ] **Step 5: Add strict renderer TypeScript config**

`tsconfig.renderer.json` extends the root config but overrides:

```json
{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "types": ["vite/client", "node"]
  },
  "include": ["src/renderer-app/**/*.ts", "src/renderer-app/**/*.tsx", "test/renderer-app/**/*.ts", "test/renderer-app/**/*.tsx"]
}
```

- [ ] **Step 6: Add build scripts**

Add package scripts equivalent to:

```json
{
  "renderer:build": "node scripts/build-renderer.cjs",
  "renderer:watch": "node scripts/build-renderer.cjs --watch",
  "renderer:typecheck": "tsc -p tsconfig.renderer.json --noEmit",
  "renderer:test": "vitest run test/renderer-app",
  "renderer:contract:check": "node scripts/capture-ipc-contract.cjs --check && node scripts/capture-renderer-inventory.cjs --check && node scripts/check-renderer-boundaries.cjs"
}
```

Update both `prestart` and `prestart:electron` to perform a one-shot renderer build after existing dependency preparation. Change `build.beforePack` to `scripts/before-pack.cjs`, which invokes the existing `scripts/ensure-runtime-before-pack.cjs` and then the renderer build.

- [ ] **Step 7: Add non-destructive roots to `index.html`**

Add exactly one React application root and one shared portal root:

```html
<div id="renderer-app-root" data-renderer-owner="react"></div>
<div id="renderer-app-portals"></div>
<script type="module" src="./generated/renderer-app/renderer-app.js"></script>
```

Keep all 68 legacy scripts during Phase 0.

- [ ] **Step 8: Implement the minimal React shell**

The shell renders no migrated product feature yet. It installs an ErrorBoundary and produces one diagnostic marker inside `#renderer-app-root`; it must not read `window.cogseed` directly.

- [ ] **Step 9: Build and test**

```bash
npm run renderer:typecheck
npm run renderer:build
npm run test:js -- test/renderer/renderer-build.test.ts
npm run typecheck
```

Expected: all commands PASS; generated entry exists; `src/main/**` has no diff.

- [ ] **Step 10: Start the app from the existing file entry**

```bash
./run.sh
```

Expected: existing UI remains functional, React diagnostic marker exists, and no localhost request is made.

- [ ] **Step 11: Commit the build shell**

```bash
git add package.json package-lock.json .gitignore vite.renderer.config.ts tsconfig.renderer.json \
  scripts/build-renderer.cjs scripts/before-pack.cjs src/renderer/index.html \
  src/renderer-app test/renderer/renderer-build.test.ts
git commit -m "feat(renderer): add offline React build shell"
```

---

### Task 5: Implement feature flags and exclusive ownership lifecycle

**Files:**
- Create: `src/renderer-app/migration/feature-flags.ts`
- Create: `src/renderer-app/migration/ownership.ts`
- Create: `src/renderer-app/migration/types.ts`
- Create: `test/renderer-app/migration/feature-flags.test.ts`
- Create: `test/renderer-app/migration/ownership.test.ts`
- Modify: `src/renderer/index.html`

- [ ] **Step 1: Write failing tests for versioned flags**

Use one storage key:

```text
cogseed.renderer.flags.v1
```

Tests cover missing, malformed, unknown, legacy, and React values. Unknown flags default to legacy.

- [ ] **Step 2: Write failing lifecycle tests**

Use this interface:

```ts
type RendererOwner = 'legacy' | 'react';

type FeatureMount = {
  owner: RendererOwner;
  dispose(): void;
};
```

Tests prove that acquiring a second owner disposes the first before mounting, repeated dispose is safe, and errors during dispose do not allow two active owners.

- [ ] **Step 3: Implement flags and ownership registry**

Do not create a bridge between React state and legacy global mutable state. Flags select one owner; they do not synchronize both implementations.

- [ ] **Step 4: Add boot-time flag projection**

Before legacy feature initialization, expose a frozen read-only projection such as:

```js
window.__cogseedRendererFlags = Object.freeze(parsedFlags);
```

Legacy modules read only their own flag when that module is migrated. Do not retrofit all 89 modules in one commit.

- [ ] **Step 5: Run tests**

```bash
npm run renderer:test -- test/renderer-app/migration
npm run renderer:typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit lifecycle infrastructure**

```bash
git add src/renderer-app/migration src/renderer/index.html test/renderer-app/migration
git commit -m "feat(renderer): enforce exclusive feature ownership"
```

---

### Task 6: Create the typed IPC bridge and CI ratchet

**Files:**
- Create: `src/renderer-app/global.d.ts`
- Create: `src/renderer-app/ipc/bridge.ts`
- Create: `src/renderer-app/ipc/client.ts`
- Create: `src/renderer-app/ipc/types.ts`
- Create: `src/renderer-app/ipc/schemas.ts`
- Create: `src/renderer-app/ipc/channels.generated.ts`
- Create: `src/renderer-app/ipc/dynamic-channels.ts`
- Create: `scripts/check-renderer-boundaries.cjs`
- Create: `test/renderer-app/ipc/bridge.test.ts`
- Create: `test/renderer-app/ipc/stream.test.ts`
- Create: `test/renderer/renderer-boundaries.test.ts`

- [ ] **Step 1: Generate static channel unions from the committed snapshot**

Generate separate `InvokeChannel` and `StreamChannel` unions. Generation must fail if one literal channel appears under both kinds.

- [ ] **Step 2: Declare the exact bridge shape**

```ts
type CogseedStreamHandle = {
  promise: Promise<void>;
  cancel(): void;
};

type CogseedBridge = {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  stream(channel: string, payload: unknown, onEvent: (event: unknown) => void): CogseedStreamHandle;
};
```

Do not add timeout, retry, normalization, or automatic error conversion.

- [ ] **Step 3: Write stream parity tests**

Cover normal done, cancel, repeated cancel, event-handler throw, component cleanup, and cid switch cleanup. Assert the same externally visible semantics as `src/main/preload.js`.

- [ ] **Step 4: Implement `bridge.ts` as the only direct global access point**

`client.ts` exposes named methods backed by `schemas.ts`. Initially, unmigrated channels are absent from `client.ts`; do not expose a public arbitrary-channel helper to components.

- [ ] **Step 5: Register all 29 dynamic call sites**

For each dynamic call site, record file, owner, finite allowed channel set or lookup table. A wildcard string is not acceptable.

- [ ] **Step 6: Implement the source-boundary checker**

The checker fails when:

- `window.cogseed` appears under `src/renderer-app/**` outside `ipc/bridge.ts` or declaration files;
- a new legacy direct call is absent from the committed snapshot;
- generated contract or inventory is stale;
- a dynamic call site lacks a registry entry.

- [ ] **Step 7: Run focused and repository gates**

```bash
npm run renderer:typecheck
npm run renderer:test -- test/renderer-app/ipc
npm run test:js -- test/renderer/renderer-boundaries.test.ts
npm run renderer:contract:check
```

Expected: PASS.

- [ ] **Step 8: Commit the IPC protection layer**

```bash
git add src/renderer-app/ipc src/renderer-app/global.d.ts \
  scripts/check-renderer-boundaries.cjs test/renderer-app/ipc \
  test/renderer/renderer-boundaries.test.ts package.json
git commit -m "feat(renderer): add typed IPC boundary and contract ratchet"
```

---

### Task 7: Migrate pure helpers, then one isolated vertical slice

**Files:**
- Create: `src/renderer-app/helpers/icons.tsx`
- Create: `src/renderer-app/components/shared/Avatar.tsx`
- Create: one approved isolated feature under `src/renderer-app/components/shared/`
- Modify: the corresponding single legacy module under `src/renderer/modules/`
- Modify: `src/renderer-app/app/App.tsx`
- Modify: `docs/superpowers/migrations/renderer-rewrite-inventory.md`
- Create: corresponding tests under `test/renderer-app/components/shared/`

- [ ] **Step 1: Add characterization tests for icon/avatar output**

Assert semantic labels, fallback initials, image failure fallback, locale-dependent text, and existing CSS classes that must remain stable.

- [ ] **Step 2: Migrate helper logic without changing behavior**

Do not redesign icon SVGs, fallback rules, colors, or aria labels in this commit.

- [ ] **Step 3: Select one isolated, read-only feature with one or more IPC reads**

The selected feature must have a dedicated DOM root, no editor, no stream, and a tractable legacy `dispose()`. Record the chosen module and reason in the migration matrix before implementation.

- [ ] **Step 4: Tighten only that feature's IPC schemas**

Replace `unknown` with exact request/response types for the selected channels and add client methods.

- [ ] **Step 5: Implement legacy/React mutual exclusion**

When the feature flag is React, the legacy module must not attach listeners or issue IPC. When the flag is legacy, React must not render the feature.

- [ ] **Step 6: Test both owners and repeated mount/unmount**

Assert exact IPC calls and verify listener/timer counts return to baseline after 20 mount/unmount cycles.

- [ ] **Step 7: Run Phase 0 gates**

```bash
npm run renderer:typecheck
npm run renderer:test
npm run renderer:contract:check
npm run typecheck
npm test
npm run renderer:build
```

Expected: PASS; existing test count does not decrease.

- [ ] **Step 8: Verify rollback**

Set the feature flag to legacy, restart, and execute the feature's Golden Path. Then revert the feature commit and repeat.

- [ ] **Step 9: Commit the first product slice**

```bash
git add src/renderer-app src/renderer/modules docs/superpowers/migrations \
  test/renderer-app test/renderer-characterization
git commit -m "feat(renderer): migrate first isolated React slice"
```

---

## 4. Phase 1 — conversation, split into six independent releases

### Shared rule for Tasks 8–13

Each task must:

1. add/extend legacy characterization first;
2. tighten only the needed IPC schemas;
3. use a dedicated feature flag;
4. preserve the previous conversation slice when disabled;
5. add explicit cleanup tests;
6. update the migration matrix;
7. run the full gate in Task 14 before merge.

---

### Task 8: Phase 1A — read-only conversation shell

**Files:**
- Create: `src/renderer-app/components/chat/ConversationShell.tsx`
- Create: `src/renderer-app/components/chat/ConversationList.tsx`
- Create: `src/renderer-app/components/chat/MessageList.tsx`
- Create: `src/renderer-app/components/chat/MessageBubble.tsx`
- Create: `src/renderer-app/stores/conversation-store.ts`
- Create: `src/renderer-app/stores/conversation-types.ts`
- Modify: `src/renderer/modules/conversation.js`
- Create: tests under `test/renderer-app/chat/phase-1a/`

- [ ] Characterize list load, pagination, selection, history load, plain messages, empty state, scroll anchoring, and cid switch.
- [ ] Define store state for current cid, request generation, normalized message ids, list pagination, loading, and errors.
- [ ] Implement read-only IPC client methods with exact schemas.
- [ ] Implement ConversationList and plain MessageBubble without composer, stream, markdown, attachment, or side tools.
- [ ] Discard stale list/history results when request generation no longer matches the current cid.
- [ ] Add keyboard/focus and 500/1000-message performance tests.
- [ ] Verify `conversation.readonly` flag rollback and commit as `feat(renderer): migrate read-only conversation shell`.

---

### Task 9: Phase 1B — rich message rendering

**Files:**
- Create: `src/renderer-app/components/chat/MarkdownMessage.tsx`
- Create: `src/renderer-app/components/chat/AttachmentRow.tsx`
- Create: `src/renderer-app/components/chat/QuoteBlock.tsx`
- Create: `src/renderer-app/components/chat/ChatArtifact.tsx`
- Create: `src/renderer-app/components/chat/ChatFileViewer.tsx`
- Create: `src/renderer-app/components/chat/ChatLightbox.tsx`
- Create: `src/renderer-app/components/chat/ChatMdDrawer.tsx`
- Create: tests under `test/renderer-app/chat/phase-1b/`

- [ ] Characterize existing markdown sanitization, link policy, code, math, attachment, quote, artifact, viewer, lightbox, and drawer behavior.
- [ ] Move pure render helpers with no output changes; retain existing DOMPurify and vendor behavior.
- [ ] Use only the shared portal root for drawer/lightbox layers.
- [ ] Add security tests for script HTML, dangerous schemes, external links, local paths, and malformed attachment metadata.
- [ ] Add focus return, Escape, stacking, and repeated open/close leak tests.
- [ ] Verify `conversation.richMessages` rollback and commit as `feat(renderer): migrate rich conversation messages`.

---

### Task 10: Phase 1C — Composer and drafts

**Files:**
- Create: `src/renderer-app/components/chat/Composer.tsx`
- Create: `src/renderer-app/components/chat/ComposerAttachments.tsx`
- Create: `src/renderer-app/components/chat/UseSelection.tsx`
- Create: `src/renderer-app/stores/composer-store.ts`
- Create: tests under `test/renderer-app/chat/phase-1c/`

- [ ] Characterize typing, submit, Shift+Enter, IME composition, disabled state, use-selection, attachments, draft restore, optimistic echo, send failure, and retry.
- [ ] Define a message client id and deterministic reconciliation rule with server echo.
- [ ] Preserve absent/null/empty payload fields exactly as legacy recorder output.
- [ ] Implement draft persistence without changing existing storage keys or serialization.
- [ ] Test double-submit prevention, cid switch with unsent draft, and unmount during send.
- [ ] Verify `conversation.composer` rollback and commit as `feat(renderer): migrate conversation composer`.

---

### Task 11: Phase 1D — realtime streams and actor state

**Files:**
- Create: `src/renderer-app/services/conversation-stream.ts`
- Modify: `src/renderer-app/stores/conversation-store.ts`
- Create: `src/renderer-app/components/chat/ActorStatus.tsx`
- Create: tests under `test/renderer-app/chat/phase-1d/`

- [ ] Characterize delta ordering, done, cancel, failure, retry, duplicate events, late events, and cid switch during stream.
- [ ] Keep the active stream handle outside React component render state and cancel it in one store/service cleanup path.
- [ ] Tag events with the local subscription generation and ignore stale generations.
- [ ] Implement dedupe only where legacy already dedupes; do not invent protocol semantics.
- [ ] Test handler throw, repeated cancel, unmount, cid switch, and 1000-event burst.
- [ ] Verify `conversation.stream` rollback and commit as `feat(renderer): migrate conversation stream lifecycle`.

---

### Task 12: Phase 1E — plan, queue, and continue-work widgets

**Files:**
- Create: `src/renderer-app/components/chat/PlanRail.tsx`
- Create: `src/renderer-app/components/chat/QueueDraft.tsx`
- Create: `src/renderer-app/components/chat/ContinueWork.tsx`
- Modify: corresponding legacy modules
- Create: tests under `test/renderer-app/chat/phase-1e/`

- [ ] Characterize visibility, interaction, ordering, disabled/error states, and IPC payloads for all three widgets.
- [ ] Implement each widget behind its own flag so rollback does not require reverting the entire group.
- [ ] Verify keyboard/focus and conversation-switch cleanup.
- [ ] Commit each widget as a separate independently revertible commit.

---

### Task 13: Phase 1F — terminal and side tools

**Files:**
- Create: `src/renderer-app/components/chat/TerminalPanel.tsx`
- Create: `src/renderer-app/components/chat/ChatAside.tsx`
- Create: `src/renderer-app/components/chat/ChatSideBrowser.tsx`
- Create: `src/renderer-app/components/chat/ChatSideHost.tsx`
- Modify: corresponding legacy modules
- Create: tests under `test/renderer-app/chat/phase-1f/`

- [ ] Characterize xterm construction, fit, input, output, cancel, resize, cid switch, and dispose.
- [ ] Wrap existing xterm vendor APIs; do not upgrade xterm in this task.
- [ ] Ensure every xterm instance calls `dispose()` exactly once and removes ResizeObserver/listeners.
- [ ] Characterize side browser/host/aside navigation, external link policy, errors, and cleanup.
- [ ] Migrate terminal, aside, browser, and host as separate commits and flags.
- [ ] Run 20 mount/unmount cycles and verify no active stream, observer, or terminal instance remains.

---

### Task 14: Phase 1 release gate

**Files:**
- Create: `playwright.renderer.config.ts`
- Create: `test/e2e/renderer-golden-path.spec.ts`
- Modify: `docs/superpowers/migrations/renderer-golden-path.md`

- [ ] Install the approved Playwright dependency and browser/runtime artifacts according to repository policy.
- [ ] Automate launch, conversation switch, send, stream, cancel, retry, rich message, attachment, terminal open/close, and fallback restart.
- [ ] Run legacy and React variants in separate Electron launches using the same deterministic fixture.
- [ ] Run:

```bash
npm run renderer:typecheck
npm run renderer:test
npm run renderer:contract:check
npm run typecheck
npm test
npm run renderer:build
npx playwright test -c playwright.renderer.config.ts test/e2e/renderer-golden-path.spec.ts
```

Expected: all PASS; no baseline test removal; no IPC contract expansion; no `src/main/**` diff.

- [ ] Package and run macOS and Windows smoke using the repository's platform procedures.
- [ ] Record performance and heap/listener comparisons against Phase 0.0.
- [ ] Keep all Phase 1 flags available; do not delete `conversation.js` yet.

---

## 5. Phase 2 — domain panels

### Task 15: Migrate cognition

**Scope:** `skills.js`, `skills-bindings.js`, recall modules, memory, kb-picker, personal ontology, contexts, personal-context modules.

- [ ] Split the migration into independent flags for skills, recall, memory/KB, ontology, and contexts.
- [ ] For each flag: characterize read/save/delete/error/cancel, tighten IPC schemas, implement React, test cleanup, verify fallback, update inventory, commit independently.
- [ ] Preserve i18n keys, source-display rules, sanitization, external drop behavior, and existing storage formats.

### Task 16: Migrate settings

**Scope:** settings, settings tabs, security, messaging settings, model authorization/chip/guard.

- [ ] Use one flag per settings tab or cohesive save boundary.
- [ ] Characterize initial load, dirty state, validation, save, cancel, auth flow, error recovery, and focus.
- [ ] Preserve payload omission/default semantics exactly.
- [ ] Commit each tab independently.

### Task 17: Migrate Agents and local CLI

**Scope:** agents, local-agents, interactive-cli.

- [ ] Separate Agent list/detail, local status, and interactive CLI flags.
- [ ] Characterize process status, cancellation, reconnect, output ordering, and teardown.
- [ ] Verify renderer code never spawns processes and continues using canonical IPC.
- [ ] Commit each surface independently.

### Task 18: Migrate marketplace, connectors, expense, and onboarding

- [ ] Marketplace: characterize categories/cache/install/remove/detail and dynamic channel mappings.
- [ ] Connectors/connections/p3394: characterize status, degraded states, auth, refresh, and push unsubscribe.
- [ ] Expense: preserve capability/gesture and host authorization flow; do not bypass preload-specific APIs.
- [ ] Onboarding: preserve project creation, completion, keyboard/focus, and restart behavior.
- [ ] Use one feature flag and one revertible commit per cohesive surface.

### Task 19: Migrate remaining shared modules and helpers

- [ ] Resolve every remaining row in `renderer-rewrite-inventory.md`; wildcard rows are not acceptable.
- [ ] Migrate context menu, sidebar resize, dialogs, search, workspace, validation report, file-operation policy, import/delete modals, and remaining touchpoint/shared modules.
- [ ] For global interaction modules, test event exclusivity and repeated dispose before enabling React by default.
- [ ] Run `capture-renderer-inventory.cjs --check` after every commit; the remaining legacy owner count must monotonically decrease.

---

## 6. Phase 3 — default switch, soak, and removal

### Task 20: Phase 3A — make React the default while retaining fallback

**Files:**
- Modify: `src/renderer-app/migration/feature-flags.ts`
- Modify: `docs/superpowers/migrations/renderer-rewrite-inventory.md`
- Create: `docs/superpowers/migrations/renderer-soak-report.md`

- [ ] Change defaults to React only after every inventory row has a passing React owner and tested legacy fallback.
- [ ] Run all automated gates on macOS and Windows.
- [ ] Complete one explicit release observation period with renderer error, crash, memory, listener, stream, startup, and Golden Path results recorded.
- [ ] Exercise the legacy fallback in the same production build; a fallback that was not tested does not count as rollback.
- [ ] Block Phase 3B on any open P0/P1 renderer regression.

### Task 21: Phase 3B — remove legacy owners and classic scripts

**Files:**
- Modify: `src/renderer/index.html`
- Delete: migrated files under `src/renderer/modules/`
- Modify: `src/renderer-app/migration/feature-flags.ts`
- Modify: `scripts/capture-renderer-inventory.cjs`
- Modify: `scripts/check-renderer-boundaries.cjs`
- Modify: legacy CSS files only where selectors are proven unused
- Modify: packaging smoke tests

- [ ] Delete one legacy domain at a time, not all 89 modules in one commit.
- [ ] After each domain deletion, remove only its script tags and proven-unused selectors.
- [ ] Run source-boundary and inventory checks; all `window.cogseed` React access must remain in `ipc/bridge.ts`.
- [ ] Remove feature flags only after their legacy implementation is gone and the deletion commit passes rollback-by-revert.
- [ ] Preserve vendor files still required by React wrappers.
- [ ] End with one Vite module entry plus any explicitly retained non-bundled vendor assets required by policy.

### Task 22: Final lock and release gate

- [ ] Run:

```bash
npm run renderer:typecheck
npm run renderer:test
npm run renderer:contract:check
npm run typecheck
npm test
npm run renderer:build
npx playwright test -c playwright.renderer.config.ts
npm run package:dev:mac
npm run verify:package:dev:mac
```

- [ ] Run the equivalent Windows packaging and native verification commands on Windows.
- [ ] Confirm no test files or assertions were removed solely to make the migration pass.
- [ ] Confirm IPC static channel sets and all typed payload/response/event schemas match the frozen contract.
- [ ] Confirm no main/preload/user-data-format changes are included.
- [ ] Confirm the final inventory contains zero legacy feature owners and no unresolved module rows.
- [ ] Tag or record the last known-good legacy-capable commit for emergency git revert.
- [ ] Commit final cleanup as small domain commits followed by one metadata-only lock commit.

---

## 7. Phase P — P3394 remote Agent ↔ Agent communication

This track is independent from the renderer rewrite. It can start after the renderer Phase 0 typed IPC/ownership boundary exists, but it must use separate commits, flags, contract diffs, test fixtures, release gates, and rollback points. The existing P3394 main-side foundation is reused; no network implementation is placed in React.

### Task 23: P3394 P0 — protocol, identity, and threat-model lock

**Files/areas:**
- Review: `src/main/features/p3394/`
- Review: `src/main/features/p3394_bridge/`
- Review: `src/main/ipc/p3394_external.ts`
- Create: `docs/superpowers/migrations/p3394-remote-agent-design.md`
- Create: `test/p3394/fixtures/` and threat-model tests

- [ ] Confirm whether v1 targets another CogSeed instance, arbitrary A2A Agents, or both.
- [ ] Record the authoritative binding, Agent Card discovery/pinning, authentication, secret storage, capability profile, and endpoint policy.
- [ ] Confirm the current A2A adapter limitation: dialer-oriented, no streaming, no multi-party sessions. Do not advertise P2/P3 capability until implemented and tested.
- [ ] Define the P3394 remote message fields: `spec_version`, `message_id`, `session_id`, `task_id`, sender/recipients, `reply_to`, `idempotency_key`, `traceparent`, payload parts, and error/cancel/completion states.
- [ ] Define maximum delegation depth, loop detection, message/artifact limits, time/cost budgets, user approval, and audit requirements.
- [ ] Produce a threat model covering token leakage, replay, confused deputy, SSRF/endpoint abuse, remote prompt injection, unauthorized side effects, and denial-of-service.
- [ ] Stop here if protocol ownership or security approval is missing; do not add renderer UI or network code.

**Verification:** protocol review approved; threat-model tests cover rejection paths; no `src/main/**` or preload changes are mixed into renderer commits.

**Commit boundary:**

```bash
git commit -m "docs(p3394): lock remote agent protocol and threat model"
```

### Task 24: P3394 P1 — one-to-one request/response vertical slice

**Files/areas:**
- Create or modify: `src/main/ipc/p3394_agent.ts` after P0 approval
- Create: `src/renderer-app/ipc/p3394-client.ts`
- Create: `src/renderer-app/ipc/p3394-types.ts`
- Create: `test/p3394/request-response.test.ts`
- Create: `test/renderer-app/ipc/p3394-client.test.ts`

- [ ] Add a separately named IPC namespace, for example `p3394.agent.listPeers`, `connect`, `disconnect`, `createSession`, `send`, and `cancel`; exact channels require P0 approval.
- [ ] Keep remote endpoint, Agent Card, bearer token/node key, retry policy, and P3394 envelope construction in main/features only.
- [ ] Implement local Agent A selecting remote Agent B, creating a session, sending one task, receiving one result, and persisting the result in the local conversation projection.
- [ ] Cover success, authentication failure, unreachable peer, protocol incompatibility, remote rejection, timeout, local cancellation, duplicate submission, and result persistence.
- [ ] Require explicit target selection and visible connection/permission state; remote Agent must not silently create local side effects.
- [ ] Add a feature flag with legacy/no-remote fallback; fallback must not issue a remote request.

**Verification:** exact IPC recorder assertions, main-side integration fixture, renderer error-state tests, and one Electron Golden Path using two controlled Agent fixtures.

**Rollback:** disable the P3394 flag or revert the isolated commit; existing 427 renderer IPC channels and legacy external-agent flows remain unchanged.

### Task 25: P3394 P2 — bidirectional streaming and recovery

**Files/areas:**
- Modify: approved P3394 channel adapter/session/outbox boundaries only
- Create: `test/p3394/stream-recovery.test.ts`
- Modify: `src/renderer-app/ipc/p3394-client.ts` only through typed adapter

- [ ] Add stream event, ack, cursor, resume, outbox, retry/backoff, and disconnect/reconnect behavior.
- [ ] Specify and test delivery semantics; use “at-least-once transport + idempotent effects” unless a stronger guarantee is proven.
- [ ] Test duplicate and late events, ordering, cancellation, session close, process restart, and resume after cursor loss.
- [ ] Ensure cleanup releases sockets, timers, listeners, stream handles, and unfinished task resources.
- [ ] Keep renderer unaware of transport details and prevent arbitrary channel/URL input.

**Verification:** deterministic fault-injection tests, two-node reconnect test, listener/heap checks, and no secret/token leakage in logs or renderer state.

### Task 26: P3394 P3 — multi-Agent delegation and collaboration

**Files/areas:**
- Modify: approved delegation/session/authorization boundaries
- Create: `test/p3394/multi-agent-collaboration.test.ts`
- Modify: `test/e2e/renderer-golden-path.spec.ts` with an isolated remote collaboration path

- [ ] Support A→B→C delegation only after capability, authorization, maximum depth, loop detection, and budget checks are enforced.
- [ ] Support multiple recipients/multi-party sessions only after the P2 ordering and recovery guarantees are stable.
- [ ] Trace every cross-Agent message to local user, origin session, parent task, sender, recipient, and audit record.
- [ ] Add explicit human approval for remote actions with local side effects and clear denial UX.
- [ ] Verify remote prompt/content cannot bypass local path sandbox, tool policy, or runtime spawn boundaries.

**Verification:** collaboration fixture passes success, denied capability, loop, depth, budget, approval, partial failure, and audit replay scenarios.

### Task 27: P3394 release gate and compatibility lock

- [ ] Run the full renderer and P3394 suites independently and together.
- [ ] Verify no existing IPC channel changed and any new `p3394.agent.*` channel is present in a reviewed contract diff.
- [ ] Verify P3394 fallback/disable behavior in a packaged `file://` Electron build on macOS and Windows.
- [ ] Verify peer revoke/disable, auth rotation, upgrade/restart, outbox recovery, and data cleanup.
- [ ] Record an operational runbook: connect, inspect, revoke, disable, recover, rotate credentials, and emergency shutdown.
- [ ] Keep P3394 commits independently revertible; renderer Phase 3 cleanup must not delete required main bridge code.

**Commit boundary:**

```bash
git commit -m "feat(p3394): release remote agent communication track"
```

## 8. Verification matrix

| Gate | Every slice | Phase 1 | Phase 2 domain | Phase 3 |
|---|---:|---:|---:|---:|
| Legacy characterization | Yes | Yes | Yes | N/A after deletion |
| React unit/component tests | Yes | Yes | Yes | Yes |
| IPC contract `--check` | Yes | Yes | Yes | Yes |
| Boundary ratchet | Yes | Yes | Yes | Yes |
| Renderer strict typecheck | Yes | Yes | Yes | Yes |
| Existing typecheck/tests | Yes | Yes | Yes | Yes |
| Production renderer build | Yes | Yes | Yes | Yes |
| Electron Golden Path | Changed subset | Full conversation | Domain subset | Full |
| macOS/Windows package smoke | Phase exit | Yes | Phase exit | Yes |
| Listener/stream/heap check | Changed feature | Full conversation | Changed domain | Full |
| Legacy fallback | Yes | Yes | Yes | Phase 3A only |

---

## 9. Estimation and checkpoints

| Phase | Estimate | Re-estimation checkpoint |
|---|---:|---|
| 0.0 | 6–10 person-days | After contract/inventory and legacy fixture completion |
| 0 | 6–10 person-days | After first vertical slice and packaged smoke |
| 1 | 28–42 person-days | After 1A and 1D |
| 2 | 24–36 person-days | After cognition and settings |
| 3A/3B | 6–12 person-days | After observation period |
| P3394 P0–P1 | 12–20 person-days | After protocol/security review and first remote Golden Path |
| P3394 P2–P3 | 20–40 person-days | After P1 soak and two-node fault-injection validation |
| Renderer rewrite total | 70–110 person-days | Excludes P3394 track |
| Combined program envelope | 102–170 person-days | P3394 must be separately staffed and re-estimated |

Shared hotspots—IPC schemas, conversation store, CSS layers, Vite entry, and migration flags—must have named owners before parallel work begins. Parallel tasks must use disjoint feature flags and file ownership.

---

## 10. Self-review checklist

Before execution, verify this plan against the spec:

- [ ] Every spec hard constraint maps to a task and automated gate.
- [ ] All 89 first-party modules appear individually in the generated/human inventory.
- [ ] No task treats 427 as a required final call-site count.
- [ ] All 29 dynamic IPC call sites have finite mappings.
- [ ] No task requires a Vite dev server or main/preload change.
- [ ] P3394 network/token/protocol logic remains in main/features, not React.
- [ ] P3394 remote communication has separate P0–P3 tasks, gates, flags, and rollback points.
- [ ] New P3394 IPC is additive and separately reviewed; existing 427-call contract remains unchanged.
- [ ] No feature is simultaneously owned by legacy and React.
- [ ] Phase 1 is six independent releases, not one conversation rewrite commit.
- [ ] E2E and packaged smoke are mandatory, not optional.
- [ ] Phase 3 includes an observed fallback period before deletion.
- [ ] There are no placeholder markers or deferred-work phrases.

## Next skill

After the design and architecture exception are approved, execute with `$superpower-subagents` (recommended for independent feature slices) or `$superpower-executing-plans` (inline batches with checkpoints).
