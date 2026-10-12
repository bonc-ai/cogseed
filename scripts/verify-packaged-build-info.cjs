#!/usr/bin/env node
'use strict';

// Verify the metadata that actually made it into the packaged app. Build-time
// validation alone is insufficient: electron-builder can still omit or replace
// a file before the installer is produced.

const fs = require('node:fs');
const path = require('node:path');
const { extractFile } = require('@electron/asar');
const { normalizeHttpsOrigin } = require('./write-build-info.cjs');

const ROOT = path.resolve(__dirname, '..');
const PLACEHOLDER_ORIGIN = 'https://hub.example.com';

function argValue(name, argv = process.argv) {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit === undefined ? undefined : hit.slice(prefix.length);
}

function argValues(name, argv = process.argv) {
  const prefix = `--${name}=`;
  return argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
}

function macAsarCandidates(root, arch) {
  const preferred = arch === 'arm64' ? ['mac-arm64', 'mac'] : ['mac', 'mac-arm64'];
  return preferred.map((directory) => path.join(
    root,
    'dist',
    directory,
    'CogSeed.app',
    'Contents',
    'Resources',
    'app.asar',
  ));
}

function resolvePackagedAsar({
  root = ROOT,
  platform = process.platform,
  arch = process.arch,
  appPath,
  exists = fs.existsSync,
} = {}) {
  const base = path.resolve(root);
  if (appPath) {
    const candidate = path.resolve(base, appPath);
    if (candidate.endsWith(`${path.sep}app.asar`) || candidate.endsWith('/app.asar')) return candidate;
    if (platform === 'darwin') {
      const app = candidate.endsWith('.app') ? candidate : path.dirname(candidate);
      return path.join(app, 'Contents', 'Resources', 'app.asar');
    }
    if (platform === 'win32') {
      const unpacked = candidate.endsWith('.exe') ? path.dirname(candidate) : candidate;
      return path.join(unpacked, 'resources', 'app.asar');
    }
    return path.join(candidate, 'resources', 'app.asar');
  }

  const candidates = platform === 'win32'
    ? [path.join(base, 'dist', 'win-unpacked', 'resources', 'app.asar')]
    : platform === 'darwin'
      ? macAsarCandidates(base, arch)
      : [];
  const found = candidates.find(exists);
  return found || candidates[0] || '';
}

function readBuildInfo(asarPath, readAsarFile = extractFile) {
  return JSON.parse(Buffer.from(readAsarFile(asarPath, '.build/build-info.json')).toString('utf8'));
}

function verifyPackagedBuildInfo(asarPath, {
  expectedChannel = 'release',
  exists = fs.existsSync,
  readAsarFile = extractFile,
} = {}) {
  const errors = [];
  let identity = null;

  if (!asarPath) {
    errors.push('cannot resolve packaged app.asar');
  } else if (!exists(asarPath)) {
    errors.push(`missing packaged app.asar: ${asarPath}`);
  } else {
    try {
      identity = readBuildInfo(asarPath, readAsarFile);
    } catch (error) {
      errors.push(`cannot read packaged .build/build-info.json: ${error.message || error}`);
    }
  }

  if (!identity || identity.channel !== expectedChannel) {
    errors.push(`build identity channel must be ${expectedChannel}`);
  }
  if (!identity || !String(identity.commit || '').trim()) {
    errors.push('build identity commit is missing');
  }

  if (identity && Object.prototype.hasOwnProperty.call(identity, 'hubApiBase')) {
    const normalized = normalizeHttpsOrigin(identity.hubApiBase);
    if (!normalized) errors.push('packaged hubApiBase must be a valid HTTPS origin');
    else if (normalized === PLACEHOLDER_ORIGIN) errors.push('packaged hubApiBase must not be the public placeholder origin');
  }
  if (expectedChannel === 'release' && (!identity || !String(identity.hubApiBase || '').trim())) {
    errors.push('release package is missing the injected hubApiBase');
  }

  return { ok: errors.length === 0, errors, asarPath, identity };
}

function main(argv = process.argv, env = process.env) {
  const expectedChannel = argValue('channel', argv) || env.COGSEED_EXPECTED_BUILD_CHANNEL || 'release';
  const requestedApps = argValues('app', argv);
  const appPaths = requestedApps.length > 0 ? requestedApps : [undefined];
  const results = appPaths.map((appPath) => verifyPackagedBuildInfo(
    resolvePackagedAsar({ root: ROOT, appPath }),
    { expectedChannel },
  ));
  const failures = results.flatMap((result) => result.ok ? [] : result.errors);
  if (failures.length > 0) {
    process.stderr.write(`[verify-packaged-build-info] ${failures.join('\n')}\n`);
    return 1;
  }
  process.stdout.write(`[verify-packaged-build-info] OK (${expectedChannel}, ${results.length} package(s))\n`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  PLACEHOLDER_ORIGIN,
  macAsarCandidates,
  resolvePackagedAsar,
  readBuildInfo,
  verifyPackagedBuildInfo,
  main,
};
