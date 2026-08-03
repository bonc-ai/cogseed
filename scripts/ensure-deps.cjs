#!/usr/bin/env node
// 启动前依赖一致性检查：比较 package.json + package-lock.json 的 SHA256 与
// node_modules/.orkas-deps-hash 里上次安装的哈希，不一致就自动 npm install。
// 由 run.sh / run.cmd 调用，单点跨平台。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const BRAND = require('../src/resources/brand.json');

const APP_NAME = BRAND.appName;
const LOG_PREFIX = `[${APP_NAME}]`;

const PC_DIR = path.resolve(__dirname, '..');
const PKG = path.join(PC_DIR, 'package.json');
const LOCK = path.join(PC_DIR, 'package-lock.json');
const NODE_MODULES = path.join(PC_DIR, 'node_modules');
const STAMP = path.join(NODE_MODULES, '.orkas-deps-hash');

function missingDeclaredDependencyPackages(options = {}) {
  const packageFile = options.packageFile || PKG;
  const nodeModulesDir = options.nodeModulesDir || NODE_MODULES;
  const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const names = new Set([
    ...Object.keys(packageJson.dependencies || {}),
    ...Object.keys(packageJson.devDependencies || {}),
  ]);
  const missing = [];
  for (const name of [...names].sort()) {
    const manifest = path.join(nodeModulesDir, ...name.split('/'), 'package.json');
    try {
      const installed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (!installed || typeof installed.version !== 'string' || !installed.version.trim()) {
        missing.push(name);
      }
    } catch {
      missing.push(name);
    }
  }
  return missing;
}

function summarizePackages(packages) {
  const visible = packages.slice(0, 5).join(', ');
  return packages.length > 5 ? `${visible}, +${packages.length - 5} more` : visible;
}

function dependencyInstallReason({ nodeModulesExists, stored, current, missingPackages }) {
  if (!nodeModulesExists) return 'node_modules_missing';
  if (stored !== current) return 'fingerprint_changed';
  if (missingPackages.length > 0) return 'packages_incomplete';
  return '';
}

// 指纹只覆盖真正影响 npm install 结果的字段，避免改 scripts.stop / build /
// name 这类无关字段也触发重装。
function depFingerprint() {
  const h = crypto.createHash('sha256');
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  } catch (err) {
    h.update('<pkg-parse-error>\0' + err.message);
    return h.digest('hex');
  }
  const subset = {};
  for (const k of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'overrides',
    'resolutions',
    'workspaces',
  ]) {
    if (pkg[k] !== undefined) subset[k] = pkg[k];
  }
  // install 钩子改了会改 node_modules 内容
  if (pkg.scripts) {
    const hooks = {};
    for (const s of ['preinstall', 'install', 'postinstall']) {
      if (pkg.scripts[s] !== undefined) hooks[s] = pkg.scripts[s];
    }
    if (Object.keys(hooks).length) subset.__installHooks = hooks;
  }
  h.update(JSON.stringify(subset));
  h.update('\0');
  if (fs.existsSync(LOCK)) {
    h.update(fs.readFileSync(LOCK));
  } else {
    h.update('<missing-lock>');
  }
  return h.digest('hex');
}

function readStamp() {
  try {
    return fs.readFileSync(STAMP, 'utf8').trim();
  } catch {
    return '';
  }
}

function writeStamp(hash) {
  fs.writeFileSync(STAMP, hash + '\n', 'utf8');
}

function npmInstallInvocation() {
  let packageManager = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
    packageManager = String(pkg.packageManager || '').trim();
  } catch {
    packageManager = '';
  }

  if (/^npm@\d/.test(packageManager)) {
    const corepackCmd = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
    const corepackProbe = spawnSync(corepackCmd, ['--version'], {
      cwd: PC_DIR,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    if (!corepackProbe.error) {
      return {
        cmd: corepackCmd,
        args: ['npm', 'install'],
        shell: process.platform === 'win32',
        label: `corepack npm install (${packageManager})`,
      };
    }
    console.warn(`[Mate Agent] corepack unavailable (${corepackProbe.error.message}); falling back to npm install.`);
    return {
      cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['install'],
      shell: process.platform === 'win32',
      label: `npm install (fallback for ${packageManager})`,
    };
  }

  return {
    cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['install'],
    shell: process.platform === 'win32',
    label: 'npm install',
  };
}

function runNpmInstall() {
  const invocation = npmInstallInvocation();
  console.log(`[Mate Agent] Installing dependencies with ${invocation.label}...`);
  const res = spawnSync(invocation.cmd, invocation.args, {
    cwd: PC_DIR,
    stdio: 'inherit',
    shell: invocation.shell,
  });
  if (res.error) {
    console.error(`[Mate Agent] ${invocation.label} failed to start:`, res.error.message);
    process.exit(1);
  }
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

// KB embedding 模型（bge-small-zh-v1.5，95MB）随 postinstall 下到
// `PC/resources/embedding-model/`，gitignored。即使 package.json/lockfile
// 没变、但模型文件被误删（或 clone 后还没跑过 postinstall），这里补跑一次。
// 脚本本身幂等 —— 文件齐全时立即返回。
const MODEL_DIR = path.join(PC_DIR, 'resources', 'embedding-model', 'fast-bge-small-zh-v1.5');
const MODEL_REQUIRED = ['config.json', 'tokenizer.json', 'model_optimized.onnx'];

function modelReady() {
  if (!fs.existsSync(MODEL_DIR)) return false;
  return MODEL_REQUIRED.every((f) => fs.existsSync(path.join(MODEL_DIR, f)));
}

function runModelFetch() {
  const res = spawnSync(process.execPath, [path.join(PC_DIR, 'scripts', 'fetch-embedding-model.mjs')], {
    cwd: PC_DIR,
    stdio: 'inherit',
    shell: false,
  });
  if (res.error) {
    console.error('[Mate Agent] 模型下载启动失败：', res.error.message);
    process.exit(1);
  }
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

const ELECTRON_DIR = path.join(NODE_MODULES, 'electron');
const ELECTRON_INSTALL = path.join(ELECTRON_DIR, 'install.js');
const ELECTRON_PATH_TXT = path.join(ELECTRON_DIR, 'path.txt');

function electronExpectedVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, 'package.json'), 'utf8'));
    return String(pkg.version || '').trim();
  } catch {
    return '';
  }
}

function electronBinaryPath() {
  try {
    const rel = fs.readFileSync(ELECTRON_PATH_TXT, 'utf8').trim();
    if (!rel) return '';
    return path.join(ELECTRON_DIR, 'dist', rel);
  } catch {
    return '';
  }
}

function electronPlatformPath() {
  switch (process.platform) {
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'win32':
      return 'electron.exe';
    default:
      return 'electron';
  }
}

function electronDarwinAppRoot(bin) {
  const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}Electron`;
  if (!bin.endsWith(marker)) return '';
  return bin.slice(0, -marker.length);
}

function electronDistReady(distDir, relPath, expected) {
  const bin = path.join(distDir, relPath);
  if (!bin || !fs.existsSync(bin)) return false;

  try {
    const actual = fs.readFileSync(path.join(distDir, 'version'), 'utf8').trim().replace(/^v/, '');
    if (actual !== expected) return false;
  } catch {
    return false;
  }

  if (process.platform === 'darwin') {
    const appRoot = electronDarwinAppRoot(bin);
    if (!appRoot) return false;
    const framework = path.join(
      appRoot,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Electron Framework',
    );
    if (!fs.existsSync(framework)) return false;
  }

  return true;
}

function electronReady() {
  const expected = electronExpectedVersion();
  if (!expected) return false;
  try {
    const rel = fs.readFileSync(ELECTRON_PATH_TXT, 'utf8').trim();
    if (!rel) return false;
    return electronDistReady(path.join(ELECTRON_DIR, 'dist'), rel, expected);
  } catch {
    return false;
  }
}

function runElectronInstall(reason) {
  if (!fs.existsSync(ELECTRON_INSTALL)) {
    console.error('[Mate Agent] Electron package is incomplete: node_modules/electron/install.js is missing.');
    console.error('[Mate Agent] Run `npm install` in PC/ or remove PC/node_modules and start again.');
    process.exit(1);
  }

  console.log(`[Mate Agent] Electron binary is not ready (${reason}); repairing Electron install...`);
  const res = spawnSync(process.execPath, [ELECTRON_INSTALL], {
    cwd: PC_DIR,
    stdio: 'inherit',
    shell: false,
  });
  if (res.error) {
    console.error('[Mate Agent] Electron install script failed to start:', res.error.message);
    process.exit(1);
  }
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function findFileByName(root, name) {
  if (!root || !fs.existsSync(root)) return '';
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === name) return candidate;
    }
  }
  return '';
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function repairWindowsElectronFromCache() {
  if (process.platform !== 'win32') return false;

  const version = electronExpectedVersion();
  const archiveName = `electron-v${version}-win32-${process.arch}.zip`;
  let expectedSha = '';
  try {
    const checksums = JSON.parse(fs.readFileSync(path.join(ELECTRON_DIR, 'checksums.json'), 'utf8'));
    expectedSha = String(checksums[archiveName] || '').toLowerCase();
  } catch {
    return false;
  }
  if (!version || !expectedSha) return false;

  const cacheRoot = process.env.electron_config_cache
    || (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'electron', 'Cache'));
  const archive = findFileByName(cacheRoot, archiveName);
  if (!archive) return false;

  const actualSha = sha256File(archive);
  if (actualSha !== expectedSha) {
    console.warn(`[Mate Agent] Ignoring Electron cache with a checksum mismatch: ${archiveName}`);
    return false;
  }

  const distDir = path.join(ELECTRON_DIR, 'dist');
  console.log('[Mate Agent] Electron npm extraction was incomplete; repairing from the verified download cache...');
  fs.rmSync(distDir, { recursive: true, force: true });
  const command = `Expand-Archive -LiteralPath ${powershellQuote(archive)} -DestinationPath ${powershellQuote(distDir)} -Force`;
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', command,
  ], {
    cwd: PC_DIR,
    stdio: 'inherit',
    shell: false,
    timeout: 10 * 60 * 1000,
  });
  if (result.error || result.status !== 0) {
    console.warn('[Mate Agent] Verified Electron cache extraction failed:', result.error?.message || `exit ${result.status}`);
    return false;
  }
  fs.writeFileSync(ELECTRON_PATH_TXT, 'electron.exe', 'utf8');
  return electronReady();
}

function ensureElectronReady(reason = 'missing binary') {
  if (electronReady()) return;

  runElectronInstall(reason);
  if (electronReady()) return;
  if (repairWindowsElectronFromCache()) return;

  const bin = electronBinaryPath() || '<missing path.txt>';
  console.error('[Mate Agent] Electron is still incomplete after repair.');
  console.error(`[Mate Agent] Expected Electron binary: ${bin}`);
  console.error('[Mate Agent] Check network access to the Electron download host, then rerun Mate Agent.');
  process.exit(1);
}

function main() {
  if (!fs.existsSync(PKG)) {
    console.error('[Mate Agent] 找不到 package.json：', PKG);
    process.exit(1);
  }

  const current = depFingerprint();
  const stored = readStamp();
  const nodeModulesExists = fs.existsSync(NODE_MODULES);
  const missingPackages = nodeModulesExists ? missingDeclaredDependencyPackages() : [];
  const installReason = dependencyInstallReason({
    nodeModulesExists,
    stored,
    current,
    missingPackages,
  });

  if (!installReason) {
    // 依赖已同步；但模型文件可能被误删，单独校验一次。
    if (!modelReady()) {
      console.log('[Mate Agent] 知识库 embedding 模型缺失，补下载（约 90MB）...');
      runModelFetch();
    }
    ensureElectronReady('dependency stamp is current but Electron files are incomplete');
    return;
  }

  if (installReason === 'node_modules_missing') {
    console.log('[Mate Agent] 首次运行：安装依赖 + 下载嵌入模型（约 5～10 分钟）...');
  } else if (installReason === 'packages_incomplete') {
    console.log(`[Mate Agent] Installed npm packages are incomplete (${summarizePackages(missingPackages)}); repairing...`);
  } else {
    console.log('[Mate Agent] 依赖与 package.json / lockfile 不一致，执行 npm install...');
  }

  runNpmInstall();
  const missingAfterInstall = missingDeclaredDependencyPackages();
  if (missingAfterInstall.length > 0) {
    console.error(`[Mate Agent] npm install completed but required packages are still incomplete: ${summarizePackages(missingAfterInstall)}`);
    process.exit(1);
  }
  ensureElectronReady('npm install finished without a complete Electron binary');

  // 双保险：npm install 的 postinstall 已跑 fetch-embedding-model，若因 npm
  // 的 postinstall 被 --ignore-scripts / CI 配置跳过，这里再兜底补一次。
  if (!modelReady()) {
    console.log('[Mate Agent] 嵌入模型尚未就绪，补下载...');
    runModelFetch();
  }

  // 安装后重新算一次（postinstall 钩子不会改 package.json/lockfile，但保险起见）
  const finalHash = depFingerprint();
  try {
    writeStamp(finalHash);
  } catch (err) {
    console.warn('[Mate Agent] 警告：写入依赖 stamp 失败（不影响启动）：', err.message);
  }
}

if (require.main === module) main();

module.exports = {
  dependencyInstallReason,
  missingDeclaredDependencyPackages,
};
