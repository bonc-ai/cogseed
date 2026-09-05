#!/usr/bin/env node
/**
 * Ensure node-pty's native addon matches the installed Electron ABI.
 *
 * node-pty 1.1 ships Node-API prebuilds for the primary platforms, while a
 * source build still lands under build/Release. Probe the actual runtime
 * candidates with Electron first (cheap and idempotent), and rebuild from
 * source only when no compatible build or prebuild is available.
 *
 * Also repairs a node-pty 1.1.0 packaging defect: the npm tarball ships the
 * macOS `spawn-helper` prebuild without the execute bit, which makes
 * `posix_spawn` of the helper fail (integrated terminal reports
 * "posix_spawnp failed."). Restore mode 0755 whenever a prebuild helper is
 * present so fresh installs and packaged builds get a working terminal.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pcRoot = resolve(here, '..');
const require_ = createRequire(import.meta.url);

const electronCli = require_.resolve('electron/cli.js');
const electronPackage = require_.resolve('electron/package.json');
const nodePtyRoot = resolve(pcRoot, 'node_modules', 'node-pty');
const electronVersion = JSON.parse(readFileSync(electronPackage, 'utf8')).version;
const rebuildMeta = resolve(nodePtyRoot, 'build', 'Release', '.forge-meta');

function resolveNativeAddons() {
  const names = process.platform === 'win32'
    ? ['conpty.node', 'pty.node']
    : ['pty.node'];
  const dirs = [
    resolve(nodePtyRoot, 'build', 'Release'),
    resolve(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`),
  ];
  for (const dir of dirs) {
    const addons = names.map((name) => resolve(dir, name));
    if (addons.every(existsSync)) return addons;
  }
  return names.map((name) => resolve(dirs[0], name));
}

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
  const requireSnippet = resolveNativeAddons()
    .map((addon) => `require(${JSON.stringify(addon)})`)
    .join(';');
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

function markElectronRebuildComplete() {
  const { getAbi } = require_('node-abi');
  mkdirSync(resolve(nodePtyRoot, 'build', 'Release'), { recursive: true });
  writeFileSync(rebuildMeta, `${process.arch}--${getAbi(electronVersion, 'electron')}`);
}

/**
 * Repair node-pty 1.1.0's missing execute bit on the macOS spawn-helper.
 *
 * node-pty's unix backend spawns `prebuilds/<platform>-<arch>/spawn-helper`
 * via posix_spawn before exec'ing the user's shell. The npm tarball ships
 * that helper as mode 0644 (upstream packaging bug), so a fresh install uses
 * the prebuild and every integrated-terminal open fails with the generic
 * "posix_spawnp failed." (pty.cc hides the real EACCES errno).
 *
 * Only touched when the file exists, so win32 (ConPTY, no helper) and linux
 * (no prebuilds; source build already produces 0755) are no-ops. Idempotent:
 * mode already has an execute bit → skipped.
 */
function ensureSpawnHelperExecutable() {
  const prebuildsRoot = resolve(nodePtyRoot, 'prebuilds');
  let entries;
  try {
    entries = readdirSync(prebuildsRoot, { withFileTypes: true });
  } catch {
    return; // prebuilds/ missing (source-only layout)
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const helper = resolve(prebuildsRoot, entry.name, 'spawn-helper');
    if (!existsSync(helper)) continue; // win32/linux have no spawn-helper
    try {
      const mode = statSync(helper).mode;
      if ((mode & 0o111) === 0) {
        chmodSync(helper, 0o755);
        console.log(`[ensure-node-pty-electron-abi] restored execute bit on ${helper}`);
      }
    } catch (err) {
      console.warn(`[ensure-node-pty-electron-abi] cannot chmod ${helper}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// Skip when the installed addon already loads under Electron. Probe in a child
// process because an incompatible native binary can hard-crash the loader.
if (probeElectronAbi({ quiet: true })) {
  ensureSpawnHelperExecutable();
  markElectronRebuildComplete();
  process.exit(0);
}

/**
 * Locate the rebuild CLI.
 *
 * Resolving any subpath (`@electron/rebuild/lib/cli.js`, or even
 * `@electron/rebuild/package.json`) fails on @electron/rebuild v4: it declares
 * `"exports": "./lib/main.js"`, so Node rejects every other subpath with
 * ERR_PACKAGE_PATH_NOT_EXPORTED even though the files are on disk. The old
 * catch-all read that as "package missing", which is why a fully-installed tree
 * reported `@electron/rebuild not found; run npm install`.
 *
 * Only the main entry is exported, so resolve that and walk up to the package
 * root (the `lib/` parent). Then take the CLI path from `bin` when package.json
 * is readable, else fall back to the conventional `lib/cli.js`. Reading
 * package.json from an absolute path is fine — `exports` only gates specifier
 * resolution, not file reads.
 */
function resolveRebuildCli(pkgName) {
  let mainEntry;
  try {
    mainEntry = require_.resolve(pkgName);
  } catch {
    return '';
  }
  // .../@electron/rebuild/lib/main.js → .../@electron/rebuild
  let pkgDir = dirname(dirname(mainEntry));
  if (!existsSync(resolve(pkgDir, 'package.json'))) {
    const up = dirname(pkgDir);
    if (existsSync(resolve(up, 'package.json'))) pkgDir = up;
  }
  try {
    const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf8'));
    const binField = pkg.bin;
    const rel = typeof binField === 'string'
      ? binField
      : binField && (binField['electron-rebuild'] || Object.values(binField)[0]);
    if (rel) {
      const abs = resolve(pkgDir, rel);
      if (existsSync(abs)) return abs;
    }
  } catch { /* fall through to the conventional layout */ }
  const legacy = resolve(pkgDir, 'lib', 'cli.js');
  return existsSync(legacy) ? legacy : '';
}

const rebuildBin = resolveRebuildCli('@electron/rebuild') || resolveRebuildCli('electron-rebuild');
if (!rebuildBin) {
  console.error('[ensure-node-pty-electron-abi] @electron/rebuild not found; run `npm install` to get it');
  process.exit(1);
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
  ensureSpawnHelperExecutable();
  markElectronRebuildComplete();
  process.exit(0);
}

console.error(`[ensure-node-pty-electron-abi] rebuild did not produce a loadable Electron ABI (${describeResult(result)})`);
probeElectronAbi();
process.exit(result.status ?? 1);
