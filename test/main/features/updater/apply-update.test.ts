/**
 * Detached update helper (`bin/apply-update.cjs`).
 *
 * The helper is spawned by `features/updater/installer.ts` as
 * `<app binary> [helper, parentPid, installerPath, logPath]` with
 * `ELECTRON_RUN_AS_NODE=1` and discarded stdio, so this file pins the two
 * contracts that file depends on: the NSIS flag set and the wait-then-spawn
 * order. Everything else is injected (`isAlive`, `spawnFn`), so no case here
 * installs anything.
 *
 * The failure cases run the helper as a real child process, because `main()` is
 * only reachable through its `require.main` guard: the helper's log is the only
 * durable channel it has (the caller discards its stderr), so those cases assert
 * on the log, not just on the exit code.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

/** What `defaultSpawn` returns (a pid) and what an injected stub may return. */
type SpawnResult = number | { pid?: number };

const helper = require('../../../../bin/apply-update.cjs') as {
  INSTALLER_ARGS: string[];
  INSTALLER_SPAWN_OPTIONS: { detached: boolean; stdio: string; windowsHide: boolean };
  defaultSpawn: (
    exe: string,
    args: string[],
    spawnFn?: (exe: string, args: string[], opts: Record<string, unknown>) => SpawnResult,
  ) => number;
  waitForParentExit: (
    pid: number,
    opts: { isAlive?: (pid: number) => boolean; timeoutMs: number; pollMs: number },
  ) => Promise<boolean>;
  runInstaller: (installerPath: string, spawnFn: (exe: string, args: string[]) => SpawnResult) => number;
};

const HELPER_PATH = path.join(process.cwd(), 'bin', 'apply-update.cjs');

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-apply-update-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Drive the helper's own `isAlive` (no injected probe) through a stubbed `process.kill`. */
async function withKillThrowing(code: string, run: () => Promise<void>): Promise<void> {
  const original = process.kill;
  (process as unknown as { kill: unknown }).kill = () => {
    throw Object.assign(new Error(`kill failed: ${code}`), { code });
  };
  try {
    await run();
  } finally {
    (process as unknown as { kill: unknown }).kill = original;
  }
}

/**
 * A pid that is certainly gone: `spawnSync` waits for the probe process to exit
 * before it returns. 999999 is a fallback only — it is not a valid Windows pid
 * (those are multiples of 4) and sits above any plausible POSIX pid.
 */
function deadPid(): number {
  return spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' }).pid ?? 999999;
}

/**
 * Preloaded into the helper's own process before it destructures
 * `require('node:child_process')`, which is the only way to drive `main()`'s
 * failure branches from the outside.
 *
 * The message is deliberately not the real one: asserting on it proves the stub
 * was in effect and the case did not pass by spawning the fixture file.
 */
const SPAWN_STUB_THROWS = `
const cp = require('node:child_process');
cp.spawn = () => {
  // Reviewer-measured Windows shape: for a path that exists but is not a valid
  // executable, spawn() throws synchronously and an 'error' listener never runs.
  throw Object.assign(new Error('spawn UNKNOWN (preloaded stub)'), { errno: -4094, code: 'UNKNOWN' });
};
`;

const SPAWN_STUB_NO_PID = `
const cp = require('node:child_process');
// pid 0 is Windows' System Idle process, so "no pid" must never read as success.
cp.spawn = () => ({ pid: 0, unref() {} });
`;

interface HelperRun {
  /** Temp root of the run; no log line may contain it (basenames only). */
  dir: string;
  status: number | null;
  log: string;
}

function runHelper(opts: { installPath?: string; spawnStub?: string } = {}): HelperRun {
  const dir = makeTempDir();
  const logPath = path.join(dir, 'apply-update.log');
  const installerPath = opts.installPath ?? path.join(dir, 'CogSeed-0.0.9-win-x64.exe');
  if (!opts.installPath) fs.writeFileSync(installerPath, 'stub installer artifact\n');

  const env = { ...process.env };
  if (opts.spawnStub) {
    const preload = path.join(dir, 'spawn-stub.cjs');
    fs.writeFileSync(preload, opts.spawnStub, 'utf8');
    // NODE_OPTIONS tokenizes its own value: forward slashes, not backslashes,
    // and quotes because a temp root can contain spaces.
    env.NODE_OPTIONS = [process.env.NODE_OPTIONS, `--require "${preload.replace(/\\/g, '/')}"`]
      .filter(Boolean)
      .join(' ');
  }

  let status: number | null = 0;
  try {
    execFileSync(process.execPath, [HELPER_PATH, String(deadPid()), installerPath, logPath], { stdio: 'ignore', env });
  } catch (err) {
    status = (err as { status?: number }).status ?? null;
  }
  return { dir, status, log: fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '' };
}

describe('apply-update helper', () => {
  it('uses the silent + force-run flag set the NSIS template requires', () => {
    expect(helper.INSTALLER_ARGS).toEqual(['/S', '--force-run']);
  });

  it('waits until the parent process is gone', async () => {
    let alive = true;
    setTimeout(() => { alive = false; }, 30);
    const ok = await helper.waitForParentExit(4242, { isAlive: () => alive, timeoutMs: 1_000, pollMs: 5 });
    expect(ok).toBe(true);
  });

  it('gives up instead of hanging forever', async () => {
    const ok = await helper.waitForParentExit(4242, { isAlive: () => true, timeoutMs: 40, pollMs: 5 });
    expect(ok).toBe(false);
  });

  // `defaultSpawn` returns a ChildProcess-like object, so that is the shape this
  // seam is pinned against.
  it('spawns the installer with the silent flags', () => {
    const spawnFn = vi.fn(() => ({ pid: 777 }));
    const pid = helper.runInstaller('C:\\x\\CogSeed-0.0.9-win-x64.exe', spawnFn);
    expect(pid).toBe(777);
    expect(spawnFn).toHaveBeenCalledWith('C:\\x\\CogSeed-0.0.9-win-x64.exe', ['/S', '--force-run']);
  });

  // Regression lock for the 2026-10-08 real-machine failure: a non-detached
  // installer is destroyed with the helper's process tree, so the update
  // downloads and hands off cleanly and then silently never installs. Detaching
  // is what keeps the installer alive after `main()` returns; `unref()` only
  // releases this process from the event loop and cannot replace it.
  it('detaches the installer so it outlives this helper', () => {
    const calls: Array<{ exe: string; args: string[]; opts: Record<string, unknown> }> = [];
    const unref = vi.fn();
    const spawnFn = vi.fn((exe: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ exe, args, opts });
      return { pid: 4242, unref };
    });
    const pid = helper.defaultSpawn('C:\\x\\CogSeed-1.2.1-win-x64.exe', ['/S', '--force-run'], spawnFn);
    expect(pid).toBe(4242);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
    expect(calls[0].args).toEqual(['/S', '--force-run']);
    // Still released from the event loop: the helper must not stay alive under
    // $INSTDIR while NSIS runs CHECK_APP_RUNNING.
    expect(unref).toHaveBeenCalledTimes(1);
    expect(helper.INSTALLER_SPAWN_OPTIONS.detached).toBe(true);
  });

  // The seam stays tolerant: a bare pid is still accepted from an injected stub.
  it('keeps accepting a bare pid from the injected seam', () => {
    expect(helper.runInstaller('C:\\x\\CogSeed-0.0.9-win-x64.exe', () => 1234)).toBe(1234);
  });

  // The real probe is only reachable through the default `isAlive`, because a
  // spawned installer must never be held up by a wrong "still alive" answer.
  it('treats a vanished pid (ESRCH) as exited via its own probe', async () => {
    await withKillThrowing('ESRCH', async () => {
      const ok = await helper.waitForParentExit(4242, { timeoutMs: 1_000, pollMs: 5 });
      expect(ok).toBe(true);
    });
  });

  it('treats a pid we may not signal (EPERM) as still alive via its own probe', async () => {
    await withKillThrowing('EPERM', async () => {
      const ok = await helper.waitForParentExit(4242, { timeoutMs: 40, pollMs: 5 });
      expect(ok).toBe(false);
    });
  });

  // pid 0 is Windows' System Idle process and negatives are not pids at all:
  // both must fail the usage guard instead of starting a 60 s wait.
  it('rejects a non-positive parent pid as a usage error', () => {
    const dir = makeTempDir();
    const installerPath = path.join(dir, 'CogSeed-0.0.9-win-x64.exe');
    const logPath = path.join(dir, 'apply-update.log');
    fs.writeFileSync(installerPath, 'stub installer artifact\n');

    for (const pid of ['0', '-1']) {
      let status: number | null = 0;
      try {
        execFileSync(process.execPath, [HELPER_PATH, pid, installerPath, logPath], { stdio: 'ignore' });
      } catch (err) {
        status = (err as { status?: number }).status ?? null;
      }
      expect(status, `parent pid ${pid}`).toBe(2);
    }
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it('refuses a missing installer instead of spawning and reporting a bogus pid', () => {
    const dir = makeTempDir();
    const run = runHelper({ installPath: path.join(dir, 'CogSeed-9.9.9-win-x64.exe') });

    expect(run.status).not.toBe(0);
    expect(run.log).toContain('installer missing');
    expect(run.log).not.toContain('installer spawned');
    // Basenames only: the log is attached to bug reports.
    expect(run.log).not.toContain(dir);
  });

  // A window that exists but is not a valid executable makes spawn() throw
  // synchronously. Unrecorded, that failure leaves the user un-updated with the
  // log ending at `parent exited`. SmartScreen/AV blocks and elevation denials
  // reach the same branch.
  it('records a synchronous spawn failure instead of dying silently', () => {
    const run = runHelper({ spawnStub: SPAWN_STUB_THROWS });

    expect(run.status).not.toBe(0);
    expect(run.log).toContain('installer spawn failed');
    expect(run.log).toContain('(preloaded stub)');
    expect(run.log).not.toContain('installer spawned');
    expect(run.log).not.toContain(run.dir);
  });

  // A falsy pid is never a successful spawn: pid 0 is a real Windows pid (System
  // Idle), so `installer spawned pid=0` would read like success.
  it('treats a spawn result without a pid as a failure', () => {
    const run = runHelper({ spawnStub: SPAWN_STUB_NO_PID });

    expect(run.status).not.toBe(0);
    expect(run.log).toContain('installer spawn returned no pid');
    expect(run.log).not.toContain('installer spawned');
  });

  it.skipIf(process.platform !== 'win32')('records a real invalid-executable spawn failure', () => {
    // The in-situ version of the case above: a fixture file that exists but is
    // not a PE image. Measured on the shipped toolchain as `spawn UNKNOWN`,
    // errno -4094, thrown from the spawn() call.
    const dir = makeTempDir();
    const installerPath = path.join(dir, 'CogSeed-0.0.9-win-x64.exe');
    fs.writeFileSync(installerPath, 'not a PE image\n');
    const run = runHelper({ installPath: installerPath });

    expect(run.status).not.toBe(0);
    expect(run.log).toContain('installer spawn failed');
    expect(run.log).toContain('spawn UNKNOWN');
    expect(run.log).not.toContain('installer spawned');
  });
});
