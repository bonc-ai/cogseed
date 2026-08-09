#!/usr/bin/env node
/**
 * Ensure node-pty's native addon matches the installed Electron ABI.
 *
 * node-pty ships a source build (node-gyp), compiled against system Node on
 * `npm install`, so its ABI won't match Electron. The app loads node-pty
 * through Electron's embedded Node, so we rebuild the addon against the
 * installed Electron version. Mirrors ensure-sqlite-electron-abi.mjs: probe
 * first (cheap, idempotent), rebuild only when the probe fails.
 *
 * Unlike better-sqlite3 (prebuild-install has Electron prebuilds), node-pty is
 * rebuilt from source via @electron/rebuild.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pcRoot = resolve(here, '..');
const require_ = createRequire(import.meta.url);

const electronCli = require_.resolve('electron/cli.js');
const electronPackage = require_.resolve('electron/package.json');
const nativeAddon = resolve(pcRoot, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node');

function describeResult(result) {
  const parts = [];
  if (typeof result.status === 'number') parts.push(`exit ${result.status}`);
  if (result.signal) parts.push(`signal ${result.signal}`);
  if (result.error) parts.push(`error ${result.error.message}`);
  return parts.join(', ') || 'unknown termination';
}

function firstUsefulLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function probeElectronAbi({ quiet = false } = {}) {
  const requireSnippet = `require(${JSON.stringify(nativeAddon)})`;
  const result = spawnSync(process.execPath, [electronCli, '-e', requireSnippet], {
    cwd: pcRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (result.status === 0) return true;
  if (!quiet) {
    const detail = describeResult(result);
    const reason = firstUsefulLine(result.stderr) || firstUsefulLine(result.stdout);
    console.error(`[ensure-node-pty-electron-abi] Electron ABI probe failed (${detail})${reason ? `: ${reason}` : ''}`);
  }
  return false;
}

// Skip when the installed addon already loads under Electron. Probe in a child
// process because an incompatible native binary can hard-crash the loader.
if (probeElectronAbi({ quiet: true })) {
  process.exit(0);
}

const electronVersion = JSON.parse(readFileSync(electronPackage, 'utf8')).version;
let rebuildBin;
try {
  // @electron/rebuild >= 4 restricts exports to ./lib/main.js, so resolve the
  // package entry and take the sibling cli.js instead of the subpath.
  rebuildBin = resolve(dirname(require_.resolve('@electron/rebuild')), 'cli.js');
} catch {
  try {
    rebuildBin = require_.resolve('electron-rebuild/lib/cli.js');
  } catch {
    console.error('[ensure-node-pty-electron-abi] @electron/rebuild not found; run `npm install` to get it');
    process.exit(1);
  }
}

const result = spawnSync(process.execPath, [
  rebuildBin,
  '--only', 'node-pty',
  '--version', electronVersion,
], {
  cwd: pcRoot,
  stdio: 'inherit',
});

// Runtime probe is authoritative.
if (probeElectronAbi({ quiet: true })) {
  process.exit(0);
}

console.error(`[ensure-node-pty-electron-abi] rebuild did not produce a loadable Electron ABI (${describeResult(result)})`);
probeElectronAbi();
process.exit(result.status ?? 1);
