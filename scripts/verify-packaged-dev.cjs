#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { listPackage, extractFile } = require('@electron/asar');
const { expectedDevAppPath } = require('./package-dev-mac.cjs');

const ROOT = path.resolve(__dirname, '..');
const ASAR_REQUIRED = Object.freeze([
  'package.json',
  'bootstrap.cjs',
  'src/main/install-data-root.cjs',
  'src/main/util/migrate-source-data-root.cjs',
  '.build/build-info.json',
  'src/main/index.ts',
  'src/renderer/modules/agents.js',
]);
const RESOURCE_REQUIRED = Object.freeze([
  ['builtin', '_manifest.json'],
  ['runtime', 'manifest.json'],
  ['officecli', 'officecli-mac-arm64'],
  ['packages', 'nseap-meta-skill-engine', 'dist', 'index.js'],
]);

function normalizeAsarEntry(entry) {
  return String(entry || '').replaceAll('\\', '/').replace(/^\/+/, '');
}

function verifyPackagedDevBundle(appPath, options = {}) {
  const errors = [];
  const exists = options.exists || fs.existsSync;
  const resources = path.join(appPath, 'Contents', 'Resources');
  const asarPath = path.join(resources, 'app.asar');
  if (!exists(appPath)) errors.push(`missing app bundle: ${appPath}`);
  if (!exists(asarPath)) errors.push(`missing app.asar: ${asarPath}`);

  let entries = new Set();
  const listAsar = options.listAsar || listPackage;
  if (exists(asarPath)) {
    try { entries = new Set(listAsar(asarPath).map(normalizeAsarEntry)); }
    catch (error) { errors.push(`cannot list app.asar: ${error.message || error}`); }
  }
  for (const required of ASAR_REQUIRED) {
    if (!entries.has(required)) errors.push(`missing app.asar entry: ${required}`);
  }
  for (const parts of RESOURCE_REQUIRED) {
    const requiredPath = path.join(resources, ...parts);
    if (!exists(requiredPath)) errors.push(`missing packaged resource: ${parts.join('/')}`);
  }

  let identity = null;
  if (entries.has('.build/build-info.json')) {
    try {
      const readAsarFile = options.readAsarFile || extractFile;
      identity = JSON.parse(Buffer.from(readAsarFile(asarPath, '.build/build-info.json')).toString('utf8'));
    } catch (error) { errors.push(`invalid .build/build-info.json: ${error.message || error}`); }
  }
  if (!identity || identity.channel !== 'packaged-dev') errors.push('build identity channel must be packaged-dev');
  if (!identity || !String(identity.commit || '').trim()) errors.push('build identity commit is missing');
  return { ok: errors.length === 0, errors, appPath, asarPath, identity };
}

function verifySmokeMarker(marker) {
  const errors = [];
  if (marker?.status !== 'ready') errors.push('smoke marker must have status=ready');
  if (marker?.appIsPackaged !== true) errors.push('smoke marker must confirm appIsPackaged=true');
  if (marker?.appAsar !== true) errors.push('smoke marker must confirm appAsar=true');
  if (marker?.preloadLoaded !== true) errors.push('smoke marker must confirm preloadLoaded=true');
  if (marker?.rendererLoaded !== true) errors.push('smoke marker must confirm rendererLoaded=true');
  if (marker?.ipcPing !== 'pong') errors.push('smoke marker must confirm ipcPing=pong');
  return errors;
}

function waitForMarker(markerPath, child, timeoutMs = 90_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (fs.existsSync(markerPath)) {
        clearInterval(timer);
        try { resolve(JSON.parse(fs.readFileSync(markerPath, 'utf8'))); }
        catch (error) { reject(new Error(`invalid smoke marker: ${error.message || error}`)); }
        return;
      }
      if (child.exitCode != null) {
        clearInterval(timer);
        reject(new Error(`packaged app exited before writing the smoke marker (status ${child.exitCode})`));
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        child.kill('SIGTERM');
        reject(new Error(`timed out after ${timeoutMs}ms waiting for packaged launch smoke`));
      }
    }, 200);
  });
}

async function launchSmoke(appPath) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mate-agent-packaged-dev-'));
  const markerPath = path.join(tempRoot, 'ready.json');
  const executable = path.join(appPath, 'Contents', 'MacOS', 'Mate Agent Dev');
  if (!fs.existsSync(executable)) throw new Error(`missing packaged executable: ${executable}`);
  const child = spawn(executable, [], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ORKAS_PACKAGED_LAUNCH_SMOKE_FILE: markerPath,
      ORKAS_WORKSPACE_ROOT: path.join(tempRoot, 'workspace'),
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
  try {
    const marker = await waitForMarker(markerPath, child);
    const errors = verifySmokeMarker(marker);
    if (errors.length) throw new Error(`${errors.join('; ')}${stderr ? `\n${stderr}` : ''}`);
    return marker;
  } finally {
    if (child.exitCode == null) child.kill('SIGTERM');
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('verify:package:dev:mac is supported only on macOS');
  const appPath = process.argv[2] ? path.resolve(process.argv[2]) : expectedDevAppPath(ROOT);
  const bundle = verifyPackagedDevBundle(appPath);
  if (!bundle.ok) throw new Error(bundle.errors.join('\n'));
  const marker = await launchSmoke(appPath);
  process.stdout.write(`${JSON.stringify({ ok: true, appPath, identity: bundle.identity, smoke: marker }, null, 2)}\n`);
}

module.exports = { ASAR_REQUIRED, RESOURCE_REQUIRED, verifyPackagedDevBundle, verifySmokeMarker };

if (require.main === module) {
  main().catch((error) => {
    console.error(`[verify-packaged-dev] ${error.message || error}`);
    process.exit(1);
  });
}
