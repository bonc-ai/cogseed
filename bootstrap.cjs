// Electron entry shim: register tsx so the main process can
// `require('./src/main')` and resolve to src/main/index.ts (Node folder →
// index.ts rule + tsx/cjs transpilation). Keeps __dirname semantics identical
// to running plain JS — no compile step in dev.
//
// Two hooks:
//  - `tsx/cjs` (sync require hook) handles src/main/**/*.ts on the require()
//    code path.
//  - `tsx/esm` (ESM loader, registered via node:module) handles dynamic
//    `import()` specifiers that resolve to .ts files — notably the
//    `import('#core-agent')` subpath import that targets core-agent source.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  normalizeEnv,
} = require('./src/main/identity-contract.cjs');
const {
  migrateLegacyInstallRoots,
} = require('./src/main/cogseed-install-migration.cjs');
const {
  initializeInstallDataRoot,
  selectRuntimeVariant,
} = require('./src/main/install-data-root.cjs');
const packageMeta = require('./package.json');

function detectPackagedRuntime() {
  const appPath = String(process.resourcesPath || '');
  return !!process.versions.electron
    && !!appPath
    && !appPath.includes(`${path.sep}node_modules${path.sep}electron${path.sep}`);
}

try {
  const isPackaged = detectPackagedRuntime();
  const isPackagedDev = isPackaged && packageMeta.orkasBuildChannel === 'packaged-dev';
  const normalizedEnv = normalizeEnv(process.env);
  Object.assign(process.env, normalizedEnv);
  if (isPackagedDev && !process.env.COGSEED_WORKSPACE_ROOT && !process.env.ORKAS_WORKSPACE_ROOT) {
    process.env.COGSEED_WORKSPACE_ROOT = path.join(os.homedir(), '.cogseed-dev', 'data');
  }
  const runtimeVariant = selectRuntimeVariant({
    argv: process.argv.slice(1),
    envVariant: process.env.ORKAS_RUNTIME_VARIANT || process.env.COGSEED_SOURCE_RUNTIME_VARIANT,
    isPackaged,
    sourceVariant: packageMeta.orkasSourceRuntimeVariant,
  });
  process.env.COGSEED_SOURCE_RUNTIME_VARIANT = runtimeVariant;
  process.env.ORKAS_RUNTIME_VARIANT = runtimeVariant;
  migrateLegacyInstallRoots({
    env: process.env,
  });
  initializeInstallDataRoot(process.env.COGSEED_SOURCE_RUNTIME_VARIANT, {
    allowWorkspaceOverride: isPackagedDev,
  });
} catch (err) {
  process.stderr.write(`[CogSeed] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 2;
  throw err;
}

for (const arg of process.argv.slice(1)) {
  if (typeof arg !== 'string') continue;
  if (arg.startsWith('--orkas-api-base-url=')) {
    process.env.ORKAS_API_BASE_URL = arg.slice('--orkas-api-base-url='.length);
  } else if (arg.startsWith('--orkas-voice-api-base=')) {
    process.env.ORKAS_VOICE_API_BASE = arg.slice('--orkas-voice-api-base='.length);
  } else if (arg.startsWith('--orkas-kstar-engine-command=')) {
    process.env.ORKAS_KSTAR_ENGINE_COMMAND = arg.slice('--orkas-kstar-engine-command='.length);
  } else if (arg.startsWith('--orkas-kstar-engine-args=')) {
    process.env.ORKAS_KSTAR_ENGINE_ARGS = arg.slice('--orkas-kstar-engine-args='.length);
  } else if (arg.startsWith('--orkas-kstar-engine-cwd=')) {
    process.env.ORKAS_KSTAR_ENGINE_CWD = arg.slice('--orkas-kstar-engine-cwd='.length);
  } else if (arg.startsWith('--orkas-kstar-engine-ontology-dir=')) {
    process.env.ORKAS_KSTAR_ENGINE_ONTOLOGY_DIR = arg.slice('--orkas-kstar-engine-ontology-dir='.length);
  }
}

function configurePackagedEsbuildBinary() {
  if (!process.versions.electron || !process.resourcesPath || process.env.ESBUILD_BINARY_PATH) {
    return;
  }

  const platformPackages = {
    'darwin:arm64': ['@esbuild', 'darwin-arm64', 'bin', 'esbuild'],
    'darwin:x64': ['@esbuild', 'darwin-x64', 'bin', 'esbuild'],
    'linux:arm64': ['@esbuild', 'linux-arm64', 'bin', 'esbuild'],
    'linux:x64': ['@esbuild', 'linux-x64', 'bin', 'esbuild'],
    'win32:arm64': ['@esbuild', 'win32-arm64', 'esbuild.exe'],
    'win32:ia32': ['@esbuild', 'win32-ia32', 'esbuild.exe'],
    'win32:x64': ['@esbuild', 'win32-x64', 'esbuild.exe'],
  };
  const parts = platformPackages[`${process.platform}:${process.arch}`];
  if (!parts) return;

  const bin = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    ...parts,
  );
  if (fs.existsSync(bin)) {
    process.env.ESBUILD_BINARY_PATH = bin;
  }
}

function configureWindowsVcRuntimePath() {
  if (process.platform !== 'win32') return;
  const platformKey = `${process.platform}-${process.arch}`;
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'runtime', 'vc', platformKey),
    path.join(__dirname, 'resources', 'runtime', 'vc', platformKey),
  ].filter(Boolean);
  const runtimeDir = candidates.find((dir) => fs.existsSync(path.join(dir, 'vcruntime140.dll')));
  if (!runtimeDir) return;
  const entries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  process.env.PATH = [runtimeDir, ...entries.filter((entry) => path.resolve(entry) !== path.resolve(runtimeDir))]
    .join(path.delimiter);
}

configureWindowsVcRuntimePath();
configurePackagedEsbuildBinary();

require('tsx/cjs');
require('tsx/esm/api').register();

require('./src/main');
