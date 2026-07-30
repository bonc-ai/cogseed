# Local Development Stabilization Design

**Date:** 2026-07-30  
**Branch:** `codex/local-stabilization`  
**Baseline:** `242541b`

## Goal

Stabilize the current local Mate Agent development version without changing Personal Ontology behavior and without promoting changes to the official/default remote branches. The work covers Python test-runtime discovery, deterministic source startup identity, read-only local Git/worktree diagnostics, a separately named macOS development package with packaged smoke verification, and semantic audits of selected teammate branches.

## Non-goals

- Do not modify Personal Ontology feature, UI, storage, prompts, skills, tests, or packaging semantics.
- Do not merge, reset, force-push, or otherwise update `origin/main`, `origin/master`, `origin/develop`, or protected integration branches.
- Do not pop/drop stashes, delete worktrees, or delete branches automatically.
- Do not merge teammate feature branches automatically; produce evidence and recommendations first.
- Do not overwrite `/Applications/Mate Agent.app` during development packaging.
- Do not add npm dependencies.

## Current Problems

1. `scripts/run-python-tests.mjs` selects the first executable Python rather than the first Python that can actually import pytest. On this machine it selects Homebrew Python 3.14 and `npm test` exits after the JavaScript suite because pytest is missing.
2. Source and packaged apps both report only `2026.7.21`; neither the Renderer nor packaged smoke evidence identifies commit, dirty state, build channel, or build time.
3. Multiple worktrees and stale local branches/stashes are difficult to distinguish. Existing commands are ad hoc and cleanup would be destructive without an evidence report.
4. The installed app is not representative of the current source, while there is no separately named packaged development app for safe QA.
5. Teammate branches contain unique and parallel work. Direct merging would duplicate provider implementations or import unrelated features without review.

## Design Overview

The implementation is divided into four independently verifiable components:

1. **Pytest-capable runtime resolution** — test each Python candidate with `-m pytest --version`, select only a working pytest runtime, and print a bounded diagnostic when none exists.
2. **Build/runtime identity** — expose channel, commit, dirty flag, and build time through the existing `orkas.env` API and sidebar version label. Source launch receives identity from `run.sh` / `run.cmd`; packaged builds consume a generated build-info resource.
3. **Read-only workspace audit** — one script reports worktrees, branch tracking state, stash summaries, untracked files, and branch divergence. It never mutates Git state.
4. **Development packaging and teammate audits** — package a distinct `Mate Agent Dev.app` under `dist-dev/`, run the existing packaged launch smoke, verify critical provider/P3394 resources, and generate semantic branch reports without merging.

---

## 1. Python Test Runtime Resolution

### Files

- Modify `scripts/run-python-tests.mjs`
- Add `scripts/python-test-runtime.mjs`
- Add `scripts/setup-python-test-env.mjs`
- Add `test/scripts/python-test-runtime.test.ts`

### Candidate order

The resolver considers candidates in this order:

1. `ORKAS_TEST_PYTHON`
2. Repository venv:
   - macOS/Linux: `<repo>/venv/bin/python`
   - Windows: `<repo>/venv/Scripts/python.exe`
3. Bundled runtime Python for the active platform, when present under `resources/runtime/python/<platform-arch>/...`
4. `python3`
5. `python`

A candidate is usable only when both probes succeed:

```text
<python> --version
<python> -m pytest --version
```

The resolver returns structured evidence:

```ts
{
  selected: string | null,
  attempts: Array<{
    candidate: string,
    exists: boolean | null,
    pythonOk: boolean,
    pytestOk: boolean,
    reason: string,
  }>,
}
```

### Failure behavior

When no candidate has pytest, the script exits with code 2 and prints:

- every candidate attempted;
- whether Python started;
- whether pytest was importable;
- the repository-local bootstrap command for the current platform.

It must not silently install packages or use network access. A separate explicit command, `npm run test:resources:setup`, creates the repository-local `venv` and installs the pinned resource-test requirements after printing the target interpreter and environment path. The normal test command never invokes setup automatically. During this implementation the setup command will be run once in the isolated worktree so `npm test` is green there.

### Compatibility

`ORKAS_TEST_PYTHON` remains the explicit override. Windows path handling is tested without launching Windows binaries by testing candidate construction as pure logic.

---

## 2. Build and Runtime Identity

### Files

- Add `src/main/util/build-identity.ts`
- Add `scripts/write-build-info.cjs`
- Modify `src/main/index.ts`
- Modify `src/renderer/modules/boot.js`
- Modify `src/renderer/locales/{en,zh,ja,pt}.json`
- Modify `run.sh`
- Modify `run.cmd`
- Modify `package.json`
- Add `test/main/util/build-identity.test.ts`
- Extend relevant Renderer version-label tests

### Identity shape

```ts
interface BuildIdentity {
  channel: 'dev' | 'packaged-dev' | 'release' | 'unknown';
  commit: string;
  dirty: boolean | null;
  builtAt: string;
}
```

### Source launch

`run.sh` and `run.cmd` compute identity before Electron starts:

- `ORKAS_BUILD_CHANNEL=dev`
- `ORKAS_BUILD_COMMIT=<short sha>`
- `ORKAS_BUILD_DIRTY=1|0`
- `ORKAS_BUILD_TIME=<ISO timestamp>`

Failure to run Git is non-fatal and produces `unknown` values.

### Packaged launch

`scripts/write-build-info.cjs` writes a generated JSON file under `.build/` before packaging. The file is included in the app package and read by `build-identity.ts`. `.build/` is ignored by Git.

The package must not run Git commands at runtime. The generated `.build/build-info.json` is explicitly included in the Electron Builder `files` list. Packaged identity also appears in `extraMetadata` so `bootstrap.cjs` can identify a packaged-dev build before `install-data-root.cjs` runs.

### IPC and UI

The existing `orkas.env` response is extended with:

```json
{
  "buildChannel": "dev",
  "buildCommit": "242541b",
  "buildDirty": false,
  "buildTime": "2026-07-30T..."
}
```

The sidebar continues to show the semantic version, with a compact development suffix:

```text
v2026.7.21 · dev · 242541b
```

The title tooltip contains the full build time and dirty status. Release-channel builds may keep the compact label as only the semantic version unless commit display is explicitly enabled.

No private path or branch name is exposed to Renderer telemetry.

---

## 3. Read-only Workspace Audit

### Files

- Add `scripts/audit-local-workspace.mjs`
- Add `test/scripts/audit-local-workspace.test.ts`
- Add npm script `audit:workspace`

### Report

The command emits a human-readable summary and supports `--json`:

```text
npm run audit:workspace
npm run audit:workspace -- --json
```

It reports:

- repository root and current commit;
- worktrees and checked-out branches;
- dirty/untracked counts per worktree;
- local branches whose upstream is gone;
- local/remote ahead-behind counts;
- stash index, subject, parent commit, and file summary;
- duplicate branches pointing at the same commit;
- known risky state such as a feature branch and `main` sharing the same tip.

### Safety

The script is read-only. It must not call:

- `git stash pop/drop/clear`;
- `git branch -d/-D`;
- `git worktree remove/prune`;
- `git reset`, `checkout`, or `switch`;
- any push command.

Cleanup remains a separate user-approved action after reviewing the report.

---

## 4. Development Packaging

### Files

- Modify `bootstrap.cjs`
- Add `scripts/package-dev-mac.cjs`
- Add `scripts/verify-packaged-dev.cjs`
- Modify `package.json`
- Extend packaged resource/static tests as needed

### Output

The command:

```text
npm run package:dev:mac
```

produces an unpacked app under:

```text
dist-dev/mac-arm64/Mate Agent Dev.app
```

It must not copy over or delete `/Applications/Mate Agent.app`.

Development package identity:

```text
productName: Mate Agent Dev
appId: com.mateagent.desktop.dev
channel: packaged-dev
```

The packaging script creates a temporary Electron Builder config derived from `package.json` that changes product name/app id/output, removes production protocol registration, injects packaged-dev `extraMetadata`, and includes `.build/build-info.json`. It does not rewrite the checked-in production build config.

Before `src/main/index.ts` imports `install-data-root.cjs`, `bootstrap.cjs` reads packaged `extraMetadata`. For `packaged-dev`, it sets `ORKAS_WORKSPACE_ROOT` to `<home>/.orkas-dev/data` unless the caller already provided an override. Production/source behavior remains unchanged. This prevents packaged-dev QA from contaminating the installed app's account/cache state.

### Verification

`verify-packaged-dev.cjs` checks:

- app bundle exists;
- `app.asar` exists;
- build-info exists and matches the requested commit;
- current custom-provider and P3394 runtime files exist in `app.asar`;
- builtin/runtime/OfficeCLI/engine resources exist;
- the existing packaged launch smoke reaches Renderer ready and IPC ping;
- launched app identity reports `packaged-dev` and the expected commit.

The verification does not install the app globally.

---

## 5. Teammate Branch Semantic Audits

### Files

- Add `scripts/audit-branch-diff.mjs`
- Add `test/scripts/audit-branch-diff.test.ts`
- Add npm script `audit:branch`
- Store generated reports outside tracked source by default (`.build/audits/`)

### Usage

```text
npm run audit:branch -- origin/dev/wujiayu
npm run audit:branch -- origin/dev/niubaokang
```

### Report sections

- ancestry and merge base;
- unique commits on each side;
- changed-file overlap;
- exact duplicate files;
- likely parallel implementations based on shared paths/symbol names;
- files safe for isolated cherry-pick consideration;
- tests added by the branch;
- hosted/open-source strip-rule implications;
- recommendation: `duplicate`, `needs manual port`, `independent candidate`, or `do not merge`.

The script does not merge or cherry-pick.

Initial audits target:

- `origin/dev/wujiayu` — provider implementation overlap plus unique Agent governance work;
- `origin/dev/niubaokang` — reimbursement agent and sensitive-output filtering.

---

## Error Handling and Logging

- Scripts print concise diagnostics to stderr and return non-zero exit codes for failed verification.
- App logging continues through `createLogger`; no new production `console.log` calls.
- Build identity logs contain only channel, commit, dirty status, and time.
- Workspace audit reports local paths to the invoking terminal only; it does not send telemetry.
- Packaging verification failures are explicit and stop before any installation step.

## Testing Strategy

### Focused tests

1. Python resolver: precedence, missing executable, Python without pytest, explicit override, Windows paths.
2. Build identity: env precedence, packaged JSON fallback, malformed/missing JSON, no Git runtime dependency.
3. Renderer version label: release/dev/dirty formatting and i18n tooltip.
4. Workspace audit: parse worktree/branch/stash fixtures and prove no mutating Git subcommands are emitted.
5. Branch audit: merge-base and overlap classification fixtures.
6. Packaging verifier: temporary fake bundle fixtures plus real packaged smoke on macOS.

### Full verification

- `npm test`
- `npm run typecheck`
- `npm run builtin:manifest:check`
- `git diff --check`
- `npm run audit:workspace -- --json`
- `npm run package:dev:mac`
- packaged launch smoke

## Rollout Order

1. Python test runtime resolution.
2. Build/runtime identity and source startup proof.
3. Read-only Git/worktree audit.
4. Development packaging and packaged smoke.
5. Teammate branch audit reports.
6. Present cleanup/integration recommendations for a separate approval; do not mutate branches/stashes automatically.

## Accepted Trade-offs

- This design does not auto-install pytest; deterministic diagnostics are safer than hidden network/package changes.
- It creates a separate development app instead of replacing the installed app.
- It audits Git state and teammate branches but deliberately defers destructive cleanup and code integration until the evidence is reviewed.
- It leaves Personal Ontology untouched even where shared files such as `package.json`, `run.sh`, and Renderer version labels are changed for general stabilization.
