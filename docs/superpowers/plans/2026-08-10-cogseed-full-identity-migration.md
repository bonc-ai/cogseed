# CogSeed Full Identity Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax via update_plan.

**Goal:** Make CogSeed the canonical internal product identity while automatically migrating legacy Orkas/Mate data and preserving one release of protocol, bridge, environment, runtime, artifact, and entrypoint compatibility.

**Architecture:** Keep `bootstrap.cjs` as the package main and introduce a CJS-only identity contract plus pre-tsx install migration. Canonical code uses CogSeed names; centralized compatibility adapters normalize legacy identifiers at the process boundary. Business IPC channels and user data schemas remain unchanged unless they are purely product identity fields.

**Tech Stack:** Electron main/preload, Node CJS bootstrap, TypeScript main features, classic renderer JavaScript, JSON/JSONL file storage, macOS/Windows launchers, Vitest through `npm run test:js`, Python resources through `npm test`.

---

## Task 1: Add the canonical identity contract and migration test fixtures

**Files:**
- Create: `src/resources/identity.json`
- Create: `src/main/identity-contract.cjs`
- Create: `test/main/identity-contract.test.ts`
- Create: `test/main/identity-migration-fixtures.test.ts`
- Modify: `src/resources/brand.json`
- Modify: `test/main/brand.test.ts`

- [ ] **Step 1: Write failing canonical identity tests**

Assert the canonical values and aliases:

```ts
expect(identity.appId).toBe('com.cogseed.desktop');
expect(identity.protocolScheme).toBe('cogseed');
expect(identity.legacyProtocolSchemes).toEqual(['mateagent', 'orkas']);
expect(identity.dataRootName).toBe('.cogseed');
expect(identity.legacyDataRootNames).toEqual(['.orkas']);
expect(identity.runtimeVariant).toBe('cogseed');
expect(identity.legacyRuntimeVariants).toEqual(['mate']);
expect(normalizeRuntimeVariant('mate')).toBe('cogseed');
expect(normalizeRuntimeVariant('cogseed')).toBe('cogseed');
```

- [ ] **Step 2: Run the tests and verify the canonical contract is missing**

```bash
npm run test:js -- test/main/identity-contract.test.ts
```

Expected: FAIL because `identity.json`, the CJS loader, and canonical fields do not exist.

- [ ] **Step 3: Implement the pure CJS contract**

`identity-contract.cjs` must export only JSON-backed constants and pure functions usable by `bootstrap.cjs` before tsx registration:

```js
const IDENTITY = Object.freeze(JSON.parse(fs.readFileSync(IDENTITY_JSON, 'utf8')));
function normalizeRuntimeVariant(value) { /* canonical first, legacy alias second */ }
function normalizeEnv(env) { /* reject conflicting old/new values */ }
function protocolSchemes() { return [IDENTITY.protocolScheme, ...IDENTITY.legacyProtocolSchemes]; }
module.exports = { IDENTITY, normalizeRuntimeVariant, normalizeEnv, protocolSchemes };
```

- [ ] **Step 4: Run identity tests and commit**

```bash
npm run test:js -- test/main/identity-contract.test.ts
 git add src/resources/identity.json src/main/identity-contract.cjs test/main/identity-contract.test.ts src/resources/brand.json test/main/brand.test.ts
 git commit -m "feat: add CogSeed canonical identity contract"
```

## Task 2: Mount pre-tsx migration in the bootstrap chain

**Files:**
- Create: `src/main/cogseed-install-migration.cjs`
- Modify: `bootstrap.cjs`
- Modify: `src/main/install-data-root.cjs`
- Modify: `package.json` build files allowlist
- Create: `test/main/cogseed-install-migration.test.ts`
- Modify: `test/main/util/runtime-launcher.test.ts`

- [ ] **Step 1: Write failing bootstrap/migration mount tests**

Assert package main and call order:

```ts
expect(pkg.main).toBe('bootstrap.cjs');
expect(bootstrap).toContain("require('./src/main/identity-contract.cjs')");
expect(bootstrap).toContain("require('./src/main/cogseed-install-migration.cjs')");
expect(bootstrap.indexOf('cogseed-install-migration')).toBeLessThan(bootstrap.indexOf("require('tsx/cjs')"));
```

- [ ] **Step 2: Implement the CJS migration module**

Expose testable functions:

```js
resolveCanonicalContainer({ platform, home, localAppData, env })
resolveLegacyContainer({ platform, home, localAppData, env })
planMigration({ canonicalRoot, legacyRoot, markerPath })
copyAndVerifyMigration({ sourceRoot, destinationRoot, progress, fsImpl })
writeMigrationMarker({ canonicalRoot, manifest, sourceKind })
```

Rules:

- production root `.orkas` → `.cogseed`;
- packaged-dev/source-dev `.orkas-dev` → `.cogseed-dev`;
- copy/clone preserves source on all platforms;
- canonical temporary directory is sibling of destination;
- verify file count, critical hashes, and secret files before atomic rename;
- if both roots exist without marker, return a conflict error and never merge;
- no TypeScript, feature, model, renderer, or logger imports;
- no raw paths, token values, or filenames in logs.

- [ ] **Step 3: Wire bootstrap normalization before tsx**

`bootstrap.cjs` must:

1. load identity contract;
2. normalize old argv/env names;
3. run migration;
4. set only `COGSEED_*` canonical env for child code;
5. register tsx and load main.

Old variables with conflicting new values must fail with a stable error code.

- [ ] **Step 4: Run migration fixture tests**

```bash
npm run test:js -- test/main/cogseed-install-migration.test.ts test/main/identity-contract.test.ts test/main/util/runtime-launcher.test.ts
```

Expected: all migration cases pass, including interruption/re-entry, both roots, `.orkas-dev`, Windows pin paths, and source retention.

- [ ] **Step 5: Commit the bootstrap migration checkpoint**

```bash
git add bootstrap.cjs src/main/cogseed-install-migration.cjs src/main/install-data-root.cjs package.json test/main/cogseed-install-migration.test.ts test/main/util/runtime-launcher.test.ts
git commit -m "feat: migrate legacy data roots before CogSeed boot"
```

## Task 3: Rename App ID, protocol registration, and deep-link normalization

**Files:**
- Modify: `src/main/brand.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/preload.js` only for sync boot channel aliases
- Modify: connector/OAuth deep-link handlers under `src/main/`
- Modify: `package.json`, `run.sh`, `run.cmd`, `scripts/prepare-source-runtime.cjs`
- Create/modify: `test/main/cogseed-protocol.test.ts`
- Modify: `test/main/util/source-runtime-bundle.test.ts`, `test/scripts/package-dev-mac.test.ts`

- [ ] **Step 1: Write failing identity/protocol tests**

Assert canonical generation and legacy consumption:

```ts
expect(APP_BRAND.appId).toBe('com.cogseed.desktop');
expect(APP_BRAND.protocolScheme).toBe('cogseed');
expect(CONNECTOR_PROTOCOL_SCHEMES).toEqual(['cogseed', 'mateagent', 'orkas']);
expect(normalizeDeepLink('orkas://connectors/oauth/callback').scheme).toBe('cogseed');
expect(normalizeDeepLink('mateagent://connectors/oauth/callback').scheme).toBe('cogseed');
```

- [ ] **Step 2: Implement canonical App ID and protocol identity**

Package/source identities become `com.cogseed.desktop[.source.<variant>]`. Register `cogseed`, `mateagent`, and `orkas` during compatibility. New URL generation uses only `cogseed://`.

- [ ] **Step 3: Verify platform paths**

macOS source bundle must be `CogSeed.app`; Windows/Linux product metadata must use CogSeed. Old bundle names remain only as source migration candidates and wrapper tests.

- [ ] **Step 4: Run protocol tests and commit**

```bash
npm run test:js -- test/main/cogseed-protocol.test.ts test/main/brand.test.ts test/main/util/source-runtime-bundle.test.ts test/scripts/package-dev-mac.test.ts
 git add src/main/brand.ts src/main/index.ts src/main/preload.js package.json run.sh run.cmd scripts/prepare-source-runtime.cjs test/main/cogseed-protocol.test.ts test/main/brand.test.ts test/main/util/source-runtime-bundle.test.ts test/scripts/package-dev-mac.test.ts
 git commit -m "feat: switch packaged identity and protocols to CogSeed"
```

## Task 4: Rename preload bridge and IPC transport with one-version aliasing

**Files:**
- Modify: `src/main/preload.js`
- Modify: `src/main/ipc/index.ts`
- Modify: `src/main/index.ts`
- Create: `src/main/cogseed-transport-compat.ts` or equivalent main-only adapter
- Bulk modify renderer modules from `window.orkas` to `window.cogseed`
- Create: `test/main/cogseed-transport-compat.test.ts`
- Modify: renderer preload/IPC tests

- [ ] **Step 1: Write failing bridge/transport tests**

Assert canonical exposure and legacy forwarding:

```ts
expect(preload).toContain("contextBridge.exposeInMainWorld('cogseed'");
expect(preload).toContain("contextBridge.exposeInMainWorld('orkas'");
expect(preload).toContain("ipcRenderer.invoke('cogseed.invoke'");
expect(compat.invoke('recall.sources.list', payload)).toEqual(canonicalResult);
```

- [ ] **Step 2: Implement canonical preload API**

Expose one frozen API object under `window.cogseed`. Expose a legacy proxy under `window.orkas` that calls the same functions. Add `__cogseedI18nBoot` and a read-only `__orkasI18nBoot` alias.

- [ ] **Step 3: Implement canonical main transport and aliases**

Canonical transport names are `cogseed.invoke`, `cogseed.stream`, `cogseed:bootI18n`, and canonical stream event/cancel channels. Register old transport names only in the compatibility adapter. Keep business channels (`recall.*`, `skills.*`, `contexts.*`) unchanged.

- [ ] **Step 4: Migrate renderer call sites**

Replace renderer runtime references with `window.cogseed`. Add a static test that production renderer modules contain no `window.orkas` outside the explicit compatibility test/adapter allowlist.

- [ ] **Step 5: Run bridge/IPC tests and commit**

```bash
npm run test:js -- test/main/cogseed-transport-compat.test.ts test/renderer/preload-push-allowlist.test.ts test/renderer/ipc-shim-cognition.test.ts test/renderer/ipc-shim.test.ts
 git add src/main/preload.js src/main/ipc/index.ts src/main/index.ts src/main/cogseed-transport-compat.ts src/renderer test/main/cogseed-transport-compat.test.ts test/renderer
 git commit -m "feat: make CogSeed the canonical renderer bridge"
```

## Task 5: Migrate artifact iframe protocol without widening security

**Files:**
- Modify: `src/main/features/chat_artifacts.ts`
- Modify: `src/renderer/modules/artifact-security.js`
- Modify: `src/renderer/modules/chat-artifact.js`
- Modify: `test/main/features/chat_artifacts.test.ts`
- Modify: `test/renderer/artifact-security.test.ts`
- Modify: `test/main/model/core-agent/local-tools.test.ts`
- Modify: `test/main/brand.test.ts`

- [ ] **Step 1: Write failing canonical/legacy artifact tests**

Cover canonical bridge path, metadata, sentinel, globals, and old artifact fixtures. Assert both sentinel variants require identical trusted source/frame validation.

- [ ] **Step 2: Implement canonical artifact protocol**

New artifacts write/serve:

```text
__cogseed/bridge.js
__cogseed-meta.json
__cogseedArtifact
window.cogseedArtifact
CogSeedArtifactSecurity
```

Legacy artifacts continue to read/serve old identifiers through one shared implementation. Reserved-path rejection covers both prefixes. Artifact iframes never receive `window.cogseed` or `window.orkas`.

- [ ] **Step 3: Run artifact security tests**

```bash
npm run test:js -- test/main/features/chat_artifacts.test.ts test/renderer/artifact-security.test.ts test/main/model/core-agent/local-tools.test.ts
```

Expected: old fixtures and new fixtures pass, with no security contract widening.

- [ ] **Step 4: Commit artifact checkpoint**

```bash
git add src/main/features/chat_artifacts.ts src/renderer/modules/artifact-security.js src/renderer/modules/chat-artifact.js test/main/features/chat_artifacts.test.ts test/renderer/artifact-security.test.ts test/main/model/core-agent/local-tools.test.ts test/main/brand.test.ts
git commit -m "feat: migrate artifact protocol to CogSeed with legacy support"
```

## Task 6: Rename local-agent MCP identity and bridge configuration

**Files:**
- Modify: `src/main/features/local_agents/backends/codex.ts`
- Modify: Claude/local-agent bridge config builders and shared `BridgeRunConfig`
- Modify: `bin/orkas-bridge.cjs` → create `bin/cogseed-bridge.cjs` plus wrapper
- Modify: bridge env/config paths and runner wiring
- Modify: local-agent prompts and tests

- [ ] **Step 1: Write failing MCP identity tests**

Assert Codex initialize, MCP config keys, server info, prompt, and bridge env use CogSeed:

```ts
expect(initialize.clientInfo).toMatchObject({ name: 'cogseed', title: 'CogSeed' });
expect(overrides.join('\n')).toContain('mcp_servers.cogseed');
expect(prompt).toContain('runs inside CogSeed');
expect(prompt).not.toContain('runs inside Orkas');
```

- [ ] **Step 2: Implement canonical local-agent identity**

New runs generate `cogseed` MCP names/config keys/env; old wrapper and old env values normalize at the boundary. Do not rename tool business names or persisted task IDs.

- [ ] **Step 3: Run local-agent tests and commit**

```bash
npm run test:js -- test/main/features/local_agents/bridge_args.test.ts test/main/features/local_agents/bridge_e2e.test.ts test/main/features/local_agents/codex-execution-e2e.test.ts
 git add src/main/features/local_agents bin/cogseed-bridge.cjs bin/orkas-bridge.cjs test/main/features/local_agents
 git commit -m "feat: expose CogSeed MCP identity to local agents"
```

## Task 7: Rename runtime/backend modules and worker entrypoints

**Files:**
- Rename: `src/main/features/mate_agent_runtime/` → `src/main/features/cogseed_runtime/`
- Rename: `src/main/features/mate_agent_backend/` → `src/main/features/cogseed_backend/`
- Rename corresponding test directories
- Rename/create: `bin/cogseed-runtime-worker.cjs` plus legacy wrapper
- Rename/create: `scripts/restart-cogseed.sh` plus legacy wrapper
- Modify imports, logger names, prompts, gate allowlists, worker choke points, docs

- [ ] **Step 1: Write failing path/import/static residual tests**

Assert canonical directories and worker paths exist, old names occur only in compatibility wrappers/fixtures, and worker spawn remains at the approved choke point.

- [ ] **Step 2: Perform path-preserving git renames**

Use `git mv` for directories/files. Update imports and package/build allowlists in the same commit. Keep old wrapper files with no business logic.

- [ ] **Step 3: Run runtime/backend tests**

```bash
npm run test:js -- test/main/features/cogseed_runtime test/main/features/cogseed_backend test/main/util/runtime-gate.test.ts test/main/util/bundled-runtime.test.ts test/static/kstar-single-core.test.ts
```

- [ ] **Step 4: Commit runtime checkpoint**

```bash
git add src/main/features bin scripts test/main/features test/main/util test/static
 git commit -m "refactor: rename CogSeed runtime and backend modules"
```

## Task 8: Rename security paths, markers, launchers, instructions, and residual gates

**Files:**
- Modify: `src/main/quality/rules/skill-runner.ts`
- Modify: `src/main/util/file-import.ts`, `src/main/util/bundled-runtime.ts`, runtime fetch/gate scripts
- Rename/update: smoke and restart scripts
- Modify: `AGENTS.md`, `CLAUDE.md`
- Create: `test/main/cogseed-residual-identifiers.test.ts`
- Modify security/runtime/static tests

- [ ] **Step 1: Write failing security marker/residual tests**

Cover both `.cogseed` canonical and `.orkas` legacy protected paths, marker reads/writes, import temp cleanup, `smoke-cogseed-*`, and instruction files.

- [ ] **Step 2: Update security rules and markers**

Canonical writes use `.cogseed-*`; reads/cleanup accept one-version `.orkas-*`. `MARKETPLACE_INSTALL_SCRIPT_RE` must reject direct scripts under both roots.

- [ ] **Step 3: Update AGENTS/CLAUDE hard constraints**

Replace canonical renderer bridge, runtime choke point, restart script, log path, data root, and artifact iframe wording. Explicitly document the legacy alias boundary.

- [ ] **Step 4: Run security and residual tests**

```bash
npm run test:js -- test/main/cogseed-residual-identifiers.test.ts test/main/quality/skill-runner.test.ts test/main/util/file-import.test.ts test/main/util/bundled-runtime.test.ts test/renderer/artifact-security.test.ts
```

- [ ] **Step 5: Commit security/instructions checkpoint**

```bash
git add src/main/quality src/main/util scripts bin AGENTS.md CLAUDE.md test
 git commit -m "security: align CogSeed paths and identity boundaries"
```

## Task 9: Update packaging, docs, and migration telemetry

**Files:**
- Modify: `package.json`, `package-lock.json`, `README.md`, `docs/README.md`
- Modify: `scripts/package-dev-mac.cjs`, `scripts/verify-packaged-dev.cjs`, platform installers
- Modify public locales and user-facing error strings
- Add deprecated alias telemetry with redacted type/count only
- Update packaging and source-runtime tests

- [ ] **Step 1: Write failing packaging/docs tests**

Assert canonical product metadata, bundle names, package files, old wrapper inclusion, migration marker inclusion, and absence of stale public names outside the allowlist.

- [ ] **Step 2: Update package and platform metadata**

Use `com.cogseed.desktop`, CogSeed product names, `cogseed://`, canonical bundle/executable names, and include migration/compatibility assets in packaged files.

- [ ] **Step 3: Run packaging tests**

```bash
npm run test:js -- test/main/brand.test.ts test/main/util/source-runtime-bundle.test.ts test/scripts/package-dev-mac.test.ts test/scripts/verify-packaged-dev.test.ts test/main/util/packaged-resource-gate.test.ts
```

- [ ] **Step 4: Commit packaging checkpoint**

```bash
git add package.json package-lock.json README.md docs scripts test
 git commit -m "build: package CogSeed identity and migration assets"
```

## Task 10: Full verification and platform smoke checks

**Files:**
- Review all changed files; no unreviewed compatibility identifiers remain.

- [ ] **Step 1: Run static checks**

```bash
git diff --check
npm run typecheck
```

- [ ] **Step 2: Run focused migration/identity/security tests**

```bash
npm run test:js -- \
  test/main/identity-contract.test.ts \
  test/main/cogseed-install-migration.test.ts \
  test/main/cogseed-protocol.test.ts \
  test/main/cogseed-transport-compat.test.ts \
  test/main/features/chat_artifacts.test.ts \
  test/renderer/artifact-security.test.ts \
  test/main/features/local_agents/bridge_args.test.ts \
  test/main/features/local_agents/bridge_e2e.test.ts \
  test/main/cogseed-residual-identifiers.test.ts \
  test/main/brand.test.ts
```

- [ ] **Step 3: Run complete tests**

```bash
npm test
```

Expected: zero failed tests; only explicit real external CLI tests may skip.

- [ ] **Step 4: Verify macOS source launch**

From the migration worktree:

```bash
scripts/restart-cogseed.sh
ps -Ao pid,lstart,command | grep -- '--cogseed-runtime-variant=cogseed' | grep -v grep
```

Verify the process path contains `cogseed-full-identity-migration`, the bundle is `CogSeed.app`, the data root is `.cogseed`, and launcher logs contain no new `[Mate Agent]` output.

- [ ] **Step 5: Verify migration fixtures on both platforms**

Run the fixture matrix on macOS in CI/local and Windows in the platform runner. Confirm source `.orkas` remains unchanged after migration and canonical `.cogseed` is authoritative.

- [ ] **Step 6: Commit final verification artifacts**

```bash
git status --short --branch
git diff --check
git log --oneline --decorate -12
```

## Commit order

```text
identity contract
→ bootstrap/data migration
→ app/protocol identity
→ preload/IPC aliases
→ artifact iframe protocol
→ local-agent MCP identity
→ runtime/backend renames
→ security paths/instructions
→ packaging/docs
→ final verification
```
