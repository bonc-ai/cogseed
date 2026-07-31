#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createDevBuilderConfig(baseConfig = {}, identity = {}) {
  const config = clone(baseConfig) || {};
  config.appId = 'com.mateagent.desktop.dev';
  config.productName = 'Mate Agent Dev';
  delete config.protocols;
  config.directories = { ...(config.directories || {}), output: 'dist-dev' };
  const files = Array.isArray(config.files) ? [...config.files] : [];
  if (!files.includes('.build/build-info.json')) files.push('.build/build-info.json');
  config.files = files;
  config.extraMetadata = {
    ...(config.extraMetadata || {}),
    orkasBuildChannel: identity.channel || 'packaged-dev',
  };
  config.mac = {
    ...(config.mac || {}),
    target: [{ target: 'dir', arch: ['arm64'] }],
  };
  return config;
}

function expectedDevAppPath(root = ROOT, arch = 'arm64') {
  return path.join(root, 'dist-dev', `mac-${arch}`, 'Mate Agent Dev.app');
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed with status ${result.status}`);
}

function main() {
  if (process.platform !== 'darwin') throw new Error('package:dev:mac is supported only on macOS');
  run(process.execPath, [path.join(ROOT, 'scripts', 'write-build-info.cjs'), '--channel=packaged-dev']);
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const config = createDevBuilderConfig(packageJson.build, { channel: 'packaged-dev' });
  const configPath = path.join(ROOT, '.build', 'electron-builder-dev.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const builderCli = require.resolve('electron-builder/out/cli/cli.js');
  run(process.execPath, [builderCli, '--config', configPath, '--mac', 'dir', '--arm64', '--publish', 'never']);
  const appPath = expectedDevAppPath(ROOT);
  if (!fs.existsSync(appPath)) throw new Error(`development app was not produced: ${appPath}`);
  process.stdout.write(`${appPath}\n`);
}

module.exports = { createDevBuilderConfig, expectedDevAppPath };

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`[package-dev-mac] ${error.message || error}`);
    process.exit(1);
  }
}
