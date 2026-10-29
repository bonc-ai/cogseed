/**
 * Path + env plumbing for child processes that load **TypeScript** entries at
 * runtime through tsx (`bin/cogseed-embed-worker.cjs`,
 * `bin/cogseed-runtime-worker.cjs`).
 *
 * Packaged builds need two different roots, and getting only one right still
 * fails at startup:
 *
 *   - The tsx / `.ts` entry root must stay on the **ASAR root**. `.ts`
 *     sources are not in `asarUnpack`, so a child pointed at
 *     `app.asar.unpacked` dies with
 *     `Cannot find module '.../app.asar.unpacked/src/main/...'`.
 *   - The esbuild binary must come from **`app.asar.unpacked`**. A binary
 *     cannot be executed from inside the archive, so leaving
 *     `ESBUILD_BINARY_PATH` unset while `COGSEED_PC_DIR` points at the ASAR
 *     dies with `spawn ENOTDIR`.
 *
 * The main process solves the same problem in `bootstrap.cjs`
 * (`configurePackagedEsbuildBinary`); this module brings the identical rules
 * to the spawn sites.
 *
 * A third problem is module resolution rather than paths: `electron` is a
 * devDependency and is not shipped, so host modules in the worker's import
 * graph that do `import { app } from 'electron'` fail with
 * `Cannot find module 'electron'`. The worker scripts themselves alias that
 * specifier to `bin/child-electron-stub.cjs`, so nothing is needed here.
 *
 * In dev the source tree is on real disk, so both resolve to the same place
 * and no override is needed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { PC_ROOT } from '../paths';

/** `app.asar` → `app.asar.unpacked`. No-op when the path has no ASAR segment. */
export function unpackedResourcePath(p: string = PC_ROOT): string {
  return p.replace(/\bapp\.asar\b/, 'app.asar.unpacked');
}

/**
 * Console scripts live under `bin/**`, which IS unpacked in packaged builds.
 *
 * `root` defaults to the live app root; tests pass a fake packaged layout so
 * the asar → asar.unpacked mapping is covered without a real build.
 */
export function childWorkerScriptPath(scriptName: string, root: string = PC_ROOT): string {
  return path.join(unpackedResourcePath(root), 'bin', scriptName);
}

const ESBUILD_PLATFORM_PACKAGES: Record<string, string[]> = {
  'darwin:arm64': ['@esbuild', 'darwin-arm64', 'bin', 'esbuild'],
  'darwin:x64': ['@esbuild', 'darwin-x64', 'bin', 'esbuild'],
  'linux:arm64': ['@esbuild', 'linux-arm64', 'bin', 'esbuild'],
  'linux:x64': ['@esbuild', 'linux-x64', 'bin', 'esbuild'],
  'win32:arm64': ['@esbuild', 'win32-arm64', 'esbuild.exe'],
  'win32:ia32': ['@esbuild', 'win32-ia32', 'esbuild.exe'],
  'win32:x64': ['@esbuild', 'win32-x64', 'esbuild.exe'],
};

/**
 * Absolute path to the platform esbuild binary inside `app.asar.unpacked`,
 * or `undefined` when it is absent (dev, unsupported platform, or a build
 * that genuinely does not need tsx).
 *
 * `root` / `platform` / `arch` are injectable for the same reason as
 * `childWorkerScriptPath`: the packaged branch is otherwise unreachable from
 * tests, which is how the unpacked-root defect shipped in 1.2.0.
 */
export function esbuildBinaryPath(
  root: string = PC_ROOT,
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  const parts = ESBUILD_PLATFORM_PACKAGES[`${platform}:${arch}`];
  if (!parts) return undefined;
  const bin = path.join(unpackedResourcePath(root), 'node_modules', ...parts);
  return fs.existsSync(bin) ? bin : undefined;
}

/**
 * Shared env for TS-loading child processes.
 *
 * `process.env` is merged by the caller; this returns only the overrides so
 * call sites stay explicit about what they add.
 *
 * `COGSEED_PC_DIR` must stay on the **ASAR root** while the script path goes to
 * `app.asar.unpacked`: the `.ts` entry only exists inside the archive, and the
 * esbuild binary only exists outside it. Pointing both at the same root is the
 * defect this module exists to prevent.
 */
export function typescriptChildEnv(root: string = PC_ROOT): Record<string, string> {
  const env: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    // ASAR root (NOT unpacked): tsx + the `.ts` entry resolve from here.
    COGSEED_PC_DIR: root,
  };
  const esbuild = esbuildBinaryPath(root);
  if (esbuild) env.ESBUILD_BINARY_PATH = esbuild;
  return env;
}
