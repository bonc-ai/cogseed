# CogSeed-only Brand Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Make CogSeed the only accepted and emitted product identity across runtime, storage, IPC, CLI, renderer, prompts, packaging, tests, and documentation.

**Architecture:** Replace compatibility-at-the-edge with a single canonical identity contract. All runtime surfaces consume `COGSEED_*`, all app communication uses CogSeed-prefixed channels, and all persisted product namespaces use CogSeed names. A permanent residual-identifier gate prevents legacy CogSeed/Mate product identifiers from returning.

**Tech Stack:** Electron, TypeScript, CommonJS bootstrap scripts, vanilla renderer JavaScript, Vitest, Node.js scripts, Python resource tests.

---

## File and boundary map

- `src/resources/identity.json`, `src/resources/brand.json`, `src/main/brand.ts`, `src/main/identity-contract.cjs`: canonical identity source.
- `bootstrap.cjs`, `src/main/install-data-root.cjs`, `src/main/paths.ts`: startup environment and data-root selection.
- `src/main/ipc/index.ts`, `src/main/preload.js`, `src/renderer/modules/ipc-shim.js`: IPC and renderer bridge.
- `src/main/features/cogseed_backend/**`, `src/main/features/cogseed_runtime/**`: backend/runtime type, schema, storage, protocol, and IPC names.
- `bin/**`, `scripts/**`, `resources/builtin/**`: child-process contracts, packaged tools, and builtin skills.
- `src/renderer/**`, `src/main/locales/**`, `src/main/prompts/**`: user-facing and renderer identity.
- `package.json`, `package-lock.json`, packaging gates: package metadata and shipped file list.
- `test/**`: canonical behavior and negative compatibility tests.
- `scripts/check-cogseed-only-identifiers.mjs`: permanent residual gate.

### Task 1: Add the CogSeed-only residual and identity tests

**Files:**
- Modify: `test/main/identity-contract.test.ts`
- Modify: `test/main/cogseed-protocol.test.ts`
- Modify: `test/main/cogseed-residual-identifiers.test.ts`
- Create: `scripts/check-cogseed-only-identifiers.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing identity assertions**

Replace alias expectations with canonical-only assertions:

```ts
expect(identity.IDENTITY).toMatchObject({
  appName: 'CogSeed',
  appId: 'com.cogseed.desktop',
  protocolScheme: 'cogseed',
  dataRootName: '.cogseed',
  devDataRootName: '.cogseed-dev',
  runtimeVariant: 'cogseed',
  envPrefix: 'COGSEED',
});
expect(identity.protocolSchemes()).toEqual(['cogseed']);
expect(() => identity.normalizeRuntimeVariant('cogseed')).toThrow();
expect(identity.normalizeEnv({ COGSEED_WORKSPACE_ROOT: '/root' }))
  .toEqual({ COGSEED_WORKSPACE_ROOT: '/root' });
```

Add protocol rejection assertions:

```ts
expect(normalizeDeepLink('cogseed://connectors/oauth/callback')).toBeNull();
expect(normalizeDeepLink('cogseed://connectors/oauth/callback')).toBeNull();
expect(CONNECTOR_PROTOCOL_SCHEMES).toEqual(['cogseed']);
```

- [ ] **Step 2: Add the residual gate script**

Create a tracked-file scanner that fails on product identifiers matching:

```js
const forbiddenContent = [
  /\bCOGSEED_[A-Z0-9_]+\b/g,
  /\bCogSeed\b/g,
  /\bcogseed(?:[.:_/-]|\b)/g,
  /\bCOGSEED_AGENT[A-Z0-9_]*\b/g,
  /\bCogSeedAgent[A-Za-z0-9_]*\b/g,
  /\bcogseedAgent[A-Za-z0-9_]*\b/g,
  /\bcogseed(?:[.:_/-]|\b)/g,
  /\bcogseed-agent(?:[.:_/-]|\b)/g,
  /\bcogseed(?:[.:_/-]|\b)/g,
  /\bCOGSEED_RUNTIME[A-Z0-9_]*\b/g,
  /\bCogSeedRuntime[A-Za-z0-9_]*\b/g,
  /\bcogseedRuntime[A-Za-z0-9_]*\b/g,
  /\bcogseed-runtime(?:[.:_/-]|\b)/g,
];
```

Scan `git ls-files`, skip binary files by NUL detection, and fail with `file:line` output. Add an `audit:identity` npm script.

- [ ] **Step 3: Run the tests and residual gate to verify failure**

Run:

```bash
node scripts/run-tests.mjs run test/main/identity-contract.test.ts test/main/cogseed-protocol.test.ts test/main/cogseed-residual-identifiers.test.ts
npm run audit:identity
```

Expected: failures showing legacy protocol aliases, environment aliases, and repository residuals.

- [ ] **Step 4: Commit the failing guardrail**

```bash
git add test/main/identity-contract.test.ts test/main/cogseed-protocol.test.ts test/main/cogseed-residual-identifiers.test.ts scripts/check-cogseed-only-identifiers.mjs package.json
git commit -m "test: enforce CogSeed-only identity"
```

### Task 2: Collapse identity, bootstrap, and data-root handling to CogSeed only

**Files:**
- Modify: `src/resources/identity.json`
- Modify: `src/resources/brand.json`
- Modify: `src/main/identity-contract.cjs`
- Modify: `src/main/brand.ts`
- Modify: `src/main/install-data-root.cjs`
- Modify: `bootstrap.cjs`
- Delete: `src/main/cogseed-install-migration.cjs`
- Delete: `src/main/cogseed-transport-compat.ts`
- Delete: `src/main/util/migrate-source-data-root.cjs`
- Delete: `test/main/cogseed-install-migration.test.ts`
- Delete: `test/main/cogseed-transport-compat.test.ts`
- Modify: related identity/bootstrap/install-data-root tests

- [ ] **Step 1: Remove legacy identity fields and aliases**

Canonical JSON shape:

```json
{
  "appName": "CogSeed",
  "appId": "com.cogseed.desktop",
  "protocolScheme": "cogseed",
  "dataRootName": ".cogseed",
  "devDataRootName": ".cogseed-dev",
  "runtimeVariant": "cogseed",
  "envPrefix": "COGSEED"
}
```

`protocolSchemes()` returns only `['cogseed']`; `normalizeEnv()` returns the provided canonical environment without legacy translation; `normalizeRuntimeVariant()` accepts only `cogseed`.

- [ ] **Step 2: Remove migration and transport compatibility imports**

Delete bootstrap calls to `migrateLegacyInstallRoots`, remove legacy root resolution, and remove old transport constants. Source and packaged startup resolve only `.cogseed` / `.cogseed-dev`.

- [ ] **Step 3: Rename package metadata consumed at bootstrap**

Use:

```json
"cogseedSourceRuntimeVariant": "cogseed"
```

and `cogseedBuildChannel` where build scripts stamp a channel. Bootstrap reads only CogSeed-named fields and recognizes only:

```text
--cogseed-api-base-url=
--cogseed-voice-api-base=
```

- [ ] **Step 4: Run focused startup and identity tests**

```bash
node scripts/run-tests.mjs run test/main/identity-contract.test.ts test/main/cogseed-protocol.test.ts test/main/install-data-root.test.ts test/main/brand.test.ts test/setup-env.test.ts
```

Expected: pass; legacy variants and schemes reject.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: collapse app identity to CogSeed only"
```

### Task 3: Rename all environment and child-process contracts

**Files:**
- Modify: `src/main/**`
- Modify: `src/core-agent/**`
- Modify: `bin/**`
- Modify: `scripts/**`
- Modify: `resources/builtin/**`
- Modify: `resources/test/**`
- Modify: `test/**`

- [ ] **Step 1: Apply the canonical environment mapping**

Perform exact identifier replacements, including:

```text
COGSEED_WORKSPACE_ROOT -> COGSEED_WORKSPACE_ROOT
COGSEED_PC_DIR -> COGSEED_PC_DIR
COGSEED_NODE -> COGSEED_NODE
COGSEED_UID -> COGSEED_UID
COGSEED_RUNTIME_VARIANT -> COGSEED_RUNTIME_VARIANT
COGSEED_OUTPUT_DIR -> COGSEED_OUTPUT_DIR
COGSEED_AGENT_ID -> COGSEED_AGENT_ID
COGSEED_PYTHON -> COGSEED_PYTHON
COGSEED_UV -> COGSEED_UV
COGSEED_BUNDLED_* -> COGSEED_BUNDLED_*
COGSEED_TTS_* -> COGSEED_TTS_*
COGSEED_MCP_* -> COGSEED_MCP_*
COGSEED_P3394_* -> COGSEED_P3394_*
COGSEED_METACOGNITION -> COGSEED_METACOGNITION
```

Apply the same rename to shell parameter expressions and PowerShell environment syntax.

- [ ] **Step 2: Rename internal runtime names**

Rename product types and constants:

```text
CogSeedAgentKernel -> CogSeedKernel
CogSeedAgentKernelDeps -> CogSeedKernelDeps
COGSEED_AGENT_RUNTIME_PROTOCOL_VERSION -> COGSEED_RUNTIME_PROTOCOL_VERSION
COGSEED_RUNTIME_TOOL_POLICY -> COGSEED_RUNTIME_TOOL_POLICY
CogSeedTask* -> CogSeedTask*
CogSeedSession* -> CogSeedSession*
CogSeedConnector* -> CogSeedConnector*
CogSeedCapability* -> CogSeedCapability*
cogseedAgentRuntime -> cogseedRuntime
```

Rename files such as `cogseed-control-service.ts`, `cogseed-execution-store.ts`, and `cogseed-kb-store.ts` to CogSeed equivalents and update imports.

- [ ] **Step 3: Rename persisted namespaces**

Change path helpers and stored domains from `cogseed` / `cogseed_runtime` to `cogseed`, including cloud/local task, session, connector, KB, audit, capability, and worker state paths. Do not retain fallback reads.

- [ ] **Step 4: Run typecheck and targeted runtime tests**

```bash
npm run typecheck
node scripts/run-tests.mjs run test/main/paths.test.ts test/main/features/cogseed_backend test/main/features/cogseed_runtime test/main/model/core-agent/client.test.ts
```

Expected: pass with no old environment or type names.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: rename runtime contracts to CogSeed"
```

### Task 4: Cut IPC and renderer projection over to CogSeed-only channels

**Files:**
- Modify: `src/main/ipc/index.ts`
- Modify: `src/main/preload.js`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/modules/ipc-shim.js`
- Modify: `src/renderer/modules/conversation-info.js`
- Modify: every renderer caller and corresponding test

- [ ] **Step 1: Remove old transport registrations**

Keep only:

```ts
ipcMain.handle('cogseed.invoke', handleInvoke);
ipcMain.on('cogseed.streamStart', handleStreamStart);
ipcMain.on('cogseed.streamCancel', handleStreamCancel);
ipcMain.on('cogseed:bootI18n', handleBootI18n);
```

- [ ] **Step 2: Rename backend logical channels**

Use canonical channel families:

```text
cogseed.task.* -> cogseed.task.*
cogseed.session.* -> cogseed.session.*
cogseed.runtime.* -> cogseed.runtime.*
cogseed.connector.* -> cogseed.backend.connector.*
cogseed.kb.* -> cogseed.backend.kb.*
```

Update main handlers, preload allowlists, renderer calls, fixtures, and tests together.

- [ ] **Step 3: Replace `window.cogseedAgentProjection`**

Expose and consume `window.cogseedProjection`; rename state fields and local helper names from `cogseed` to `cogseed` where they refer to this product backend.

- [ ] **Step 4: Add rejection tests**

Assert that old IPC transports are absent from source and old logical channels return unknown-channel responses in handler-level tests.

- [ ] **Step 5: Run IPC and renderer tests**

```bash
node scripts/run-tests.mjs run test/main/ipc test/renderer/cogseed-agent-projection.test.ts test/renderer/conversation-info.test.ts
```

Rename test files whose filenames carry the old product identity before committing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: expose only CogSeed IPC contracts"
```

### Task 5: Rename CLI tools and remove wrappers

**Files:**
- Rename: `bin/cogseed-pkg.cjs` -> `bin/cogseed-pkg.cjs`
- Delete: `bin/cogseed-bridge.cjs`
- Delete: `bin/cogseed-runtime-worker.cjs`
- Modify: `bin/cogseed-bridge.cjs`
- Modify: `bin/cogseed-runtime-worker.cjs`
- Modify: `bin/run-skill.cjs`
- Modify: `package.json`
- Modify: transport templates and builtin skills under `resources/builtin/**`
- Rename: related tests and fixture documents

- [ ] **Step 1: Rename package CLI and tool names**

Change `cogseed_*` tool names to `cogseed_*`, for example:

```text
cogseed_list_skills -> cogseed_list_skills
cogseed_read_skill -> cogseed_read_skill
cogseed_run_skill -> cogseed_run_skill
cogseed_dispatch_to -> cogseed_dispatch_to
cogseed_hand_off_to -> cogseed_hand_off_to
cogseed_kb_search -> cogseed_kb_search
```

Update tool catalogs, schemas, prompts, tests, and connector templates.

- [ ] **Step 2: Remove wrapper files and package entries**

Remove legacy wrapper files from source, electron-builder `files`, scripts, diagnostics, and tests. Ensure no shipped path references them.

- [ ] **Step 3: Rename temp markers and runtime files**

Rename `.cogseed-runtime.json`, `.cogseed-whisper-ready.json`, `.cogseed-ocr-verified`, temp prefixes, and package receipt/guard names to CogSeed forms. Do not read legacy markers.

- [ ] **Step 4: Run CLI/package tests**

```bash
node scripts/run-tests.mjs run test/main/util/cogseed-pkg.test.ts test/main/util/cogseed-pkg-tarball.test.ts test/main/model/local-tools.test.ts test/main/features/packages.test.ts
node p3394-gateway/test/smoke.cjs
```

Rename the old test filenames first; expected result is pass with canonical commands only.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: ship only CogSeed CLI tools"
```

### Task 6: Rename API, renderer, prompt, and UI identity

**Files:**
- Modify: `src/main/features/api_common.ts`
- Modify: `src/main/features/client_config.ts`
- Modify: `src/main/features/marketplace.ts`
- Modify: `src/renderer/**`
- Modify: `src/main/locales/**`
- Modify: `src/main/prompts/**`
- Modify: `resources/mac-locales/**`
- Modify: related tests

- [ ] **Step 1: Rename HTTP client headers**

Use only:

```text
CogSeed-App-Version
CogSeed-Platform
CogSeed-OS-Version
CogSeed-Arch
CogSeed-Channel
```

Update tests to reject `CogSeed-*` headers.

- [ ] **Step 2: Require the CogSeed API base**

Introduce a validated resolver:

```ts
export function requireCogSeedApiBase(env = process.env): string {
  const raw = String(env.COGSEED_API_BASE_URL || '').trim();
  if (!raw) throw new Error('COGSEED_API_BASE_URL is required');
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('COGSEED_API_BASE_URL must be an HTTPS origin/path without credentials, query, or fragment');
  }
  return url.toString().replace(/\/$/, '');
}
```

Use it for client config, Marketplace, server-managed OAuth, and account/server calls. Tests set an explicit CogSeed API base.

- [ ] **Step 3: Rename renderer runtime identifiers**

Change:

```text
application/x-cogseed-file -> application/x-cogseed-file
cogseed-agent-run-finished -> cogseed-agent-run-finished
cogseed:model-entries-changed -> cogseed:model-entries-changed
cogseed:mp:* -> cogseed:mp:*
cogseed-core-agent -> cogseed-core-agent
cogseed_core -> cogseed_core
```

Rename CSS/data attributes and internal helper names where they encode the product identity.

- [ ] **Step 4: Clean prompts and locales**

Replace `$COGSEED_OUTPUT_DIR` with `$COGSEED_OUTPUT_DIR`, `cogseed-pkg.cjs` with `cogseed-pkg.cjs`, and remove old locale keys and user-visible labels. Keep external integration brands unchanged.

- [ ] **Step 5: Run focused UI/API tests**

```bash
node scripts/run-tests.mjs run test/main/features/api_common.test.ts test/main/features/client_config.test.ts test/main/features/marketplace_projects.test.ts test/renderer
```

Expected: pass; no old header, event, storage, or prompt names.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: rename API and renderer identity to CogSeed"
```

### Task 7: Clean documentation, fixtures, filenames, and package lock

**Files:**
- Modify/rename: `README*`, `docs/**`, `.claude/**`, `.raymond/**`, JSON fixtures, report files, tests
- Modify: `LICENSE`
- Modify: `package-lock.json`

- [ ] **Step 1: Rename tracked paths carrying legacy product names**

Use `git mv` for all non-archived paths whose filename contains `cogseed`, `cogseed-agent`, `cogseed`, or `cogseed-runtime`. Delete obsolete compatibility fixture files instead of preserving renamed copies when their only purpose was legacy acceptance.

- [ ] **Step 2: Replace legacy product prose**

Replace old product attribution, migration instructions, architecture labels, and examples with CogSeed wording. Remove compatibility sections that instruct users to use old schemes, env vars, directories, or wrappers.

- [ ] **Step 3: Regenerate package lock metadata**

Run:

```bash
npm install --package-lock-only --ignore-scripts
```

Verify the package name and script paths are CogSeed-only and dependency versions are otherwise unchanged.

- [ ] **Step 4: Run the residual gate**

```bash
npm run audit:identity
```

Expected: zero forbidden content or tracked path findings.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: remove legacy product identity"
```

### Task 8: Full verification and final residue audit

**Files:**
- Modify only if verification exposes defects.

- [ ] **Step 1: Verify type and syntax**

```bash
npm run typecheck
find src/main src/renderer bin p3394-gateway scripts -type f \( -name '*.js' -o -name '*.cjs' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check
```

Expected: zero errors.

- [ ] **Step 2: Verify resources and manifests**

```bash
npm run test:resources
npm run builtin:manifest:check
```

Expected: all resource tests pass and manifest current.

- [ ] **Step 3: Run full JS tests**

```bash
npm run test:js
```

Expected: all tests pass. If the pre-existing Feishu identity lookup timeout remains, fix it before completion rather than excluding tests.

- [ ] **Step 4: Run P3394 smoke and package gates**

```bash
node p3394-gateway/test/smoke.cjs
node scripts/run-tests.mjs run test/main/util/packaged-resource-gate.test.ts test/main/util/codesign-runtime-gate.test.ts
```

Expected: pass.

- [ ] **Step 5: Verify renderer/main channel parity**

Run the literal invoke/stream parity scanner and confirm no renderer channel lacks a main handler. Resolve the existing `projects.list` mismatch during this task if it remains.

- [ ] **Step 6: Verify no source changes are hidden by ignored artifacts**

```bash
git status --short
git diff --check
npm run audit:identity
```

Expected: only intentional tracked changes, no whitespace errors, no legacy identity findings.

- [ ] **Step 7: Final commit**

```bash
git add -A
git commit -m "test: verify CogSeed-only cutover"
```
