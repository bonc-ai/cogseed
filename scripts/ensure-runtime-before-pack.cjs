#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { slimRuntimeRoot } = require('./slim-runtime.cjs');
const {
  PACKAGED_RUNTIME_KINDS,
  runtimeKey,
  verifyRuntimeRoot,
  verifyWindowsVcExtraFilesConfig,
} = require('../bin/runtime-gate.cjs');
const {
  verifyExtraResourcesConfig,
  verifyMacLocalizedMetadataRoot,
} = require('../bin/packaged-resource-gate.cjs');
const { verifySourceEntrypointContract } = require('../bin/packaged-entrypoint-gate.cjs');
const { verifyBuiltinExtraResourcesConfig, verifyBuiltinRoot } = require('../bin/builtin-resource-gate.cjs');

const ARCH_MAP = new Map([
  ['0', 'ia32'],
  ['1', 'x64'],
  ['2', 'armv7l'],
  ['3', 'arm64'],
  ['4', 'universal'],
  ['ia32', 'ia32'],
  ['x64', 'x64'],
  ['armv7l', 'armv7l'],
  ['arm64', 'arm64'],
  ['universal', 'universal'],
]);

function normalizeArch(value) {
  return ARCH_MAP.get(String(value)) || String(value || process.arch);
}

function pruneRuntimeRoot(root, keys) {
  const allowed = new Set(keys);
  for (const kind of PACKAGED_RUNTIME_KINDS) {
    const kindDir = path.join(root, kind);
    if (!fs.existsSync(kindDir) || !fs.statSync(kindDir).isDirectory()) {
      continue;
    }
    for (const entry of fs.readdirSync(kindDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || allowed.has(entry.name)) {
        continue;
      }
      fs.rmSync(path.join(kindDir, entry.name), { recursive: true, force: true });
    }
  }
}

module.exports = async function ensureRuntimeBeforePack(context) {
  const pcRoot = path.resolve(__dirname, '..');
  const runtimeRoot = path.join(pcRoot, 'resources', 'runtime');
  const platform = context && context.electronPlatformName
    ? String(context.electronPlatformName)
    : process.platform;
  const arch = normalizeArch(context && context.arch);
  const arches = arch === 'universal' ? ['x64', 'arm64'] : [arch];

  for (const targetArch of arches) {
    const addon = spawnSync(process.execPath, [
      path.join(pcRoot, 'scripts', 'build-notification-permission-addon.cjs'),
      '--platform', platform,
      '--arch', targetArch,
      ...(arches.length > 1 ? ['--keep-other-arches'] : []),
    ], {
      cwd: pcRoot,
      encoding: 'utf8',
      stdio: 'inherit',
      env: process.env,
    });
    if (addon.error) throw addon.error;
    if (addon.status !== 0) {
      throw new Error(`notification permission addon failed for ${platform}-${targetArch} with status ${addon.status}`);
    }
  }

  // Fail the actual packaging run, even when tests were skipped, if a new
  // extraResources destination has no declared verification owner.
  const packageJson = JSON.parse(fs.readFileSync(path.join(pcRoot, 'package.json'), 'utf8'));
  verifyExtraResourcesConfig(packageJson.build && packageJson.build.extraResources);
  verifyWindowsVcExtraFilesConfig(packageJson.build && packageJson.build.win);
  verifyMacLocalizedMetadataRoot(path.join(pcRoot, 'resources', 'mac-locales'));
  verifyBuiltinExtraResourcesConfig(packageJson.build && packageJson.build.extraResources);
  verifyBuiltinRoot(path.join(pcRoot, 'resources', 'builtin'), { allowIgnoredJunk: true });
  // Keep separately spawned production files synchronized with the actual bin
  // tree. A new runtime entrypoint or build-only helper cannot enter a package
  // until it is classified in the shared closed-world contract.
  verifySourceEntrypointContract(pcRoot);

  const embedding = spawnSync(process.execPath, [
    path.join(pcRoot, 'scripts', 'fetch-embedding-model.mjs'),
  ], {
    cwd: pcRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    env: process.env,
  });
  if (embedding.error) throw embedding.error;
  if (embedding.status !== 0) {
    throw new Error(`fetch-embedding-model failed with status ${embedding.status}`);
  }

  for (const targetArch of arches) {
    const res = spawnSync(process.execPath, [
      path.join(pcRoot, 'bin', 'ensure-runtime.cjs'),
      '--root', runtimeRoot,
      '--platform', platform,
      '--arch', targetArch,
    ], {
      cwd: pcRoot,
      encoding: 'utf8',
      stdio: 'inherit',
      env: process.env,
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error(`ensure-runtime failed for ${platform}-${targetArch} with status ${res.status}`);
    }
  }

  // VC Runtime is a first-class Windows runtime dependency. Provision it
  // explicitly so the shared pre-pack verifier does not rely on another
  // dependency's side effect.
  if (platform === 'win32') {
    for (const targetArch of arches) {
      const res = spawnSync(process.execPath, [
        path.join(pcRoot, 'scripts', 'fetch-win-vc-runtime.cjs'),
        '--platform', platform,
        '--arch', targetArch,
      ], {
        cwd: pcRoot,
        encoding: 'utf8',
        stdio: 'inherit',
        env: process.env,
      });
      if (res.error) throw res.error;
      if (res.status !== 0) {
        throw new Error(`fetch-win-vc-runtime failed for ${platform}-${targetArch} with status ${res.status}`);
      }
    }
  }

  slimRuntimeRoot(runtimeRoot, { platform, arch });
  const allowedKeys = arches.map(targetArch => runtimeKey(platform, targetArch));
  pruneRuntimeRoot(runtimeRoot, allowedKeys);

  const verified = [];
  for (const targetArch of arches) {
    verified.push(...verifyRuntimeRoot(runtimeRoot, platform, targetArch, { allowedKeys }));
  }
  console.log(`[runtime-gate] pre-pack verified: ${verified.join(', ')}`);
};
