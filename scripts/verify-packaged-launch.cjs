#!/usr/bin/env node
'use strict';

// Launch the unpacked application under an isolated profile and require the
// app's own main/preload/renderer IPC proof. This verifies the product, not
// just electron-builder's ability to emit an installer.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_TIMEOUT_MS = 90_000;

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

function executableForMacBundle(appPath) {
  const product = path.basename(appPath, '.app');
  return path.join(appPath, 'Contents', 'MacOS', product);
}

function resolvePackagedExecutable(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const exists = options.exists || fs.existsSync;
  const requested = options.appPath || process.argv[2];

  if (requested) {
    const candidate = path.resolve(root, requested);
    if (platform === 'darwin' && candidate.endsWith('.app')) return executableForMacBundle(candidate);
    return candidate;
  }

  const candidates = platform === 'win32'
    ? [path.join(root, 'dist', 'win-unpacked', 'CogSeed.exe')]
    : [
      ...(arch === 'arm64' ? [path.join(root, 'dist', 'mac-arm64', 'CogSeed.app')] : []),
      path.join(root, 'dist', 'mac', 'CogSeed.app'),
      ...(arch !== 'arm64' ? [path.join(root, 'dist', 'mac-arm64', 'CogSeed.app')] : []),
    ].map(executableForMacBundle);

  const executable = candidates.find(exists);
  if (!executable) {
    throw new Error(`cannot find packaged executable; checked: ${candidates.join(', ')}`);
  }
  return executable;
}

function waitForMarker(markerPath, child, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer;
    let timeoutTimer;
    const cleanup = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      child.off('error', onError);
      child.off('close', onClose);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const readMarker = () => {
      if (!fs.existsSync(markerPath)) return false;
      try { settle(resolve, JSON.parse(fs.readFileSync(markerPath, 'utf8'))); }
      catch (error) { settle(reject, new Error(`invalid packaged launch marker: ${error.message || error}`)); }
      return true;
    };
    const onError = (error) => settle(reject, new Error(`packaged app process error: ${error?.message || error}`));
    const onClose = (code) => {
      if (!readMarker()) settle(reject, new Error(`packaged app exited before writing the launch marker (status ${code})`));
    };
    const check = () => {
      if (readMarker()) return;
      if (child.exitCode != null) {
        settle(reject, new Error(`packaged app exited before writing the launch marker (status ${child.exitCode})`));
      }
    };

    child.once('error', onError);
    child.once('close', onClose);
    pollTimer = setInterval(check, 200);
    timeoutTimer = setTimeout(() => {
      settle(reject, new Error(`timed out after ${timeoutMs}ms waiting for packaged launch smoke`));
    }, timeoutMs);
  });
}

function terminateChild(child, graceMs = 5_000) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    let forceTimer;
    const onClose = () => {
      if (forceTimer) clearTimeout(forceTimer);
      child.off('close', onClose);
      resolve();
    };
    child.once('close', onClose);
    forceTimer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
    }, graceMs);
    try { child.kill('SIGTERM'); } catch (_) {}
  });
}

async function launchPackagedSmoke(executable, options = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-packaged-launch-'));
  const markerPath = path.join(tempRoot, 'ready.json');
  const launchEnv = { ...process.env, ...(options.env || {}) };
  delete launchEnv.COGSEED_WORKSPACE_ROOT;
  delete launchEnv.COGSEED_RUNTIME_CONTAINER;
  const child = spawn(executable, [], {
    cwd: options.cwd || ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...launchEnv,
      HOME: tempRoot,
      USERPROFILE: tempRoot,
      LOCALAPPDATA: path.join(tempRoot, 'local-app-data'),
      APPDATA: path.join(tempRoot, 'app-data'),
      COGSEED_PACKAGED_LAUNCH_SMOKE_FILE: markerPath,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-12_000); });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-12_000); });
  try {
    const marker = await waitForMarker(markerPath, child, options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const errors = verifySmokeMarker(marker);
    if (errors.length) throw new Error(errors.join('; '));
    return marker;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const details = [
      message,
      stdout.trim() ? `--- app stdout (tail) ---\n${stdout.trim()}` : '',
      stderr.trim() ? `--- app stderr (tail) ---\n${stderr.trim()}` : '',
    ].filter(Boolean).join('\n');
    throw new Error(details);
  } finally {
    await terminateChild(child);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function main() {
  const executable = resolvePackagedExecutable();
  if (!fs.existsSync(executable)) throw new Error(`missing packaged executable: ${executable}`);
  const marker = await launchPackagedSmoke(executable);
  process.stdout.write(`${JSON.stringify({ ok: true, executable, smoke: marker }, null, 2)}\n`);
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  executableForMacBundle,
  resolvePackagedExecutable,
  verifySmokeMarker,
  waitForMarker,
  terminateChild,
  launchPackagedSmoke,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[verify-packaged-launch] ${error.message || error}\n`);
    process.exitCode = 1;
  });
}
