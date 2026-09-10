# Windows v0.10.0 Mainline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将旧 Windows 修复中仍有效的进程回收、WorkBuddy/CLI 发现、打包和全量测试能力迁入最新 `develop`，并在不改变现有分支核心流程的前提下建立同一 SHA 的 macOS/Windows/合规发布门禁，为 `v0.10.0` 做本地候选验证。

**Architecture:** 以 `origin/develop@99f63d78` 为唯一代码基线，在隔离分支 `fix/windows-full-suite-v010` 上只做语义迁移，不合并落后的 Windows 分支历史。开发 PR 仍进入 `develop`，`develop -> cicd` 仍使用 Merge Commit；正式 tag 只允许指向已通过双平台和合规 push 门禁的当前 `cicd` tip。发布由单一 workflow 编排两个平台构建和一次 Release 写入。

**Tech Stack:** Electron、TypeScript、Node.js、Vitest、PowerShell、GitHub Actions、electron-builder。

**User constraint:** 本计划执行期间不提交、不推送、不合并、不创建 PR、不删除现有 worktree。

---

## File boundaries

- `src/main/features/local_agents/backends/base.ts`: `killProcessTree` 的永不拒绝 Promise 契约和 watchdog 回收。
- `src/main/features/local_agents/version.ts`: 版本探测终止状态机，等待目标 child close 与 tree-kill 完成。
- `src/main/features/local_agents/{which,registry}.ts`、`scripts/diagnose-local-agents.mjs`: WorkBuddy 和 Windows shim 发现。
- `bin/packaged-entrypoint-gate.cjs`、`scripts/after-pack.js`、`package*.json`: 打包入口、运行时依赖与 Windows 产物。
- `scripts/{run-tests,test-worker-args,python-test-runtime}.mjs`、`test/helpers/*capabilities*`: Windows 全量测试隔离和平台能力判断。
- `.github/workflows/{ci,compliance,release}.yml`: 保持原分支流程，建立 cicd 双平台、合规和原子发布。
- `scripts/verify-release-gates.mjs`: exact-SHA 和 workflow-run 来源校验。
- `test/scripts/*`: CI/CD 静态契约与发布门禁单测。
- `CHANGELOG.md`、`publiccode.yml`、`sbom.cdx.json`、`package*.json`: 发布准备阶段统一对齐 `0.10.0`。

### Task 1: Preserve source state and establish the clean baseline

**Files:**
- Verify only: old worktree and new isolated worktree

- [x] **Step 1: Create an isolated branch from latest develop**

Run:

```powershell
git fetch origin develop cicd --tags
git worktree add -b fix/windows-full-suite-v010 C:\Users\27821\Documents\Codex\2026-09-04\ji\cogseed-v010 origin/develop
```

Observed: new worktree is at `99f63d789e20e58cbd6e1be046c9d9a0af9d9f45`; the original dirty worktree remains untouched.

- [x] **Step 2: Install locked dependencies**

Run: `npm ci`

Observed: exit 0; 711 packages installed. Audit findings are pre-existing dependency metadata and are not auto-fixed in this task.

- [x] **Step 3: Run the requested first-line baseline**

Run:

```powershell
npm run test:js -- test/main/features/local_agents/version.test.ts test/main/features/local_agents/base.test.ts test/main/features/local_agents/registry.test.ts test/main/features/local_agents/which.test.ts test/main/util/codesign-runtime-gate.test.ts test/main/util/packaged-entrypoint-gate.test.ts test/scripts/diagnose-local-agents.test.ts
npm run typecheck
```

Observed: 7 test files passed, 86 tests passed, 2 skipped; typecheck exit 0.

### Task 2: Make process-tree termination awaitable

**Files:**
- Modify: `test/main/features/local_agents/base.test.ts`
- Modify: `test/main/features/local_agents/watchdog.test.ts`
- Modify: `src/main/features/local_agents/backends/base.ts`

- [ ] **Step 1: Add failing Promise-contract tests**

Add tests that assert:

```ts
const completion = killProcessTree(child, 'SIGTERM', { platform: 'win32', spawnFn });
expect(completion).toBeInstanceOf(Promise);
killer.emit('exit', 1, null);
expect(child.kill).toHaveBeenCalledTimes(1);
killer.emit('close', 1, null);
await expect(completion).resolves.toBeUndefined();
```

Cover taskkill success, non-zero exit, spawn error, close ordering, fallback-only-once, POSIX process-group fallback, and watchdog disarm cancelling a pending hard kill.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm run test:js -- --maxWorkers=1 test/main/features/local_agents/base.test.ts test/main/features/local_agents/watchdog.test.ts
```

Expected: fail because the current function returns `void`, resolves before taskkill `close`, and watchdog disarm leaves the hard-kill timer armed.

- [ ] **Step 3: Implement the minimal contract**

Change the public signature to:

```ts
export function killProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals,
  opts: { platform?: NodeJS.Platform; spawnFn?: SpawnFn } = {},
): Promise<void>
```

The Promise must never reject. On Windows it resolves on the taskkill helper's `close`, removes `error`/`exit`/`close` listeners, and performs the direct-child fallback at most once. Synchronous spawn failure and POSIX paths return `Promise.resolve()` after their best-effort signal. Store the watchdog hard-kill timer and clear it in `disarm()`.

- [ ] **Step 4: Verify GREEN**

Run the Task 2 command again. Expected: both files pass with no unhandled errors or timers.

### Task 3: Make version-probe termination a bounded state machine

**Files:**
- Modify: `test/main/features/local_agents/version.test.ts`
- Modify: `src/main/features/local_agents/version.ts`

- [ ] **Step 1: Add failing lifecycle tests**

Expose only the existing internal probe through a test hook:

```ts
export const __versionTestHooks = { probeVersionOnce };
```

Use fake children and deferred kill Promises to cover both `close-first` and `kill-first`. Assert that a timeout resolves only after both barriers, deadline fallback retains an error sink until late kill completion, POSIX close-during-grace escalates immediately, rejected/throwing injected killers are normalized, and the real Windows `.cmd` retry leaves no descendant PIDs.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm run test:js -- --maxWorkers=1 test/main/features/local_agents/version.test.ts
```

Expected: lifecycle tests fail against the current early-resolve implementation.

- [ ] **Step 3: Implement the state machine**

Introduce explicit state for `terminationOutcome`, `childClosedDuringTermination`, `pendingKillOperations`, grace timer, deadline timer, stream/listener cleanup, and a temporary late-error sink. `finish()` may resolve a termination outcome only after normal close and tree-kill completion; the bounded deadline returns `unavailable` and detaches handles without allowing late errors to crash the suite.

Keep the public API backward compatible and add optional total budgeting:

```ts
export async function detectVersion(
  binPath: string,
  timeoutMs = 5000,
  versionArgs: readonly string[] = ['--version'],
  options: { totalBudgetMs?: number } = {},
): Promise<string | null>
```

- [ ] **Step 4: Verify GREEN and type safety**

Run:

```powershell
npm run test:js -- --maxWorkers=1 test/main/features/local_agents/version.test.ts test/main/features/local_agents/base.test.ts test/main/features/local_agents/watchdog.test.ts
npm run typecheck
```

Expected: all targeted tests and typecheck pass.

### Task 4: Restore WorkBuddy discovery and packaged runtime contracts

**Files:**
- Modify tests first: `test/main/features/local_agents/{base,registry,which}.test.ts`
- Modify tests first: `test/scripts/diagnose-local-agents.test.ts`
- Modify tests first: `test/main/util/{codesign-runtime-gate,packaged-entrypoint-gate}.test.ts`
- Modify: `src/main/features/local_agents/{which,registry}.ts`
- Modify: `src/main/features/local_agents/backends/base.ts`
- Modify: `scripts/diagnose-local-agents.mjs`
- Modify: `bin/packaged-entrypoint-gate.cjs`
- Modify: `scripts/after-pack.js`
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Add missing-behavior tests and verify RED**

Assert WorkBuddy is present in the registry, resolves Windows `.cmd`/`.exe` candidates, diagnostic JSON reports it independently from authentication, and packaged entrypoint/native runtime gates contain every declared loader/runtime dependency.

Run:

```powershell
npm run test:js -- --maxWorkers=1 test/main/features/local_agents/base.test.ts test/main/features/local_agents/registry.test.ts test/main/features/local_agents/which.test.ts test/scripts/diagnose-local-agents.test.ts test/main/util/codesign-runtime-gate.test.ts test/main/util/packaged-entrypoint-gate.test.ts
```

Expected: new assertions fail for missing discovery or packaging behavior, not for fixture syntax.

- [ ] **Step 2: Add the minimal implementation**

Migrate only the old worktree's semantic changes. Preserve all newer `develop` behavior. In `package*.json`, migrate only required dependencies and lock entries; do not copy the old `0.9.0` version hunk.

- [ ] **Step 3: Verify GREEN**

Run the Task 4 test command and `npm run typecheck`. Expected: all targeted checks pass.

### Task 5: Port Windows full-suite isolation without masking product failures

**Files:**
- Create: `scripts/test-worker-args.mjs`
- Create: `test/scripts/run-tests.test.ts`
- Create: `test/helpers/{fs-capabilities,tls-capabilities}.ts`
- Create: `test/helpers/fs-capabilities.test.ts`
- Modify: `scripts/{run-tests,python-test-runtime,package-dev-mac}.mjs`
- Modify: `test/setup-env.ts`, `test/setup-env.test.ts`
- Modify only affected cross-platform tests and their corresponding production files from commit `615b84da`.

- [ ] **Step 1: Port test-runner and capability tests only**

Test `--maxWorkers=1` propagation on Windows, resource environment setup, CRLF/symlink/chmod/TLS capability detection, and deterministic main-runtime drain.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm run test:js -- --maxWorkers=1 test/scripts/run-tests.test.ts test/setup-env.test.ts test/helpers/fs-capabilities.test.ts
```

Expected: fail because helpers and worker-argument behavior are absent.

- [ ] **Step 3: Implement helpers and surgical cross-platform fixes**

Use capability-based skips only where the OS/filesystem truly lacks a primitive. Do not skip product behavior failures. Preserve latest develop changes in `space_import`, KB, renderer, IPC, and other files that diverged after the old branch.

- [ ] **Step 4: Run the full JS suite**

Run:

```powershell
npm run test:js -- --maxWorkers=1
```

Expected: zero failures and zero unhandled errors. Any suspected flaky failure must be rerun alone and then rerun with its neighboring suite before classification.

### Task 6: Encode the original cicd flow as tested workflow contracts

**Files:**
- Create: `scripts/verify-release-gates.mjs`
- Create: `test/scripts/verify-release-gates.test.ts`
- Create: `test/scripts/release-workflow-contract.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/compliance.yml`
- Replace tag publishing with: `.github/workflows/release.yml`
- Remove tag publishing triggers from old macOS/Windows publisher workflows.

- [ ] **Step 1: Write failing release-gate tests**

Cover exact cicd tip success, ancestor-tag rejection, wrong SHA, PR/manual-run rejection, missing/failed/skipped macOS or Windows jobs, missing/failed compliance, annotated-tag peeling, and latest-attempt selection.

- [ ] **Step 2: Write failing workflow topology tests**

Assert:

```text
develop PR: email gate only
cicd PR/push: macOS + Windows + compliance
release: tag only -> gate -> two builds -> one publisher
```

Also assert only the publisher has `contents: write`, and `workflow_dispatch` has no release path.

- [ ] **Step 3: Verify RED**

Run:

```powershell
npm run test:js -- --maxWorkers=1 test/scripts/verify-release-gates.test.ts test/scripts/release-workflow-contract.test.ts
```

Expected: fail because exact-SHA gate and unified release topology do not yet exist.

- [ ] **Step 4: Implement the tested workflows**

Keep the original branch model. CI automatic branch filters remain cicd-only. The release gate queries successful `push` runs on `cicd` for the exact release SHA and requires macOS, Windows, and compliance jobs. Both platform builds checkout the tag SHA and a single publish job creates the Release.

- [ ] **Step 5: Verify GREEN and YAML parsing**

Run the Task 6 tests plus a YAML parse of every `.github/workflows/*.yml`. Expected: tests pass and all workflows parse.

### Task 7: Align release metadata to v0.10.0

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `publiccode.yml`
- Modify: `sbom.cdx.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add or update version-consistency test and verify RED**

Assert all machine-readable version fields equal `0.10.0` and changelog contains a `0.10.0` entry.

- [ ] **Step 2: Update all five sources once**

Do not edit the existing `v0.9.0` tag or Release. Set the candidate metadata to `0.10.0` only after functional and workflow tests are green.

- [ ] **Step 3: Verify GREEN**

Run the version-consistency test and `npm run typecheck`.

### Task 8: Run complete Windows gates and package locally

**Files:**
- Verify all changed files

- [ ] **Step 1: Static and targeted gates**

```powershell
npm run typecheck
npm run lint
npm run test:js -- --maxWorkers=1 test/main/features/local_agents/version.test.ts test/main/features/local_agents/base.test.ts test/main/features/local_agents/registry.test.ts test/main/features/local_agents/which.test.ts test/main/util/codesign-runtime-gate.test.ts test/main/util/packaged-entrypoint-gate.test.ts test/scripts/diagnose-local-agents.test.ts
```

- [ ] **Step 2: Resource, native, and protocol gates**

```powershell
npm run test:resources:setup
npm run test:resources
npm run test:platform-native
node p3394-gateway/test/smoke.cjs
```

- [ ] **Step 3: Full JS and Windows build**

```powershell
npm run test:js -- --maxWorkers=1
npm run build:win
```

- [ ] **Step 4: Inspect final state without publishing**

```powershell
git diff --check
git status --short
git diff --stat
```

Expected: all gates exit 0, the exact `CogSeed-0.10.0-win-x64.exe` exists, and the worktree contains only intentional uncommitted changes. Stop before commit, push, merge, PR creation, tag creation, or Release upload.
