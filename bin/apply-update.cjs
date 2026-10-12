#!/usr/bin/env node
/**
 * Detached update applier (Windows).
 *
 * Spawned by features/updater/installer.ts through the app's own Electron binary
 * with ELECTRON_RUN_AS_NODE=1, so no extra runtime ships for this.
 *
 * Argv contract (installer.ts:128-132):
 *   apply-update.cjs <parent-pid> <installer-path> [log-path]
 *
 * Sequence: wait for the app process to exit (file locks), then run the NSIS
 * installer silently. `--force-run` is required because the one-click template
 * only relaunches the app when not silent OR force-run is set:
 *   app-builder-lib/templates/nsis/installSection.nsh:91-102
 *   app-builder-lib/out/targets/nsis/NsisTarget.js:413-414,584
 *
 * The log is best-effort diagnostics, not a success channel: nothing in the app
 * reads it, and install success/failure is decided on the next launch by the
 * boot guard, which compares the running version against the pending-install
 * record. `installer spawned` therefore means only that the installer process
 * started, never that the update applied.
 *
 * `INSTALLER_SPAWN_OPTIONS.detached` is load-bearing and was established from a
 * real-machine failure on 2026-10-08 (see `defaultSpawn`): a non-detached
 * installer dies with this helper's process tree, so the log stops at
 * `installer spawned` and the version never changes.
 *
 * The app re-verifies the installer's sha256 (installer.ts:110) and this helper
 * then waits up to 60 s before executing that same path, so the bytes could in
 * principle be replaced in between (TOCTOU). Same-user attacker, low risk; a
 * re-verify here would need a 4th argv element, and this contract is frozen.
 *
 * Usage: apply-update.cjs <parent-pid> <installer-path> [log-path]
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const INSTALLER_ARGS = ['/S', '--force-run'];

// The parent is quitting while we wait, so this budget has to clear the app's
// whole quit flush (src/main/index.ts:1735-1756): search flushAll, KB vector DB
// close, bridge close, and every managed external gateway. That flush is NOT
// bounded in the worst case: flushAll() awaits a per-index async-mutex that has
// no timeout (src/main/features/search/indexer.ts:152, :94-97) and full index
// passes hold that same lock (:328, :560), so a large reconcile can outlast any
// budget we pick. 60 s is a heuristic, unbounded in the worst case, and it
// bounds only this wait — after a timeout the installer runs anyway, because
// waiting forever leaves the user permanently on the old version.
//
// That timeout branch is survivable: the one-click installer always runs
// CHECK_APP_RUNNING (app-builder-lib/templates/nsis/installSection.nsh:33) and
// force-closes anything running from $INSTDIR
// (allowOnlyOneInstallerInstance.nsh:105-160), and the quit-path steps that can
// overrun are crash-safe (search index writes are tmp+rename,
// src/main/features/search/storage.ts:88-93; the vector store's VACUUM on close
// is transactional, src/main/features/vec_store.ts:561-570).
//
// Omitting `--updated` is deliberate for P0: the normal path quits the app
// first, so the installer should find nothing running. Because it is omitted,
// isUpdated is false (allowOnlyOneInstallerInstance.nsh:108-119), so a
// still-running app is force-killed with no grace window, and a non-closable
// instance (elevated app vs non-elevated installer) makes the silent installer
// take the MessageBox's IDCANCEL default and Quit
// (allowOnlyOneInstallerInstance.nsh:156-157) — exiting without installing and
// without log evidence. `--updated` was considered and deferred.
const PARENT_WAIT_TIMEOUT_MS = 60_000;
const PARENT_POLL_MS = 250;

/**
 * Signal 0 probes existence without delivering anything.
 *
 * ESRCH means the pid is gone (safe to install). EPERM means the process exists
 * but is not ours to signal — still running, still holding the installer's file
 * locks — so a probe error must never be read as "exited" by accident.
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function waitForParentExit(pid, opts = {}) {
  const aliveProbe = typeof opts.isAlive === 'function' ? opts.isAlive : isAlive;
  const timeoutMs = opts.timeoutMs ?? PARENT_WAIT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? PARENT_POLL_MS;
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (!aliveProbe(pid)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

/**
 * Run the installer and report its pid; 0 means "no process started".
 *
 * `spawnFn` is an injected seam, so both shapes have to keep working: the real
 * `defaultSpawn` returns a pid while a stub may return a ChildProcess-like
 * object. A falsy result is a failure for the caller — pid 0 is a real Windows
 * pid (System Idle), so it must never be logged as a successful spawn.
 */
function runInstaller(installerPath, spawnFn) {
  const child = spawnFn(installerPath, INSTALLER_ARGS);
  return typeof child === 'number' ? child : (child && child.pid) || 0;
}

/**
 * Spawn the installer so that it outlives this helper.
 *
 * `detached: true` is a correctness requirement, not a preference, and it was
 * established from a real-machine failure on Windows (10.0.26200, 2026-10-08):
 * a NON-detached installer is destroyed together with this helper's process tree
 * as soon as `main()` returns. The log still ends at `installer spawned`, NSIS
 * writes nothing, the installed version never changes, and the only trace left
 * is the boot guard's `install-missed` verdict on the next launch — the user
 * stays on the old build with no error shown. Measured on the delivered 1.2.0
 * package updating to a real 1.2.1 build: 4/4 non-detached attempts installed
 * nothing (two through the app, one through this helper run manually, one
 * through a bare `spawn` with these same options), and 2/2 detached attempts
 * installed correctly (one bare `spawn`, one through the app). Control runs of
 * the very same artifact from a console, synchronously, install fine.
 *
 * `unref()` is required on top of that, and for its own reason: without it the
 * child would keep this helper referenced for the installer's whole lifetime
 * (minutes), so the helper would still be a running executable under $INSTDIR
 * when NSIS runs CHECK_APP_RUNNING — and the PowerShell branch force-kills
 * everything under $INSTDIR with no $pid exclusion
 * (allowOnlyOneInstallerInstance.nsh:94). Detaching and `unref()` are not
 * substitutes: the first keeps the installer alive past this process, the second
 * stops this process from outliving the spawn.
 *
 * `spawnFn` is the same injected seam `runInstaller` takes; production passes
 * nothing and gets `node:child_process.spawn`.
 */
const INSTALLER_SPAWN_OPTIONS = Object.freeze({
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});

function defaultSpawn(exe, args, spawnFn = spawn) {
  const child = spawnFn(exe, args, INSTALLER_SPAWN_OPTIONS);
  child.unref();
  return child.pid || 0;
}

async function main(argv) {
  const parentPid = Number(argv[0]);
  const installerPath = argv[1];
  const logPath = argv[2];
  // pid 0 is Windows' System Idle process and negatives are not pids at all: the
  // wait below would spin on a process that can never be the app.
  if (!Number.isInteger(parentPid) || parentPid <= 0 || !installerPath) {
    process.stderr.write('usage: apply-update.cjs <parent-pid> <installer-path> [log-path]\n');
    process.exit(2);
  }
  const note = (line) => {
    if (!logPath) return;
    try {
      fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    } catch { /* logging must never block the install */ }
  };

  // Basename only: this log travels in bug reports, and a raw path would let a
  // newline in the path forge additional log lines.
  const installerName = path.basename(installerPath);
  note(`helper start parent=${parentPid} installer=${installerName}`);
  // Checked before the wait, not just before the spawn: if the artifact vanished
  // between download and now, waiting for the parent is pure delay and a spawn
  // would report a pid for a process that never installs anything.
  if (!fs.existsSync(installerPath)) {
    note(`installer missing: ${installerName}`);
    process.stderr.write(`apply-update: installer missing: ${installerPath}\n`);
    process.exit(1);
  }
  try {
    // Size + mtime make a later "it never installed" report diagnosable against
    // the artifact that was actually handed over.
    const stat = fs.statSync(installerPath);
    note(`installer artifact ${installerName} size=${stat.size} mtime=${stat.mtime.toISOString()}`);
  } catch { /* the spawn below reports the real failure */ }

  const exited = await waitForParentExit(parentPid, { isAlive, timeoutMs: PARENT_WAIT_TIMEOUT_MS, pollMs: PARENT_POLL_MS });
  note(exited ? 'parent exited' : 'parent wait timed out; installing anyway');

  let pid;
  try {
    pid = runInstaller(installerPath, defaultSpawn);
  } catch (err) {
    // Windows throws synchronously from spawn() for a path that exists but is
    // not a valid executable (`spawn UNKNOWN`, errno -4094); an 'error' listener
    // is never consulted. SmartScreen/AV blocks and elevation denials land here
    // too. Unrecorded, this leaves the app gone, nothing installed, and the log
    // ending at `parent exited` — this log is the helper's only durable channel.
    note(`installer spawn failed: ${err && err.message}`);
    process.stderr.write(`apply-update: installer spawn failed: ${err && err.message}\n`);
    process.exit(1);
  }
  if (!pid) {
    note('installer spawn returned no pid');
    process.stderr.write('apply-update: installer spawn returned no pid\n');
    process.exit(1);
  }
  note(`installer spawned pid=${pid}`);
}

module.exports = { INSTALLER_ARGS, INSTALLER_SPAWN_OPTIONS, defaultSpawn, waitForParentExit, runInstaller };

if (require.main === module) {
  void main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`apply-update failed: ${err && err.message}\n`);
    process.exit(1);
  });
}
