# Remove Meta Skill Evolution Line B-prime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Remove the Meta Skill Engine / standalone Evolution Console line from the current worktree while preserving a lightweight Skills/Cognition version-history and rollback capability.

**Architecture:** First create an archive worktree that preserves the current `develop` state. In the active worktree, delete the standalone Evolution Console UI, delete `src/main/features/evolution/`, remove the `packages/nseap-meta-skill-engine` workspace and all build/packaging hooks, and make P3394 run without a bundled KSTAR engine by default. Preserve only the user-facing Skills/Cognition version-history and rollback behavior by moving that logic into `src/main/features/skills/` so it no longer depends on Meta Skill Engine or the evolution feature namespace.

**Tech Stack:** Electron main process TypeScript, classic renderer JavaScript, `window.cogseed.invoke`, npm workspaces, Vitest through `npm run test:js` / `npm test`, shell launchers `run.sh` and `run.cmd`.

---

## File structure and responsibilities

### Archive / worktree

- Preserve branch: `dev/archive-meta-skill-evolution-console`
- Preserve worktree path: `/Users/sudai/.config/codex/worktrees/Mate Agent/meta-skill-evolution-preserve`
- Purpose: keeps the full Meta Skill Engine + Evolution Console implementation available for later asset-governance extraction.

### New lightweight skills versioning files

- Create: `src/main/features/skills/version-store.ts`
  - Owns skill version JSON records under `<uid>/local/skills/versions/<skillId>.json`.
  - Reads legacy records from `<uid>/local/kstar/versions/<skillId>.json` for compatibility.
  - Writes new records only to `<uid>/local/skills/versions/`.
- Create: `src/main/features/skills/rollback-service.ts`
  - Writes a historical `SKILL.md` snapshot back through `writeSkillFileForEdit`.
  - Appends rollback provenance through `appendSkillVersion`.

### Cognition integration

- Modify: `src/main/features/cognition/skill-summary.ts`
  - Import from `../skills/version-store` and `../skills/rollback-service` instead of `../evolution/*`.
- Modify tests that assert skill detail version and rollback behavior:
  - `test/renderer/skills-frontmatter.test.ts`
  - Create: `test/main/features/cognition/skill-summary.test.ts` for direct backend summary and rollback assertions.

### Renderer removal

- Delete: `src/renderer/modules/evolution/pages.js`
- Delete: `src/renderer/modules/evolution/console.js`
- Modify: `src/renderer/index.html`
  - Remove `evolution-btn`.
  - Remove `topbar-evolution-toggle`.
  - Remove `panel-evolution` block.
- Modify: `src/renderer/modules/lazy-features.js`
  - Remove the `evolution` lazy bundle entry.
- Modify: `src/renderer/modules/state.js`
  - Remove event handlers for `evolution-btn` and `topbar-evolution-toggle`.
- Modify: `src/renderer/modules/boot.js`
  - Normalize any attempted `setView('evolution')` call to `setView('skills')` before panel selection.
- Modify: `src/renderer/style.css`
  - Remove the `#panel-evolution` scoped CSS block.
- Modify: `src/renderer/locales/en.json`, `src/renderer/locales/zh.json`, `src/renderer/locales/ja.json`, `src/renderer/locales/pt.json`
  - Remove standalone evolution entry strings if they are no longer referenced.

### P3394 renderer helper relocation

- Create: `src/renderer/modules/p3394-observability.js`
  - Move `boundaryLabel`, `renderExecutionObservability`, and `renderValidationRun` from `src/renderer/modules/evolution/pages.js`.
- Modify: `test/renderer/p3394-execution-observability.test.ts`
  - Require the new helper module.

### IPC and shim removal

- Modify: `src/main/ipc/index.ts`
  - Remove `import * as evolution from '../features/evolution';`.
  - Remove all `evolution.*` invoke handlers.
  - Remove `evolution.evals.run` stream handler.
- Modify: `src/renderer/modules/ipc-shim.js`
  - Remove all `/api/evolution/*` route mappings.
- Delete: `test/main/ipc/evolution-ipc.test.ts`
- Delete or rewrite: `test/renderer/ipc-shim-evolution.test.ts`
- Modify: `test/main/ipc/p3394-contract.test.ts`
  - Remove the assertion that `evolution.dashboard` is registered.

### Backend evolution and engine removal

- Delete: `src/main/features/evolution/`
- Delete: `test/main/features/evolution/`
- Delete: `packages/nseap-meta-skill-engine/`
- Delete: engine-specific tests:
  - `test/static/meta-skill-engine-packaging.test.ts`
  - or rewrite it as a negative test that the package is not bundled.

### P3394 bundled engine removal

- Modify: `src/main/paths.ts`
  - Remove `metaSkillEnginePackageDir()`.
- Modify: `src/main/features/p3394/kstar-factory.ts`
  - Stop constructing a default command from `packages/nseap-meta-skill-engine/dist/index.js`.
  - Only create a KSTAR adapter when `COGSEED_KSTAR_ENGINE_COMMAND` and `COGSEED_KSTAR_ENGINE_ARGS` are explicitly configured.
  - Return `null` in degraded mode when external engine configuration is absent.
- Modify: `test/main/features/p3394/kstar-factory.test.ts`
  - Assert that no env configuration returns `null` and logs degraded/unavailable.
  - Keep tests for explicit external engine configuration.

### Package, launcher, packaging, and docs

- Modify: `package.json`
  - Remove `npm run engine:build` from `postinstall`.
  - Remove scripts `engine:build`, `engine:test`, `engine:check`.
  - Remove `extraResources` entry for `packages/nseap-meta-skill-engine`.
  - Remove `workspaces: ["packages/*"]` if `packages/` becomes empty.
- Regenerate: `package-lock.json`
  - Run `npm install --package-lock-only` after package changes.
- Modify: `run.sh` and `run.cmd`
  - Remove auto-build and auto-injection logic for bundled Meta Skill Engine.
  - Preserve support for user-provided `COGSEED_KSTAR_ENGINE_*` env vars by passing them through when present.
- Modify: `bin/packaged-resource-gate.cjs`
  - Remove `packages/nseap-meta-skill-engine` from `EXTRA_RESOURCES_CONTRACT`.
- Modify: `scripts/verify-packaged-dev.cjs`
  - Remove `['packages', 'nseap-meta-skill-engine', 'dist', 'index.js']` from `RESOURCE_REQUIRED`.
- Modify docs:
  - `docs/superpowers/handover-meta-skill-console.md`
  - `docs/README.md`
  - `README-源码包说明.txt`
  - Any plan docs that describe the engine as current built-in behavior should be marked as archived or superseded by this plan.

---

## Task 0: Preserve the current full line in an archive worktree

**Files:** none in active worktree.

- [ ] **Step 0.1: Verify no project-local worktree ignore issue is introduced**

Run:

```bash
git -C "/Users/sudai/Documents/Mate Agent" status --short
git -C "/Users/sudai/Documents/Mate Agent" worktree list --porcelain
```

Expected: current dirty files are visible; do not modify them in this task. The archive worktree will be created outside the repository under `/Users/sudai/.config/codex/worktrees/`.

- [ ] **Step 0.2: Create preserve worktree from current develop commit**

Run:

```bash
git -C "/Users/sudai/Documents/Mate Agent" worktree add \
  "/Users/sudai/.config/codex/worktrees/Mate Agent/meta-skill-evolution-preserve" \
  -b dev/archive-meta-skill-evolution-console develop
```

Expected: worktree is created at `/Users/sudai/.config/codex/worktrees/Mate Agent/meta-skill-evolution-preserve` on branch `dev/archive-meta-skill-evolution-console`.

- [ ] **Step 0.3: Verify preserved files exist**

Run:

```bash
test -d "/Users/sudai/.config/codex/worktrees/Mate Agent/meta-skill-evolution-preserve/packages/nseap-meta-skill-engine"
test -d "/Users/sudai/.config/codex/worktrees/Mate Agent/meta-skill-evolution-preserve/src/main/features/evolution"
test -d "/Users/sudai/.config/codex/worktrees/Mate Agent/meta-skill-evolution-preserve/src/renderer/modules/evolution"
```

Expected: all three commands exit with status `0`.

- [ ] **Step 0.4: Record archive location in current plan execution notes**

Append this exact line to the final implementation summary, not to source code:

```text
Archive worktree preserved at /Users/sudai/.config/codex/worktrees/Mate Agent/meta-skill-evolution-preserve on dev/archive-meta-skill-evolution-console.
```

---

## Task 1: Move lightweight skill version storage out of evolution

**Files:**
- Create: `src/main/features/skills/version-store.ts`
- Test: `test/main/features/skills/version-store.test.ts`

- [ ] **Step 1.1: Write failing version-store tests**

Create `test/main/features/skills/version-store.test.ts` with tests that cover:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

let root = '';

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-version-store-'));
  process.env.COGSEED_WORKSPACE_ROOT = root;
});

afterEach(async () => {
  delete process.env.COGSEED_WORKSPACE_ROOT;
  await fs.rm(root, { recursive: true, force: true });
});

describe('skills version-store', () => {
  it('writes new records under local/skills/versions and marks content snapshots rollbackable', async () => {
    const mod = await import('../../../../src/main/features/skills/version-store');
    const list = await mod.appendSkillVersion('u1', 'skill-a', { version: '0.2.0', note: 'apply', runId: 'run-1', content: 'body' });
    expect(list[0]).toMatchObject({ version: '0.2.0', note: 'apply', runId: 'run-1', content: 'body', canRollback: true });
    const stored = JSON.parse(await fs.readFile(path.join(root, 'u1', 'local', 'skills', 'versions', 'skill-a.json'), 'utf8'));
    expect(stored[0].version).toBe('0.2.0');
  });

  it('reads legacy local/kstar/versions records when no new store exists', async () => {
    const legacy = path.join(root, 'u1', 'local', 'kstar', 'versions');
    await fs.mkdir(legacy, { recursive: true });
    await fs.writeFile(path.join(legacy, 'skill-a.json'), JSON.stringify([{ version: '0.1.0', at: '2026-01-01T00:00:00.000Z' }]), 'utf8');
    const mod = await import('../../../../src/main/features/skills/version-store');
    const list = await mod.listSkillVersions('u1', 'skill-a');
    expect(list).toEqual([{ version: '0.1.0', at: '2026-01-01T00:00:00.000Z', canRollback: false }]);
  });
});
```

- [ ] **Step 1.2: Run failing test**

Run:

```bash
npm run test:js -- test/main/features/skills/version-store.test.ts
```

Expected: fails because `src/main/features/skills/version-store.ts` does not exist.

- [ ] **Step 1.3: Create implementation**

Create `src/main/features/skills/version-store.ts` by copying the behavior from the old evolution version store, with these path functions:

```ts
function versionsDir(uid: string): string {
  return path.join(workspaceRoot(), uid, 'local', 'skills', 'versions');
}
function legacyVersionsDir(uid: string): string {
  return path.join(workspaceRoot(), uid, 'local', 'kstar', 'versions');
}
```

`listSkillVersions(uid, skillId)` must:

1. Try `<uid>/local/skills/versions/<skillId>.json` first.
2. If missing or empty, try `<uid>/local/kstar/versions/<skillId>.json`.
3. Normalize records without `content` to `canRollback: false`.
4. Normalize records with string `content` to `canRollback: true`.

`appendSkillVersion(uid, skillId, entry)` must:

1. Read existing list through `listSkillVersions`.
2. Unshift the new record.
3. Write only to `<uid>/local/skills/versions/<skillId>.json`.

- [ ] **Step 1.4: Run test**

Run:

```bash
npm run test:js -- test/main/features/skills/version-store.test.ts
```

Expected: passes.

---

## Task 2: Move skill rollback out of evolution

**Files:**
- Create: `src/main/features/skills/rollback-service.ts`
- Test: `test/main/features/skills/rollback-service.test.ts`

- [ ] **Step 2.1: Write failing rollback tests**

Create `test/main/features/skills/rollback-service.test.ts` with tests for success and missing snapshot:

```ts
import { describe, expect, it, vi } from 'vitest';

describe('skills rollback-service', () => {
  it('writes a rollbackable version snapshot and appends provenance', async () => {
    const mod = await import('../../../../src/main/features/skills/rollback-service');
    const writeFn = vi.fn(async () => true);
    const appendVersionFn = vi.fn(async () => []);
    const listVersionsFn = vi.fn(async () => [{ version: '0.1.0', at: '2026-01-01T00:00:00.000Z', content: 'old skill', canRollback: true }]);
    const result = await mod.rollbackSkillToVersion('u1', { skillId: 'skill-a', version: '0.1.0', writeFn, appendVersionFn, listVersionsFn });
    expect(result).toEqual({ ok: true, skillId: 'skill-a', version: '0.1.0' });
    expect(writeFn).toHaveBeenCalledWith('skill-a', 'SKILL.md', 'old skill');
    expect(appendVersionFn).toHaveBeenCalledWith('u1', 'skill-a', expect.objectContaining({ version: '0.1.0', note: 'Rollback to 0.1.0', content: 'old skill' }));
  });

  it('rejects rollback when the target record has no content snapshot', async () => {
    const mod = await import('../../../../src/main/features/skills/rollback-service');
    await expect(mod.rollbackSkillToVersion('u1', {
      skillId: 'skill-a',
      version: '0.1.0',
      writeFn: vi.fn(async () => true),
      appendVersionFn: vi.fn(async () => []),
      listVersionsFn: vi.fn(async () => [{ version: '0.1.0', at: '2026-01-01T00:00:00.000Z', canRollback: false }]),
    })).rejects.toThrow('skill version is not rollbackable');
  });
});
```

- [ ] **Step 2.2: Run failing test**

Run:

```bash
npm run test:js -- test/main/features/skills/rollback-service.test.ts
```

Expected: fails because the service does not exist.

- [ ] **Step 2.3: Create implementation**

Create `src/main/features/skills/rollback-service.ts` with the rollback logic from old `src/main/features/evolution/patch-service.ts`, importing:

```ts
import { writeSkillFileForEdit } from '../skills';
import { appendSkillVersion, listSkillVersions } from './version-store';
```

Do not copy `applyPatchToSkill`, `bumpSemver`, or P3394 validation into this file. This service is rollback-only.

- [ ] **Step 2.4: Run test**

Run:

```bash
npm run test:js -- test/main/features/skills/rollback-service.test.ts
```

Expected: passes.

---

## Task 3: Repoint Cognition skill summary to the lightweight skills services

**Files:**
- Modify: `src/main/features/cognition/skill-summary.ts`
- Test: `test/main/features/skills/version-store.test.ts`
- Test: `test/main/features/skills/rollback-service.test.ts`
- Test: `test/renderer/skills-frontmatter.test.ts`

- [ ] **Step 3.1: Update imports**

In `src/main/features/cognition/skill-summary.ts`, replace:

```ts
import { listSkillVersions } from '../evolution/versions-store';
import { rollbackSkillToVersion } from '../evolution/patch-service';
```

with:

```ts
import { listSkillVersions } from '../skills/version-store';
import { rollbackSkillToVersion } from '../skills/rollback-service';
```

- [ ] **Step 3.2: Run focused tests**

Run:

```bash
npm run test:js -- test/main/features/skills/version-store.test.ts test/main/features/skills/rollback-service.test.ts test/renderer/skills-frontmatter.test.ts
```

Expected: passes; skill detail version history and rollback still work through `cognition.skills.summary` and `cognition.skills.rollback`.

---

## Task 4: Move P3394 observability renderer helpers out of evolution pages

**Files:**
- Create: `src/renderer/modules/p3394-observability.js`
- Modify: `test/renderer/p3394-execution-observability.test.ts`

- [ ] **Step 4.1: Create focused helper module**

Copy the implementations of `escapeHtml`, `boundaryLabel`, `renderExecutionObservability`, and `renderValidationRun` from `src/renderer/modules/evolution/pages.js` into `src/renderer/modules/p3394-observability.js`.

At the end of the file, expose CommonJS exports for tests:

```js
if (typeof module !== 'undefined') {
  module.exports = { escapeHtml, boundaryLabel, renderExecutionObservability, renderValidationRun };
}
```

- [ ] **Step 4.2: Update test import**

In `test/renderer/p3394-execution-observability.test.ts`, replace:

```js
const P = require('../../src/renderer/modules/evolution/pages.js');
```

with:

```js
const P = require('../../src/renderer/modules/p3394-observability.js');
```

- [ ] **Step 4.3: Run test**

Run:

```bash
npm run test:js -- test/renderer/p3394-execution-observability.test.ts
```

Expected: passes.

---

## Task 5: Remove standalone Evolution Console renderer surface

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/modules/lazy-features.js`
- Modify: `src/renderer/modules/state.js`
- Modify: `src/renderer/modules/boot.js`
- Modify: `src/renderer/style.css`
- Delete: `src/renderer/modules/evolution/pages.js`
- Delete: `src/renderer/modules/evolution/console.js`
- Modify tests:
  - `test/renderer/boot-evolution.test.ts`
  - `test/renderer/topbar-evolution.test.ts`
  - `test/renderer/lazy-features-evolution.test.ts`

- [ ] **Step 5.1: Update renderer tests to assert removal**

Modify the three evolution renderer tests so they assert:

```ts
expect(html).not.toContain('id="panel-evolution"');
expect(html).not.toContain('id="evolution-btn"');
expect(html).not.toContain('id="topbar-evolution-toggle"');
expect(src).not.toContain('evolution/pages.js');
expect(src).not.toContain('evolution/console.js');
```

For boot behavior, assert legacy `evolution` maps to `skills`.

- [ ] **Step 5.2: Remove markup**

In `src/renderer/index.html`, delete exactly these UI surfaces:

- `<button class="sidebar-btn" id="evolution-btn" ...>` block.
- `<button ... id="topbar-evolution-toggle" ...>` block.
- The `<!-- Evolution Console -->` section containing `id="panel-evolution"`.

- [ ] **Step 5.3: Remove lazy registration**

In `src/renderer/modules/lazy-features.js`, remove:

```js
evolution: [
  { src: './modules/evolution/pages.js' },
  { src: './modules/evolution/console.js' },
],
```

- [ ] **Step 5.4: Remove navigation bindings**

In `src/renderer/modules/state.js`, delete the two event listener lines for `evolution-btn` and `topbar-evolution-toggle`.

- [ ] **Step 5.5: Add legacy view fallback**

In `src/renderer/modules/boot.js`, add this as the first statement inside `setView(view, cid, opts = {})`:

```js
  if (view === 'evolution') view = 'skills';
```

Also remove the `: view === 'evolution' ? 'panel-evolution'` branches from `_lazyFeaturePanel(view)` and from the `panelId` expression inside `setView`.

- [ ] **Step 5.6: Remove scoped CSS block**

In `src/renderer/style.css`, delete the block starting with:

```css
/* ── Evolution Console (进化控制台)
```

through the last selector scoped to `#panel-evolution`.

- [ ] **Step 5.7: Delete renderer evolution module files**

Run:

```bash
rm -rf src/renderer/modules/evolution
```

- [ ] **Step 5.8: Run renderer tests**

Run:

```bash
npm run test:js -- test/renderer/boot-evolution.test.ts test/renderer/topbar-evolution.test.ts test/renderer/lazy-features-evolution.test.ts test/renderer/p3394-execution-observability.test.ts
```

Expected: passes.

---

## Task 6: Remove evolution IPC and API shim

**Files:**
- Modify: `src/main/ipc/index.ts`
- Modify: `src/renderer/modules/ipc-shim.js`
- Delete: `test/main/ipc/evolution-ipc.test.ts`
- Delete or rewrite: `test/renderer/ipc-shim-evolution.test.ts`
- Modify: `test/main/ipc/p3394-contract.test.ts`

- [ ] **Step 6.1: Update p3394 contract test**

In `test/main/ipc/p3394-contract.test.ts`, delete the test named:

```ts
it('evolution 通道也已注册且与 p3394 无碰撞', ...)
```

Keep the test that checks P3394 channels are registered.

- [ ] **Step 6.2: Remove evolution import and handlers**

In `src/main/ipc/index.ts`:

1. Delete:

```ts
import * as evolution from '../features/evolution';
```

2. Delete all invoke handler entries whose key starts with `evolution.`.
3. Delete the stream handler entry whose key is `evolution.evals.run`.

- [ ] **Step 6.3: Remove shim routes**

In `src/renderer/modules/ipc-shim.js`, delete every route whose path contains `/api/evolution/`.

- [ ] **Step 6.4: Remove evolution IPC tests**

Run:

```bash
rm -f test/main/ipc/evolution-ipc.test.ts test/renderer/ipc-shim-evolution.test.ts
```

- [ ] **Step 6.5: Run IPC and shim tests**

Run:

```bash
npm run test:js -- test/main/ipc/p3394-contract.test.ts test/renderer/skills-frontmatter.test.ts
```

Expected: passes; no test asserts that `evolution.*` channels exist.

---

## Task 7: Remove main evolution feature and tests

**Files:**
- Delete: `src/main/features/evolution/`
- Delete: `test/main/features/evolution/`

- [ ] **Step 7.1: Delete feature and tests**

Run:

```bash
rm -rf src/main/features/evolution test/main/features/evolution
```

- [ ] **Step 7.2: Verify no source import remains**

Run:

```bash
git grep -n "features/evolution\|../evolution\|./evolution" -- src test ':!docs/superpowers/plans/2026-08-10-remove-meta-skill-evolution-line-b-prime.md'
```

Expected: no matches.

- [ ] **Step 7.3: Run TypeScript compile check**

Run:

```bash
npx tsc --noEmit
```

Expected: no missing module errors for `features/evolution`.

---

## Task 8: Remove bundled Meta Skill Engine from package, launchers, and P3394 defaults

**Files:**
- Delete: `packages/nseap-meta-skill-engine/`
- Modify: `package.json`
- Regenerate: `package-lock.json`
- Modify: `run.sh`
- Modify: `run.cmd`
- Modify: `src/main/paths.ts`
- Modify: `src/main/features/p3394/kstar-factory.ts`
- Modify: `test/main/features/p3394/kstar-factory.test.ts`

- [ ] **Step 8.1: Update kstar-factory tests for explicit external configuration**

In `test/main/features/p3394/kstar-factory.test.ts`, change the default-config test so no env vars means `getKstarAdapter('default-user')` returns `null` and does not create `McpConnection`.

Add or keep a test with explicit env:

```ts
process.env.COGSEED_KSTAR_ENGINE_COMMAND = 'node';
process.env.COGSEED_KSTAR_ENGINE_ARGS = JSON.stringify(['/opt/kstar/dist/index.js', '--stdio']);
process.env.COGSEED_KSTAR_ENGINE_CWD = '/opt/kstar';
process.env.COGSEED_KSTAR_ENGINE_ONTOLOGY_DIR = '/opt/kstar/ontologies';
```

Expected adapter config for the explicit-env test:

```ts
expect(McpConnection).toHaveBeenCalledWith('p3394-engine-default-user', expect.objectContaining({
  kind: 'stdio',
  command: 'node',
  args: ['/opt/kstar/dist/index.js', '--stdio'],
  cwd: '/opt/kstar',
  env: { NSEAP_ONTOLOGY_DIR: '/opt/kstar/ontologies' },
}));
```

- [ ] **Step 8.2: Modify `kstar-factory.ts` default behavior**

In `src/main/features/p3394/kstar-factory.ts`:

1. Remove import of `metaSkillEnginePackageDir` and `path` if it is only used for the bundled engine.
2. Replace `defaultEngineConfig()` with a function that returns `null` unless both env vars are present:

```ts
function configuredEngineConfig(): Pick<CreateKstarAdapterOptions, 'engineCommand' | 'engineArgs' | 'engineCwd' | 'engineEnv'> | null {
  const command = process.env.COGSEED_KSTAR_ENGINE_COMMAND;
  const argsRaw = process.env.COGSEED_KSTAR_ENGINE_ARGS;
  if (!command || !argsRaw) return null;
  return {
    engineCommand: command,
    engineArgs: JSON.parse(argsRaw),
    engineCwd: process.env.COGSEED_KSTAR_ENGINE_CWD,
    engineEnv: process.env.COGSEED_KSTAR_ENGINE_ONTOLOGY_DIR
      ? { NSEAP_ONTOLOGY_DIR: process.env.COGSEED_KSTAR_ENGINE_ONTOLOGY_DIR }
      : undefined,
  };
}
```

3. In `getKstarAdapter`, before `createKstarAdapter`, call `configuredEngineConfig()` and return `null` with `log.warn('kstar engine not configured', { userId })` when it is absent.

- [ ] **Step 8.3: Remove `metaSkillEnginePackageDir`**

In `src/main/paths.ts`, delete the `metaSkillEnginePackageDir()` function and its comment block.

- [ ] **Step 8.4: Remove launcher auto-build and bundled-engine injection**

In `run.sh`, delete the block that starts with:

```sh
# Build meta-skill engine if present.
```

and ends before:

```sh
cd "$APP_DIR"
```

Then change the macOS `ARGS` construction so it passes KSTAR args only when `COGSEED_KSTAR_ENGINE_COMMAND` is already set by the environment.

In `run.cmd`, delete the block that sets `KSTAR_ENGINE_DIR`, `KSTAR_ENGINE_ENTRY`, and default `COGSEED_KSTAR_ENGINE_*` values from `packages\nseap-meta-skill-engine`.

- [ ] **Step 8.5: Remove package scripts and resources**

In `package.json`:

1. Remove `&& npm run engine:build` from `postinstall`.
2. Delete script keys `engine:build`, `engine:test`, `engine:check`.
3. Delete the `extraResources` object whose `from` is `packages/nseap-meta-skill-engine`.
4. If `packages/` is empty after deletion, delete the root `workspaces` field.

- [ ] **Step 8.6: Delete package and regenerate lockfile**

Run:

```bash
rm -rf packages/nseap-meta-skill-engine
npm install --package-lock-only
```

Expected: `package-lock.json` no longer contains `nseap-meta-skill-engine`.

- [ ] **Step 8.7: Run focused P3394 factory tests**

Run:

```bash
npm run test:js -- test/main/features/p3394/kstar-factory.test.ts
```

Expected: passes with no bundled engine assumptions.

---

## Task 9: Remove packaging resource contracts for Meta Skill Engine

**Files:**
- Modify: `bin/packaged-resource-gate.cjs`
- Modify: `scripts/verify-packaged-dev.cjs`
- Modify tests:
  - `test/main/util/packaged-resource-gate.test.ts`
  - `test/scripts/verify-packaged-dev.test.ts`
- Delete or rewrite: `test/static/meta-skill-engine-packaging.test.ts`

- [ ] **Step 9.1: Remove extra resource contract**

In `bin/packaged-resource-gate.cjs`, remove this entry from `EXTRA_RESOURCES_CONTRACT`:

```js
'packages/nseap-meta-skill-engine': 'meta-skill-engine-package-contract',
```

- [ ] **Step 9.2: Remove packaged-dev required resource**

In `scripts/verify-packaged-dev.cjs`, remove this item from `RESOURCE_REQUIRED`:

```js
['packages', 'nseap-meta-skill-engine', 'dist', 'index.js'],
```

- [ ] **Step 9.3: Remove or rewrite packaging tests**

If `test/static/meta-skill-engine-packaging.test.ts` only asserts the engine is bundled, delete it:

```bash
rm -f test/static/meta-skill-engine-packaging.test.ts
```

Update resource-gate and verify-packaged-dev tests so their expected resource lists no longer include `packages/nseap-meta-skill-engine`.

- [ ] **Step 9.4: Run packaging tests**

Run:

```bash
npm run test:js -- test/main/util/packaged-resource-gate.test.ts test/scripts/verify-packaged-dev.test.ts
```

Expected: passes.

---

## Task 10: Update docs to mark the line archived outside the active worktree

**Files:**
- Modify: `docs/superpowers/handover-meta-skill-console.md`
- Modify: `docs/README.md`
- Modify: `README-源码包说明.txt`
- Modify: `docs/superpowers/plans/2026-08-04-recall-cognition-asset-center.md`
- Modify: `docs/superpowers/plans/2026-08-05-recall-core-migration.md`

- [ ] **Step 10.1: Update handover doc header**

At the top of `docs/superpowers/handover-meta-skill-console.md`, add:

```md
> Archived from active worktree on 2026-08-10. The full implementation is preserved on branch `dev/archive-meta-skill-evolution-console` at `/Users/sudai/.config/codex/worktrees/Mate Agent/meta-skill-evolution-preserve`. The active worktree no longer carries the bundled Meta Skill Engine or standalone Evolution Console.
```

- [ ] **Step 10.2: Remove current-engine claims from docs README**

In `docs/README.md`, replace claims that `packages/nseap-meta-skill-engine/` is the current unique KSTAR core with text saying:

```md
The previous repository-owned Meta Skill Engine line was archived out of the active worktree on 2026-08-10. P3394 now runs without a bundled KSTAR engine by default; an external engine may be configured with `COGSEED_KSTAR_ENGINE_COMMAND` and `COGSEED_KSTAR_ENGINE_ARGS`.
```

- [ ] **Step 10.3: Update source package note**

In `README-源码包说明.txt`, remove the bullet that says the source package includes `packages/nseap-meta-skill-engine`.

- [ ] **Step 10.4: Update Recall/Cognition plans**

In both plan files, replace “retain evolution backend” with:

```md
The old evolution backend was archived with the Meta Skill Engine line. Skills/Cognition retains lightweight skill version history and rollback through `src/main/features/skills/version-store.ts` and `src/main/features/skills/rollback-service.ts`.
```

- [ ] **Step 10.5: Run doc grep**

Run:

```bash
git grep -n "packages/nseap-meta-skill-engine\|src/main/features/evolution\|Evolution Console\|进化控制台" -- docs README-源码包说明.txt
```

Expected: remaining matches are explicitly archival, not current active-worktree instructions.

---

## Task 11: Final repository-wide cleanup and verification

**Files:** all modified files.

- [ ] **Step 11.1: Verify no active references remain**

Run:

```bash
git grep -n "nseap-meta-skill-engine\|engine:build\|engine:test\|engine:check\|src/main/features/evolution\|modules/evolution\|/api/evolution\|evolution\.dashboard\|panel-evolution\|evolution-btn\|topbar-evolution-toggle" -- ':!docs/superpowers/handover-meta-skill-console.md' ':!docs/superpowers/plans/2026-08-10-remove-meta-skill-evolution-line-b-prime.md'
```

Expected: no active-code matches. Archival docs may mention the removed line only as archived history.

- [ ] **Step 11.2: Check package lock no longer has workspace package**

Run:

```bash
node -e "const p=require('./package-lock.json'); const hits=Object.keys(p.packages||{}).filter(k=>k.includes('nseap-meta-skill-engine')); if(hits.length){console.error(hits); process.exit(1)}"
```

Expected: exits `0`.

- [ ] **Step 11.3: Run diff whitespace check**

Run:

```bash
git diff --check
```

Expected: no whitespace errors.

- [ ] **Step 11.4: Run TypeScript check**

Run:

```bash
npx tsc --noEmit
```

Expected: no TypeScript errors.

- [ ] **Step 11.5: Run focused tests**

Run:

```bash
npm run test:js -- \
  test/main/features/skills/version-store.test.ts \
  test/main/features/skills/rollback-service.test.ts \
  test/main/features/p3394/kstar-factory.test.ts \
  test/main/ipc/p3394-contract.test.ts \
  test/main/util/packaged-resource-gate.test.ts \
  test/scripts/verify-packaged-dev.test.ts \
  test/renderer/boot-evolution.test.ts \
  test/renderer/topbar-evolution.test.ts \
  test/renderer/lazy-features-evolution.test.ts \
  test/renderer/p3394-execution-observability.test.ts \
  test/renderer/skills-frontmatter.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 11.6: Run full tests**

Run:

```bash
npm test
```

Expected: all tests pass. If sqlite ABI fails, run `npm run rebuild:sqlite:electron` and rerun `npm test`.

- [ ] **Step 11.7: Restart app for real-environment verification**

Run:

```bash
scripts/restart-cogseed.sh
```

Expected: command exits successfully and starts the `messaging` runtime in the background.

- [ ] **Step 11.8: Confirm startup logs**

Run:

```bash
TODAY="$(date +%Y-%m-%d)"
tail -n 120 "$HOME/.cogseed/runtime-variants/messaging/data/logs/$TODAY.log"
tail -n 120 /tmp/cogseed-agent-messaging-run.log
```

Expected:

- App reaches ready state.
- Logs do not contain missing module errors for `features/evolution`.
- Logs do not contain `nseap-meta-skill-engine` build attempts.
- P3394 without external engine logs a degraded/unconfigured state only when the KSTAR adapter is requested.

---

## Self-review

- Spec coverage: This plan preserves the full line in a separate worktree, removes the active-worktree Evolution Console, removes Meta Skill Engine workspace/build/packaging hooks, preserves lightweight skill version/rollback through Skills/Cognition, and updates tests/docs.
- Placeholder scan: The plan avoids placeholder tasks and names exact files, functions, commands, and expected results.
- Type consistency: New services expose `listSkillVersions`, `appendSkillVersion`, and `rollbackSkillToVersion`, matching the existing Cognition call sites.
- Risk callout: Task 8 intentionally changes P3394 from bundled-engine default to explicit external engine configuration. This is the core product behavior change in B-prime and must be reviewed before execution.
