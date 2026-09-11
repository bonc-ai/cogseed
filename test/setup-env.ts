/**
 * Vitest setup: force `COGSEED_WORKSPACE_ROOT` to a per-run tmp dir before
 * any test module (and therefore `src/main/paths.ts`) is imported.
 *
 * Why this is a hard requirement, not a "nice to have":
 * `paths.ts` resolves `WS_ROOT` as a *top-level module constant* from
 * `process.env.COGSEED_WORKSPACE_ROOT` at import time, and dozens of derived
 * paths (`USERS_FILE`, `userRoot(uid)`, ...) close over it. Whichever test
 * imports `paths` (or anything that transitively loads it) *first* freezes
 * `WS_ROOT`. If that first import happens before the test's own
 * `beforeEach` sets the env, `WS_ROOT` freezes to the dev default
 * `PC/data/` — every subsequent `features/users.initActiveUser()` call
 * then clobbers the developer's real `users.json` and spawns a new uid
 * skeleton under `PC/data/`.
 *
 * The same applies to an `COGSEED_WORKSPACE_ROOT` inherited from the parent
 * shell, which is why the assignment below is unconditional rather than a
 * fallback — see the comment there.
 *
 * Per-test isolation (`test.isolate: true` in `vitest.config.ts`) plus each
 * test's own `vi.resetModules()` + dynamic `await import()` still works on
 * top of this — those tests override env first, then re-import paths, and
 * get their own tmp. Tests that *don't* bother with env setup simply
 * inherit this global tmp, which is harmless (they write junk into a
 * throwaway dir) and — crucially — never write to the real data root.
 *
 * We intentionally do NOT clean the tmp dir on exit: vitest shells aren't
 * guaranteed to reach a finalizer on crashes, and the OS tmp reaper will
 * handle it. Each run gets a unique `mkdtemp` dir so stale data never
 * mingles across runs.
 */

import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { vi } from 'vitest';

// Register tsx/cjs so that any `require('./group_chat/bus')`-style CJS lookups
// (used inside features/chats.ts to break the bus ↔ chats import cycle without
// triggering the ESM dual-load bug described in 0268bce7) resolve `.ts` files
// under vitest. Without this hook vitest's plain-node CJS resolver fails the
// require with `Cannot find module './group_chat/bus'` and chats.deleteConversation
// silently skips purgeGroupDir, breaking the delete-cascade tests.
import 'tsx/cjs';

// Windows CI schedules async callbacks far more slowly than a local POSIX run.
// Keep Vitest's 1s default locally, but give every `vi.waitFor` call a bounded
// 5s default on Windows so per-test polling does not flake under maxWorkers=1.
const waitForDefaultMarker = Symbol.for('cogseed.test.wait-for-default');
const waitForUtils = vi as unknown as {
  waitFor: <T>(assertion: () => T | Promise<T>, options?: { timeout?: number; interval?: number }) => Promise<T>;
} & Record<PropertyKey, unknown>;
if (!waitForUtils[waitForDefaultMarker]) {
  const originalWaitFor = waitForUtils.waitFor.bind(vi);
  waitForUtils.waitFor = (assertion, options) => originalWaitFor(assertion, {
    timeout: process.platform === 'win32' ? 5_000 : 1_000,
    interval: 50,
    ...(options ?? {}),
  });
  waitForUtils[waitForDefaultMarker] = true;
}

// Windows can keep just-closed SQLite databases, command shims, and watched
// files non-deletable for a short interval. Most tests remove an OS-temp tree
// in afterEach with recursive rmSync; Node only retries those transient
// EPERM/EBUSY/ENOTEMPTY errors when maxRetries is non-zero. Apply that policy
// centrally to recursive removals inside the OS temp directory so every case
// gets the same semantics without weakening deletion assertions elsewhere.
if (process.platform === 'win32') {
  const require = createRequire(import.meta.url);
  // Main-process feature modules create scoped electron-log instances at
  // import time. Unit tests repeatedly reset that module graph against a new
  // temp workspace; a real file transport would retain every old Windows file
  // handle until the worker exits. Logging behavior has its own focused tests,
  // so keep the API/console transport but disable process-wide test file IO.
  const electronLog = require('electron-log/main') as {
    transports: { file: { level: string | false } };
  };
  electronLog.transports.file.level = false;
  const mutableFs = require('node:fs') as typeof fs & Record<PropertyKey, unknown>;
  const retryMarker = Symbol.for('cogseed.test.windows-temp-rm-retry');
  if (!mutableFs[retryMarker]) {
    const originalRmSync = mutableFs.rmSync.bind(mutableFs);
    mutableFs.rmSync = ((target: fs.PathLike, options?: fs.RmDirOptions) => {
      const rawTarget = String(target);
      // fs.realpathSync.native() returns Win32 extended-length paths. Normalize
      // both local and UNC forms before checking whether cleanup is safely
      // contained by the OS temp directory.
      const ordinaryTarget = rawTarget.startsWith('\\\\?\\UNC\\')
        ? `\\\\${rawTarget.slice(8)}`
        : rawTarget.startsWith('\\\\?\\')
          ? rawTarget.slice(4)
          : rawTarget;
      const resolved = path.resolve(ordinaryTarget);
      const tempRoot = path.resolve(os.tmpdir());
      const isTempTree = resolved === tempRoot || resolved.startsWith(`${tempRoot}${path.sep}`);
      if (isTempTree && options?.recursive && options.maxRetries === undefined) {
        try {
          return originalRmSync(target, { ...options, maxRetries: 10, retryDelay: 50 });
        } catch (err) {
          // The tree is inside the OS temp root, so it is a disposable
          // per-test fixture. Windows can keep sqlite/WAL, log, or cache
          // handles open past the retry budget; retrying forever cannot
          // change the product result. Leave the leftover for the OS temp
          // reaper instead of failing an otherwise-green test in afterEach.
          const code = (err as NodeJS.ErrnoException).code;
          if (options.force && ['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(String(code))) {
            process.stderr.write(`[setup-env] leaving disposable Windows temp tree after rm retries (${code}): ${resolved}\n`);
            return;
          }
          throw err;
        }
      }
      return originalRmSync(target, options);
    }) as typeof fs.rmSync;
    mutableFs[retryMarker] = true;
    syncBuiltinESMExports();
  }
}

// Unconditional. An inherited value is exactly the case that must not win:
// `index.ts` exports `COGSEED_WORKSPACE_ROOT` into the app's own environment, so
// every process CogSeed spawns — including a coding agent asked to work on this
// repo — inherits the live data root. Honouring it here froze `WS_ROOT` to
// `~/.cogseed/data` and let the suite write signals, uid skeletons, and a
// rewritten `current_user_id` straight into the user's real profile.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-vitest-'));
process.env.COGSEED_WORKSPACE_ROOT = tmpRoot;

// `os.homedir()` reads USERPROFILE on Windows and HOME on POSIX. Redirect both
// before test modules load so global skill/session discovery cannot read from
// or write fixtures into the developer's real ~/.claude and ~/.codex trees.
// Tests for real home-resolution precedence explicitly unset or replace these.
process.env.HOME = tmpRoot;
process.env.USERPROFILE = tmpRoot;

// Same inheritance, sharper edge: `users.activateUser()` pins
// `CORE_AGENT_AUTH_DIR` to the active user's `<uid>/local/config/`, and the
// app exports it to children. `src/core-agent/test/auth.test.ts` deletes the
// auth store it resolves to and restores it afterwards — so an inherited
// value has the suite round-tripping the user's real encrypted credentials,
// which a crash mid-test would take with it. Tests that need the real
// resolution order unset this themselves.
process.env.CORE_AGENT_AUTH_DIR = path.join(tmpRoot, 'core-agent-auth');

// G-20 教训：session-import 的 welcome Action Plan 在「未配置 API 模型」时
// 会回退真实调用宿主机 CLI（pickBestCliForFallback → spawn）。测试行为随
// 机器装的 CLI 变化——开发机装了 hermes/openclaw 后该用例真跑 CLI，extraction
// 状态卡 pending 数分钟超时。统一关闭：测试不依赖宿主机状态。
process.env.COGSEED_DISABLE_LOCAL_AGENT_FALLBACK = '1';
