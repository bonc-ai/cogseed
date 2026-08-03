# Local Development Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpower-subagents (recommended) or $superpower-executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking via update_plan.

**Goal:** Make the current local Mate Agent branch reproducibly testable, identifiable at runtime, diagnosable across worktrees, and packageable as an isolated macOS development app, while generating non-mutating teammate branch audits.

**Architecture:** Keep every new command dependency-free and split pure parsing/resolution logic from CLI entrypoints so Vitest can exercise it. Source identity enters via launch environment; packaged identity is generated before pack and consumed without runtime Git. Git/worktree and branch tools are read-only reporters. Development packaging derives a temporary Electron Builder config and never overwrites the installed app.

**Tech Stack:** Node.js ESM/CJS scripts, Electron main/Renderer IPC, vanilla Renderer JavaScript, Vitest, electron-builder, Git CLI.

---

### Task 1: Pytest-capable Python resolution

**Files:**
- Create: `scripts/python-test-runtime.mjs`
- Create: `scripts/setup-python-test-env.mjs`
- Modify: `scripts/run-python-tests.mjs`
- Modify: `package.json`
- Create: `test/scripts/python-test-runtime.test.ts`

- [ ] **Step 1: Write failing resolver tests**

Cover candidate order, duplicate removal, Windows venv path, executable-without-pytest rejection, explicit override precedence, and selected evidence shape. Inject `exists` and `probe` callbacks so tests never spawn real interpreters.

- [ ] **Step 2: Run RED**

```bash
npm run test:js -- test/scripts/python-test-runtime.test.ts
```

Expected: FAIL because `scripts/python-test-runtime.mjs` does not exist.

- [ ] **Step 3: Implement pure resolver and CLI integration**

Export:

```js
buildPythonCandidates({ appRoot, platform, arch, env })
resolvePytestPython({ candidates, exists, probe })
formatPythonResolutionFailure(result, { appRoot, platform })
```

Probe each candidate with `--version` and `-m pytest --version`. Update `run-python-tests.mjs` to select only a pytest-capable runtime.

- [ ] **Step 4: Add explicit setup command**

`setup-python-test-env.mjs` creates `<repo>/venv`, then installs `pytest` and `requests` using that venv. It prints the interpreter and target directory before installation. Add:

```json
"test:resources:setup": "node scripts/setup-python-test-env.mjs"
```

- [ ] **Step 5: Run GREEN and real setup**

```bash
npm run test:js -- test/scripts/python-test-runtime.test.ts
npm run test:resources:setup
npm run test:resources
```

Expected: resolver tests pass; repository venv exists; 308 resource tests pass without `ORKAS_TEST_PYTHON`.

- [ ] **Step 6: Commit**

```bash
git add scripts/python-test-runtime.mjs scripts/setup-python-test-env.mjs scripts/run-python-tests.mjs package.json test/scripts/python-test-runtime.test.ts
git commit -m "fix(test): resolve a pytest-capable Python runtime"
```

---

### Task 2: Source and packaged build identity

**Files:**
- Create: `src/main/util/build-identity.ts`
- Create: `scripts/write-build-info.cjs`
- Modify: `.gitignore`
- Modify: `bootstrap.cjs`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/modules/boot.js`
- Modify: `src/renderer/locales/en.json`
- Modify: `src/renderer/locales/zh.json`
- Modify: `src/renderer/locales/ja.json`
- Modify: `src/renderer/locales/pt.json`
- Modify: `run.sh`
- Modify: `run.cmd`
- Modify: `package.json`
- Create: `test/main/util/build-identity.test.ts`
- Create: `test/renderer/build-identity.test.ts`

- [ ] **Step 1: Write failing identity tests**

Test environment precedence, packaged JSON fallback, malformed JSON fallback, `packaged-dev` isolation metadata, and Renderer label formats:

```text
v2026.7.21 · dev · 242541b
v2026.7.21 · dev · 242541b-dirty
v2026.7.21
```

- [ ] **Step 2: Run RED**

```bash
npm run test:js -- test/main/util/build-identity.test.ts test/renderer/build-identity.test.ts
```

- [ ] **Step 3: Implement identity utility**

`build-identity.ts` returns normalized channel/commit/dirty/builtAt from environment first, then optional `.build/build-info.json`, then unknown defaults. It never invokes Git.

- [ ] **Step 4: Generate build info**

`write-build-info.cjs` invokes Git at build time, writes `.build/build-info.json`, and supports `--channel`. Ignore `/.build` and `/dist-dev` in `.gitignore`. Include `.build/build-info.json` in Electron Builder files.

- [ ] **Step 5: Wire source launch identity**

`run.sh` and `run.cmd` set `ORKAS_BUILD_*` values before Electron starts. Dev startup remains non-fatal if Git is unavailable.

- [ ] **Step 6: Wire packaged-dev early isolation**

Electron Builder `extraMetadata` contains `orkasBuildChannel`. `bootstrap.cjs` reads package metadata before loading `src/main`; for `packaged-dev` it defaults `ORKAS_WORKSPACE_ROOT` to `<home>/.orkas-dev/data`.

- [ ] **Step 7: Extend IPC and Renderer label**

Extend `orkas.env`; update `_stampSettingsVersion` and formatting helpers; add localized build tooltip labels.

- [ ] **Step 8: Run GREEN**

```bash
npm run test:js -- test/main/util/build-identity.test.ts test/renderer/build-identity.test.ts
npm run typecheck
git diff --check
```

- [ ] **Step 9: Commit**

```bash
git add .gitignore bootstrap.cjs package.json run.sh run.cmd scripts/write-build-info.cjs src/main/index.ts src/main/util/build-identity.ts src/renderer/modules/boot.js src/renderer/locales test/main/util/build-identity.test.ts test/renderer/build-identity.test.ts
git commit -m "feat(dev): expose deterministic build identity"
```

---

### Task 3: Read-only local workspace audit

**Files:**
- Create: `scripts/audit-local-workspace.mjs`
- Modify: `package.json`
- Create: `test/scripts/audit-local-workspace.test.ts`

- [ ] **Step 1: Write failing parser/report tests**

Fixture-test porcelain worktree parsing, `branch -vv` gone-upstream detection, stash parsing, duplicate tip detection, JSON schema, and forbidden mutating command absence.

- [ ] **Step 2: Run RED**

```bash
npm run test:js -- test/scripts/audit-local-workspace.test.ts
```

- [ ] **Step 3: Implement read-only audit**

Use only read commands:

```text
git rev-parse
git worktree list --porcelain
git status --porcelain=v1 --branch
git for-each-ref
git rev-list --left-right --count
git stash list
git stash show --stat
```

Support human output and `--json`.

- [ ] **Step 4: Add npm script and verify real repository**

```json
"audit:workspace": "node scripts/audit-local-workspace.mjs"
```

```bash
npm run audit:workspace
npm run audit:workspace -- --json
```

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/audit-local-workspace.mjs test/scripts/audit-local-workspace.test.ts
git commit -m "feat(dev): add read-only workspace audit"
```

---

### Task 4: Isolated macOS development package and verifier

**Files:**
- Create: `scripts/package-dev-mac.cjs`
- Create: `scripts/verify-packaged-dev.cjs`
- Modify: `package.json`
- Create: `test/scripts/package-dev-mac.test.ts`
- Create: `test/scripts/verify-packaged-dev.test.ts`

- [ ] **Step 1: Write failing config/verifier tests**

Test derived config values, production protocol removal, app id/product name/output override, build-info inclusion, expected app path, required runtime file list, and fake-bundle verification failures.

- [ ] **Step 2: Run RED**

```bash
npm run test:js -- test/scripts/package-dev-mac.test.ts test/scripts/verify-packaged-dev.test.ts
```

- [ ] **Step 3: Implement packaging config generator**

Export a pure `createDevBuilderConfig(baseConfig, identity)` and a CLI that:

1. runs `write-build-info.cjs --channel packaged-dev`;
2. writes temporary config under `.build/`;
3. executes local electron-builder for `--mac dir --arm64`;
4. outputs to `dist-dev`;
5. does not install or overwrite `/Applications/Mate Agent.app`.

- [ ] **Step 4: Implement verifier**

Verify bundle/app.asar/build identity/provider/P3394/builtin/runtime/OfficeCLI/engine resources. Launch with `ORKAS_PACKAGED_LAUNCH_SMOKE_FILE` and an isolated temp workspace, then verify the ready marker and identity.

- [ ] **Step 5: Add scripts**

```json
"package:dev:mac": "node scripts/package-dev-mac.cjs",
"verify:package:dev:mac": "node scripts/verify-packaged-dev.cjs"
```

- [ ] **Step 6: Run focused tests and real package**

```bash
npm run test:js -- test/scripts/package-dev-mac.test.ts test/scripts/verify-packaged-dev.test.ts
npm run package:dev:mac
npm run verify:package:dev:mac
```

Expected: `dist-dev/mac-arm64/Mate Agent Dev.app` exists and packaged smoke succeeds without modifying `/Applications/Mate Agent.app`.

- [ ] **Step 7: Commit**

```bash
git add package.json scripts/package-dev-mac.cjs scripts/verify-packaged-dev.cjs test/scripts/package-dev-mac.test.ts test/scripts/verify-packaged-dev.test.ts
git commit -m "feat(dev): package and verify an isolated mac app"
```

---

### Task 5: Teammate branch semantic audit

**Files:**
- Create: `scripts/audit-branch-diff.mjs`
- Modify: `package.json`
- Create: `test/scripts/audit-branch-diff.test.ts`

- [ ] **Step 1: Write failing classification tests**

Test merge-base parsing, unique commits, path overlap, exact blob equality, duplicate/parallel/independent classifications, and JSON report shape.

- [ ] **Step 2: Run RED**

```bash
npm run test:js -- test/scripts/audit-branch-diff.test.ts
```

- [ ] **Step 3: Implement branch auditor**

Read-only Git operations only. Write reports to `.build/audits/<sanitized-ref>.json` and print a concise summary. Never merge/cherry-pick/reset/push.

- [ ] **Step 4: Run real audits**

```bash
npm run audit:branch -- origin/dev/wujiayu
npm run audit:branch -- origin/dev/niubaokang
```

Expected: reports identify provider path overlap, Wujiayu's unique governance commit, and Niubaokang's independent reimbursement feature.

- [ ] **Step 5: Commit**

```bash
git add package.json scripts/audit-branch-diff.mjs test/scripts/audit-branch-diff.test.ts
git commit -m "feat(dev): add semantic branch audit"
```

---

### Task 6: Full verification and closeout evidence

**Files:**
- No production files unless verification exposes a defect.

- [ ] **Step 1: Run all focused script/identity tests**

```bash
npm run test:js -- \
  test/scripts/python-test-runtime.test.ts \
  test/main/util/build-identity.test.ts \
  test/renderer/build-identity.test.ts \
  test/scripts/audit-local-workspace.test.ts \
  test/scripts/package-dev-mac.test.ts \
  test/scripts/verify-packaged-dev.test.ts \
  test/scripts/audit-branch-diff.test.ts
```

- [ ] **Step 2: Run full repository verification**

```bash
npm test
npm run typecheck
npm run builtin:manifest:check
git diff --check
```

- [ ] **Step 3: Run operational verification**

```bash
npm run audit:workspace -- --json
npm run audit:branch -- origin/dev/wujiayu
npm run audit:branch -- origin/dev/niubaokang
npm run package:dev:mac
npm run verify:package:dev:mac
```

- [ ] **Step 4: Inspect final state**

```bash
git status --short --branch
git log --oneline --decorate 242541b..HEAD
```

Expected: only ignored `.build/`, `dist-dev/`, `venv/`, and audit outputs exist outside Git; tracked worktree is clean.
