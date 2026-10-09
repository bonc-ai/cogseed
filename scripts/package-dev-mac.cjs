#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createDevBuilderConfig(baseConfig = {}, identity = {}, options = {}) {
  const config = clone(baseConfig) || {};
  config.appId = 'com.cogseed.desktop.dev';
  config.productName = 'CogSeed Dev';
  if (options.electronDist) config.electronDist = options.electronDist;
  delete config.protocols;
  config.directories = { ...(config.directories || {}), output: options.outputDir || 'dist-dev' };
  const files = Array.isArray(config.files) ? [...config.files] : [];
  if (!files.includes('.build/build-info.json')) files.push('.build/build-info.json');
  config.files = files;
  config.extraMetadata = {
    ...(config.extraMetadata || {}),
    cogseedBuildChannel: identity.channel || 'packaged-dev',
  };
  config.mac = {
    ...(config.mac || {}),
    forceCodeSigning: false,
    identity: null,
    target: [{ target: 'dir', arch: [options.arch || 'arm64'] }],
  };
  return config;
}

function resolveLocalElectronDist({
  electronVersion,
  arch = process.arch,
  cacheRoot = path.join(os.homedir(), 'Library', 'Caches', 'electron'),
  exists = fs.existsSync,
  listDirs = (root) => fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name),
} = {}) {
  if (!electronVersion || !exists(cacheRoot)) return '';
  const zipName = `electron-v${electronVersion}-darwin-${arch}.zip`;
  for (const directory of listDirs(cacheRoot)) {
    const candidate = path.posix.join(cacheRoot, directory, zipName);
    if (exists(candidate)) return candidate;
  }
  return '';
}

function expectedDevAppPath(root = ROOT, arch = process.arch) {
  const outputDir = arch === 'x64' ? 'mac' : `mac-${arch}`;
  return path.join(root, 'dist-dev', outputDir, 'CogSeed Dev.app');
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed with status ${result.status}`);
}

function signPackagedDevApp(appPath) {
  // electron-builder applies Electron fuses after its afterPack hook. That hook
  // performs the local ad-hoc signature used by this development package, so
  // the fuse write invalidates the signature unless we sign once more here.
  // Release builds use their official signing stage, which already runs after
  // fuses; this is deliberately limited to the local packaged-dev verifier.
  run('codesign', ['--force', '--deep', '--sign', '-', appPath]);
  run('codesign', ['--verify', '--deep', appPath]);
}

function main() {
  if (process.platform !== 'darwin') throw new Error('package:dev:mac is supported only on macOS');
  run(process.execPath, [path.join(ROOT, 'scripts', 'write-build-info.cjs'), '--channel=packaged-dev']);
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
  const arch = process.arch;
  if (!['arm64', 'x64'].includes(arch)) throw new Error(`package:dev:mac does not support architecture ${arch}`);
  const electronDist = resolveLocalElectronDist({ electronVersion, arch });
  if (!electronDist) {
    throw new Error(`Electron ${electronVersion} ${arch} zip is not cached; run the normal dependency setup once before packaging`);
  }
  const config = createDevBuilderConfig(packageJson.build, { channel: 'packaged-dev' }, { electronDist, arch });
  const configPath = path.join(ROOT, '.build', 'electron-builder-dev.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const builderCli = require.resolve('electron-builder/out/cli/cli.js');
  run(process.execPath, [builderCli, '--config', configPath, '--mac', 'dir', `--${arch}`, '--publish', 'never']);
  const appPath = expectedDevAppPath(ROOT, arch);
  if (!fs.existsSync(appPath)) throw new Error(`development app was not produced: ${appPath}`);
  signPackagedDevApp(appPath);
  process.stdout.write(`${appPath}\n`);
}

module.exports = { createDevBuilderConfig, expectedDevAppPath, resolveLocalElectronDist, signPackagedDevApp };

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`[package-dev-mac] ${error.message || error}`);
    process.exit(1);
  }
}
