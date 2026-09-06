#!/usr/bin/env node
'use strict';

/**
 * Ensure the platform-specific Sherpa ONNX addon is available before a
 * Windows build. npm omits this optional dependency on macOS, while
 * electron-builder packages the dependency tree that physically exists.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  isPeX64,
  packagePath,
  packageVersion,
  readLockPackage,
} = require('./native-prepare-cache.cjs');

const ROOT = path.resolve(__dirname, '..');
const LOCK_FILE = path.join(ROOT, 'package-lock.json');
const PACKAGE_NAME = 'sherpa-onnx-win-x64';
const REQUIRED_FILES = Object.freeze([
  'sherpa-onnx.node',
  'onnxruntime.dll',
  'onnxruntime_providers_shared.dll',
  'sherpa-onnx-c-api.dll',
  'sherpa-onnx-cxx-api.dll',
]);
const RM_OPTIONS = Object.freeze({
  recursive: true,
  force: true,
  maxRetries: 6,
  retryDelay: 100,
});

function packageDir(root = ROOT) {
  return packagePath(root, PACKAGE_NAME);
}

function expectedVersion(lockFile = LOCK_FILE) {
  return readLockPackage(lockFile, PACKAGE_NAME);
}

function missingRuntimeFiles(root = ROOT) {
  const dir = packageDir(root);
  return REQUIRED_FILES.filter((file) => !fs.existsSync(path.join(dir, file)));
}

function hasWindowsRuntime(root = ROOT, version = expectedVersion()) {
  const dir = packageDir(root);
  return packageVersion(root, PACKAGE_NAME) === version
    && missingRuntimeFiles(root).length === 0
    && isPeX64(path.join(dir, 'sherpa-onnx.node'));
}

function npmCommand(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

function packPackage(tempDir, version) {
  const result = spawnSync(npmCommand(), ['pack', `${PACKAGE_NAME}@${version}`, '--json'], {
    cwd: tempDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npm pack ${PACKAGE_NAME}@${version} failed with exit code ${result.status}`);
  }
  const archiveName = JSON.parse(result.stdout)?.[0]?.filename;
  if (!archiveName) throw new Error(`npm pack ${PACKAGE_NAME}@${version} did not report an archive name`);
  return path.join(tempDir, archiveName);
}

function extractPackage(archive, destination) {
  const result = spawnSync('tar', ['-xzf', archive, '--strip-components=1'], {
    cwd: destination,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`could not extract ${path.basename(archive)}`);
}

function ensureWindowsRuntime(root = ROOT) {
  const version = expectedVersion(path.join(root, 'package-lock.json'));
  if (hasWindowsRuntime(root, version)) {
    console.log(`[ensure-sherpa-windows-runtime] reusing ${PACKAGE_NAME}@${version}`);
    return;
  }

  const destination = packageDir(root);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cogseed-sherpa-win-'));
  try {
    console.log(`[ensure-sherpa-windows-runtime] ensuring ${PACKAGE_NAME}@${version}`);
    const archive = packPackage(tempDir, version);
    fs.rmSync(destination, RM_OPTIONS);
    fs.mkdirSync(destination, { recursive: true });
    extractPackage(archive, destination);
  } finally {
    fs.rmSync(tempDir, RM_OPTIONS);
  }

  const missing = missingRuntimeFiles(root);
  if (missing.length) {
    throw new Error(`${PACKAGE_NAME}@${version} is incomplete; missing ${missing.join(', ')}`);
  }
  const addon = path.join(destination, 'sherpa-onnx.node');
  if (!isPeX64(addon)) {
    throw new Error(`${PACKAGE_NAME}@${version} did not provide a PE x64 addon: ${addon}`);
  }
}

module.exports = {
  PACKAGE_NAME,
  REQUIRED_FILES,
  hasWindowsRuntime,
  missingRuntimeFiles,
  npmCommand,
  packageDir,
};

if (require.main === module) {
  try {
    ensureWindowsRuntime();
  } catch (error) {
    console.error(`[ensure-sherpa-windows-runtime] ${error.message || error}`);
    process.exit(1);
  }
}
