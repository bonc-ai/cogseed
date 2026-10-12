/**
 * Installer action abstraction.
 *
 * macOS dmg / zip → `shell.openPath` hands the artifact to the OS.
 * Windows exe     → `installDownloadedUpdate` verifies the file once more,
 *                   hands it to a detached helper (which waits for this
 *                   process to exit, then runs `installer /S --force-run`),
 *                   and quits so the installer can replace locked files.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { app, shell } from 'electron';

import { createLogger } from '../../logger';
import { PC_ROOT } from '../../paths';
import { sha256OfFile } from '../../util/sha256';

const log = createLogger('updater:installer');

export async function openDownloadedUpdate(installerPath: string): Promise<void> {
  const errorMessage = await shell.openPath(installerPath);
  if (errorMessage) throw new Error(errorMessage);
}

export interface WindowsInstallRuntime {
  platform: NodeJS.Platform;
  /** Electron binary reused as the helper interpreter (`ELECTRON_RUN_AS_NODE`). */
  execPath: string;
  pid: number;
  /**
   * Spawn the detached helper and resolve with its pid.
   *
   * The promise is the failure channel: a missing interpreter rejects with the
   * spawn error, and the caller must not quit before it settles. A child that
   * starts but exits immediately (for example a helper script that is absent or
   * renamed) cannot be detected here — that is what the existence pre-check in
   * `installDownloadedUpdate` is for.
   */
  spawnDetached: (exe: string, args: string[], env: Record<string, string>) => Promise<number>;
  quit: () => void;
}

export interface InstallDownloadedOptions {
  installerPath: string;
  sha256: string;
  runtime: WindowsInstallRuntime;
  /**
   * Test-only override for the `bin/apply-update.cjs` helper path. Production
   * callers must use the resolved default so the packaged `asarUnpack`
   * location cannot be bypassed accidentally.
   */
  helperPathForTest?: string;
}

/**
 * Absolute path of the Windows install helper under a given app directory.
 *
 * `bin/**` ships in `asarUnpack`, so a packaged app must spawn the helper from
 * `app.asar.unpacked/bin/...`: a script inside `app.asar` is not a real
 * filesystem file and cannot be executed by a child process. This is the same
 * `PC_ROOT` + packaged-rewrite convention already used for `bin/run-skill.cjs`
 * and `bin/cogseed-pkg.cjs` (features/packages.ts, features/plugin_ui.ts).
 *
 * The result must be ABSOLUTE: the helper is spawned detached, and the working
 * directory of the spawned process is not dependable for a packaged GUI app.
 */
export function resolveApplyUpdateHelperPath(pcRoot: string, isPackaged: boolean): string {
  const pcDir = isPackaged ? pcRoot.replace(/\bapp\.asar\b/, 'app.asar.unpacked') : pcRoot;
  return path.join(pcDir, 'bin', 'apply-update.cjs');
}

export function defaultApplyUpdateHelperPath(): string {
  let isPackaged = false;
  try {
    if (app) isPackaged = Boolean(app.isPackaged);
  } catch { /* not in electron (tests) */ }
  return resolveApplyUpdateHelperPath(PC_ROOT, isPackaged);
}

/**
 * Re-verify a downloaded installer against the server-provided digest.
 *
 * Delegates the digest to the shared `sha256OfFile` helper instead of a second
 * hashing implementation. An IO failure (missing/unreadable file) always fails
 * verification, but it is reported as `unreadable` rather than as a digest
 * mismatch: a vanished artifact and a tampered one are different incidents.
 */
export function verifyFileSha256(filePath: string, expected: string): boolean {
  const actual = sha256OfFile(filePath);
  if (actual === undefined) {
    throw new Error(`installDownloadedUpdate: installer unreadable: ${path.basename(filePath)}`);
  }
  return actual === expected.trim().toLowerCase();
}

/**
 * Hand the verified installer to the detached Windows helper and quit.
 *
 * The bytes on disk are re-verified here, not trusted from the download
 * record: the artifact may have been replaced between download and install.
 */
export async function installDownloadedUpdate(opts: InstallDownloadedOptions): Promise<void> {
  const { runtime } = opts;
  if (runtime.platform !== 'win32') {
    throw new Error('installDownloadedUpdate: unsupported platform');
  }
  if (!verifyFileSha256(opts.installerPath, opts.sha256)) {
    throw new Error('installDownloadedUpdate: installer checksum mismatch');
  }
  const helper = opts.helperPathForTest || defaultApplyUpdateHelperPath();
  // A missing helper script is the silent failure mode: the interpreter is the
  // app's own binary, so the spawn succeeds, the child exits 1, and its ignored
  // stderr leaves no evidence. Refuse before spawning, never quitting (same
  // convention as features/plugin_ui.ts).
  if (!fs.existsSync(helper)) {
    throw new Error(`installDownloadedUpdate: helper not found: ${helper}`);
  }
  // Best-effort diagnostics written by the helper: its stdio is discarded, so
  // this log is the only durable trace it can leave. It is not a success
  // channel — nothing here reads it, and "the install never applied" is
  // detected on the next launch by the boot guard, which compares the running
  // version against the pending-install record. It sits next to the downloaded
  // installer (an absolute, user-writable location) rather than under the
  // install root, which may be read-only.
  const helperLogPath = path.join(path.dirname(opts.installerPath), 'apply-update.log');
  // Awaited before quitting: a failed spawn must reach the caller instead of
  // racing `app.quit()` and leaving the app gone with nothing installed.
  await runtime.spawnDetached(
    runtime.execPath,
    [helper, String(runtime.pid), opts.installerPath, helperLogPath],
    { ELECTRON_RUN_AS_NODE: '1' },
  );
  log.info('handing update to helper and exiting', { installer: path.basename(opts.installerPath) });
  runtime.quit();
}

export const defaultWindowsInstallRuntime: WindowsInstallRuntime = {
  platform: process.platform,
  execPath: process.execPath,
  pid: process.pid,
  spawnDetached: (exe, args, env) => new Promise<number>((resolve, reject) => {
    const child = spawn(exe, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    child.once('error', reject);
    // `unref()` detaches the child from the parent's event loop; it does not
    // suppress the `'spawn'`/`'error'` events, which is why it is safe here.
    child.unref();
    child.once('spawn', () => resolve(child.pid ?? 0));
  }),
  quit: () => {
    app.quit();
  },
};
